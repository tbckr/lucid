package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"
)

type clock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *clock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

func newClock() *clock { return &clock{now: time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC)} }

func TestLimiterAllow(t *testing.T) {
	t.Parallel()
	clk := newClock()
	l := NewLimiter(LimiterOptions{Rate: 2, Burst: 3, Now: clk.Now})

	for i := range 3 {
		if ok, _ := l.Allow("a"); !ok {
			t.Fatalf("request %d within burst denied", i)
		}
	}
	ok, wait := l.Allow("a")
	if ok || wait != 500*time.Millisecond {
		t.Fatalf("Allow() = %v, %v; want false, 500ms", ok, wait)
	}
	if ok, _ := l.Allow("b"); !ok {
		t.Error("other key must have its own bucket")
	}
	clk.Advance(500 * time.Millisecond)
	if ok, _ := l.Allow("a"); !ok {
		t.Error("token not refilled")
	}
	clk.Advance(time.Hour) // refill is capped at burst
	for range 3 {
		if ok, _ := l.Allow("a"); !ok {
			t.Fatal("burst not restored")
		}
	}
	if ok, _ := l.Allow("a"); ok {
		t.Error("refill exceeded burst")
	}
}

func TestLimiterZeroRate(t *testing.T) {
	t.Parallel()
	l := NewLimiter(LimiterOptions{Burst: 0})
	if ok, _ := l.Allow("a"); !ok {
		t.Error("burst is at least 1")
	}
	if ok, wait := l.Allow("a"); ok || wait != time.Hour {
		t.Errorf("Allow() = %v, %v", ok, wait)
	}
}

func TestLimiterBoundedAndSweep(t *testing.T) {
	t.Parallel()
	clk := newClock()
	l := NewLimiter(LimiterOptions{Rate: 1, Burst: 2, MaxKeys: 10, Now: clk.Now})
	for i := range 100 {
		l.Allow(strconv.Itoa(i))
	}
	if n := l.Len(); n != 10 {
		t.Errorf("Len() = %d, want 10", n)
	}
	l.Allow("busy")
	l.Allow("busy")
	clk.Advance(time.Second) // others are full again, "busy" is at 1/2
	l.Sweep()
	if n := l.Len(); n != 1 {
		t.Errorf("Len() after sweep = %d, want 1", n)
	}
}

func TestLimiterRun(t *testing.T) {
	t.Parallel()
	synctest.Test(t, func(t *testing.T) {
		l := NewLimiter(LimiterOptions{Rate: 1, Burst: 1})
		l.Allow("a")
		ctx, cancel := context.WithCancel(t.Context())
		done := make(chan struct{})
		go func() {
			l.Run(ctx, time.Minute)
			close(done)
		}()
		time.Sleep(61 * time.Second)
		synctest.Wait()
		if l.Len() != 0 {
			t.Errorf("Len() = %d, want 0", l.Len())
		}
		cancel()
		<-done
	})
}

func TestLimiterConcurrent(t *testing.T) {
	t.Parallel()
	clk := newClock()
	l := NewLimiter(LimiterOptions{Rate: 1, Burst: 100, Now: clk.Now})
	var allowed atomic.Int64
	var wg sync.WaitGroup
	for range 20 {
		wg.Go(func() {
			for range 50 {
				if ok, _ := l.Allow("shared"); ok {
					allowed.Add(1)
				}
				l.Sweep()
			}
		})
	}
	wg.Wait()
	if got := allowed.Load(); got != 100 {
		t.Errorf("allowed = %d, want exactly burst (100)", got)
	}
}

func TestLimitKey(t *testing.T) {
	t.Parallel()
	tests := map[string]string{
		"192.0.2.1":            "192.0.2.1",
		"2001:db8:1:2:3:4:5:6": "2001:db8:1:2::/64",
		"2001:db8:1:2:ffff::1": "2001:db8:1:2::/64",
		"not-an-ip":            "not-an-ip",
	}
	for in, want := range tests {
		if got := limitKey(in); got != want {
			t.Errorf("limitKey(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestRateLimitMiddleware(t *testing.T) {
	t.Parallel()
	logger, buf := testLogger(t)
	sec, _ := NewSecurity(logger, nil)
	l := NewLimiter(LimiterOptions{Name: "api", Rate: 0.1, Burst: 1, Now: newClock().Now})
	h := Chain(okHandler, RequestContext(false), RateLimit(l, sec, IsAPI))

	do := func(path, remote string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, path, http.NoBody)
		req.RemoteAddr = remote
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		return w
	}
	if w := do("/api/v1/x", "192.0.2.1:1"); w.Code != http.StatusOK {
		t.Fatalf("first request: %d", w.Code)
	}
	w := do("/api/v1/x", "192.0.2.1:2")
	if w.Code != http.StatusTooManyRequests || w.Header().Get("Retry-After") != "10" {
		t.Fatalf("second request: %d, Retry-After %q", w.Code, w.Header().Get("Retry-After"))
	}
	if decodeError(t, w.Body).Code != CodeRateLimited {
		t.Error("wrong error code")
	}
	if !strings.Contains(buf.String(), EventRateLimited) || !strings.Contains(buf.String(), `"limiter":"api"`) {
		t.Errorf("rate limit not logged: %s", buf)
	}
	if w := do("/assets/app.js", "192.0.2.1:3"); w.Code != http.StatusOK {
		t.Errorf("non-matching request limited: %d", w.Code)
	}
	if w := do("/api/v1/x", "192.0.2.2:1"); w.Code != http.StatusOK {
		t.Errorf("other client limited: %d", w.Code)
	}

	// nil match limits everything.
	l2 := NewLimiter(LimiterOptions{Rate: 1000, Burst: 1, Now: newClock().Now})
	h2 := RateLimit(l2, nil, nil)(okHandler)
	h2.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/", http.NoBody))
	w = httptest.NewRecorder()
	h2.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/", http.NoBody))
	if w.Code != http.StatusTooManyRequests || w.Header().Get("Retry-After") != "1" {
		t.Errorf("status = %d Retry-After = %q (minimum 1s)", w.Code, w.Header().Get("Retry-After"))
	}
}
