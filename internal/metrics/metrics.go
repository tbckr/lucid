package metrics

import (
	"net/http"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	// HTTPRequestDuration tracks HTTP request latency
	HTTPRequestDuration = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Name: "lucid_http_request_duration_seconds",
			Help: "HTTP request duration in seconds",
			Buckets: []float64{
				0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0,
			},
		},
		[]string{"method", "endpoint", "status"},
	)

	// HTTPRequestTotal tracks total HTTP requests
	HTTPRequestTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "lucid_http_requests_total",
			Help: "Total number of HTTP requests",
		},
		[]string{"method", "endpoint", "status"},
	)

	// ActiveSessions tracks currently active user sessions
	ActiveSessions = promauto.NewGauge(
		prometheus.GaugeOpts{
			Name: "lucid_active_sessions",
			Help: "Number of currently active user sessions",
		},
	)

	// CacheHitsTotal tracks cache hits
	CacheHitsTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "lucid_cache_hits_total",
			Help: "Total number of cache hits",
		},
		[]string{"cache_type"},
	)

	// CacheMissesTotal tracks cache misses
	CacheMissesTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "lucid_cache_misses_total",
			Help: "Total number of cache misses",
		},
		[]string{"cache_type"},
	)

	// CalDAVRequestDuration tracks CalDAV request latency
	CalDAVRequestDuration = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Name: "lucid_caldav_request_duration_seconds",
			Help: "CalDAV request duration in seconds",
			Buckets: []float64{
				0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0,
			},
		},
		[]string{"operation", "status"},
	)

	// CalDAVRequestTotal tracks total CalDAV requests
	CalDAVRequestTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "lucid_caldav_requests_total",
			Help: "Total number of CalDAV requests",
		},
		[]string{"operation", "status"},
	)
)

// RecordHTTPRequest records metrics for an HTTP request
func RecordHTTPRequest(method, endpoint string, status int, duration time.Duration) {
	statusStr := http.StatusText(status)
	if statusStr == "" {
		statusStr = "unknown"
	}
	HTTPRequestDuration.WithLabelValues(method, endpoint, statusStr).Observe(duration.Seconds())
	HTTPRequestTotal.WithLabelValues(method, endpoint, statusStr).Inc()
}

// RecordCacheHit records a cache hit
func RecordCacheHit(cacheType string) {
	CacheHitsTotal.WithLabelValues(cacheType).Inc()
}

// RecordCacheMiss records a cache miss
func RecordCacheMiss(cacheType string) {
	CacheMissesTotal.WithLabelValues(cacheType).Inc()
}

// RecordCalDAVRequest records metrics for a CalDAV request
func RecordCalDAVRequest(operation, status string, duration time.Duration) {
	CalDAVRequestDuration.WithLabelValues(operation, status).Observe(duration.Seconds())
	CalDAVRequestTotal.WithLabelValues(operation, status).Inc()
}

// IncActiveSessions increments the active sessions gauge
func IncActiveSessions() {
	ActiveSessions.Inc()
}

// DecActiveSessions decrements the active sessions gauge
func DecActiveSessions() {
	ActiveSessions.Dec()
}
