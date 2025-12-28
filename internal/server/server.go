package server

import (
	"context"
	"net/http"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/tbckr/lucid/internal/middleware"
)

// Config holds server configuration
type Config struct {
	Addr         string
	ReadTimeout  time.Duration
	WriteTimeout time.Duration
	IdleTimeout  time.Duration
}

// Server wraps http.Server with middleware and routing
type Server struct {
	*http.Server
	mux *http.ServeMux
}

// New creates and configures a new Server
func New(cfg *Config) *Server {
	mux := http.NewServeMux()

	// Create middleware stack
	handler := middleware.Chain(
		mux,
		middleware.RequestID,
		middleware.SecurityHeaders,
		middleware.RateLimit,
	)

	srv := &Server{
		mux: mux,
		Server: &http.Server{
			Addr:         cfg.Addr,
			Handler:      handler,
			ReadTimeout:  cfg.ReadTimeout,
			WriteTimeout: cfg.WriteTimeout,
			IdleTimeout:  cfg.IdleTimeout,
		},
	}

	srv.registerRoutes()
	return srv
}

// registerRoutes sets up all HTTP routes using Go 1.22+ method-based routing
func (s *Server) registerRoutes() {
	// Health checks
	s.mux.HandleFunc("GET /healthz", s.HandleHealthz)
	s.mux.HandleFunc("GET /readyz", s.HandleReadyz)

	// Metrics (placeholder for now)
	s.mux.HandleFunc("GET /metrics", s.HandleMetrics)

	// API routes
	s.mux.HandleFunc("POST /api/auth/login", s.HandleLogin)
	s.mux.HandleFunc("POST /api/auth/logout", s.HandleLogout)
	s.mux.HandleFunc("GET /api/calendars", s.HandleGetCalendars)
	s.mux.HandleFunc("GET /api/events", s.HandleGetEvents)
	s.mux.HandleFunc("POST /api/events", s.HandleCreateEvent)
	s.mux.HandleFunc("PUT /api/events/{id}", s.HandleUpdateEvent)
	s.mux.HandleFunc("DELETE /api/events/{id}", s.HandleDeleteEvent)
}

// HandleHealthz - liveness probe
func (s *Server) HandleHealthz(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(`{"status":"ok"}`))
}

// HandleReadyz - readiness probe
func (s *Server) HandleReadyz(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(`{"status":"ready"}`))
}

// HandleMetrics - Prometheus metrics endpoint
func (s *Server) HandleMetrics(w http.ResponseWriter, r *http.Request) {
	promhttp.Handler().ServeHTTP(w, r)
}

// HandleLogin - POST /api/auth/login
func (s *Server) HandleLogin(w http.ResponseWriter, r *http.Request) {
	// TODO: Implement login
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(`{"message":"login endpoint"}`))
}

// HandleLogout - POST /api/auth/logout
func (s *Server) HandleLogout(w http.ResponseWriter, r *http.Request) {
	// TODO: Implement logout
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(`{"message":"logout endpoint"}`))
}

// HandleGetCalendars - GET /api/calendars
func (s *Server) HandleGetCalendars(w http.ResponseWriter, r *http.Request) {
	// TODO: Implement
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(`{"calendars":[]}`))
}

// HandleGetEvents - GET /api/events
func (s *Server) HandleGetEvents(w http.ResponseWriter, r *http.Request) {
	// TODO: Implement
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(`{"events":[]}`))
}

// HandleCreateEvent - POST /api/events
func (s *Server) HandleCreateEvent(w http.ResponseWriter, r *http.Request) {
	// TODO: Implement
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	w.Write([]byte(`{"id":"new-event"}`))
}

// HandleUpdateEvent - PUT /api/events/{id}
func (s *Server) HandleUpdateEvent(w http.ResponseWriter, r *http.Request) {
	// TODO: Implement
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(`{"id":"updated-event"}`))
}

// HandleDeleteEvent - DELETE /api/events/{id}
func (s *Server) HandleDeleteEvent(w http.ResponseWriter, r *http.Request) {
	// TODO: Implement
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusNoContent)
}
