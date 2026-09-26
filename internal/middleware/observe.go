package middleware

import (
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"runtime/debug"
	"strconv"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

// Metrics holds the HTTP metrics (NFR-08).
type Metrics struct {
	requests *prometheus.CounterVec
	duration *prometheus.HistogramVec
}

// NewMetrics creates and registers the HTTP metrics on reg.
func NewMetrics(reg prometheus.Registerer) (*Metrics, error) {
	m := &Metrics{
		requests: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: "lucid",
			Name:      "http_requests_total",
			Help:      "HTTP requests by method, route pattern and status code.",
		}, []string{"method", "route", "code"}),
		duration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Namespace: "lucid",
			Name:      "http_request_duration_seconds",
			Help:      "HTTP request latency by method and route pattern.",
			Buckets:   prometheus.DefBuckets,
		}, []string{"method", "route"}),
	}
	for _, c := range []prometheus.Collector{m.requests, m.duration} {
		if err := reg.Register(c); err != nil {
			return nil, fmt.Errorf("registering http metrics: %w", err)
		}
	}
	return m, nil
}

// routeUnmatched labels requests that never reached a ServeMux route (e.g.
// rejected by the rate limiter).
const routeUnmatched = "unmatched"

// Observe logs every request as structured JSON and records metrics.
// Metrics are labeled with the ServeMux route pattern, never the raw path,
// to keep label cardinality bounded. metrics may be nil.
func Observe(logger *slog.Logger, metrics *Metrics) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			rec := &recorder{ResponseWriter: w, status: http.StatusOK}
			next.ServeHTTP(rec, r)
			elapsed := time.Since(start)

			// ServeMux sets r.Pattern on this very request (see RequestContext).
			route := r.Pattern
			if route == "" {
				route = routeUnmatched
			}
			method := normalizeMethod(r.Method)
			if metrics != nil {
				metrics.requests.WithLabelValues(method, route, strconv.Itoa(rec.status)).Inc()
				metrics.duration.WithLabelValues(method, route).Observe(elapsed.Seconds())
			}

			level := slog.LevelInfo
			switch r.URL.Path {
			case "/healthz", "/readyz", "/metrics":
				level = slog.LevelDebug // probes would drown the log
			}
			logger.LogAttrs(r.Context(), level, "http request",
				slog.String("request_id", RequestID(r.Context())),
				slog.String("client_ip", ClientIP(r.Context())),
				slog.String("method", r.Method),
				slog.String("path", r.URL.Path),
				slog.String("route", route),
				slog.Int("status", rec.status),
				slog.Int64("bytes", rec.bytes),
				slog.Duration("duration", elapsed),
				slog.String("user_agent", r.UserAgent()),
			)
		})
	}
}

func normalizeMethod(m string) string {
	switch m {
	case http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPut,
		http.MethodPatch, http.MethodDelete, http.MethodOptions:
		return m
	default:
		return "OTHER" // arbitrary methods must not create new label values
	}
}

// recorder captures status code and response size.
type recorder struct {
	http.ResponseWriter
	status      int
	bytes       int64
	wroteHeader bool
}

func (r *recorder) WriteHeader(code int) {
	if !r.wroteHeader {
		r.status = code
		r.wroteHeader = true
	}
	r.ResponseWriter.WriteHeader(code)
}

func (r *recorder) Write(b []byte) (int, error) {
	r.wroteHeader = true
	n, err := r.ResponseWriter.Write(b)
	r.bytes += int64(n)
	return n, err
}

// Unwrap lets http.ResponseController reach the underlying writer.
func (r *recorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }

// Recover turns a panic into a 500 JSON response and logs it with a stack
// trace. http.ErrAbortHandler is re-panicked as net/http expects.
func Recover(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			rec := &recorder{ResponseWriter: w}
			defer func() {
				if v := recover(); v != nil {
					handlePanic(logger, rec, r, v)
				}
			}()
			next.ServeHTTP(rec, r)
		})
	}
}

func handlePanic(logger *slog.Logger, rec *recorder, r *http.Request, v any) {
	if err, ok := v.(error); ok && errors.Is(err, http.ErrAbortHandler) {
		panic(v)
	}
	logger.LogAttrs(r.Context(), slog.LevelError, "panic serving request",
		slog.String("request_id", RequestID(r.Context())),
		slog.String("method", r.Method),
		slog.String("path", r.URL.Path),
		slog.Any("panic", v),
		slog.String("stack", string(debug.Stack())),
	)
	if !rec.wroteHeader {
		WriteError(rec.ResponseWriter, http.StatusInternalServerError, CodeInternal, "internal server error")
	}
}
