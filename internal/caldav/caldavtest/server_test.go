package caldavtest

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const event = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//EN\r\nBEGIN:VEVENT\r\nUID:1\r\nDTSTAMP:20250101T000000Z\r\n" +
	"DTSTART:20250101T100000Z\r\nSUMMARY:x\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"

func newTestServer(t *testing.T) (*Server, *httptest.Server, string) {
	t.Helper()
	s := New(Options{})
	cal := s.AddCalendar(Calendar{Slug: "c", Name: "C & Co", Color: "#112233FF", Description: "d"})
	s.AddCalendar(Calendar{Slug: "ro", ReadOnly: true, Components: []string{"VTODO"}})
	ts := httptest.NewServer(s)
	t.Cleanup(ts.Close)
	return s, ts, cal
}

func do(t *testing.T, ts *httptest.Server, method, path, body string, hdr map[string]string) (int, string) {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), method, ts.URL+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.SetBasicAuth("user", "pass")
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

func TestServer(t *testing.T) {
	t.Parallel()
	s, ts, cal := newTestServer(t)
	ics := map[string]string{"Content-Type": "text/calendar"}

	if code, _ := do(t, ts, http.MethodPut, cal+"a.ics", event, map[string]string{"Content-Type": "text/calendar", "If-None-Match": "*"}); code != http.StatusCreated {
		t.Fatalf("create: %d", code)
	}
	if code, _ := do(t, ts, http.MethodPut, cal+"a.ics", event, map[string]string{"Content-Type": "text/calendar", "If-None-Match": "*"}); code != http.StatusPreconditionFailed {
		t.Fatalf("create existing: %d", code)
	}
	if code, _ := do(t, ts, http.MethodPut, cal+"a.ics", event, map[string]string{"Content-Type": "text/calendar", "If-Match": `"nope"`}); code != http.StatusPreconditionFailed {
		t.Fatalf("stale If-Match: %d", code)
	}
	if code, _ := do(t, ts, http.MethodPut, cal+"new.ics", event, map[string]string{"Content-Type": "text/calendar", "If-Match": `"nope"`}); code != http.StatusPreconditionFailed {
		t.Fatalf("If-Match on missing: %d", code)
	}
	if code, _ := do(t, ts, http.MethodPut, s.HomePath()+"ro/a.ics", event, ics); code != http.StatusForbidden {
		t.Fatalf("read-only put: %d", code)
	}
	if code, _ := do(t, ts, http.MethodPut, s.HomePath()+"missing/a.ics", event, ics); code != http.StatusConflict {
		t.Fatalf("put without calendar: %d", code)
	}

	code, body := do(t, ts, "PROPFIND", s.HomePath(), "", map[string]string{"Depth": "1"})
	for _, want := range []string{"C &amp; Co", "#112233FF", "ctag-2", "sync/2", "<c:calendar-description>d</c:calendar-description>"} {
		if code != http.StatusMultiStatus || !strings.Contains(body, want) {
			t.Fatalf("PROPFIND home (%d) lacks %q:\n%s", code, want, body)
		}
	}
	propfind := `<d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><x:unknown xmlns:x="urn:x"/></d:prop></d:propfind>`
	code, body = do(t, ts, "PROPFIND", cal, propfind, map[string]string{"Depth": "1"})
	if code != http.StatusMultiStatus || !strings.Contains(body, cal+"a.ics") || !strings.Contains(body, "404 Not Found") {
		t.Fatalf("PROPFIND calendar (%d):\n%s", code, body)
	}
	if code, _ = do(t, ts, "PROPFIND", cal, "<broken", nil); code != http.StatusBadRequest {
		t.Fatalf("bad PROPFIND: %d", code)
	}

	for _, p := range s.ObjectPaths(cal) {
		data, ok := s.Object(p)
		if !ok || !strings.Contains(data, "SUMMARY:x") {
			t.Fatalf("object %s: %q", p, data)
		}
	}
	code, _ = do(t, ts, http.MethodGet, cal+"a.ics", "", nil)
	if code != http.StatusOK {
		t.Fatalf("GET: %d", code)
	}
	req, _ := http.NewRequestWithContext(t.Context(), http.MethodHead, ts.URL+cal+"a.ics", http.NoBody)
	req.SetBasicAuth("user", "pass")
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	etag := resp.Header.Get("ETag")

	if code, _ = do(t, ts, http.MethodDelete, cal+"a.ics", "", map[string]string{"If-Match": `"stale"`}); code != http.StatusPreconditionFailed {
		t.Fatalf("stale delete: %d", code)
	}
	if code, _ = do(t, ts, http.MethodDelete, cal+"a.ics", "", map[string]string{"If-Match": etag}); code != http.StatusNoContent {
		t.Fatalf("delete: %d", code)
	}
	if code, _ = do(t, ts, http.MethodDelete, cal+"a.ics", "", nil); code != http.StatusNotFound {
		t.Fatalf("delete missing: %d", code)
	}
	if s.Count(http.MethodDelete) != 3 {
		t.Fatalf("Count(DELETE) = %d", s.Count(http.MethodDelete))
	}
	s.ResetCounts()
	if s.Count(http.MethodDelete) != 0 {
		t.Fatal("ResetCounts did not reset")
	}
}

func TestServerAuthAndRouting(t *testing.T) {
	t.Parallel()
	s := New(Options{Prefix: "/dav/", DisableCTag: true, DisableSyncToken: true})
	ts := httptest.NewServer(s)
	t.Cleanup(ts.Close)

	resp, err := ts.Client().Get(ts.URL + "/dav/")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized || resp.Header.Get("WWW-Authenticate") == "" {
		t.Fatalf("unauthenticated: %d", resp.StatusCode)
	}
	if code, _ := do(t, ts, "PROPFIND", "/elsewhere/", "", nil); code != http.StatusNotFound {
		t.Fatalf("outside prefix: %d", code)
	}
	client := *ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err = client.Get(ts.URL + "/.well-known/caldav")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusMovedPermanently || resp.Header.Get("Location") != "/dav/" {
		t.Fatalf("well-known: %d %q", resp.StatusCode, resp.Header.Get("Location"))
	}

	s.SetHook(func(w http.ResponseWriter, _ *http.Request) bool {
		w.WriteHeader(http.StatusTeapot)
		return true
	})
	if code, _ := do(t, ts, http.MethodGet, "/dav/", "", nil); code != http.StatusTeapot {
		t.Fatalf("hook: %d", code)
	}
	s.SetHook(nil)

	cal := s.AddCalendar(Calendar{Slug: "c"})
	if _, err := s.PutObject(cal, "x.ics", "garbage"); err == nil {
		t.Fatal("expected parse error")
	}
	if _, err := s.PutObject(s.HomePath()+"nope/", "x.ics", event); err == nil {
		t.Fatal("expected missing calendar error")
	}
	if _, ok := s.Object(cal + "x.ics"); ok {
		t.Fatal("unexpected object")
	}
	if s.ObjectPaths("/nope/") != nil {
		t.Fatal("unexpected paths")
	}
	code, body := do(t, ts, "PROPFIND", cal, "", map[string]string{"Depth": "0"})
	if code != http.StatusMultiStatus || strings.Contains(body, "getctag>") {
		t.Fatalf("ctag should be hidden (%d):\n%s", code, body)
	}
	if code, _ := do(t, ts, "MKCOL", s.HomePath()+"new/", "", nil); code < 400 {
		t.Fatalf("MKCOL: %d", code)
	}
	if code, _ := do(t, ts, "PROPFIND", s.HomePath()+"missing/", "", map[string]string{"Depth": "0"}); code != http.StatusNotFound {
		t.Fatalf("missing calendar: %d", code)
	}
}
