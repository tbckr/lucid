package middleware

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
)

func testLogger(t *testing.T) (*slog.Logger, *syncBuffer) {
	t.Helper()
	buf := &syncBuffer{}
	return slog.New(slog.NewJSONHandler(buf, &slog.HandlerOptions{Level: slog.LevelDebug})), buf
}

type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// lines decodes the JSON log lines.
func (b *syncBuffer) lines(t *testing.T) []map[string]any {
	t.Helper()
	var out []map[string]any
	for line := range strings.SplitSeq(strings.TrimSpace(b.String()), "\n") {
		if line == "" {
			continue
		}
		m := map[string]any{}
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatalf("invalid log line %q: %v", line, err)
		}
		out = append(out, m)
	}
	return out
}

func decodeError(t *testing.T, body io.Reader) ErrorDetail {
	t.Helper()
	var e ErrorBody
	if err := json.NewDecoder(body).Decode(&e); err != nil {
		t.Fatalf("decoding error body: %v", err)
	}
	return e.Error
}

func metricValue(t *testing.T, reg *prometheus.Registry, name string, labels map[string]string) float64 {
	t.Helper()
	mfs, err := reg.Gather()
	if err != nil {
		t.Fatal(err)
	}
	for _, mf := range mfs {
		if mf.GetName() != name {
			continue
		}
	next:
		for _, m := range mf.GetMetric() {
			for _, lp := range m.GetLabel() {
				if want, ok := labels[lp.GetName()]; ok && want != lp.GetValue() {
					continue next
				}
			}
			switch {
			case m.GetCounter() != nil:
				return m.GetCounter().GetValue()
			case m.GetHistogram() != nil:
				return float64(m.GetHistogram().GetSampleCount())
			}
		}
	}
	return 0
}

var okHandler = http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
	_, _ = io.WriteString(w, "ok")
})

func TestChainOrder(t *testing.T) {
	t.Parallel()
	var order []string
	mw := func(name string) func(http.Handler) http.Handler {
		return func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				order = append(order, name)
				next.ServeHTTP(w, r)
			})
		}
	}
	h := Chain(okHandler, mw("a"), mw("b"), mw("c"))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/", http.NoBody))
	if strings.Join(order, "") != "abc" {
		t.Errorf("order = %v", order)
	}
}

func TestWriteError(t *testing.T) {
	t.Parallel()
	w := httptest.NewRecorder()
	WriteError(w, http.StatusConflict, "conflict", "reload")
	if w.Code != http.StatusConflict || !strings.HasPrefix(w.Header().Get("Content-Type"), "application/json") {
		t.Fatalf("code = %d, ct = %q", w.Code, w.Header().Get("Content-Type"))
	}
	if got := decodeError(t, w.Body); got.Code != "conflict" || got.Message != "reload" {
		t.Errorf("body = %+v", got)
	}
}

func TestRequestContext(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		trust   bool
		remote  string
		headers map[string][]string
		wantIP  string
		wantID  string // "" = generated
	}{
		{"remote v4", false, "192.0.2.1:1234", nil, "192.0.2.1", ""},
		{"remote v6", false, "[2001:db8::1]:1234", nil, "2001:db8::1", ""},
		{"remote mapped", false, "[::ffff:192.0.2.1]:1234", nil, "192.0.2.1", ""},
		{"remote no port", false, "192.0.2.1", nil, "192.0.2.1", ""},
		{"remote garbage", false, "nonsense:1", nil, "nonsense", ""},
		{"xff ignored", false, "192.0.2.1:1", map[string][]string{"X-Forwarded-For": {"203.0.113.5"}, RequestIDHeader: {"abc"}}, "192.0.2.1", ""},
		{"xff trusted", true, "10.0.0.1:1", map[string][]string{"X-Forwarded-For": {"1.2.3.4, 203.0.113.5"}}, "203.0.113.5", ""},
		{"xff multiple headers", true, "10.0.0.1:1", map[string][]string{"X-Forwarded-For": {"1.2.3.4", "198.51.100.1"}}, "198.51.100.1", ""},
		{"xff invalid", true, "10.0.0.1:1", map[string][]string{"X-Forwarded-For": {"garbage"}}, "10.0.0.1", ""},
		{"request id trusted", true, "10.0.0.1:1", map[string][]string{RequestIDHeader: {"abc-123"}}, "10.0.0.1", "abc-123"},
		{"request id injection", true, "10.0.0.1:1", map[string][]string{RequestIDHeader: {"a\nb"}}, "10.0.0.1", ""},
		{"request id too long", true, "10.0.0.1:1", map[string][]string{RequestIDHeader: {strings.Repeat("a", 65)}}, "10.0.0.1", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			var gotIP, gotID string
			h := RequestContext(tt.trust)(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
				gotIP, gotID = ClientIP(r.Context()), RequestID(r.Context())
			}))
			req := httptest.NewRequest(http.MethodGet, "/", http.NoBody)
			req.RemoteAddr = tt.remote
			for k, vs := range tt.headers {
				for _, v := range vs {
					req.Header.Add(k, v)
				}
			}
			w := httptest.NewRecorder()
			h.ServeHTTP(w, req)
			if gotIP != tt.wantIP {
				t.Errorf("ClientIP = %q, want %q", gotIP, tt.wantIP)
			}
			if tt.wantID != "" && gotID != tt.wantID {
				t.Errorf("RequestID = %q, want %q", gotID, tt.wantID)
			}
			if tt.wantID == "" && len(gotID) != 24 {
				t.Errorf("generated RequestID = %q", gotID)
			}
			if w.Header().Get(RequestIDHeader) != gotID {
				t.Errorf("response header = %q, want %q", w.Header().Get(RequestIDHeader), gotID)
			}
		})
	}
}

func TestObserve(t *testing.T) {
	t.Parallel()
	reg := prometheus.NewRegistry()
	metrics, err := NewMetrics(reg)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := NewMetrics(reg); err == nil {
		t.Error("duplicate registration must fail")
	}
	logger, buf := testLogger(t)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /items/{id}", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTeapot)
		_, _ = io.WriteString(w, "tea")
	})
	mux.HandleFunc("GET /healthz", okHandler)
	h := Chain(mux, RequestContext(false), Observe(logger, metrics))

	for _, req := range []*http.Request{
		httptest.NewRequest(http.MethodGet, "/items/1", http.NoBody),
		httptest.NewRequest(http.MethodGet, "/items/2", http.NoBody),
		httptest.NewRequest(http.MethodGet, "/healthz", http.NoBody),
		httptest.NewRequest("BREW", "/nothing", http.NoBody),
	} {
		h.ServeHTTP(httptest.NewRecorder(), req)
	}

	if v := metricValue(t, reg, "lucid_http_requests_total", map[string]string{"method": "GET", "route": "GET /items/{id}", "code": "418"}); v != 2 {
		t.Errorf("requests{items} = %v, want 2", v)
	}
	if v := metricValue(t, reg, "lucid_http_requests_total", map[string]string{"method": "OTHER", "route": routeUnmatched}); v != 1 {
		t.Errorf("requests{unmatched} = %v, want 1", v)
	}
	if v := metricValue(t, reg, "lucid_http_request_duration_seconds", map[string]string{"route": "GET /items/{id}"}); v != 2 {
		t.Errorf("duration samples = %v, want 2", v)
	}

	lines := buf.lines(t)
	if len(lines) != 4 {
		t.Fatalf("got %d log lines, want 4", len(lines))
	}
	first := lines[0]
	if first["status"] != float64(418) || first["bytes"] != float64(3) || first["route"] != "GET /items/{id}" ||
		first["path"] != "/items/1" || first["request_id"] == "" || first["client_ip"] != "192.0.2.1" {
		t.Errorf("access log = %v", first)
	}
	if lines[2]["level"] != "DEBUG" {
		t.Errorf("healthz log level = %v, want DEBUG", lines[2]["level"])
	}

	// nil metrics are allowed.
	Observe(logger, nil)(okHandler).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/", http.NoBody))
}

func TestRecorderUnwrap(t *testing.T) {
	t.Parallel()
	w := httptest.NewRecorder()
	rec := &recorder{ResponseWriter: w}
	if rec.Unwrap() != w {
		t.Error("Unwrap mismatch")
	}
	rec.WriteHeader(http.StatusAccepted)
	rec.WriteHeader(http.StatusOK) // ignored by recorder
	if rec.status != http.StatusAccepted {
		t.Errorf("status = %d", rec.status)
	}
}

func TestRecover(t *testing.T) {
	t.Parallel()
	logger, buf := testLogger(t)

	h := Recover(logger)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic("boom")
	}))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/x", http.NoBody))
	if w.Code != http.StatusInternalServerError || decodeError(t, w.Body).Code != CodeInternal {
		t.Errorf("code = %d body = %s", w.Code, w.Body)
	}
	if !strings.Contains(buf.String(), "boom") || !strings.Contains(buf.String(), "stack") {
		t.Errorf("panic not logged: %s", buf)
	}

	// Headers already sent: nothing more is written.
	h = Recover(logger)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "partial")
		panic("late")
	}))
	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/x", http.NoBody))
	if w.Body.String() != "partial" {
		t.Errorf("body = %q", w.Body)
	}

	// No panic: pass through.
	w = httptest.NewRecorder()
	Recover(logger)(okHandler).ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/", http.NoBody))
	if w.Body.String() != "ok" {
		t.Errorf("body = %q", w.Body)
	}

	// ErrAbortHandler must propagate.
	defer func() {
		v := recover()
		if err, ok := v.(error); !ok || !errors.Is(err, http.ErrAbortHandler) {
			t.Errorf("recovered %v, want ErrAbortHandler", v)
		}
	}()
	Recover(logger)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic(http.ErrAbortHandler)
	})).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/", http.NoBody))
}

func TestSecurityHeaders(t *testing.T) {
	t.Parallel()
	for _, path := range []string{"/", "/api/v1/session"} {
		w := httptest.NewRecorder()
		SecurityHeaders(okHandler).ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, http.NoBody))
		h := w.Header()
		for name, want := range map[string]string{
			"Content-Security-Policy":    contentSecurityPolicy,
			"X-Frame-Options":            "DENY",
			"X-Content-Type-Options":     "nosniff",
			"Referrer-Policy":            "no-referrer",
			"Cross-Origin-Opener-Policy": "same-origin",
		} {
			if h.Get(name) != want {
				t.Errorf("%s: %s = %q, want %q", path, name, h.Get(name), want)
			}
		}
		if !strings.Contains(h.Get("Strict-Transport-Security"), "max-age=") || h.Get("Permissions-Policy") == "" {
			t.Errorf("%s: HSTS/Permissions-Policy missing", path)
		}
		if isAPI := strings.HasPrefix(path, "/api/"); isAPI != (h.Get("Cache-Control") == "no-store") {
			t.Errorf("%s: Cache-Control = %q", path, h.Get("Cache-Control"))
		}
	}
	if !strings.Contains(contentSecurityPolicy, "frame-ancestors 'none'") || !strings.Contains(contentSecurityPolicy, "script-src 'self';") {
		t.Error("CSP too weak")
	}
}

func TestBodyLimit(t *testing.T) {
	t.Parallel()
	var readErr error
	h := BodyLimit(4)(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		_, readErr = io.ReadAll(r.Body)
	}))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/", strings.NewReader("12345")))
	var mbe *http.MaxBytesError
	if !errors.As(readErr, &mbe) {
		t.Errorf("error = %v, want MaxBytesError", readErr)
	}
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/", strings.NewReader("1234")))
	if readErr != nil {
		t.Errorf("error = %v", readErr)
	}
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/", http.NoBody))
	if readErr != nil {
		t.Errorf("error = %v", readErr)
	}
}

func TestSecurityLog(t *testing.T) {
	t.Parallel()
	var nilSec *Security
	nilSec.Log(httptest.NewRequest(http.MethodGet, "/", http.NoBody), EventLoginFailed) // no panic

	reg := prometheus.NewRegistry()
	logger, buf := testLogger(t)
	sec, err := NewSecurity(logger, reg)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := NewSecurity(logger, reg); err == nil {
		t.Error("duplicate registration must fail")
	}
	if _, err := NewSecurity(logger, nil); err != nil {
		t.Error(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", http.NoBody)
	RequestContext(false)(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		sec.Log(r, EventLoginFailed, slog.String("username", "tim"))
		sec.Log(r, EventLoginSucceeded, slog.String("username", "tim"))
	})).ServeHTTP(httptest.NewRecorder(), req)

	lines := buf.lines(t)
	if len(lines) != 2 {
		t.Fatalf("lines = %v", lines)
	}
	if lines[0]["level"] != "WARN" || lines[0]["security_event"] != EventLoginFailed ||
		lines[0]["username"] != "tim" || lines[0]["client_ip"] != "192.0.2.1" || lines[0]["request_id"] == "" {
		t.Errorf("failed login log = %v", lines[0])
	}
	if lines[1]["level"] != "INFO" {
		t.Errorf("successful login level = %v", lines[1]["level"])
	}
	if v := metricValue(t, reg, "lucid_security_events_total", map[string]string{"event": EventLoginFailed}); v != 1 {
		t.Errorf("counter = %v", v)
	}
}

func TestCSRF(t *testing.T) {
	t.Parallel()
	const token = "secret-token"
	tests := []struct {
		name    string
		method  string
		path    string
		token   string
		session string
		ct      string
		body    string
		headers map[string]string
		want    int
		code    string
	}{
		{"get passes", http.MethodGet, "/api/v1/x", "", token, "", "", nil, http.StatusOK, ""},
		{"non-api post passes", http.MethodPost, "/other", "", token, "", "", nil, http.StatusOK, ""},
		{"valid", http.MethodPost, "/api/v1/x", token, token, "application/json", "{}", nil, http.StatusOK, ""},
		{"valid charset", http.MethodPut, "/api/v1/x", token, token, "application/json; charset=utf-8", "{}", nil, http.StatusOK, ""},
		{"valid no body", http.MethodDelete, "/api/v1/x", token, token, "", "", nil, http.StatusOK, ""},
		{"missing token", http.MethodPost, "/api/v1/x", "", token, "application/json", "{}", nil, http.StatusForbidden, CodeCSRFInvalid},
		{"wrong token", http.MethodPatch, "/api/v1/x", "nope", token, "application/json", "{}", nil, http.StatusForbidden, CodeCSRFInvalid},
		{"no session", http.MethodPost, "/api/v1/x", token, "", "application/json", "{}", nil, http.StatusForbidden, CodeCSRFInvalid},
		{"form body", http.MethodPost, "/api/v1/x", token, token, "application/x-www-form-urlencoded", "a=b", nil, http.StatusBadRequest, CodeInvalidInput},
		{"text body", http.MethodPost, "/api/v1/x", token, token, "text/plain", "{}", nil, http.StatusBadRequest, CodeInvalidInput},
		{"cross-site fetch", http.MethodPost, "/api/v1/x", token, token, "application/json", "{}", map[string]string{"Sec-Fetch-Site": "cross-site"}, http.StatusForbidden, CodeCSRFInvalid},
		{"foreign origin", http.MethodPost, "/api/v1/x", token, token, "application/json", "{}", map[string]string{"Origin": "https://evil.example"}, http.StatusForbidden, CodeCSRFInvalid},
		{"same-origin fetch", http.MethodPost, "/api/v1/x", token, token, "application/json", "{}", map[string]string{"Sec-Fetch-Site": "same-origin"}, http.StatusOK, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			logger, buf := testLogger(t)
			sec, _ := NewSecurity(logger, nil)
			h := CSRF(func(*http.Request) string { return tt.session }, sec)(okHandler)
			req := httptest.NewRequest(tt.method, tt.path, strings.NewReader(tt.body))
			if tt.body == "" {
				req = httptest.NewRequest(tt.method, tt.path, http.NoBody)
			}
			if tt.token != "" {
				req.Header.Set("X-CSRF-Token", tt.token)
			}
			if tt.ct != "" {
				req.Header.Set("Content-Type", tt.ct)
			}
			for k, v := range tt.headers {
				req.Header.Set(k, v)
			}
			w := httptest.NewRecorder()
			h.ServeHTTP(w, req)
			if w.Code != tt.want {
				t.Fatalf("status = %d, want %d (%s)", w.Code, tt.want, w.Body)
			}
			if tt.code != "" && decodeError(t, w.Body).Code != tt.code {
				t.Errorf("code mismatch")
			}
			if tt.code == CodeCSRFInvalid && !strings.Contains(buf.String(), EventCSRFFailed) {
				t.Error("CSRF failure not logged")
			}
		})
	}
}
