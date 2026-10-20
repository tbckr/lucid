package caldav

import (
	"bytes"
	"context"
	"crypto/hkdf"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"slices"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/tbckr/lucid/internal/caldav/caldavtest"
	"github.com/tbckr/lucid/internal/diag"
	"github.com/tbckr/lucid/internal/domain"
)

const (
	traceUser   = "zz-trace-user"
	tracePass   = "zz-trace-pass"
	traceServer = "TestDAV/1.0"
	traceDAV    = "1, calendar-access"
)

// traceEnv is a mock whose every response carries a Server and a DAV header,
// with the standard test calendars, and a provider that logs at debug into
// logs as JSON lines.
type traceEnv struct {
	mock *caldavtest.Server
	ts   *httptest.Server
	p    *Provider
	logs *bytes.Buffer
}

func newTraceEnv(t *testing.T, opts caldavtest.Options) *traceEnv {
	t.Helper()
	opts.Username, opts.Password = traceUser, tracePass
	e := &traceEnv{mock: caldavtest.New(opts), logs: &bytes.Buffer{}}
	e.hook(nil)
	for _, c := range []caldavtest.Calendar{
		{Slug: "personal", Name: "Personal"},
		{Slug: "work", Name: "Work", Components: []string{"VEVENT", "VTODO"}},
		{Slug: "tasks", Name: "Tasks", Components: []string{"VTODO"}},
		{Slug: "holidays", Name: "Holidays", ReadOnly: true},
	} {
		e.mock.AddCalendar(c)
	}
	e.ts = httptest.NewServer(e.mock)
	t.Cleanup(e.ts.Close)
	p, err := NewProvider(Options{
		HTTPClient: e.ts.Client(),
		Registerer: prometheus.NewRegistry(),
		Logger:     slog.New(slog.NewJSONHandler(e.logs, &slog.HandlerOptions{Level: slog.LevelDebug})),
	})
	if err != nil {
		t.Fatalf("NewProvider: %v", err)
	}
	e.p = p
	return e
}

// hook installs h behind the headers every response carries; nil serves the
// mock as it is.
func (e *traceEnv) hook(h func(http.ResponseWriter, *http.Request) bool) {
	e.mock.SetHook(func(w http.ResponseWriter, r *http.Request) bool {
		w.Header().Set("Server", traceServer)
		w.Header().Set("DAV", traceDAV)
		return h != nil && h(w, r)
	})
}

// connect discovers the account with ctx, which may carry a scope.
func (e *traceEnv) connect(ctx context.Context, t *testing.T) domain.Account {
	t.Helper()
	acct, err := e.p.Connect(ctx, domain.Credentials{ServerURL: e.ts.URL, Username: traceUser, Password: tracePass})
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	return acct
}

// calendarID returns the ID of the calendar called name.
func (e *traceEnv) calendarID(t *testing.T, svc domain.CalendarService, name string) string {
	t.Helper()
	cals, err := svc.ListCalendars(t.Context())
	if err != nil {
		t.Fatalf("ListCalendars: %v", err)
	}
	for _, c := range cals {
		if c.Name == name {
			return c.ID
		}
	}
	t.Fatalf("no calendar %q in %+v", name, cals)
	return ""
}

// names are the names the pseudonymiser knows for the test account.
func (e *traceEnv) names() diag.Names {
	return diag.Names{Username: traceUser, Principal: e.mock.PrincipalPath(), Home: e.mock.HomePath()}
}

func mustParseURL(t *testing.T, s string) *url.URL {
	t.Helper()
	u, err := url.Parse(s)
	if err != nil {
		t.Fatalf("url.Parse(%q): %v", s, err)
	}
	return u
}

func scopedCtx(ctx context.Context, buf *diag.Buffer, requestID string) context.Context {
	return diag.WithScope(ctx, diag.Scope{Buffer: buf, RequestID: requestID})
}

// logLines decodes the JSON log lines.
func logLines(t *testing.T, logs *bytes.Buffer) []map[string]any {
	t.Helper()
	var out []map[string]any
	for line := range strings.SplitSeq(strings.TrimSpace(logs.String()), "\n") {
		if line == "" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatalf("log line %q: %v", line, err)
		}
		out = append(out, m)
	}
	return out
}

func TestTraceRecordsExchanges(t *testing.T) {
	t.Parallel()
	e := newTraceEnv(t, caldavtest.Options{})
	svc := e.p.Service(e.connect(t.Context(), t))
	buf := diag.NewBuffer(diag.SessionLimits)

	if _, err := svc.ListCalendars(scopedCtx(t.Context(), buf, "req-1")); err != nil {
		t.Fatalf("ListCalendars: %v", err)
	}

	got := buf.Snapshot().Exchanges
	if len(got) != 1 {
		t.Fatalf("exchanges = %+v; want one", got)
	}
	ex := got[0]
	if ex.Method != "PROPFIND" || ex.Path != "{home}/" || ex.Status != http.StatusMultiStatus {
		t.Errorf("exchange = %+v; want PROPFIND {home}/ 207", ex)
	}
	if ex.RequestID != "req-1" {
		t.Errorf("RequestID = %q; want req-1", ex.RequestID)
	}
	if ex.Server != traceServer || ex.DAV != traceDAV {
		t.Errorf("Server, DAV = %q, %q; want %q, %q", ex.Server, ex.DAV, traceServer, traceDAV)
	}
	if want := strings.TrimPrefix(e.ts.URL, "http://"); ex.Host != want {
		t.Errorf("Host = %q; want %q", ex.Host, want)
	}
	if !strings.Contains(ex.ContentType, "xml") {
		t.Errorf("ContentType = %q; want XML", ex.ContentType)
	}
	if ex.Bytes <= 0 || ex.DurationMS < 0 || ex.At.IsZero() || ex.Error != "" {
		t.Errorf("Bytes, DurationMS, At, Error = %d, %d, %v, %q; want a body, a duration, a time, no error",
			ex.Bytes, ex.DurationMS, ex.At, ex.Error)
	}
}

func TestTraceKeepsNothingWithoutScope(t *testing.T) {
	t.Parallel()
	e := newTraceEnv(t, caldavtest.Options{})
	svc := e.p.Service(e.connect(t.Context(), t))
	// No scope at all, and a scope without a buffer: both must just work.
	for _, ctx := range []context.Context{
		t.Context(),
		diag.WithScope(t.Context(), diag.Scope{RequestID: "req-2"}),
	} {
		if _, err := svc.ListCalendars(ctx); err != nil {
			t.Fatalf("ListCalendars: %v", err)
		}
	}
}

func TestTraceLogsAtDebug(t *testing.T) {
	t.Parallel()
	e := newTraceEnv(t, caldavtest.Options{})
	ctx := t.Context()
	svc := e.p.Service(e.connect(ctx, t))
	id := e.calendarID(t, svc, "Personal")
	if _, err := svc.ListEvents(ctx, id, date(2025, 3, 1, 0, 0), date(2025, 3, 8, 0, 0)); err != nil {
		t.Fatalf("ListEvents: %v", err)
	}

	out := e.logs.String()
	for _, secret := range []string{traceUser, tracePass, "personal", "work", "tasks", "holidays"} {
		if strings.Contains(out, secret) {
			t.Errorf("log contains %q:\n%s", secret, out)
		}
	}
	var home map[string]any
	for _, m := range logLines(t, e.logs) {
		if m["msg"] == "caldav exchange" && m["path"] == "{home}/" && m["method"] == "PROPFIND" {
			home = m
			break
		}
	}
	if home == nil {
		t.Fatalf("no caldav exchange line for the calendar home in:\n%s", out)
	}
	if home["level"] != "DEBUG" || home["status"] != float64(http.StatusMultiStatus) ||
		home["server"] != traceServer || home["dav"] != traceDAV ||
		home["host"] != strings.TrimPrefix(e.ts.URL, "http://") {
		t.Errorf("exchange line = %v", home)
	}
	for _, key := range []string{"duration_ms", "bytes", "content_type", "error"} {
		if _, ok := home[key]; !ok {
			t.Errorf("exchange line has no %q: %v", key, home)
		}
	}
}

func TestTraceRedirectHops(t *testing.T) {
	t.Parallel()
	e := newTraceEnv(t, caldavtest.Options{})
	svc := e.p.Service(e.connect(t.Context(), t))
	var first atomic.Bool
	e.hook(func(w http.ResponseWriter, r *http.Request) bool {
		if r.Method == "PROPFIND" && r.URL.Path == e.mock.HomePath() && first.CompareAndSwap(false, true) {
			w.Header().Set("Location", r.URL.Path+"?moved=1")
			w.WriteHeader(http.StatusMovedPermanently)
			return true
		}
		return false
	})
	buf := diag.NewBuffer(diag.SessionLimits)

	if _, err := svc.ListCalendars(scopedCtx(t.Context(), buf, "req-1")); err != nil {
		t.Fatalf("ListCalendars: %v", err)
	}

	got := buf.Snapshot().Exchanges
	if len(got) != 2 {
		t.Fatalf("exchanges = %+v; want two hops", got)
	}
	if got[0].Status != http.StatusMovedPermanently || got[1].Status != http.StatusMultiStatus {
		t.Errorf("statuses = %d, %d; want 301, 207", got[0].Status, got[1].Status)
	}
	for _, ex := range got {
		if ex.Method != "PROPFIND" || ex.Path != "{home}/" || ex.Server != traceServer {
			t.Errorf("hop = %+v", ex)
		}
	}
}

func TestTraceRedirectLoop(t *testing.T) {
	t.Parallel()
	e := newTraceEnv(t, caldavtest.Options{})
	svc := e.p.Service(e.connect(t.Context(), t))
	e.hook(func(w http.ResponseWriter, r *http.Request) bool {
		if r.Method == "PROPFIND" && r.URL.Path == e.mock.HomePath() {
			w.Header().Set("Location", r.URL.Path)
			w.WriteHeader(http.StatusFound)
			return true
		}
		return false
	})
	buf := diag.NewBuffer(diag.SessionLimits)

	_, err := svc.ListCalendars(scopedCtx(t.Context(), buf, "req-1"))

	mustErr(t, err, domain.ErrUpstream)
	mustErr(t, err, errTooManyRedirects)
	if n := len(buf.Snapshot().Exchanges); n != maxRedirects+1 {
		t.Errorf("exchanges = %d; want one per hop, %d", n, maxRedirects+1)
	}
}

func TestTraceTransportFailure(t *testing.T) {
	t.Parallel()
	e := newTraceEnv(t, caldavtest.Options{})
	svc := e.p.Service(e.connect(t.Context(), t))
	e.ts.Close()
	buf := diag.NewBuffer(diag.SessionLimits)

	_, err := svc.ListCalendars(scopedCtx(t.Context(), buf, "req-1"))

	mustErr(t, err, domain.ErrUpstream)
	got := buf.Snapshot().Exchanges
	if len(got) != 1 {
		t.Fatalf("exchanges = %+v; want one", got)
	}
	if ex := got[0]; ex.Error != "connect" || ex.Status != 0 || ex.Path != "{home}/" || ex.Method != "PROPFIND" {
		t.Errorf("exchange = %+v; want a failed PROPFIND with Error connect", ex)
	}
	// The class is all that is kept: the error text carries the URL.
	for _, secret := range []string{traceUser, "calendars"} {
		if strings.Contains(e.logs.String(), secret) {
			t.Errorf("log contains %q:\n%s", secret, e.logs.String())
		}
	}
}

func TestTraceBodyTooLarge(t *testing.T) {
	t.Parallel()
	e := newTraceEnv(t, caldavtest.Options{})
	svc := e.p.Service(e.connect(t.Context(), t))
	e.hook(func(w http.ResponseWriter, r *http.Request) bool {
		if r.Method != "PROPFIND" || r.URL.Path != e.mock.HomePath() {
			return false
		}
		w.WriteHeader(http.StatusMultiStatus)
		chunk := bytes.Repeat([]byte(" "), 1<<20)
		for range maxBodySize>>20 + 1 {
			if _, err := w.Write(chunk); err != nil {
				break
			}
		}
		return true
	})
	buf := diag.NewBuffer(diag.SessionLimits)

	_, err := svc.ListCalendars(scopedCtx(t.Context(), buf, "req-1"))

	mustErr(t, err, domain.ErrUpstream)
	mustErr(t, err, errBodyTooLarge)
	got := buf.Snapshot().Exchanges
	if len(got) != 1 || got[0].Error != "body_too_large" || got[0].Status != http.StatusMultiStatus {
		t.Errorf("exchanges = %+v; want one 207 with Error body_too_large", got)
	}
}

func TestTraceBodyReadError(t *testing.T) {
	t.Parallel()
	e := newTraceEnv(t, caldavtest.Options{})
	svc := e.p.Service(e.connect(t.Context(), t))
	e.hook(func(w http.ResponseWriter, r *http.Request) bool {
		if r.Method != "PROPFIND" || r.URL.Path != e.mock.HomePath() {
			return false
		}
		// Promise more than is sent: the connection ends inside the body.
		w.Header().Set("Content-Length", "1000")
		w.WriteHeader(http.StatusMultiStatus)
		_, _ = w.Write([]byte("<partial"))
		return true
	})
	buf := diag.NewBuffer(diag.SessionLimits)

	_, err := svc.ListCalendars(scopedCtx(t.Context(), buf, "req-1"))

	mustErr(t, err, domain.ErrUpstream)
	got := buf.Snapshot().Exchanges
	if len(got) != 1 || got[0].Status != http.StatusMultiStatus || got[0].Error != "other" || got[0].Bytes != int64(len("<partial")) {
		t.Errorf("exchanges = %+v; want one 207 with Error other and the bytes that arrived", got)
	}
}

func TestTraceClipsLongHeaders(t *testing.T) {
	t.Parallel()
	e := newTraceEnv(t, caldavtest.Options{})
	svc := e.p.Service(e.connect(t.Context(), t))
	long := strings.Repeat("s", 10*diag.MaxHeaderValue)
	e.hook(func(w http.ResponseWriter, _ *http.Request) bool {
		w.Header().Set("Server", long)
		return false
	})
	e.logs.Reset() // the lines of Connect

	if _, err := svc.ListCalendars(t.Context()); err != nil {
		t.Fatalf("ListCalendars: %v", err)
	}

	lines := logLines(t, e.logs)
	if len(lines) != 1 {
		t.Fatalf("log lines = %v; want one", lines)
	}
	if got := lines[0]["server"]; got != strings.Repeat("s", diag.MaxHeaderValue) {
		t.Errorf("server = %.20q...; want %d bytes", got, diag.MaxHeaderValue)
	}
}

func TestServiceNames(t *testing.T) {
	t.Parallel()
	p := newProvider(t, http.DefaultClient)
	tests := []struct {
		name string
		acct domain.Account
		want diag.Names
	}{
		{
			"principal and home",
			domain.Account{Username: "u", PrincipalURL: "https://h.test/dav/u/", CalendarHomeURL: "https://h.test/dav/u/cal/"},
			diag.Names{Username: "u", Principal: "/dav/u/", Home: "/dav/u/cal/"},
		},
		{
			"home gets its slash and keeps its escapes",
			domain.Account{Username: "u", PrincipalURL: "https://h.test/my%20dav/", CalendarHomeURL: "https://h.test/my%20dav/cal"},
			diag.Names{Username: "u", Principal: "/my%20dav/", Home: "/my%20dav/cal/"},
		},
		{
			"no principal",
			domain.Account{Username: "u", CalendarHomeURL: "https://h.test/dav/u/cal/"},
			diag.Names{Username: "u", Home: "/dav/u/cal/"},
		},
		{
			"principal that is no URL",
			domain.Account{Username: "u", PrincipalURL: "https://h.test/%zz", CalendarHomeURL: "https://h.test/dav/u/cal/"},
			diag.Names{Username: "u", Home: "/dav/u/cal/"},
		},
		{
			"home that is no URL",
			domain.Account{Username: "u", PrincipalURL: "https://h.test/dav/u/", CalendarHomeURL: "https://h.test/%zz"},
			diag.Names{Username: "u", Principal: "/dav/u/"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			svc, ok := p.Service(tt.acct).(*service)
			if !ok {
				t.Fatal("Service is no *service")
			}
			if svc.t.names != tt.want {
				t.Errorf("names = %+v; want %+v", svc.t.names, tt.want)
			}
		})
	}
}

func TestDiscoveryTrace(t *testing.T) {
	t.Parallel()
	e := newTraceEnv(t, caldavtest.Options{Prefix: "/dav"})
	buf := diag.NewBuffer(diag.SessionLimits)

	e.connect(scopedCtx(t.Context(), buf, "req-1"), t)

	var paths []string
	for _, ex := range buf.Snapshot().Exchanges {
		if ex.RequestID != "req-1" || ex.Method != "PROPFIND" || ex.Server != traceServer {
			t.Errorf("exchange = %+v", ex)
		}
		paths = append(paths, ex.Path)
	}
	for _, want := range []string{"/.well-known/caldav", "{principal}/"} {
		if !slices.Contains(paths, want) {
			t.Errorf("paths = %q; want %q among them", paths, want)
		}
	}
	if out := e.logs.String(); strings.Contains(out, traceUser) || strings.Contains(out, tracePass) {
		t.Errorf("discovery log carries the username or the password:\n%s", out)
	}
}

// dnsFailResolver fails every SRV lookup with a DNS error that names the
// host, as a resolver does.
type dnsFailResolver struct{}

func (dnsFailResolver) LookupSRV(_ context.Context, service, _, name string) (string, []*net.SRV, error) {
	return "", nil, &net.DNSError{Err: "no such host", Name: "_" + service + "._tcp." + name}
}

func TestDiscoveryLogsNoErrorText(t *testing.T) {
	t.Parallel()
	var logs bytes.Buffer
	p, err := NewProvider(Options{
		HTTPClient: &http.Client{Transport: hostOverride{
			host: "dav.example.test",
			next: http.DefaultTransport,
			err:  &net.DNSError{Err: "no such host", Name: "dav.example.test"},
		}},
		Registerer: prometheus.NewRegistry(),
		Logger:     slog.New(slog.NewJSONHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug})),
		Resolver:   dnsFailResolver{},
	})
	if err != nil {
		t.Fatalf("NewProvider: %v", err)
	}

	_, err = p.Connect(t.Context(), domain.Credentials{
		ServerURL: "https://dav.example.test/" + traceUser + "/calendars/", Username: traceUser, Password: tracePass,
	})

	mustErr(t, err, domain.ErrUpstream)
	out := logs.String()
	for _, leak := range []string{traceUser, tracePass, "no such host", "_caldavs"} {
		if strings.Contains(out, leak) {
			t.Errorf("log contains %q:\n%s", leak, out)
		}
	}
	var candidates, lookups int
	for _, m := range logLines(t, &logs) {
		switch m["msg"] {
		case "caldav discovery candidate failed":
			candidates++
			if (m["url"] != "https://dav.example.test/{user}/calendars/" && m["url"] != "https://dav.example.test/.well-known/caldav") || m["error"] != "dns" {
				t.Errorf("candidate line = %v; want a pseudonymised url and error dns", m)
			}
		case "caldav SRV lookup failed":
			lookups++
			if m["error"] != "dns" || m["host"] != "dav.example.test" {
				t.Errorf("SRV line = %v; want error dns", m)
			}
		}
	}
	if candidates != 2 || lookups != 2 {
		t.Errorf("candidate lines, SRV lines = %d, %d; want 2, 2", candidates, lookups)
	}
}

func TestDiscoveryLogsStatusOfCandidate(t *testing.T) {
	t.Parallel()
	e := newTraceEnv(t, caldavtest.Options{Prefix: "/dav"})

	// The first candidate, the URL as given, is outside the mock's prefix.
	_, err := e.p.Connect(t.Context(), domain.Credentials{
		ServerURL: e.ts.URL + "/" + traceUser + "/", Username: traceUser, Password: tracePass,
	})

	mustNoErr(t, err)
	if strings.Contains(e.logs.String(), traceUser) {
		t.Errorf("log contains the username:\n%s", e.logs.String())
	}
	for _, m := range logLines(t, e.logs) {
		if m["msg"] == "caldav discovery candidate failed" {
			if m["status"] != float64(http.StatusNotFound) || m["url"] != e.ts.URL+"/{user}/" {
				t.Errorf("candidate line = %v; want status 404 and the url with {user}", m)
			}
			return
		}
	}
	t.Errorf("no candidate line in:\n%s", e.logs.String())
}

func TestStatusErrorPseudonymised(t *testing.T) {
	t.Parallel()
	e := newTraceEnv(t, caldavtest.Options{})
	svc := e.p.Service(e.connect(t.Context(), t))
	id := e.calendarID(t, svc, "Personal")
	e.hook(func(w http.ResponseWriter, r *http.Request) bool {
		if r.Method == "PROPFIND" && strings.HasSuffix(r.URL.Path, "/personal/") {
			w.WriteHeader(http.StatusInternalServerError)
			return true
		}
		return false
	})

	_, err := svc.ListEvents(t.Context(), id, date(2025, 3, 1, 0, 0), date(2025, 3, 8, 0, 0))

	mustErr(t, err, domain.ErrUpstream)
	if statusCode(err) != http.StatusInternalServerError {
		t.Errorf("statusCode = %d; want 500", statusCode(err))
	}
	msg := err.Error()
	if !strings.Contains(msg, "{home}/cal-") {
		t.Errorf("error %q does not name the calendar as {home}/cal-<hash>", msg)
	}
	for _, secret := range []string{"personal", traceUser} {
		if strings.Contains(msg, secret) {
			t.Errorf("error %q contains %q", msg, secret)
		}
	}
}

func TestStatusErrorKeepsOriginOnly(t *testing.T) {
	t.Parallel()
	p := newProvider(t, http.DefaultClient)
	tr := p.newTransport("user", "pass", diag.Names{})
	u := mustParseURL(t, "https://bob:secret@dav.example.test/some/path?token=abc#frag")

	got := tr.pseudoURL(u)

	if got != "https://dav.example.test/some/path" {
		t.Errorf("pseudoURL = %q", got)
	}
}

func TestErrorClass(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		err  error
		want string
	}{
		{"dns", &net.DNSError{Err: "no such host", Name: "x.test"}, "dns"},
		{"dns in a url error", fmt.Errorf("Get x: %w", &net.DNSError{Err: "no such host", Name: "x.test"}), "dns"},
		{"dial", &net.OpError{Op: "dial"}, "connect"},
		{"unknown authority", x509.UnknownAuthorityError{}, "tls"},
		{"certificate verification", &tls.CertificateVerificationError{}, "tls"},
		{"hostname mismatch", x509.HostnameError{Host: "x.test"}, "tls"},
		{"expired certificate", x509.CertificateInvalidError{Reason: x509.Expired}, "tls"},
		{"not a TLS server", tls.RecordHeaderError{Msg: "first record does not look like a TLS handshake"}, "tls"},
		{"context deadline", context.DeadlineExceeded, "timeout"},
		{"os deadline", os.ErrDeadlineExceeded, "timeout"},
		{"wrapped deadline", fmt.Errorf("%w: %w", domain.ErrUpstream, context.DeadlineExceeded), "timeout"},
		{"net timeout", &net.OpError{Op: "read", Err: timeoutError{}}, "timeout"},
		{"canceled", context.Canceled, "canceled"},
		{"forbidden target", domain.ErrForbiddenTarget, "ssrf_blocked"},
		{"forbidden target in a dial error", &net.OpError{Op: "dial", Err: fmt.Errorf("%w: 10.0.0.1 is private", domain.ErrForbiddenTarget)}, "ssrf_blocked"},
		{"body too large", fmt.Errorf("%w: %w", domain.ErrUpstream, errBodyTooLarge), "body_too_large"},
		{"too many redirects", fmt.Errorf("%w: %w", domain.ErrUpstream, errTooManyRedirects), "redirect"},
		{"other", errors.New("x"), "other"},
		{"a status is no transport failure", &statusError{Code: 500}, "other"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := errorClass(tt.err); got != tt.want {
				t.Errorf("errorClass(%v) = %q; want %q", tt.err, got, tt.want)
			}
		})
	}
}

// timeoutError is a net.Error that reports a timeout.
type timeoutError struct{}

func (timeoutError) Error() string   { return "timeout" }
func (timeoutError) Timeout() bool   { return true }
func (timeoutError) Temporary() bool { return false }

func TestCalendarNotes(t *testing.T) {
	t.Parallel()
	e := newTraceEnv(t, caldavtest.Options{})
	personal := e.mock.HomePath() + "personal/"
	if _, err := e.mock.PutObject(personal, "a.ics", ics(
		"BEGIN:VEVENT", "UID:a", "DTSTAMP:20250301T000000Z", "DTSTART:20250302T100000Z", "DTEND:20250302T110000Z",
		"SUMMARY:A", "END:VEVENT")); err != nil {
		t.Fatalf("PutObject: %v", err)
	}
	svc := e.p.Service(e.connect(t.Context(), t))
	buf := diag.NewBuffer(diag.SessionLimits)
	ctx := scopedCtx(t.Context(), buf, "req-1")

	cals, err := svc.ListCalendars(ctx)
	if err != nil {
		t.Fatalf("ListCalendars: %v", err)
	}
	notes := func() map[string]diag.CalendarNote {
		m := map[string]diag.CalendarNote{}
		for _, n := range buf.Snapshot().Calendars {
			m[n.Path] = n
		}
		return m
	}
	pseudo := func(slug string) string { return e.p.pseudo.Path(e.names(), e.mock.HomePath()+slug+"/") }

	// Listing notes what the properties say, for every calendar.
	got := notes()
	if len(got) != 4 {
		t.Fatalf("notes = %+v; want one per calendar", got)
	}
	for slug, want := range map[string]diag.CalendarNote{
		"personal": {Events: true},
		"work":     {Events: true, Todos: true},
		"tasks":    {Todos: true},
		"holidays": {Events: true, ReadOnly: true},
	} {
		want.Path = pseudo(slug)
		if got[want.Path] != want {
			t.Errorf("note of %s = %+v; want %+v", slug, got[want.Path], want)
		}
		if !strings.HasPrefix(want.Path, "{home}/cal-") {
			t.Errorf("note path %q is not a pseudonymised calendar path", want.Path)
		}
	}

	// Reading the events adds what the server offers and how many objects.
	var id string
	for _, c := range cals {
		if c.Name == "Personal" {
			id = c.ID
		}
	}
	if _, err := svc.ListEvents(ctx, id, date(2025, 3, 1, 0, 0), date(2025, 3, 8, 0, 0)); err != nil {
		t.Fatalf("ListEvents: %v", err)
	}
	want := diag.CalendarNote{Path: pseudo("personal"), Events: true, CTag: true, SyncToken: true, Objects: 1}
	if n := notes()[want.Path]; n != want {
		t.Errorf("note of personal = %+v; want %+v", n, want)
	}
	if n := notes()[pseudo("work")]; n.CTag || n.Objects != 0 {
		t.Errorf("note of work = %+v; want it untouched by the read of another calendar", n)
	}
}

func TestCalendarNotesKeepLargestObjectCount(t *testing.T) {
	t.Parallel()
	e := newTraceEnv(t, caldavtest.Options{})
	work := e.mock.HomePath() + "work/"
	for _, name := range []string{"a.ics", "b.ics"} {
		if _, err := e.mock.PutObject(work, name, ics(
			"BEGIN:VEVENT", "UID:"+name, "DTSTAMP:20250301T000000Z", "DTSTART:20250302T100000Z", "DTEND:20250302T110000Z",
			"SUMMARY:A", "END:VEVENT")); err != nil {
			t.Fatalf("PutObject: %v", err)
		}
	}
	svc := e.p.Service(e.connect(t.Context(), t))
	id := e.calendarID(t, svc, "Work")
	buf := diag.NewBuffer(diag.SessionLimits)
	ctx := scopedCtx(t.Context(), buf, "req-1")

	if _, err := svc.ListEvents(ctx, id, date(2025, 3, 1, 0, 0), date(2025, 3, 8, 0, 0)); err != nil {
		t.Fatalf("ListEvents: %v", err)
	}
	// The tasks of the calendar are queried apart, and there are none.
	if _, err := svc.ListTodos(ctx, id); err != nil {
		t.Fatalf("ListTodos: %v", err)
	}

	notes := buf.Snapshot().Calendars
	if len(notes) != 1 || notes[0].Objects != 2 {
		t.Errorf("notes = %+v; want one with 2 objects, not the 0 of the later query", notes)
	}
}

func TestCalendarNotesWithoutCTag(t *testing.T) {
	t.Parallel()
	e := newTraceEnv(t, caldavtest.Options{DisableCTag: true, DisableSyncToken: true})
	svc := e.p.Service(e.connect(t.Context(), t))
	id := e.calendarID(t, svc, "Personal")
	buf := diag.NewBuffer(diag.SessionLimits)

	if _, err := svc.ListEvents(scopedCtx(t.Context(), buf, "req-1"), id, date(2025, 3, 1, 0, 0), date(2025, 3, 8, 0, 0)); err != nil {
		t.Fatalf("ListEvents: %v", err)
	}

	for _, n := range buf.Snapshot().Calendars {
		if n.CTag || n.SyncToken {
			t.Errorf("note = %+v; want neither CTag nor SyncToken for a server that has none", n)
		}
	}
}

func TestPseudonymKey(t *testing.T) {
	t.Parallel()
	key := bytes.Repeat([]byte{7}, keySize)
	names := diag.Names{Username: "u", Home: "/dav/u/calendars/"}
	path := "/dav/u/calendars/private/"
	newP := func(key []byte) *Provider {
		t.Helper()
		p, err := NewProvider(Options{HTTPClient: http.DefaultClient, Registerer: prometheus.NewRegistry(), Key: key})
		if err != nil {
			t.Fatalf("NewProvider: %v", err)
		}
		return p
	}

	derived, err := hkdf.Key(sha256.New, key, nil, "lucid/v1 pseudonym", keySize)
	if err != nil {
		t.Fatalf("hkdf: %v", err)
	}
	want := diag.NewPseudonymizer(derived).Path(names, path)
	if got := newP(key).pseudo.Path(names, path); got != want {
		t.Errorf("pseudonym = %q; want %q, from the HKDF key with info %q", got, want, "lucid/v1 pseudonym")
	}
	if got := newP(bytes.Repeat([]byte{8}, keySize)).pseudo.Path(names, path); got == want {
		t.Errorf("another key gives the same pseudonym %q", got)
	}
	if got := newP(nil).pseudo.Path(names, path); got == want {
		t.Errorf("a random key gives the same pseudonym %q", got)
	}
}
