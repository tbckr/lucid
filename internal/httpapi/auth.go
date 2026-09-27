package httpapi

import (
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"unicode"

	"github.com/tbckr/lucid/internal/domain"
	"github.com/tbckr/lucid/internal/middleware"
	"github.com/tbckr/lucid/internal/session"
)

// Limits for login fields.
const (
	maxServerURLLen = 2048
	maxUsernameLen  = 256
	maxPasswordLen  = 4096
)

type sessionResponse struct {
	Authenticated bool   `json:"authenticated"`
	Username      string `json:"username,omitempty"`
	ServerURL     string `json:"serverUrl,omitempty"`
	CSRFToken     string `json:"csrfToken"`
	Version       string `json:"version,omitempty"`
}

func (s *Server) sessionResponse(sess session.Session) sessionResponse {
	return sessionResponse{
		Authenticated: sess.Authenticated,
		Username:      sess.Username,
		ServerURL:     sess.ServerURL,
		CSRFToken:     sess.CSRFToken,
		Version:       s.version,
	}
}

// currentSession resolves the session cookie.
func (s *Server) currentSession(r *http.Request) (session.Session, error) {
	c, err := r.Cookie(CookieName)
	if err != nil {
		return session.Session{}, session.ErrNotFound
	}
	sess, err := s.sessions.Get(c.Value)
	if errors.Is(err, session.ErrExpired) {
		s.sec.Log(r, middleware.EventSessionExpired)
	}
	return sess, err
}

// csrfToken returns the synchronizer token of the caller's session.
func (s *Server) csrfToken(r *http.Request) string {
	sess, err := s.currentSession(r)
	if err != nil {
		return ""
	}
	return sess.CSRFToken
}

func (s *Server) setCookie(w http.ResponseWriter, sess session.Session) {
	//nolint:gosec // G124: Secure is only dropped with LUCID_COOKIE_INSECURE (local HTTP development)
	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    sess.ID,
		Path:     "/",
		Expires:  sess.ExpiresAt,
		HttpOnly: true,
		Secure:   !s.insecure,
		SameSite: http.SameSiteStrictMode,
	})
}

func (s *Server) clearCookie(w http.ResponseWriter) {
	//nolint:gosec // G124: Secure is only dropped with LUCID_COOKIE_INSECURE (local HTTP development)
	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   !s.insecure,
		SameSite: http.SameSiteStrictMode,
	})
}

// handleSession returns the session state and creates an anonymous
// session if needed, so the login form has a CSRF token.
func (s *Server) handleSession(w http.ResponseWriter, r *http.Request) {
	sess, err := s.currentSession(r)
	if err != nil {
		sess, err = s.sessions.Create()
		if err != nil {
			s.writeError(w, r, err)
			return
		}
		s.setCookie(w, sess)
	}
	middleware.WriteJSON(w, http.StatusOK, s.sessionResponse(sess))
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var creds domain.Credentials
	if err := decodeJSON(r, &creds); err != nil {
		s.writeError(w, r, err)
		return
	}
	creds.ServerURL = strings.TrimSpace(creds.ServerURL)
	creds.Username = strings.TrimSpace(creds.Username)
	if msg := validateCredentials(creds); msg != "" {
		middleware.WriteError(w, http.StatusBadRequest, codeInvalidInput, msg)
		return
	}
	// Never log the password: only username, server and client IP.
	logAttrs := []slog.Attr{slog.String("username", creds.Username), slog.String("server_url", creds.ServerURL)}

	acct, err := s.provider.Connect(r.Context(), creds)
	if err != nil {
		s.sec.Log(r, middleware.EventLoginFailed, append(logAttrs, slog.String("reason", loginFailureReason(err)))...)
		if errors.Is(err, domain.ErrUnauthorized) {
			middleware.WriteError(w, http.StatusUnauthorized, codeInvalidCredentials, "the CalDAV server rejected the credentials")
			return
		}
		s.writeError(w, r, err)
		return
	}

	oldID := ""
	if c, err := r.Cookie(CookieName); err == nil {
		oldID = c.Value
	}
	sess, err := s.sessions.Login(oldID, acct) // rotates the session ID
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.sec.Log(r, middleware.EventLoginSucceeded, logAttrs...)
	s.setCookie(w, sess)
	middleware.WriteJSON(w, http.StatusOK, s.sessionResponse(sess))
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(CookieName); err == nil {
		s.sessions.Delete(c.Value)
	}
	s.sec.Log(r, middleware.EventLogout)
	s.clearCookie(w)
	w.WriteHeader(http.StatusNoContent)
}

func validateCredentials(c domain.Credentials) string {
	switch {
	case c.ServerURL == "":
		return "serverUrl is required"
	case len(c.ServerURL) > maxServerURLLen:
		return "serverUrl too long"
	case strings.ContainsFunc(c.ServerURL, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }):
		return "serverUrl must not contain whitespace"
	case c.Username == "":
		return "username is required"
	case len(c.Username) > maxUsernameLen:
		return "username too long"
	case strings.ContainsFunc(c.Username, unicode.IsControl):
		return "username contains invalid characters"
	case c.Password == "":
		return "password is required"
	case len(c.Password) > maxPasswordLen:
		return "password too long"
	}
	authority := c.ServerURL
	if scheme, rest, ok := strings.Cut(c.ServerURL, "://"); ok {
		if scheme = strings.ToLower(scheme); scheme != "http" && scheme != "https" {
			return "serverUrl must use http or https"
		}
		if u, err := url.Parse(c.ServerURL); err != nil || u.Host == "" {
			return "serverUrl is not a valid URL"
		}
		authority = rest
	}
	if i := strings.IndexAny(authority, "/?#"); i >= 0 {
		authority = authority[:i]
	}
	if strings.Contains(authority, "@") {
		// Credentials in the URL would end up in logs and the session display.
		return "serverUrl must not contain credentials"
	}
	return ""
}

func loginFailureReason(err error) string {
	switch {
	case errors.Is(err, domain.ErrUnauthorized):
		return "invalid_credentials"
	case errors.Is(err, domain.ErrForbiddenTarget):
		return "forbidden_target"
	case errors.Is(err, domain.ErrDiscovery):
		return "discovery_failed"
	case errors.Is(err, domain.ErrInvalidInput):
		return "invalid_input"
	default:
		return "upstream_error"
	}
}
