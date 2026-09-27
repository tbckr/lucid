package httpapi

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/tbckr/lucid/internal/domain"
	"github.com/tbckr/lucid/internal/middleware"
	"github.com/tbckr/lucid/internal/session"
)

func TestNewRequiresDeps(t *testing.T) {
	t.Parallel()
	if _, err := New(Options{}); err == nil {
		t.Error("New() without deps must fail")
	}
	store, _ := session.New(session.Options{Key: make([]byte, 32)})
	if _, err := New(Options{Provider: &fakeProvider{}, Sessions: store}); err != nil {
		t.Errorf("New() with default logger: %v", err)
	}
}

func TestSessionAnonymous(t *testing.T) {
	t.Parallel()
	h := newHarness(t, nil)
	c := &client{}
	w := h.do(t, c, req{method: http.MethodGet, path: "/api/v1/session"})
	var resp sessionResponse
	decode(t, w, http.StatusOK, &resp)
	if resp.Authenticated || resp.CSRFToken == "" || resp.Username != "" {
		t.Errorf("response = %+v", resp)
	}
	cookies := w.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("cookies = %v", cookies)
	}
	ck := cookies[0]
	if ck.Name != CookieName || !ck.HttpOnly || !ck.Secure || ck.SameSite != http.SameSiteStrictMode || ck.Path != "/" {
		t.Errorf("cookie attributes = %+v", ck)
	}
	if w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("Content-Security-Policy") == "" {
		t.Error("security headers missing on API response")
	}
	if !strings.Contains(w.Body.String(), `"authenticated":false`) || strings.Contains(w.Body.String(), "username") {
		t.Errorf("body = %s", w.Body)
	}

	// Same session on the next call, no new cookie.
	w = h.do(t, c, req{method: http.MethodGet, path: "/api/v1/session"})
	var again sessionResponse
	decode(t, w, http.StatusOK, &again)
	if again.CSRFToken != resp.CSRFToken || len(w.Result().Cookies()) != 0 {
		t.Error("existing session not reused")
	}

	// Unknown cookie: a fresh session is issued.
	stale := &client{cookie: "bogus"}
	w = h.do(t, stale, req{method: http.MethodGet, path: "/api/v1/session"})
	decode(t, w, http.StatusOK, nil)
	if stale.cookie == "bogus" {
		t.Error("no new cookie for unknown session")
	}
}

func TestCookieInsecure(t *testing.T) {
	t.Parallel()
	h := newHarness(t, func(o *Options) { o.CookieInsecure = true })
	w := h.do(t, &client{}, req{method: http.MethodGet, path: "/api/v1/session"})
	if ck := w.Result().Cookies()[0]; ck.Secure {
		t.Error("Secure set despite CookieInsecure")
	}
}

func TestSessionReportsVersion(t *testing.T) {
	t.Parallel()
	h := newHarness(t, func(o *Options) { o.Version = "1.2.3" })
	c := &client{}
	for _, rq := range []req{
		{method: http.MethodGet, path: "/api/v1/session"}, // anonymous: the login page shows it
		{method: http.MethodPost, path: "/api/v1/auth/login", body: loginBody},
		{method: http.MethodGet, path: "/api/v1/session"},
	} {
		w := h.do(t, c, rq)
		var resp sessionResponse
		decode(t, w, http.StatusOK, &resp)
		if resp.Version != "1.2.3" {
			t.Errorf("%s %s: version = %q, want 1.2.3", rq.method, rq.path, resp.Version)
		}
		c.csrf = resp.CSRFToken
	}
}

func TestSessionCreateFails(t *testing.T) {
	t.Parallel()
	h := newHarness(t, func(o *Options) {
		store, _ := session.New(session.Options{Key: make([]byte, 32), MaxSessions: 1})
		_, _ = store.Login("", domain.Account{})
		o.Sessions = store
	})
	w := h.do(t, &client{}, req{method: http.MethodGet, path: "/api/v1/session"})
	expectError(t, w, http.StatusInternalServerError, codeInternal)
}

func TestLoginSuccess(t *testing.T) {
	t.Parallel()
	h := newHarness(t, nil)
	c := h.anonymous(t)
	anonCookie, anonCSRF := c.cookie, c.csrf

	w := h.do(t, c, req{
		method: http.MethodPost, path: "/api/v1/auth/login",
		body: `{"serverUrl":"  https://dav.example.com  ","username":" tim ","password":"hunter2-secret"}`,
	})
	var resp sessionResponse
	decode(t, w, http.StatusOK, &resp)
	if !resp.Authenticated || resp.Username != "tim" || resp.ServerURL != "https://dav.example.com" {
		t.Errorf("response = %+v", resp)
	}
	if resp.CSRFToken == anonCSRF || c.cookie == anonCookie {
		t.Error("login must rotate session ID and CSRF token")
	}
	if h.prov.gotCreds.Username != "tim" || h.prov.gotCreds.Password != "hunter2-secret" {
		t.Errorf("provider got %+v", h.prov.gotCreds)
	}
	if _, err := h.store.Get(anonCookie); !errors.Is(err, session.ErrNotFound) {
		t.Errorf("anonymous session survived login: %v", err)
	}
	logs := h.logs.String()
	if !strings.Contains(logs, middleware.EventLoginSucceeded) || !strings.Contains(logs, `"username":"tim"`) {
		t.Errorf("login not logged: %s", logs)
	}
	if strings.Contains(logs, "hunter2") {
		t.Error("password leaked into logs")
	}

	// The session endpoint now reports the login.
	c.csrf = resp.CSRFToken
	w = h.do(t, c, req{method: http.MethodGet, path: "/api/v1/session"})
	var sess sessionResponse
	decode(t, w, http.StatusOK, &sess)
	if !sess.Authenticated || sess.CSRFToken != resp.CSRFToken {
		t.Errorf("session = %+v", sess)
	}
}

func TestLoginErrors(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name       string
		body       string
		connectErr error
		noCSRF     bool
		headers    map[string]string
		status     int
		code       string
		logged     bool
	}{
		{"bad credentials", loginBody, fmt.Errorf("wrap: %w", domain.ErrUnauthorized), false, nil, http.StatusUnauthorized, codeInvalidCredentials, true},
		{"discovery", loginBody, domain.ErrDiscovery, false, nil, http.StatusUnprocessableEntity, codeDiscoveryFailed, true},
		{"ssrf", loginBody, fmt.Errorf("dial: %w", domain.ErrForbiddenTarget), false, nil, http.StatusBadRequest, codeForbiddenTarget, true},
		{"upstream", loginBody, domain.ErrUpstream, false, nil, http.StatusBadGateway, codeUpstreamError, true},
		{"provider invalid input", loginBody, domain.ErrInvalidInput, false, nil, http.StatusBadRequest, codeInvalidInput, true},
		{"internal", loginBody, errors.New("boom"), false, nil, http.StatusInternalServerError, codeInternal, true},
		{"no csrf", loginBody, nil, true, nil, http.StatusForbidden, middleware.CodeCSRFInvalid, false},
		{"form content type", loginBody, nil, false, map[string]string{"Content-Type": "application/x-www-form-urlencoded"}, http.StatusBadRequest, codeInvalidInput, false},
		{"unknown field", `{"serverUrl":"a.com","username":"u","password":"p","admin":true}`, nil, false, nil, http.StatusBadRequest, codeInvalidInput, false},
		{"trailing data", loginBody + `{}`, nil, false, nil, http.StatusBadRequest, codeInvalidInput, false},
		{"not json", `nope`, nil, false, nil, http.StatusBadRequest, codeInvalidInput, false},
		{"too large", `{"serverUrl":"` + strings.Repeat("a", middleware.MaxBodyBytes) + `"}`, nil, false, nil, http.StatusRequestEntityTooLarge, codeInvalidInput, false},
		{"missing server", `{"username":"u","password":"p"}`, nil, false, nil, http.StatusBadRequest, codeInvalidInput, false},
		{"long server", `{"serverUrl":"` + strings.Repeat("a", 3000) + `","username":"u","password":"p"}`, nil, false, nil, http.StatusBadRequest, codeInvalidInput, false},
		{"space in server", `{"serverUrl":"a b.com","username":"u","password":"p"}`, nil, false, nil, http.StatusBadRequest, codeInvalidInput, false},
		{"missing user", `{"serverUrl":"a.com","password":"p"}`, nil, false, nil, http.StatusBadRequest, codeInvalidInput, false},
		{"long user", `{"serverUrl":"a.com","username":"` + strings.Repeat("u", 300) + `","password":"p"}`, nil, false, nil, http.StatusBadRequest, codeInvalidInput, false},
		{"control in user", `{"serverUrl":"a.com","username":"u\u0000x","password":"p"}`, nil, false, nil, http.StatusBadRequest, codeInvalidInput, false},
		{"missing password", `{"serverUrl":"a.com","username":"u"}`, nil, false, nil, http.StatusBadRequest, codeInvalidInput, false},
		{"long password", `{"serverUrl":"a.com","username":"u","password":"` + strings.Repeat("p", 5000) + `"}`, nil, false, nil, http.StatusBadRequest, codeInvalidInput, false},
		{"ftp scheme", `{"serverUrl":"ftp://a.com","username":"u","password":"p"}`, nil, false, nil, http.StatusBadRequest, codeInvalidInput, false},
		{"no host", `{"serverUrl":"https:///x","username":"u","password":"p"}`, nil, false, nil, http.StatusBadRequest, codeInvalidInput, false},
		{"userinfo", `{"serverUrl":"https://u:p@a.com/","username":"u","password":"p"}`, nil, false, nil, http.StatusBadRequest, codeInvalidInput, false},
		{"bare userinfo", `{"serverUrl":"u@a.com","username":"u","password":"p"}`, nil, false, nil, http.StatusBadRequest, codeInvalidInput, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			h := newHarness(t, nil)
			if tt.connectErr != nil {
				h.prov.connect = func(domain.Credentials) (domain.Account, error) { return domain.Account{}, tt.connectErr }
			}
			c := h.anonymous(t)
			w := h.do(t, c, req{method: http.MethodPost, path: "/api/v1/auth/login", body: tt.body, noCSRF: tt.noCSRF, headers: tt.headers})
			expectError(t, w, tt.status, tt.code)
			if logged := strings.Contains(h.logs.String(), middleware.EventLoginFailed); logged != tt.logged {
				t.Errorf("login_failed logged = %v, want %v", logged, tt.logged)
			}
			if strings.Contains(h.logs.String(), "hunter2") {
				t.Error("password leaked into logs")
			}
		})
	}
}

func TestValidateCredentialsAccepts(t *testing.T) {
	t.Parallel()
	for _, u := range []string{
		"example.com", "example.com:8443", "HTTPS://Example.com/remote.php/dav",
		"http://192.168.1.10:5232/", "https://dav.example.com/cal/tim@example.com/",
	} {
		if msg := validateCredentials(domain.Credentials{ServerURL: u, Username: "u", Password: "p"}); msg != "" {
			t.Errorf("validateCredentials(%q) = %q", u, msg)
		}
	}
}

func TestLoginRateLimit(t *testing.T) {
	t.Parallel()
	h := newHarness(t, func(o *Options) {
		o.LoginLimiter = middleware.NewLimiter(middleware.LimiterOptions{Name: "login", Rate: 10.0 / 60, Burst: 1})
	})
	c := h.anonymous(t)
	w := h.do(t, c, req{method: http.MethodPost, path: "/api/v1/auth/login", body: loginBody})
	var resp sessionResponse
	decode(t, w, http.StatusOK, &resp)
	c.csrf = resp.CSRFToken
	w = h.do(t, c, req{method: http.MethodPost, path: "/api/v1/auth/login", body: loginBody})
	expectError(t, w, http.StatusTooManyRequests, middleware.CodeRateLimited)
	if w.Header().Get("Retry-After") == "" {
		t.Error("Retry-After missing")
	}
}

func TestAPIRateLimit(t *testing.T) {
	t.Parallel()
	h := newHarness(t, func(o *Options) {
		o.APILimiter = middleware.NewLimiter(middleware.LimiterOptions{Name: "api", Rate: 1, Burst: 2})
	})
	for range 2 {
		decode(t, h.do(t, nil, req{method: http.MethodGet, path: "/api/v1/calendars"}), http.StatusUnauthorized, nil)
	}
	expectError(t, h.do(t, nil, req{method: http.MethodGet, path: "/api/v1/calendars"}), http.StatusTooManyRequests, middleware.CodeRateLimited)
	// Non-API paths are not limited.
	decode(t, h.do(t, nil, req{method: http.MethodGet, path: "/healthz"}), http.StatusOK, nil)
}

func TestLogout(t *testing.T) {
	t.Parallel()
	h := newHarness(t, nil)
	c := h.login(t)
	old := c.cookie
	w := h.do(t, c, req{method: http.MethodPost, path: "/api/v1/auth/logout"})
	decode(t, w, http.StatusNoContent, nil)
	ck := w.Result().Cookies()
	if len(ck) != 1 || ck[0].MaxAge >= 0 || ck[0].Value != "" {
		t.Errorf("cookie not cleared: %+v", ck)
	}
	if _, err := h.store.Get(old); err == nil {
		t.Error("session survived logout")
	}
	if !strings.Contains(h.logs.String(), middleware.EventLogout) {
		t.Error("logout not logged")
	}
	// Without a valid session the CSRF check fails.
	expectError(t, h.do(t, &client{}, req{method: http.MethodPost, path: "/api/v1/auth/logout"}), http.StatusForbidden, middleware.CodeCSRFInvalid)
}

func TestSessionExpiry(t *testing.T) {
	t.Parallel()
	h := newHarness(t, nil)
	c := h.login(t)
	h.clock.Advance(3 * time.Hour) // beyond the default idle timeout
	expectError(t, h.do(t, c, req{method: http.MethodGet, path: "/api/v1/calendars"}), http.StatusUnauthorized, codeUnauthenticated)
	if !strings.Contains(h.logs.String(), middleware.EventSessionExpired) {
		t.Error("session expiry not logged")
	}

	c = h.login(t)
	h.clock.Advance(3 * time.Hour)
	// A state-changing request with an expired session fails the CSRF check.
	w := h.do(t, c, req{method: http.MethodPost, path: "/api/v1/auth/logout"})
	expectError(t, w, http.StatusForbidden, middleware.CodeCSRFInvalid)
}

func TestUnknownAPI(t *testing.T) {
	t.Parallel()
	h := newHarness(t, nil)
	for _, rq := range []req{
		{method: http.MethodGet, path: "/api/v1/nope"},
		{method: http.MethodGet, path: "/api/"},
		{method: http.MethodPatch, path: "/api/v2/x"},
	} {
		c := h.anonymous(t)
		expectError(t, h.do(t, c, rq), http.StatusNotFound, codeNotFound)
	}
}

func TestHealthAndReadiness(t *testing.T) {
	t.Parallel()
	h := newHarness(t, nil)
	var st status
	decode(t, h.do(t, nil, req{method: http.MethodGet, path: "/healthz"}), http.StatusOK, &st)
	if st.Status != "ok" {
		t.Errorf("healthz = %+v", st)
	}
	decode(t, h.do(t, nil, req{method: http.MethodGet, path: "/readyz"}), http.StatusOK, nil)
	h.srv.SetReady(false)
	decode(t, h.do(t, nil, req{method: http.MethodGet, path: "/readyz"}), http.StatusServiceUnavailable, &st)
	decode(t, h.do(t, nil, req{method: http.MethodGet, path: "/healthz"}), http.StatusOK, nil)
}

func TestMetricsEndpoint(t *testing.T) {
	t.Parallel()
	h := newHarness(t, func(o *Options) {
		o.MetricsHandler = http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte("metrics"))
		})
	})
	w := h.do(t, nil, req{method: http.MethodGet, path: "/metrics"})
	if w.Code != http.StatusOK || w.Body.String() != "metrics" {
		t.Errorf("metrics: %d %q", w.Code, w.Body)
	}
	// Without a handler, /metrics falls through to the SPA.
	h = newHarness(t, nil)
	w = h.do(t, nil, req{method: http.MethodGet, path: "/metrics"})
	if !strings.Contains(w.Body.String(), "<html") {
		t.Errorf("metrics served without handler: %q", w.Body)
	}
}

func TestPanicRecovered(t *testing.T) {
	t.Parallel()
	h := newHarness(t, nil)
	c := h.login(t)
	h.svc.panicMsg = "kaboom"
	w := h.do(t, c, req{method: http.MethodGet, path: "/api/v1/calendars"})
	expectError(t, w, http.StatusInternalServerError, codeInternal)
	if w.Header().Get("X-Frame-Options") != "DENY" {
		t.Error("security headers missing on panic response")
	}
}
