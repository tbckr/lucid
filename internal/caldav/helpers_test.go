package caldav

import (
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/tbckr/lucid/internal/caldav/caldavtest"
	"github.com/tbckr/lucid/internal/domain"
)

// fakeClock is a manually advanced clock.
type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

// env bundles a mock server, a provider and a connected service.
type env struct {
	mock  *caldavtest.Server
	ts    *httptest.Server
	p     *Provider
	svc   domain.CalendarService
	acct  domain.Account
	clock *fakeClock
	cals  map[string]string // slug -> calendar ID
	paths map[string]string // slug -> calendar path
}

func newProvider(t *testing.T, client *http.Client) *Provider {
	t.Helper()
	p, err := NewProvider(Options{HTTPClient: client, Registerer: prometheus.NewRegistry(), Logger: slog.New(slog.DiscardHandler)})
	if err != nil {
		t.Fatalf("NewProvider: %v", err)
	}
	return p
}

// newEnv starts a mock with the standard test calendars and connects to it.
func newEnv(t *testing.T, opts caldavtest.Options) *env {
	t.Helper()
	mock := caldavtest.New(opts)
	e := &env{mock: mock, cals: map[string]string{}, paths: map[string]string{}}
	for _, c := range []caldavtest.Calendar{
		{Slug: "personal", Name: "Personal", Color: "#3B82F6FF"},
		{Slug: "work", Name: "Work", Description: "Job stuff", Components: []string{"VEVENT", "VTODO"}},
		{Slug: "tasks", Name: "Tasks", Color: "#F97316", Components: []string{"VTODO"}},
		{Slug: "holidays", Name: "Holidays", ReadOnly: true},
	} {
		e.paths[c.Slug] = mock.AddCalendar(c)
		e.cals[c.Slug] = encodeID(e.paths[c.Slug])
	}
	e.ts = httptest.NewServer(mock)
	t.Cleanup(e.ts.Close)
	e.p = newProvider(t, e.ts.Client())
	e.clock = &fakeClock{t: time.Date(2025, 3, 1, 12, 0, 0, 0, time.UTC)}
	e.p.now = e.clock.Now
	acct, err := e.p.Connect(t.Context(), domain.Credentials{
		ServerURL: e.ts.URL, Username: cmpOrStr(opts.Username, "user"), Password: cmpOrStr(opts.Password, "pass"),
	})
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	e.acct = acct
	e.svc = e.p.Service(acct)
	return e
}

func cmpOrStr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// put seeds an object and returns its ID.
func (e *env) put(t *testing.T, slug, name string, lines ...string) string {
	t.Helper()
	p, err := e.mock.PutObject(e.paths[slug], name, ics(lines...))
	if err != nil {
		t.Fatalf("PutObject: %v", err)
	}
	return encodeID(p)
}

// ics wraps component lines into a VCALENDAR.
func ics(lines ...string) string {
	all := append([]string{"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN"}, lines...)
	all = append(all, "END:VCALENDAR", "")
	return strings.Join(all, "\r\n")
}

func mustErr(t *testing.T, err, target error) {
	t.Helper()
	if !errors.Is(err, target) {
		t.Fatalf("error = %v; want %v", err, target)
	}
}

func mustNoErr(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func date(y int, m time.Month, d, h, mi int) time.Time {
	return time.Date(y, m, d, h, mi, 0, 0, time.UTC)
}

func ptr[T any](v T) *T { return &v }
