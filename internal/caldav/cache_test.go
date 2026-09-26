package caldav

import (
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	dto "github.com/prometheus/client_model/go"

	"github.com/tbckr/lucid/internal/caldav/caldavtest"
	"github.com/tbckr/lucid/internal/domain"
)

func TestObjectCache(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		opts caldavtest.Options
		// wantRevalidateHit: after freshness expired without changes, the
		// cache is still used (CTag or sync-token unchanged).
		wantRevalidateHit bool
	}{
		{name: "ctag", wantRevalidateHit: true},
		{name: "sync-token fallback", opts: caldavtest.Options{DisableCTag: true}, wantRevalidateHit: true},
		{name: "no tags", opts: caldavtest.Options{DisableCTag: true, DisableSyncToken: true}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, tt.opts)
			e.put(t, "personal", "a.ics", "BEGIN:VEVENT", "UID:a", "DTSTAMP:20250101T000000Z",
				"DTSTART:20250305T100000Z", "DTEND:20250305T110000Z", "SUMMARY:A", "END:VEVENT")
			from, to := date(2025, 3, 1, 0, 0), date(2025, 4, 1, 0, 0)
			list := func() []domain.Event {
				t.Helper()
				evs, err := e.svc.ListEvents(t.Context(), e.cals["personal"], from, to)
				mustNoErr(t, err)
				return evs
			}
			counts := func() (int, int) { return e.mock.Count("PROPFIND"), e.mock.Count("REPORT") }
			e.mock.ResetCounts()

			// 1. Cold cache: PROPFIND (ctag) + REPORT.
			if n := len(list()); n != 1 {
				t.Fatalf("got %d events; want 1", n)
			}
			if pf, rep := counts(); pf != 1 || rep != 1 {
				t.Fatalf("cold: PROPFIND=%d REPORT=%d; want 1/1", pf, rep)
			}
			// 2. Fresh: served from memory without any request.
			list()
			if pf, rep := counts(); pf != 1 || rep != 1 {
				t.Fatalf("fresh: PROPFIND=%d REPORT=%d; want 1/1", pf, rep)
			}
			// 3. Stale but unchanged: revalidate with PROPFIND only.
			e.clock.Advance(time.Minute)
			list()
			wantRep := 1
			if !tt.wantRevalidateHit {
				wantRep = 2
			}
			if pf, rep := counts(); pf != 2 || rep != wantRep {
				t.Fatalf("revalidate: PROPFIND=%d REPORT=%d; want 2/%d", pf, rep, wantRep)
			}
			// 4. Changed by another client: REPORT again after freshness.
			e.put(t, "personal", "b.ics", "BEGIN:VEVENT", "UID:b", "DTSTAMP:20250101T000000Z",
				"DTSTART:20250306T100000Z", "SUMMARY:B", "END:VEVENT")
			if n := len(list()); n != 1 {
				t.Fatalf("still fresh: got %d events; want 1 (cached)", n)
			}
			e.clock.Advance(time.Minute)
			if n := len(list()); n != 2 {
				t.Fatalf("after change: got %d events; want 2", n)
			}
			if _, rep := counts(); rep != wantRep+1 {
				t.Fatalf("after change: REPORT=%d; want %d", rep, wantRep+1)
			}
			// 5. Own writes invalidate immediately.
			_, err := e.svc.CreateEvent(t.Context(), e.cals["personal"], domain.EventInput{
				Title: "C", Start: date(2025, 3, 7, 9, 0), End: date(2025, 3, 7, 10, 0),
			})
			mustNoErr(t, err)
			if n := len(list()); n != 3 {
				t.Fatalf("after create: got %d events; want 3", n)
			}

			hits := counterValue(t, e.p.metrics.hits)
			misses := counterValue(t, e.p.metrics.misses)
			if hits < 2 || misses < 3 {
				t.Fatalf("metrics hits=%v misses=%v", hits, misses)
			}
		})
	}
}

func TestObjectCacheErrors(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	e.mock.SetHook(func(w http.ResponseWriter, r *http.Request) bool {
		if r.Method == "REPORT" {
			w.WriteHeader(http.StatusInternalServerError)
			return true
		}
		return false
	})
	_, err := e.svc.ListEvents(t.Context(), e.cals["personal"], date(2025, 3, 1, 0, 0), date(2025, 4, 1, 0, 0))
	mustErr(t, err, domain.ErrUpstream)
	_, err = e.svc.ListTodos(t.Context(), encodeID(e.mock.HomePath()+"missing/"))
	mustErr(t, err, domain.ErrNotFound)
	if got := counterValue(t, e.p.metrics.errors); got != 2 {
		t.Fatalf("errors metric = %v; want 2", got)
	}
}

func TestObjectCacheConcurrent(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	e.put(t, "personal", "a.ics", "BEGIN:VEVENT", "UID:a", "DTSTAMP:20250101T000000Z",
		"DTSTART:20250305T100000Z", "SUMMARY:A", "RRULE:FREQ=DAILY", "END:VEVENT")
	var wg sync.WaitGroup
	for range 16 {
		wg.Go(func() {
			for range 20 {
				evs, err := e.svc.ListEvents(t.Context(), e.cals["personal"], date(2025, 3, 1, 0, 0), date(2025, 4, 1, 0, 0))
				if err != nil || len(evs) != 27 {
					t.Errorf("ListEvents = %d events, %v", len(evs), err)
					return
				}
			}
		})
	}
	wg.Wait()
}

func TestCacheKeyIsolation(t *testing.T) {
	t.Parallel()
	p := newProvider(t, http.DefaultClient)
	a := p.Service(domain.Account{Username: "alice", CalendarHomeURL: "https://dav.example/home/"}).(*service)
	b := p.Service(domain.Account{Username: "bob", CalendarHomeURL: "https://dav.example/home/"}).(*service)
	c := p.Service(domain.Account{Username: "alice", CalendarHomeURL: "https://other.example/home/"}).(*service)
	keys := map[string]bool{}
	for _, s := range []*service{a, b, c} {
		keys[s.cacheKey("/home/cal/", "VEVENT")] = true
	}
	if len(keys) != 3 {
		t.Fatalf("cache keys collide: %v", keys)
	}
}

func TestMetricsRegistration(t *testing.T) {
	t.Parallel()
	reg := prometheus.NewRegistry()
	p1, err := NewProvider(Options{HTTPClient: http.DefaultClient, Registerer: reg})
	mustNoErr(t, err)
	p2, err := NewProvider(Options{HTTPClient: http.DefaultClient, Registerer: reg})
	mustNoErr(t, err)
	p1.metrics.hits.Inc()
	p2.metrics.hits.Inc()
	if got := counterValue(t, p1.metrics.hits); got != 2 {
		t.Fatalf("shared counter = %v; want 2", got)
	}
	if _, err := NewProvider(Options{HTTPClient: http.DefaultClient}); err != nil {
		t.Fatalf("nil registerer: %v", err)
	}
	if _, err := NewProvider(Options{}); err == nil {
		t.Fatal("expected error without HTTP client")
	}
}

func counterValue(t *testing.T, c prometheus.Counter) float64 {
	t.Helper()
	var m dto.Metric
	if err := c.Write(&m); err != nil {
		t.Fatalf("reading counter: %v", err)
	}
	return m.GetCounter().GetValue()
}
