package middleware

import (
	"crypto/subtle"
	"fmt"
	"log/slog"
	"mime"
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
)

// Security event names (NFR-23, OWASP A09).
const (
	EventLoginSucceeded = "login_succeeded"
	EventLoginFailed    = "login_failed"
	EventLogout         = "logout"
	EventCSRFFailed     = "csrf_failed"
	EventRateLimited    = "rate_limited"
	EventSSRFBlocked    = "ssrf_blocked"
	EventSessionExpired = "session_expired"
)

// Security logs security-relevant events with the client IP and request
// ID. Callers must never pass secrets (passwords, tokens, session IDs).
// A nil *Security is a no-op.
type Security struct {
	logger *slog.Logger
	events *prometheus.CounterVec
}

// NewSecurity creates a security event logger. reg may be nil.
func NewSecurity(logger *slog.Logger, reg prometheus.Registerer) (*Security, error) {
	s := &Security{
		logger: logger,
		events: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: "lucid",
			Name:      "security_events_total",
			Help:      "Security events (failed logins, CSRF failures, rate limiting, SSRF blocks, ...).",
		}, []string{"event"}),
	}
	if reg != nil {
		if err := reg.Register(s.events); err != nil {
			return nil, fmt.Errorf("registering security metrics: %w", err)
		}
	}
	return s, nil
}

// Log records event for request r.
func (s *Security) Log(r *http.Request, event string, attrs ...slog.Attr) {
	if s == nil {
		return
	}
	s.events.WithLabelValues(event).Inc()
	level := slog.LevelWarn
	if event == EventLoginSucceeded || event == EventLogout {
		level = slog.LevelInfo
	}
	base := []slog.Attr{
		slog.String("security_event", event),
		slog.String("request_id", RequestID(r.Context())),
		slog.String("client_ip", ClientIP(r.Context())),
		slog.String("method", r.Method),
		slog.String("path", r.URL.Path),
	}
	s.logger.LogAttrs(r.Context(), level, "security event", append(base, attrs...)...)
}

// contentSecurityPolicy only allows same-origin resources. Inline styles
// are allowed because UI libraries set style attributes; inline scripts are not.
const contentSecurityPolicy = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
	"img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; " +
	"base-uri 'self'; form-action 'self'; frame-ancestors 'none'"

// SecurityHeaders sets the security headers (NFR-19) on every response and
// disables caching of API responses.
func SecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", contentSecurityPolicy)
		// Browsers ignore HSTS on plain HTTP, so it is safe to always send.
		h.Set("Strict-Transport-Security", "max-age=63072000; includeSubDomains")
		h.Set("X-Frame-Options", "DENY")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Permissions-Policy", "accelerometer=(), camera=(), geolocation=(), gyroscope=(), "+
			"magnetometer=(), microphone=(), payment=(), usb=()")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		h.Set("Cross-Origin-Resource-Policy", "same-origin")
		if IsAPI(r) {
			// API responses contain personal data: keep them out of caches.
			h.Set("Cache-Control", "no-store")
		}
		next.ServeHTTP(w, r)
	})
}

// MaxBodyBytes is the request body limit of the API.
const MaxBodyBytes = 1 << 20

// BodyLimit caps request bodies at n bytes.
func BodyLimit(n int64) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Body != nil && r.Body != http.NoBody {
				r.Body = http.MaxBytesReader(w, r.Body, n)
			}
			next.ServeHTTP(w, r)
		})
	}
}

// CSRFHeader carries the synchronizer token.
const CSRFHeader = "X-Csrf-Token"

// CSRF enforces the synchronizer token pattern (NFR-17) for state-changing
// API requests: the X-CSRF-Token header must equal the token stored in the
// caller's session. tokenFor returns that token ("" if there is no
// session). As defense in depth, cross-origin browser requests are also
// rejected via Sec-Fetch-Site/Origin, and bodies must be application/json
// (which HTML forms cannot send cross-site without a CORS preflight).
func CSRF(tokenFor func(*http.Request) string, sec *Security) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		deny := func(w http.ResponseWriter, r *http.Request, reason string) {
			sec.Log(r, EventCSRFFailed, slog.String("reason", reason))
			WriteError(w, http.StatusForbidden, CodeCSRFInvalid, "missing or invalid CSRF token")
		}
		cop := http.NewCrossOriginProtection()
		cop.SetDenyHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			deny(w, r, "cross-origin request")
		}))

		check := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			want := tokenFor(r)
			got := r.Header.Get(CSRFHeader)
			if want == "" || got == "" || subtle.ConstantTimeCompare([]byte(got), []byte(want)) != 1 {
				deny(w, r, "token mismatch")
				return
			}
			if r.ContentLength != 0 && !isJSON(r.Header.Get("Content-Type")) {
				WriteError(w, http.StatusBadRequest, CodeInvalidInput, "Content-Type must be application/json")
				return
			}
			next.ServeHTTP(w, r)
		})
		protected := cop.Handler(check)

		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !IsAPI(r) || isSafeMethod(r.Method) {
				next.ServeHTTP(w, r)
				return
			}
			protected.ServeHTTP(w, r)
		})
	}
}

func isSafeMethod(m string) bool {
	return m == http.MethodGet || m == http.MethodHead || m == http.MethodOptions
}

func isJSON(ct string) bool {
	mt, _, err := mime.ParseMediaType(ct)
	return err == nil && mt == "application/json"
}
