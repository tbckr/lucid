package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tbckr/lucid/internal/diag"
	"github.com/tbckr/lucid/internal/domain"
	"github.com/tbckr/lucid/internal/middleware"
	"github.com/tbckr/lucid/internal/session"
)

// canaryICS is an object whose every value carries the canary: none of it may
// get into a skeleton or a log line (NFR-36).
const canaryICS = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Example//Calendar//EN\r\n" +
	"BEGIN:VEVENT\r\nUID:zz-canary-uid\r\nDTSTAMP:20250301T000000Z\r\nDTSTART:20250302T100000Z\r\n" +
	"SUMMARY:zz-canary title\r\nDESCRIPTION:zz-canary notes\r\nATTENDEE:mailto:zz-canary@example.test\r\n" +
	"END:VEVENT\r\nEND:VCALENDAR\r\n"

func getReport(t *testing.T, h *harness, c *client) diag.Report {
	t.Helper()
	var rep diag.Report
	decode(t, h.do(t, c, req{method: http.MethodGet, path: "/api/v1/diagnostics"}), http.StatusOK, &rep)
	return rep
}

func TestDiagnosticsAnonymous(t *testing.T) {
	t.Parallel()
	h := newHarness(t, func(o *Options) { o.Version = "1.2.3" })
	c := h.anonymous(t)

	w := h.do(t, c, req{method: http.MethodGet, path: "/api/v1/diagnostics"})
	var rep diag.Report
	decode(t, w, http.StatusOK, &rep)

	if rep.Authenticated || rep.Format != 1 {
		t.Errorf("Authenticated, Format = %v, %d; want false, 1", rep.Authenticated, rep.Format)
	}
	if rep.Account != nil {
		t.Errorf("Account = %+v; want none for an anonymous session", rep.Account)
	}
	want := diag.LucidInfo{Version: "1.2.3", Mode: "server", OS: runtime.GOOS, Arch: runtime.GOARCH}
	if rep.Lucid != want {
		t.Errorf("Lucid = %+v; want %+v", rep.Lucid, want)
	}
	if time.Since(rep.CreatedAt).Abs() > time.Minute {
		t.Errorf("CreatedAt = %v; want about now", rep.CreatedAt)
	}
	// Empty lists are [], not null, and there is no account key.
	body := w.Body.String()
	for _, part := range []string{`"exchanges":[]`, `"problems":[]`, `"calendars":[]`} {
		if !strings.Contains(body, part) {
			t.Errorf("body %s lacks %s", body, part)
		}
	}
	if strings.Contains(body, `"account"`) {
		t.Errorf("body %s has an account", body)
	}
	if len(h.svc.calls) != 0 {
		t.Errorf("service calls = %v; the report makes no upstream call", h.svc.calls)
	}
}

func TestDiagnosticsNoSession(t *testing.T) {
	t.Parallel()
	h := newHarness(t, nil)
	for name, c := range map[string]*client{
		"no cookie":      nil,
		"unknown cookie": {cookie: strings.Repeat("A", 43)},
		"malformed":      {cookie: "x"},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			w := h.do(t, c, req{method: http.MethodGet, path: "/api/v1/diagnostics"})
			expectError(t, w, http.StatusUnauthorized, codeUnauthenticated)
			if got := w.Result().Header.Values("Set-Cookie"); len(got) != 0 {
				t.Errorf("Set-Cookie = %v; the report must not start a session", got)
			}
		})
	}
}

func TestDiagnosticsExpiredSession(t *testing.T) {
	t.Parallel()
	h := newHarness(t, nil)
	c := h.anonymous(t)
	h.clock.Advance(time.Hour) // beyond the anonymous lifetime

	expectError(t, h.do(t, c, req{method: http.MethodGet, path: "/api/v1/diagnostics"}), http.StatusUnauthorized, codeUnauthenticated)
}

func TestDiagnosticsAuthenticated(t *testing.T) {
	t.Parallel()
	h := newHarness(t, nil)
	h.prov.connect = func(creds domain.Credentials) (domain.Account, error) {
		return domain.Account{
			Username: creds.Username, Password: creds.Password, ServerURL: creds.ServerURL,
			EndpointURL:     "https://dav.example.com/remote.php/dav/",
			PrincipalURL:    "https://dav.example.com/remote.php/dav/principals/users/tim/",
			CalendarHomeURL: "https://dav.example.com/remote.php/dav/calendars/tim/",
		}, nil
	}
	c := h.login(t)

	rep := getReport(t, h, c)

	if !rep.Authenticated {
		t.Error("Authenticated = false; want true")
	}
	want := diag.AccountInfo{
		Endpoint:  "https://dav.example.com/remote.php/dav/",
		Principal: "/remote.php/dav/principals/users/{user}/",
		Home:      "/remote.php/dav/calendars/{user}/",
	}
	if rep.Account == nil || *rep.Account != want {
		t.Errorf("Account = %+v; want %+v", rep.Account, want)
	}
	if len(h.svc.calls) != 0 {
		t.Errorf("service calls = %v; the report makes no upstream call", h.svc.calls)
	}
}

func TestDiagnosticsLocalMode(t *testing.T) {
	t.Parallel()
	h := newHarness(t, func(o *Options) { o.Local = true })
	c := &client{}
	local := req{host: "localhost:3456", method: http.MethodGet, path: "/api/v1/session"}
	var sess sessionResponse
	decode(t, h.do(t, c, local), http.StatusOK, &sess)

	local.path = "/api/v1/diagnostics"
	var rep diag.Report
	decode(t, h.do(t, c, local), http.StatusOK, &rep)

	if rep.Lucid.Mode != "local" {
		t.Errorf("Mode = %q; want local", rep.Lucid.Mode)
	}
}

func TestDiagnosticsShowsTheTrace(t *testing.T) {
	t.Parallel()
	h := newHarness(t, nil)
	c := h.login(t)
	buf, err := h.store.Diagnostics(c.cookie)
	if err != nil {
		t.Fatal(err)
	}
	buf.AddExchange(diag.Exchange{At: h.clock.Now(), Method: "PROPFIND", Host: "dav.example.com", Path: "{home}/", Status: 207, Server: "Radicale"})
	buf.AddProblem(diag.Problem{Kind: diag.ProblemUnparsableObject, Path: "{home}/cal-1/obj-1.ics", ObjectID: "o1", Reason: "bad", Skeleton: diag.Skeleton{Text: "BEGIN:VCALENDAR"}})
	buf.NoteCalendar("{home}/cal-1/", func(n *diag.CalendarNote) { n.Events = true })

	rep := getReport(t, h, c)

	if len(rep.Exchanges) != 1 || rep.Exchanges[0].Method != "PROPFIND" || rep.Exchanges[0].Status != 207 {
		t.Errorf("Exchanges = %+v; want the PROPFIND", rep.Exchanges)
	}
	if len(rep.Problems) != 1 || rep.Problems[0].ObjectID != "o1" || rep.Problems[0].Skeleton.Text != "BEGIN:VCALENDAR" {
		t.Errorf("Problems = %+v; want the one problem, with its object ID", rep.Problems)
	}
	if len(rep.Calendars) != 1 || rep.Calendars[0].Path != "{home}/cal-1/" || !rep.Calendars[0].Events {
		t.Errorf("Calendars = %+v; want the note", rep.Calendars)
	}
	if rep.Server.Product != "Radicale" || rep.Server.Host != "dav.example.com" {
		t.Errorf("Server = %+v; want Radicale on dav.example.com", rep.Server)
	}
}

func TestAccountInfo(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		acct domain.Account
		want diag.AccountInfo
	}{
		{
			"user in the paths",
			domain.Account{
				Username: "Tim", EndpointURL: "https://dav.example.com/dav/",
				PrincipalURL: "https://dav.example.com/dav/principals/tim/", CalendarHomeURL: "https://dav.example.com/dav/tim/calendars/",
			},
			diag.AccountInfo{Endpoint: "https://dav.example.com/dav/", Principal: "/dav/principals/{user}/", Home: "/dav/{user}/calendars/"},
		},
		{
			"user in the endpoint, and no credentials, query or fragment",
			domain.Account{
				Username: "tim", EndpointURL: "https://tim:hunter2@dav.example.com:8443/dav/tim/?token=zz#frag",
				PrincipalURL: "/principals/tim/", CalendarHomeURL: "/calendars/tim/",
			},
			diag.AccountInfo{Endpoint: "https://dav.example.com:8443/dav/{user}/", Principal: "/principals/{user}/", Home: "/calendars/{user}/"},
		},
		{
			"local part of an address",
			domain.Account{
				Username: "tim@example.com", EndpointURL: "https://dav.example.com/",
				PrincipalURL: "https://dav.example.com/p/tim/", CalendarHomeURL: "https://dav.example.com/c/tim%40example.com/",
			},
			diag.AccountInfo{Endpoint: "https://dav.example.com/", Principal: "/p/{user}/", Home: "/c/{user}/"},
		},
		{
			"unknown parts stay empty",
			domain.Account{Username: "tim", EndpointURL: "https://dav.example.com/", PrincipalURL: "http://[::1", CalendarHomeURL: ""},
			diag.AccountInfo{Endpoint: "https://dav.example.com/"},
		},
		{"unusable endpoint", domain.Account{Username: "tim", EndpointURL: "http://[::1"}, diag.AccountInfo{}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := accountInfo(tt.acct); got != tt.want {
				t.Errorf("accountInfo = %+v; want %+v", got, tt.want)
			}
		})
	}
}

func TestDiagnosticsAccountFailure(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		err     error
		wantLog string
	}{
		{"session gone meanwhile", session.ErrNotFound, ""},
		{"session expired meanwhile", session.ErrExpired, middleware.EventSessionExpired},
		{"credentials unreadable", errors.New("cipher: message authentication failed"), "loading session account"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			h := newHarness(t, nil)
			c := h.login(t)
			h.srv.sessions = failingAccountStore{h.store, tt.err}

			w := h.do(t, c, req{method: http.MethodGet, path: "/api/v1/diagnostics"})

			// As for every other route that needs the account.
			expectError(t, w, http.StatusUnauthorized, codeUnauthenticated)
			if tt.wantLog != "" && !strings.Contains(h.logs.String(), tt.wantLog) {
				t.Errorf("log lacks %q:\n%s", tt.wantLog, h.logs)
			}
		})
	}
}

type failingAccountStore struct {
	SessionStore
	err error
}

func (s failingAccountStore) Account(string) (domain.Account, error) {
	return domain.Account{}, s.err
}

func TestDiagnosticsObjectSkeleton(t *testing.T) {
	t.Parallel()
	h := newHarness(t, nil)
	c := h.login(t)
	h.svc.objectData = []byte(canaryICS)

	w := h.do(t, c, req{method: http.MethodGet, path: "/api/v1/diagnostics/objects/obj-1"})

	var resp struct {
		ID       string        `json:"id"`
		Skeleton diag.Skeleton `json:"skeleton"`
	}
	decode(t, w, http.StatusOK, &resp)
	if resp.ID != "obj-1" || h.svc.gotID != "obj-1" {
		t.Errorf("id, asked for = %q, %q; want obj-1 both", resp.ID, h.svc.gotID)
	}
	if !strings.Contains(resp.Skeleton.Text, "BEGIN:VEVENT") || !strings.Contains(resp.Skeleton.Text, "SUMMARY") {
		t.Errorf("skeleton = %q; want the shape of the object", resp.Skeleton.Text)
	}
	if strings.Contains(strings.ToLower(w.Body.String()), "zz-canary") {
		t.Errorf("response shows the canary: %s", w.Body)
	}
	if strings.Contains(strings.ToLower(h.logs.String()), "zz-canary") {
		t.Errorf("log shows the canary:\n%s", h.logs)
	}
	if got := w.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q; want no-store", got)
	}
}

func TestDiagnosticsObjectContent(t *testing.T) {
	t.Parallel()
	h := newHarness(t, nil)
	c := h.login(t)
	h.svc.objectData = []byte(canaryICS)

	w := h.do(t, c, req{method: http.MethodGet, path: "/api/v1/diagnostics/objects/obj-1/content"})

	var resp struct {
		ID      string `json:"id"`
		Content string `json:"content"`
	}
	decode(t, w, http.StatusOK, &resp)
	if resp.ID != "obj-1" || h.svc.gotID != "obj-1" {
		t.Errorf("id, asked for = %q, %q; want obj-1 both", resp.ID, h.svc.gotID)
	}
	if resp.Content != canaryICS {
		t.Errorf("content = %q; want the object verbatim", resp.Content)
	}
	if strings.Contains(strings.ToLower(h.logs.String()), "zz-canary") {
		t.Errorf("log shows the canary:\n%s", h.logs)
	}
	if got := w.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q; want no-store", got)
	}
}

func TestDiagnosticsObjectRequiresLogin(t *testing.T) {
	t.Parallel()
	for _, anonymous := range []bool{true, false} {
		for _, path := range []string{"/api/v1/diagnostics/objects/obj-1", "/api/v1/diagnostics/objects/obj-1/content"} {
			t.Run(fmt.Sprintf("anonymous=%v%s", anonymous, path), func(t *testing.T) {
				t.Parallel()
				h := newHarness(t, nil)
				h.svc.objectData = []byte(canaryICS)
				var c *client // no cookie at all
				if anonymous {
					c = h.anonymous(t)
				}

				w := h.do(t, c, req{method: http.MethodGet, path: path})

				expectError(t, w, http.StatusUnauthorized, codeUnauthenticated)
				if strings.Contains(strings.ToLower(w.Body.String()), "zz-canary") {
					t.Errorf("response shows the canary: %s", w.Body)
				}
				if len(h.svc.calls) != 0 {
					t.Errorf("service calls = %v; nothing is fetched without a login", h.svc.calls)
				}
			})
		}
	}
}

func TestDiagnosticsObjectErrors(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		id     string
		err    error
		status int
		code   string
	}{
		{"foreign or bad ID", "obj-1", domain.ErrNotFound, http.StatusNotFound, codeNotFound},
		{"server unreachable", "obj-1", domain.ErrUpstream, http.StatusBadGateway, codeUpstreamError},
		{"ID too long", strings.Repeat("a", maxIDLen+1), nil, http.StatusBadRequest, codeInvalidInput},
	}
	for _, tt := range tests {
		for _, suffix := range []string{"", "/content"} {
			t.Run(tt.name+suffix, func(t *testing.T) {
				t.Parallel()
				h := newHarness(t, nil)
				c := h.login(t)
				h.svc.err = tt.err

				w := h.do(t, c, req{method: http.MethodGet, path: "/api/v1/diagnostics/objects/" + tt.id + suffix})

				expectError(t, w, tt.status, tt.code)
			})
		}
	}
}

func TestDiagnosticsObjectForcedLogout(t *testing.T) {
	t.Parallel()
	h := newHarness(t, nil)
	c := h.login(t)
	old := c.cookie
	h.svc.err = domain.ErrUnauthorized

	expectError(t, h.do(t, c, req{method: http.MethodGet, path: "/api/v1/diagnostics/objects/obj-1/content"}), http.StatusUnauthorized, codeUnauthenticated)

	if c.cookie == old || c.cookie == "" {
		t.Errorf("cookie = %q; want a new session", c.cookie)
	}
	if _, err := h.store.Get(old); !errors.Is(err, session.ErrNotFound) {
		t.Errorf("old session: err = %v; want ErrNotFound", err)
	}
}

func TestScopeAttached(t *testing.T) {
	t.Parallel()
	h := newHarness(t, nil)
	c := h.login(t)
	buf, err := h.store.Diagnostics(c.cookie)
	if err != nil {
		t.Fatal(err)
	}

	w := h.do(t, c, req{method: http.MethodGet, path: "/api/v1/calendars"})

	decode(t, w, http.StatusOK, nil)
	scope, ok := diag.ScopeFrom(h.svc.gotCtx)
	if !ok {
		t.Fatal("the service's context has no diagnostics scope")
	}
	if scope.Buffer != buf {
		t.Error("scope.Buffer is not the session's buffer")
	}
	if id := w.Header().Get(middleware.RequestIDHeader); id == "" || scope.RequestID != id {
		t.Errorf("scope.RequestID = %q; want the X-Request-Id %q", scope.RequestID, id)
	}
}

func TestScopeRecordsIntoTheSession(t *testing.T) {
	t.Parallel()
	h := newHarness(t, nil)
	c := h.login(t)
	h.svc.onList = func(ctx context.Context) {
		scope, _ := diag.ScopeFrom(ctx)
		scope.Buffer.AddExchange(diag.Exchange{RequestID: scope.RequestID, Method: "PROPFIND", Path: "{home}/", Status: 207})
	}

	w := h.do(t, c, req{method: http.MethodGet, path: "/api/v1/calendars"})
	rep := getReport(t, h, c)

	if len(rep.Exchanges) != 1 || rep.Exchanges[0].RequestID != w.Header().Get(middleware.RequestIDHeader) {
		t.Errorf("Exchanges = %+v; want the one of the request %s", rep.Exchanges, w.Header().Get(middleware.RequestIDHeader))
	}
}

func TestWithDiagnostics(t *testing.T) {
	t.Parallel()
	const own = "<own>" // stands for the cookie of the logged-in client
	tests := []struct {
		name   string
		path   string
		cookie string
		want   bool
	}{
		{"API request with a session", "/api/v1/calendars", own, true},
		{"API request without a cookie", "/api/v1/calendars", "", false},
		{"API request with an unknown session", "/api/v1/calendars", strings.Repeat("B", 43), false},
		{"API request with a malformed cookie", "/api/v1/calendars", "x", false},
		{"other than API", "/healthz", own, false},
		{"the SPA", "/calendar", own, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			h := newHarness(t, nil)
			c := h.login(t)
			var (
				got   diag.Scope
				found bool
			)
			next := http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
				got, found = diag.ScopeFrom(r.Context())
			})
			r := httptest.NewRequest(http.MethodGet, tt.path, http.NoBody)
			switch tt.cookie {
			case "":
			case own:
				r.AddCookie(&http.Cookie{Name: CookieName, Value: c.cookie})
			default:
				r.AddCookie(&http.Cookie{Name: CookieName, Value: tt.cookie})
			}

			h.srv.withDiagnostics(next).ServeHTTP(httptest.NewRecorder(), r)

			if found != tt.want {
				t.Fatalf("scope attached = %v; want %v", found, tt.want)
			}
			if found && got.Buffer == nil {
				t.Error("the scope has no buffer")
			}
		})
	}
}

// TestExpiredSessionLoggedOnce checks that the session lookup of the scope
// does not swallow the security event of an expired session: it logs it, and
// the handler behind it, which finds the session gone, does not log it twice.
func TestExpiredSessionLoggedOnce(t *testing.T) {
	t.Parallel()
	h := newHarness(t, nil)
	c := h.login(t)
	h.clock.Advance(3 * time.Hour) // beyond the idle timeout

	expectError(t, h.do(t, c, req{method: http.MethodGet, path: "/api/v1/calendars"}), http.StatusUnauthorized, codeUnauthenticated)

	if n := strings.Count(h.logs.String(), `"security_event":"`+middleware.EventSessionExpired+`"`); n != 1 {
		t.Errorf("%d session_expired events; want 1\n%s", n, h.logs)
	}
}

func TestFailDemotes(t *testing.T) {
	t.Parallel()
	h := newHarness(t, nil)
	c := h.login(t)
	old := c.cookie
	h.svc.onList = func(ctx context.Context) {
		scope, _ := diag.ScopeFrom(ctx)
		scope.Buffer.AddExchange(diag.Exchange{RequestID: scope.RequestID, Method: "PROPFIND", Path: "{home}/", Status: http.StatusForbidden})
		scope.Buffer.AddProblem(diag.Problem{
			RequestID: scope.RequestID, Kind: diag.ProblemUnparsableObject, Path: "{home}/cal-1/obj-1.ics",
			ObjectID: "secret-object-id", Reason: "bad", Skeleton: diag.Skeleton{Text: "BEGIN:VCALENDAR"},
		})
	}
	h.svc.err = domain.ErrUnauthorized

	w := h.do(t, c, req{method: http.MethodGet, path: "/api/v1/calendars"})

	expectError(t, w, http.StatusUnauthorized, codeUnauthenticated)
	cookies := w.Result().Cookies()
	if len(cookies) != 1 || cookies[0].Name != CookieName {
		t.Fatalf("cookies = %v; want the one session cookie", cookies)
	}
	ck := cookies[0]
	if ck.Value == "" || ck.Value == old || ck.MaxAge < 0 || !ck.HttpOnly || !ck.Secure || ck.SameSite != http.SameSiteStrictMode {
		t.Errorf("cookie = %+v; want a new session cookie set like any other", ck)
	}
	failedID := w.Header().Get(middleware.RequestIDHeader)

	// The old session is gone, the new one is anonymous and holds the trace.
	if _, err := h.store.Get(old); !errors.Is(err, session.ErrNotFound) {
		t.Errorf("old session: err = %v; want ErrNotFound", err)
	}
	var sess sessionResponse
	decode(t, h.do(t, c, req{method: http.MethodGet, path: "/api/v1/session"}), http.StatusOK, &sess)
	if sess.Authenticated || sess.CSRFToken == "" || sess.CSRFToken == c.csrf {
		t.Errorf("session = %+v; want an anonymous one with a new CSRF token", sess)
	}
	rep := getReport(t, h, c)
	if rep.Authenticated || rep.Account != nil {
		t.Errorf("report: Authenticated, Account = %v, %+v; want an anonymous report", rep.Authenticated, rep.Account)
	}
	if len(rep.Exchanges) != 1 || rep.Exchanges[0].Status != http.StatusForbidden || rep.Exchanges[0].RequestID != failedID {
		t.Errorf("Exchanges = %+v; want the failed one of request %s", rep.Exchanges, failedID)
	}
	if len(rep.Problems) != 1 || rep.Problems[0].RequestID != failedID || rep.Problems[0].ObjectID != "" || rep.Problems[0].Skeleton.Text != "BEGIN:VCALENDAR" {
		t.Errorf("Problems = %+v; want the problem kept, without its object ID", rep.Problems)
	}
	if strings.Contains(h.logs.String(), "secret-object-id") {
		t.Error("object ID in the log")
	}

	// Without a login there are no contents to show.
	h.svc.err = nil
	h.svc.objectData = []byte(canaryICS)
	expectError(t, h.do(t, c, req{method: http.MethodGet, path: "/api/v1/diagnostics/objects/obj-1/content"}), http.StatusUnauthorized, codeUnauthenticated)
	// The old cookie leads nowhere.
	expectError(t, h.do(t, &client{cookie: old}, req{method: http.MethodGet, path: "/api/v1/diagnostics"}), http.StatusUnauthorized, codeUnauthenticated)
}

// TestFailDemoteConcurrent checks the forced logout of requests that fail
// together: exactly one of them sets the new session cookie, and none clears
// it, as the answer of a loser would overwrite the cookie of the winner and
// lose the trace (FR-36).
func TestFailDemoteConcurrent(t *testing.T) {
	t.Parallel()
	const requests = 4
	h := newHarness(t, nil)
	c := h.login(t)
	old := c.cookie
	rv := newRendezvous(requests)
	h.svc.rendezvous = rv
	h.svc.err = domain.ErrUnauthorized
	h.svc.onList = func(ctx context.Context) {
		scope, _ := diag.ScopeFrom(ctx)
		scope.Buffer.AddExchange(diag.Exchange{RequestID: scope.RequestID, Method: "PROPFIND", Status: http.StatusForbidden})
	}

	resps := make([]*httptest.ResponseRecorder, requests)
	var wg sync.WaitGroup
	for i := range resps {
		wg.Add(1)
		go func() {
			defer wg.Done()
			resps[i] = h.do(t, &client{cookie: old, csrf: c.csrf}, req{method: http.MethodGet, path: "/api/v1/calendars"})
		}()
	}
	wg.Wait()

	if rv.timedOut.Load() {
		t.Fatal("the requests did not overlap")
	}
	var setCookies []string
	for _, w := range resps {
		expectError(t, w, http.StatusUnauthorized, codeUnauthenticated)
		setCookies = append(setCookies, w.Result().Header.Values("Set-Cookie")...)
	}
	if len(setCookies) != 1 {
		t.Fatalf("Set-Cookie headers = %q; want exactly one", setCookies)
	}
	var winner *http.Cookie
	for _, w := range resps {
		if cookies := w.Result().Cookies(); len(cookies) == 1 {
			winner = cookies[0]
		}
	}
	if winner == nil || winner.Name != CookieName || winner.Value == "" || winner.Value == old || winner.MaxAge < 0 {
		t.Fatalf("cookie = %+v; want a new session cookie, not a clearing one", winner)
	}

	// The winner's session keeps the trace of every request.
	rep := getReport(t, h, &client{cookie: winner.Value})
	if rep.Authenticated || len(rep.Exchanges) != requests {
		t.Errorf("report: Authenticated, %d exchanges = %v; want anonymous with %d", len(rep.Exchanges), rep.Authenticated, requests)
	}
}

// demoteStore is a session store whose Demote fails with err.
type demoteStore struct {
	SessionStore
	err error
}

func (s demoteStore) Demote(string) (session.Session, error) { return session.Session{}, s.err }

func TestFailDemoteFailure(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		err  error
		// clears is whether the response clears the cookie. Where Demote says
		// the session is already gone or no account, a concurrent forced logout
		// has set the new cookie, and the answer must not overwrite it.
		clears bool
	}{
		{"gone", session.ErrNotFound, false},
		{"expired", session.ErrExpired, false},
		{"anonymous", session.ErrNotAuthenticated, false},
		{"gone, wrapped", errors.Join(errors.New("x"), session.ErrNotFound), false},
		{"store full", session.ErrFull, true},
		{"unexpected", errors.New("boom"), true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			h := newHarness(t, nil)
			c := h.login(t)
			old := c.cookie
			h.srv.sessions = demoteStore{h.store, tt.err}
			h.svc.err = domain.ErrUnauthorized

			w := h.do(t, c, req{method: http.MethodGet, path: "/api/v1/calendars"})

			expectError(t, w, http.StatusUnauthorized, codeUnauthenticated)
			setCookies := w.Result().Header.Values("Set-Cookie")
			_, getErr := h.store.Get(old)
			if tt.clears {
				cookies := w.Result().Cookies()
				if len(cookies) != 1 || cookies[0].Name != CookieName || cookies[0].Value != "" || cookies[0].MaxAge >= 0 {
					t.Errorf("Set-Cookie = %q; want the cookie cleared", setCookies)
				}
				if !errors.Is(getErr, session.ErrNotFound) {
					t.Errorf("old session: err = %v; want it destroyed", getErr)
				}
				return
			}
			if len(setCookies) != 0 {
				t.Errorf("Set-Cookie = %q; want none", setCookies)
			}
			if getErr != nil {
				t.Errorf("old session: err = %v; the answer must leave the store alone", getErr)
			}
		})
	}
}

func TestForceLogoutWithoutCookie(t *testing.T) {
	t.Parallel()
	h := newHarness(t, nil)
	w := httptest.NewRecorder()

	h.srv.forceLogout(w, httptest.NewRequest(http.MethodGet, "/api/v1/calendars", http.NoBody))

	if got := w.Result().Header.Values("Set-Cookie"); len(got) != 0 {
		t.Errorf("Set-Cookie = %q; there is no session to end, so none to set or clear", got)
	}
}
