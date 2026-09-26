// Package middleware contains the HTTP middleware chain of Lucid: request
// context (ID, client IP), access logging and metrics, panic recovery,
// security headers, body limits, CSRF protection and rate limiting.
//
// Every middleware has the shape func(http.Handler) http.Handler.
package middleware

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net"
	"net/http"
	"net/netip"
	"strings"
)

// Error codes shared with internal/httpapi (see docs/API.md).
const (
	CodeInvalidInput = "invalid_input"
	CodeCSRFInvalid  = "csrf_invalid"
	CodeRateLimited  = "rate_limited"
	CodeInternal     = "internal"
)

// ErrorBody is the JSON error envelope of the API.
type ErrorBody struct {
	Error ErrorDetail `json:"error"`
}

// ErrorDetail is the content of ErrorBody.
type ErrorDetail struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// WriteJSON writes v as JSON with the given status.
func WriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		return // the client is gone or v is not encodable; headers are already sent
	}
}

// WriteError writes the API error envelope.
func WriteError(w http.ResponseWriter, status int, code, msg string) {
	WriteJSON(w, status, ErrorBody{Error: ErrorDetail{Code: code, Message: msg}})
}

// Chain applies mws to h; the first middleware is the outermost.
func Chain(h http.Handler, mws ...func(http.Handler) http.Handler) http.Handler {
	for i := len(mws) - 1; i >= 0; i-- {
		h = mws[i](h)
	}
	return h
}

// IsAPI reports whether the request targets the JSON API.
func IsAPI(r *http.Request) bool {
	return strings.HasPrefix(r.URL.Path, "/api/")
}

type ctxKey int

const (
	keyRequestID ctxKey = iota
	keyClientIP
)

// RequestIDHeader carries the request ID in responses (and, behind a
// trusted proxy, in requests).
const RequestIDHeader = "X-Request-Id"

// RequestContext stores a request ID and the client IP in the request
// context. It must be the outermost middleware: it is the only one that
// replaces the *http.Request, and Observe relies on seeing the request that
// ServeMux annotates with its Pattern.
//
// Proxy headers (X-Forwarded-For, X-Request-Id) are only honored with
// trustProxy, otherwise any client could spoof its IP and dodge rate limits.
func RequestContext(trustProxy bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			id := ""
			if trustProxy {
				id = sanitizeRequestID(r.Header.Get(RequestIDHeader))
			}
			if id == "" {
				id = newRequestID()
			}
			w.Header().Set(RequestIDHeader, id)
			ctx := context.WithValue(r.Context(), keyRequestID, id)
			ctx = context.WithValue(ctx, keyClientIP, clientIP(r, trustProxy))
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// RequestID returns the request ID stored by RequestContext.
func RequestID(ctx context.Context) string {
	s, _ := ctx.Value(keyRequestID).(string)
	return s
}

// ClientIP returns the client IP stored by RequestContext.
func ClientIP(ctx context.Context) string {
	s, _ := ctx.Value(keyClientIP).(string)
	return s
}

func newRequestID() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b) // never fails since Go 1.24
	return hex.EncodeToString(b)
}

func sanitizeRequestID(s string) string {
	if s == "" || len(s) > 64 {
		return ""
	}
	for i := range len(s) {
		c := s[i]
		if !('a' <= c && c <= 'z' || 'A' <= c && c <= 'Z' || '0' <= c && c <= '9' || c == '-' || c == '_' || c == '.') {
			return "" // keep logs free of injected content
		}
	}
	return s
}

func clientIP(r *http.Request, trustProxy bool) string {
	if trustProxy {
		// Use the right-most entry: it was appended by our trusted proxy.
		// Entries further left are client-controlled.
		if values := r.Header.Values("X-Forwarded-For"); len(values) > 0 {
			parts := strings.Split(values[len(values)-1], ",")
			if ip, err := netip.ParseAddr(strings.TrimSpace(parts[len(parts)-1])); err == nil {
				return ip.Unmap().String()
			}
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	if ip, err := netip.ParseAddr(host); err == nil {
		return ip.Unmap().WithZone("").String()
	}
	return host
}
