// Package httpapi implements the REST API of docs/API.md, the operational
// endpoints (/healthz, /readyz, /metrics) and the embedded SPA, and wires
// them into the security middleware chain.
package httpapi

import (
	"errors"
	"io/fs"
	"log/slog"
	"net/http"
	"sync/atomic"

	"github.com/tbckr/lucid/internal/domain"
	"github.com/tbckr/lucid/internal/middleware"
	"github.com/tbckr/lucid/internal/session"
	"github.com/tbckr/lucid/internal/undo"
)

// CookieName is the session cookie.
const CookieName = "lucid_session"

// SessionStore is the session storage used by the handlers
// (implemented by *session.Store).
type SessionStore interface {
	// Create starts an anonymous session.
	Create() (session.Session, error)
	// Get returns a session (session.ErrNotFound / session.ErrExpired).
	Get(id string) (session.Session, error)
	// Account decrypts the credentials of an authenticated session.
	Account(id string) (domain.Account, error)
	// Login creates an authenticated session and destroys oldID.
	Login(oldID string, acct domain.Account) (session.Session, error)
	// Delete destroys a session.
	Delete(id string)
}

// Options configures the Server.
type Options struct {
	// Provider connects to CalDAV servers. Required.
	Provider domain.Provider
	// Sessions stores sessions. Required.
	Sessions SessionStore
	// Undo stores the short-lived snapshots that undo a change of a
	// recurring todo or of an event series (FR-17). nil means no undo
	// tokens are ever issued, and the undo routes always answer 404
	// "nothing to undo".
	Undo *undo.Store
	// Logger receives access and error logs. Default slog.Default().
	Logger *slog.Logger
	// Security receives security events. Optional.
	Security *middleware.Security
	// Metrics records HTTP metrics. Optional.
	Metrics *middleware.Metrics
	// MetricsHandler is served at GET /metrics when non-nil.
	MetricsHandler http.Handler
	// Assets is the built SPA (web.Dist()). nil or without index.html
	// serves a placeholder page.
	Assets fs.FS
	// APILimiter limits all /api/ requests per client. Optional.
	APILimiter *middleware.Limiter
	// LoginLimiter additionally limits login attempts per client. Optional.
	LoginLimiter *middleware.Limiter
	// CookieInsecure drops the Secure cookie attribute (local HTTP only).
	CookieInsecure bool
	// TrustProxyHeaders takes the client IP from X-Forwarded-For.
	TrustProxyHeaders bool
	// Version of the running binary, reported by GET /api/v1/session.
	Version string
}

// Server is the complete HTTP handler of Lucid.
type Server struct {
	provider domain.Provider
	sessions SessionStore
	undo     *undo.Store
	logger   *slog.Logger
	sec      *middleware.Security
	insecure bool
	version  string
	ready    atomic.Bool
	handler  http.Handler
}

// New creates the Server.
func New(opts Options) (*Server, error) {
	if opts.Provider == nil || opts.Sessions == nil {
		return nil, errors.New("httpapi: Provider and Sessions are required")
	}
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	s := &Server{
		provider: opts.Provider,
		sessions: opts.Sessions,
		undo:     opts.Undo,
		logger:   opts.Logger,
		sec:      opts.Security,
		insecure: opts.CookieInsecure,
		version:  opts.Version,
	}
	s.ready.Store(true)

	mux := http.NewServeMux()
	login := http.Handler(http.HandlerFunc(s.handleLogin))
	if opts.LoginLimiter != nil {
		login = middleware.RateLimit(opts.LoginLimiter, s.sec, nil)(login)
	}
	mux.HandleFunc("GET /api/v1/session", s.handleSession)
	mux.Handle("POST /api/v1/auth/login", login)
	mux.HandleFunc("POST /api/v1/auth/logout", s.handleLogout)
	mux.HandleFunc("GET /api/v1/calendars", s.handleListCalendars)
	mux.HandleFunc("GET /api/v1/calendars/{calendarId}/events", s.handleListEvents)
	mux.HandleFunc("POST /api/v1/calendars/{calendarId}/events", s.handleCreateEvent)
	mux.HandleFunc("PUT /api/v1/events/{eventId}", s.handleUpdateEvent)
	mux.HandleFunc("DELETE /api/v1/events/{eventId}", s.handleDeleteEvent)
	mux.HandleFunc("PUT /api/v1/events/{eventId}/occurrences/{recurrenceId}", s.handleUpdateOccurrence)
	mux.HandleFunc("DELETE /api/v1/events/{eventId}/occurrences/{recurrenceId}", s.handleDeleteOccurrence)
	mux.HandleFunc("POST /api/v1/events/{eventId}/undo", s.handleUndoEvent)
	mux.HandleFunc("GET /api/v1/calendars/{calendarId}/todos", s.handleListTodos)
	mux.HandleFunc("GET /api/v1/calendars/{calendarId}/todos/occurrences", s.handleListTodoOccurrences)
	mux.HandleFunc("POST /api/v1/calendars/{calendarId}/todos", s.handleCreateTodo)
	mux.HandleFunc("PUT /api/v1/todos/{todoId}", s.handleUpdateTodo)
	mux.HandleFunc("DELETE /api/v1/todos/{todoId}", s.handleDeleteTodo)
	mux.HandleFunc("POST /api/v1/todos/{todoId}/undo", s.handleUndoTodo)
	mux.HandleFunc("/api/", func(w http.ResponseWriter, _ *http.Request) {
		middleware.WriteError(w, http.StatusNotFound, codeNotFound, "no such API endpoint")
	})
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		middleware.WriteJSON(w, http.StatusOK, status{"ok"})
	})
	mux.HandleFunc("GET /readyz", s.handleReady)
	if opts.MetricsHandler != nil {
		mux.Handle("GET /metrics", opts.MetricsHandler)
	}
	mux.Handle("/", newSPA(opts.Assets))

	mws := []func(http.Handler) http.Handler{
		middleware.RequestContext(opts.TrustProxyHeaders), // must stay outermost
		middleware.Observe(opts.Logger, opts.Metrics),
		middleware.SecurityHeaders,
		middleware.Recover(opts.Logger),
		middleware.BodyLimit(middleware.MaxBodyBytes),
	}
	if opts.APILimiter != nil {
		mws = append(mws, middleware.RateLimit(opts.APILimiter, s.sec, middleware.IsAPI))
	}
	mws = append(mws, middleware.CSRF(s.csrfToken, s.sec))
	s.handler = middleware.Chain(mux, mws...)
	return s, nil
}

// ServeHTTP implements http.Handler.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.handler.ServeHTTP(w, r)
}

// SetReady switches /readyz between 200 and 503. Call SetReady(false) at
// the start of a graceful shutdown so load balancers stop sending traffic.
func (s *Server) SetReady(ready bool) { s.ready.Store(ready) }

type status struct {
	Status string `json:"status"`
}

func (s *Server) handleReady(w http.ResponseWriter, _ *http.Request) {
	if !s.ready.Load() {
		middleware.WriteJSON(w, http.StatusServiceUnavailable, status{"shutting down"})
		return
	}
	middleware.WriteJSON(w, http.StatusOK, status{"ok"})
}
