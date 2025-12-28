package middleware

import (
	"context"
	"fmt"
	"net/http"
	"sync"
	"time"

	"crypto/rand"
	"encoding/hex"
)

// Middleware is a function that wraps an http.Handler
type Middleware func(http.Handler) http.Handler

// Chain applies middlewares in order
func Chain(handler http.Handler, middlewares ...Middleware) http.Handler {
	for i := len(middlewares) - 1; i >= 0; i-- {
		handler = middlewares[i](handler)
	}
	return handler
}

// RequestID middleware adds a unique request ID to context and headers
func RequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestID := generateRequestID()
		
		// Add to context
		ctx := context.WithValue(r.Context(), "request-id", requestID)
		
		// Add to response header
		w.Header().Set("X-Request-ID", requestID)
		
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// SecurityHeaders middleware adds OWASP security headers
func SecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Content Security Policy
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; frame-ancestors 'none'")
		
		// HSTS (Strict-Transport-Security)
		w.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload")
		
		// X-Frame-Options
		w.Header().Set("X-Frame-Options", "DENY")
		
		// X-Content-Type-Options
		w.Header().Set("X-Content-Type-Options", "nosniff")
		
		// Referrer-Policy
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		
		// Permissions-Policy
		w.Header().Set("Permissions-Policy", "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()")
		
		next.ServeHTTP(w, r)
	})
}

// RateLimit middleware implements token bucket rate limiting per IP
func RateLimit(next http.Handler) http.Handler {
	buckets := &sync.Map{}
	
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip := getClientIP(r)
		
		bucket := getBucket(buckets, ip, 100, time.Minute) // 100 requests per minute
		
		if !bucket.Allow() {
			w.Header().Set("Retry-After", "60")
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusTooManyRequests)
			w.Write([]byte(`{"error":"rate limit exceeded"}`))
			return
		}
		
		next.ServeHTTP(w, r)
	})
}

// CSRF middleware implements synchronizer token pattern
func CSRF(next http.Handler) http.Handler {
	tokenCache := &sync.Map{}
	
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Only check for state-changing requests
		if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodOptions {
			sessionID, err := extractSessionID(r)
			if err != nil {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusUnauthorized)
				w.Write([]byte(`{"error":"no session"}`))
				return
			}
			
			token := r.Header.Get("X-CSRF-Token")
			if token == "" {
				token = r.FormValue("csrf_token")
			}
			
			expectedToken, ok := tokenCache.Load(sessionID)
			if !ok || expectedToken != token {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusForbidden)
				w.Write([]byte(`{"error":"csrf validation failed"}`))
				return
			}
		}
		
		next.ServeHTTP(w, r)
	})
}

// TokenBucket for rate limiting
type TokenBucket struct {
	tokens    float64
	maxTokens float64
	refillRate float64 // tokens per nanosecond
	lastRefill time.Time
	mu        sync.Mutex
}

// Allow checks if a request is allowed and decrements the bucket
func (tb *TokenBucket) Allow() bool {
	tb.mu.Lock()
	defer tb.mu.Unlock()
	
	now := time.Now()
	elapsed := now.Sub(tb.lastRefill).Seconds()
	tb.tokens = min(tb.maxTokens, tb.tokens+elapsed*tb.refillRate)
	tb.lastRefill = now
	
	if tb.tokens >= 1 {
		tb.tokens--
		return true
	}
	return false
}

func getBucket(buckets *sync.Map, ip string, maxTokens int, period time.Duration) *TokenBucket {
	val, loaded := buckets.LoadOrStore(ip, &TokenBucket{
		tokens:     float64(maxTokens),
		maxTokens:  float64(maxTokens),
		refillRate: float64(maxTokens) / period.Seconds(),
		lastRefill: time.Now(),
	})
	
	bucket := val.(*TokenBucket)
	
	// Reset bucket if it's been unused for longer than the period
	if loaded {
		bucket.mu.Lock()
		if time.Since(bucket.lastRefill) > period*2 {
			bucket.tokens = float64(maxTokens)
			bucket.lastRefill = time.Now()
		}
		bucket.mu.Unlock()
	}
	
	return bucket
}

// Utility functions

func generateRequestID() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func getClientIP(r *http.Request) string {
	// Check X-Forwarded-For (with validation to prevent header injection)
	forwardedFor := r.Header.Get("X-Forwarded-For")
	if forwardedFor != "" {
		// Only use the first IP in the list
		if ips := splitAndTrim(forwardedFor); len(ips) > 0 {
			return ips[0]
		}
	}
	
	// Check X-Real-IP
	if realIP := r.Header.Get("X-Real-IP"); realIP != "" {
		return realIP
	}
	
	// Fall back to RemoteAddr
	if colon := len(r.RemoteAddr) - 1; colon >= 0 {
		if i := len(r.RemoteAddr) - 1; i >= 0 && r.RemoteAddr[i:i+1] == "]" {
			// IPv6
			return r.RemoteAddr
		}
	}
	
	return r.RemoteAddr[:len(r.RemoteAddr)-1] // Remove port
}

func splitAndTrim(s string) []string {
	var result []string
	for i := 0; i < len(s); i++ {
		if s[i] == ',' {
			result = append(result, s[:i])
			s = s[i+1:]
			i = 0
			continue
		}
	}
	if len(s) > 0 {
		result = append(result, s)
	}
	return result
}

func extractSessionID(r *http.Request) (string, error) {
	cookie, err := r.Cookie("session_id")
	if err != nil {
		return "", fmt.Errorf("no session cookie: %w", err)
	}
	return cookie.Value, nil
}

func min(a, b float64) float64 {
	if a < b {
		return a
	}
	return b
}
