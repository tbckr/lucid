package middleware

import (
	"context"
	"log/slog"
	"math"
	"net/http"
	"net/netip"
	"strconv"
	"sync"
	"time"
)

// DefaultMaxKeys bounds the number of tracked clients per Limiter.
const DefaultMaxKeys = 100_000

// LimiterOptions configures a Limiter.
type LimiterOptions struct {
	// Name identifies the limiter in logs ("api", "login").
	Name string
	// Rate is the refill rate in tokens per second. Must be positive.
	Rate float64
	// Burst is the bucket size.
	Burst int
	// MaxKeys bounds memory: beyond it, an arbitrary bucket is evicted.
	// Default DefaultMaxKeys.
	MaxKeys int
	// Now is the clock. Default time.Now.
	Now func() time.Time
}

// Limiter is a token-bucket rate limiter keyed by client (NFR-18). It is
// safe for concurrent use.
type Limiter struct {
	name    string
	rate    float64
	burst   float64
	maxKeys int
	now     func() time.Time

	mu      sync.Mutex
	buckets map[string]*bucket
}

type bucket struct {
	tokens float64
	last   time.Time
}

// NewLimiter creates a Limiter.
func NewLimiter(opts LimiterOptions) *Limiter {
	if opts.MaxKeys <= 0 {
		opts.MaxKeys = DefaultMaxKeys
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	return &Limiter{
		name:    opts.Name,
		rate:    opts.Rate,
		burst:   float64(max(opts.Burst, 1)),
		maxKeys: opts.MaxKeys,
		now:     opts.Now,
		buckets: make(map[string]*bucket),
	}
}

// Allow takes a token for key. If none is available it returns false and
// the time until the next token.
func (l *Limiter) Allow(key string) (bool, time.Duration) {
	now := l.now()
	l.mu.Lock()
	defer l.mu.Unlock()

	b, ok := l.buckets[key]
	if !ok {
		if len(l.buckets) >= l.maxKeys {
			// Bound memory. Evicting an arbitrary bucket at worst gives that
			// client a fresh burst; the janitor normally keeps the map small.
			for k := range l.buckets {
				delete(l.buckets, k)
				break
			}
		}
		b = &bucket{tokens: l.burst, last: now}
		l.buckets[key] = b
	}
	if elapsed := now.Sub(b.last).Seconds(); elapsed > 0 {
		b.tokens = math.Min(l.burst, b.tokens+elapsed*l.rate)
	}
	b.last = now
	if b.tokens >= 1 {
		b.tokens--
		return true, 0
	}
	if l.rate <= 0 {
		return false, time.Hour
	}
	return false, time.Duration((1 - b.tokens) / l.rate * float64(time.Second))
}

// Sweep removes buckets that have refilled completely; they are
// indistinguishable from new ones, so this loses no state.
func (l *Limiter) Sweep() {
	now := l.now()
	l.mu.Lock()
	defer l.mu.Unlock()
	for k, b := range l.buckets {
		if b.tokens+now.Sub(b.last).Seconds()*l.rate >= l.burst {
			delete(l.buckets, k)
		}
	}
}

// Len returns the number of tracked clients.
func (l *Limiter) Len() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.buckets)
}

// Run calls Sweep every interval until ctx is canceled.
func (l *Limiter) Run(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			l.Sweep()
		}
	}
}

// RateLimit rejects requests with 429 once the client's bucket is empty.
// Only requests for which match returns true are limited (nil: all).
func RateLimit(l *Limiter, sec *Security, match func(*http.Request) bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if match != nil && !match(r) {
				next.ServeHTTP(w, r)
				return
			}
			ok, wait := l.Allow(limitKey(ClientIP(r.Context())))
			if ok {
				next.ServeHTTP(w, r)
				return
			}
			secs := max(int(math.Ceil(wait.Seconds())), 1)
			sec.Log(r, EventRateLimited, slog.String("limiter", l.name))
			w.Header().Set("Retry-After", strconv.Itoa(secs))
			WriteError(w, http.StatusTooManyRequests, CodeRateLimited, "too many requests, retry later")
		})
	}
}

// limitKey groups IPv6 clients by /64: a single host usually controls a
// whole /64 and could otherwise rotate addresses to evade the limit.
func limitKey(ip string) string {
	addr, err := netip.ParseAddr(ip)
	if err != nil || addr.Is4() {
		return ip
	}
	p, _ := addr.Prefix(64) // cannot fail for IPv6
	return p.String()
}
