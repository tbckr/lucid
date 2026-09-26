// Package caldav implements domain.Provider and domain.CalendarService for
// CalDAV servers (RFC 4791).
//
// It uses a small WebDAV client on top of net/http and encoding/xml (so that
// conditional requests, redirects and response size limits are fully under
// control), github.com/emersion/go-ical for iCalendar parsing and
// github.com/teambition/rrule-go for recurrence expansion.
//
// Calendar objects are cached per calendar in an LRU (see internal/cache) and
// revalidated via the CalendarServer getctag property (falling back to the
// WebDAV sync-token).
package caldav

import (
	"cmp"
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"time"

	// Embed the IANA time zone database so that TZID handling and DST
	// transitions do not depend on the host or container having tzdata.
	_ "time/tzdata"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/tbckr/lucid/internal/cache"
	"github.com/tbckr/lucid/internal/domain"
)

// Defaults for Options.
const (
	DefaultCacheSize      = 256
	DefaultCacheFreshness = 10 * time.Second
)

// Options configures the Provider. Zero values select sensible defaults.
type Options struct {
	// HTTPClient is used for all outgoing requests. It must be SSRF-safe
	// (see internal/safehttp). Required.
	HTTPClient *http.Client
	// CacheSize is the maximum number of cached calendars (LRU). Default 256.
	CacheSize int
	// CacheFreshness is how long a cached calendar is served without
	// re-checking its CTag. Default 10s.
	CacheFreshness time.Duration
	// Registerer receives cache metrics. Optional.
	Registerer prometheus.Registerer
	// Logger is used for diagnostics. Default slog.Default().
	Logger *slog.Logger
	// Resolver performs DNS SRV lookups during discovery (RFC 6764).
	// Default net.DefaultResolver.
	Resolver SRVResolver
}

// SRVResolver looks up DNS SRV records. *net.Resolver implements it.
type SRVResolver interface {
	LookupSRV(ctx context.Context, service, proto, name string) (string, []*net.SRV, error)
}

// Provider implements domain.Provider. It owns the state shared by all
// accounts: HTTP client, object cache and metrics.
type Provider struct {
	opts    Options
	log     *slog.Logger
	cache   *cache.LRU[string, *calEntry]
	metrics metrics
	now     func() time.Time
}

var _ domain.Provider = (*Provider)(nil)

type metrics struct {
	hits, misses, errors prometheus.Counter
}

// NewProvider creates a Provider.
func NewProvider(opts Options) (*Provider, error) {
	if opts.HTTPClient == nil {
		return nil, errors.New("caldav: HTTPClient is required")
	}
	opts.CacheSize = cmp.Or(opts.CacheSize, DefaultCacheSize)
	opts.CacheFreshness = cmp.Or(opts.CacheFreshness, DefaultCacheFreshness)
	if opts.Resolver == nil {
		opts.Resolver = net.DefaultResolver
	}
	log := opts.Logger
	if log == nil {
		log = slog.Default()
	}
	return &Provider{
		opts:  opts,
		log:   log,
		cache: cache.New[string, *calEntry](opts.CacheSize),
		metrics: metrics{
			hits: registerCounter(opts.Registerer, prometheus.CounterOpts{
				Name: "lucid_caldav_cache_hits_total",
				Help: "Calendar object set requests served from the cache.",
			}),
			misses: registerCounter(opts.Registerer, prometheus.CounterOpts{
				Name: "lucid_caldav_cache_misses_total",
				Help: "Calendar object set requests that required a REPORT to the CalDAV server.",
			}),
			errors: registerCounter(opts.Registerer, prometheus.CounterOpts{
				Name: "lucid_caldav_cache_errors_total",
				Help: "Calendar object set requests that failed upstream.",
			}),
		},
		now: time.Now,
	}, nil
}

// registerCounter creates a counter and registers it. If an identical
// collector is already registered (several providers sharing a registry),
// the existing one is reused.
func registerCounter(reg prometheus.Registerer, opts prometheus.CounterOpts) prometheus.Counter {
	c := prometheus.NewCounter(opts)
	if reg == nil {
		return c
	}
	if err := reg.Register(c); err != nil {
		var are prometheus.AlreadyRegisteredError
		if errors.As(err, &are) {
			if existing, ok := are.ExistingCollector.(prometheus.Counter); ok {
				return existing
			}
		}
	}
	return c
}
