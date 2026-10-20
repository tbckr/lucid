package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"encoding/xml"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/tbckr/lucid/internal/caldav"
	"github.com/tbckr/lucid/internal/caldav/caldavtest"
	"github.com/tbckr/lucid/internal/diag"
	"github.com/tbckr/lucid/internal/httpapi"
	"github.com/tbckr/lucid/internal/middleware"
	"github.com/tbckr/lucid/internal/session"
	"github.com/tbckr/lucid/internal/undo"
)

// The canary is in every value of the account and of the calendar that must
// stay out of logs and of the problem report (NFR-36, FR-36). It cannot occur
// in a hex pseudonym, and the checks ignore its case.
const (
	canary     = "zz-canary"
	canaryUser = canary + "-user"
	canaryPass = canary + "-pass"
)

// canaryEvent is stored on the CalDAV server as canary-obj.ics, with the canary
// in every value.
const canaryEvent = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\n" +
	"X-WR-CALNAME:" + canary + " calendar name\r\n" +
	"BEGIN:VEVENT\r\n" +
	"UID:" + canary + "-uid\r\n" +
	"DTSTAMP:20250301T000000Z\r\nDTSTART:20250302T100000Z\r\nDTEND:20250302T110000Z\r\n" +
	"SUMMARY:" + canary + " title\r\n" +
	"DESCRIPTION:" + canary + " notes\r\n" +
	"LOCATION:" + canary + " place\r\n" +
	"CATEGORIES:" + canary + "\r\n" +
	"X-CUSTOM:" + canary + "\r\n" +
	"ORGANIZER;CN=" + canary + " organizer:mailto:" + canary + "-organizer@example.test\r\n" +
	"ATTENDEE;CN=" + canary + " attendee:mailto:" + canary + "@example.test\r\n" +
	"END:VEVENT\r\nEND:VCALENDAR\r\n"

// canaryBroken is iCalendar that does not parse, and whose END line puts a value
// of the object into the error of the parser.
const canaryBroken = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:" + canary + " secret\r\nEND:" + canary + "\r\n"

// canarySabre is the error body of Sabre/dav, whose message is the server's
// free text.
const canarySabre = `<?xml version="1.0" encoding="utf-8"?>
<d:error xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns">
  <s:sabredav-version>4.6.0</s:sabredav-version>
  <s:exception>Sabre\DAV\Exception\Forbidden</s:exception>
  <s:message>` + canary + ` may not be written</s:message>
</d:error>`

// canaryInput is the body of a create and of an update of an event.
const canaryInput = `{"title":"` + canary + ` title","description":"` + canary + ` notes","location":"` + canary + ` place",` +
	`"start":"2025-03-02T10:00:00Z","end":"2025-03-02T11:00:00Z","allDay":false}`

// lockedBuffer is a log destination the handlers can write to together.
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// innerRequest marks the request a hook passes on to the mock itself.
type innerRequest struct{}

// canaryMock is a CalDAV server with the canary in the account, the calendar and
// its object, and a hook that makes it misbehave: its REPORT adds an object that
// does not parse, its first PUT is refused with 415 and a Sabre body, and,
// once armed, every PROPFIND is answered with 403.
type canaryMock struct {
	*caldavtest.Server
	calPath    string
	brokenPath string
	denyProps  atomic.Bool
	putRefused atomic.Bool
}

func newCanaryMock(t *testing.T) (*canaryMock, *httptest.Server) {
	t.Helper()
	m := &canaryMock{Server: caldavtest.New(caldavtest.Options{Username: canaryUser, Password: canaryPass})}
	m.calPath = m.AddCalendar(caldavtest.Calendar{
		Slug: canary + "-cal", Name: canary + " calendar", Description: canary + " description",
	})
	if _, err := m.PutObject(m.calPath, canary+"-obj.ics", canaryEvent); err != nil {
		t.Fatalf("PutObject: %v", err)
	}
	m.brokenPath = m.calPath + canary + "-broken.ics"
	m.SetHook(m.hook)
	ts := httptest.NewServer(m)
	t.Cleanup(ts.Close)
	return m, ts
}

func (m *canaryMock) hook(w http.ResponseWriter, r *http.Request) bool {
	if r.Context().Value(innerRequest{}) != nil {
		return false
	}
	switch {
	case r.Method == "REPORT" && r.URL.Path == m.calPath:
		m.reportWithBrokenObject(w, r)
		return true
	case r.Method == http.MethodGet && r.URL.Path == m.brokenPath:
		w.Header().Set("Content-Type", "text/calendar; charset=utf-8")
		_, _ = io.WriteString(w, canaryBroken)
		return true
	case r.Method == http.MethodPut && m.putRefused.CompareAndSwap(false, true):
		w.Header().Set("Content-Type", "application/xml; charset=utf-8")
		w.WriteHeader(http.StatusUnsupportedMediaType)
		_, _ = io.WriteString(w, canarySabre)
		return true
	case r.Method == "PROPFIND" && m.denyProps.Load():
		w.Header().Set("Content-Type", "application/xml; charset=utf-8")
		w.WriteHeader(http.StatusForbidden)
		_, _ = io.WriteString(w, canarySabre)
		return true
	}
	return false
}

// reportWithBrokenObject answers a REPORT as the mock does, with one more
// object in the multistatus, the one that does not parse.
func (m *canaryMock) reportWithBrokenObject(w http.ResponseWriter, r *http.Request) {
	rec := httptest.NewRecorder()
	m.ServeHTTP(rec, r.WithContext(context.WithValue(r.Context(), innerRequest{}, true)))
	body := rec.Body.String()
	if end := strings.LastIndex(body, "</"); rec.Code == http.StatusMultiStatus && end >= 0 {
		var broken strings.Builder
		broken.WriteString(`<d:response xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:href>` + m.brokenPath +
			`</d:href><d:propstat><d:prop><d:getetag>"broken"</d:getetag><c:calendar-data>`)
		_ = xml.EscapeText(&broken, []byte(canaryBroken))
		broken.WriteString(`</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`)
		body = body[:end] + broken.String() + body[end:]
	}
	for k, v := range rec.Header() {
		if k != "Content-Length" {
			w.Header()[k] = v
		}
	}
	w.WriteHeader(rec.Code)
	_, _ = io.WriteString(w, body)
}

// browser is a minimal browser: it keeps the session cookie and the CSRF token.
type browser struct {
	t      *testing.T
	api    http.Handler
	host   string
	cookie string
	csrf   string
}

// do sends a request and returns the status and the body of the response. The
// header values come as key, value pairs.
func (b *browser) do(method, path, body string, header ...string) (int, string) {
	b.t.Helper()
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Host = b.host
	if body != "" {
		r.Header.Set("Content-Type", "application/json")
	}
	if b.cookie != "" {
		r.AddCookie(&http.Cookie{Name: httpapi.CookieName, Value: b.cookie})
	}
	if b.csrf != "" {
		r.Header.Set(middleware.CSRFHeader, b.csrf)
	}
	for i := 0; i+1 < len(header); i += 2 {
		r.Header.Set(header[i], header[i+1])
	}
	w := httptest.NewRecorder()
	b.api.ServeHTTP(w, r)
	for _, c := range w.Result().Cookies() {
		if c.Name == httpapi.CookieName {
			b.cookie = c.Value
			if c.MaxAge < 0 {
				b.cookie = ""
			}
		}
	}
	return w.Code, w.Body.String()
}

// expect sends a request that must answer want, and returns its body.
func (b *browser) expect(want int, method, path, body string, header ...string) string {
	b.t.Helper()
	status, got := b.do(method, path, body, header...)
	if status != want {
		b.t.Fatalf("%s %s: status = %d, want %d; body: %s", method, path, status, want, got)
	}
	return got
}

// decodeAs decodes the JSON body into a T.
func decodeAs[T any](t *testing.T, body string) T {
	t.Helper()
	var v T
	if err := json.Unmarshal([]byte(body), &v); err != nil {
		t.Fatalf("decoding %q: %v", body, err)
	}
	return v
}

// containsCanary reports whether s has the canary, in any case.
func containsCanary(s string) bool {
	return strings.Contains(strings.ToLower(s), canary)
}

// securityEvent matches the attribute of a security event in a text log line.
var securityEvent = regexp.MustCompile(`(^|\s)security_event=`)

// isSecurityEvent reports whether a log line is a security event, which keeps
// the user name by design (NFR-23).
func isSecurityEvent(line string, jsonLog bool) bool {
	if !jsonLog {
		return securityEvent.MatchString(line)
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(line), &m); err != nil {
		return false
	}
	_, ok := m["security_event"]
	return ok
}

// A flow through the whole stack, with the canary in everything the account and
// the calendar hold and with a server that misbehaves, at debug level: no log
// line but the security events has it, none has the password, neither the
// problem report nor a skeleton has it, and the content endpoint, the one place
// that returns contents, does (NFR-36, FR-36).
func TestNoContentsInLogsOrReport(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name  string
		local bool
	}{{"server mode", false}, {"local mode", true}} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			runCanaryFlow(t, tc.local)
		})
	}
}

func runCanaryFlow(t *testing.T, local bool) {
	t.Helper()
	mock, ts := newCanaryMock(t)

	// The log has the format of its mode, as in cmd/lucid.
	logs := &lockedBuffer{}
	opts := &slog.HandlerOptions{Level: slog.LevelDebug}
	var handler slog.Handler = slog.NewJSONHandler(logs, opts)
	if local {
		handler = slog.NewTextHandler(logs, opts)
	}
	logger := slog.New(middleware.NewContextHandler(handler))

	provider, err := caldav.NewProvider(caldav.Options{
		HTTPClient: ts.Client(), // safehttp would block the loopback address
		Logger:     logger.With("component", "caldav"),
		Key:        bytes.Repeat([]byte{7}, 32), // fixed, so no ID or pseudonym is ever a canary by chance
	})
	if err != nil {
		t.Fatal(err)
	}
	store, err := session.New(session.Options{Key: bytes.Repeat([]byte{9}, 32)})
	if err != nil {
		t.Fatal(err)
	}
	sec, err := middleware.NewSecurity(logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	api, err := httpapi.New(httpapi.Options{
		Provider: provider, Sessions: store, Undo: undo.New(undo.Options{}),
		Logger: logger, Security: sec, Local: local, Version: "test",
	})
	if err != nil {
		t.Fatal(err)
	}
	host := "lucid.example.test"
	if local {
		host = "127.0.0.1:8080"
	}
	b := &browser{t: t, api: api, host: host}

	// The session of the login screen.
	type sessionBody struct {
		CSRFToken string `json:"csrfToken"`
	}
	b.csrf = decodeAs[sessionBody](t, b.expect(http.StatusOK, http.MethodGet, "/api/v1/session", "")).CSRFToken

	// A login with a wrong password, then the right one.
	login := func(password string) string {
		return `{"serverUrl":"` + ts.URL + `","username":"` + canaryUser + `","password":"` + password + `"}`
	}
	b.expect(http.StatusUnauthorized, http.MethodPost, "/api/v1/auth/login", login(canaryPass+"-wrong"))
	b.csrf = decodeAs[sessionBody](t, b.expect(http.StatusOK, http.MethodPost, "/api/v1/auth/login", login(canaryPass))).CSRFToken

	// Listing: the calendar, then its events, where the server adds an object
	// that does not parse.
	type calendarsBody struct {
		Calendars []struct {
			ID string `json:"id"`
		} `json:"calendars"`
	}
	cals := decodeAs[calendarsBody](t, b.expect(http.StatusOK, http.MethodGet, "/api/v1/calendars", ""))
	if len(cals.Calendars) != 1 {
		t.Fatalf("calendars = %+v; want one", cals.Calendars)
	}
	calID := cals.Calendars[0].ID
	type eventsBody struct {
		Events []struct {
			ID   string `json:"id"`
			ETag string `json:"etag"`
		} `json:"events"`
	}
	events := decodeAs[eventsBody](t, b.expect(http.StatusOK, http.MethodGet,
		"/api/v1/calendars/"+calID+"/events?start=2025-03-01T00:00:00Z&end=2025-04-01T00:00:00Z", ""))
	if len(events.Events) != 1 {
		t.Fatalf("events = %+v; want the one that parses", events.Events)
	}
	eventID, etag := events.Events[0].ID, events.Events[0].ETag

	// A create the server refuses with 415 and a body of free text, and an
	// update it accepts.
	b.expect(http.StatusBadGateway, http.MethodPost, "/api/v1/calendars/"+calID+"/events", canaryInput)
	b.expect(http.StatusOK, http.MethodPut, "/api/v1/events/"+eventID, canaryInput, "If-Match", etag)

	// The report of the session: what went wrong, and no content.
	reportBody := b.expect(http.StatusOK, http.MethodGet, "/api/v1/diagnostics", "")
	report := decodeAs[diag.Report](t, reportBody)
	var brokenID string
	kinds := map[diag.ProblemKind]bool{}
	for i := range report.Problems {
		p := &report.Problems[i]
		kinds[p.Kind] = true
		if p.Kind == diag.ProblemUnparsableObject {
			brokenID = p.ObjectID
		}
	}
	if !kinds[diag.ProblemUnparsableObject] || !kinds[diag.ProblemRejectedWrite] {
		t.Fatalf("problems = %+v; want an unparsable object and a rejected write", report.Problems)
	}
	if brokenID == "" {
		t.Fatalf("the unparsable object has no objectId before the logout: %+v", report.Problems)
	}

	// The skeletons of the object that does not parse and of the one that does.
	type skeletonBody struct {
		Skeleton diag.Skeleton `json:"skeleton"`
	}
	skeletons := map[string]string{}
	for name, id := range map[string]string{"broken": brokenID, "event": eventID} {
		body := b.expect(http.StatusOK, http.MethodGet, "/api/v1/diagnostics/objects/"+id, "")
		if sk := decodeAs[skeletonBody](t, body).Skeleton; !strings.Contains(sk.Text, "BEGIN:") {
			t.Errorf("skeleton of the %s object = %q; want its shape", name, sk.Text)
		}
		skeletons[name] = body
	}

	// The positive control: the content endpoint has the contents, so that a
	// canary missing elsewhere is not a canary that never got in.
	type contentBody struct {
		Content string `json:"content"`
	}
	content := decodeAs[contentBody](t, b.expect(http.StatusOK, http.MethodGet, "/api/v1/diagnostics/objects/"+eventID+"/content", "")).Content
	for _, want := range []string{"SUMMARY:", "DESCRIPTION:", "LOCATION:", "ATTENDEE", "UID:"} {
		if i := strings.Index(content, want); i < 0 || !containsCanary(content[i:min(i+len(want)+80, len(content))]) {
			t.Errorf("content lacks %s with the canary:\n%s", want, content)
		}
	}

	// The server turns the credentials down on a read: the session ends, and
	// the new anonymous one keeps the trace.
	oldCookie := b.cookie
	mock.denyProps.Store(true)
	b.expect(http.StatusUnauthorized, http.MethodGet, "/api/v1/calendars", "")
	mock.denyProps.Store(false)
	if b.cookie == "" || b.cookie == oldCookie {
		t.Fatalf("cookie after the forced logout = %q (before %q); want the one of a new session", b.cookie, oldCookie)
	}
	afterBody := b.expect(http.StatusOK, http.MethodGet, "/api/v1/diagnostics", "")
	after := decodeAs[diag.Report](t, afterBody)
	if after.Authenticated {
		t.Error("the report after the forced logout says the session is authenticated")
	}
	afterKinds := map[diag.ProblemKind]bool{}
	for i := range after.Problems {
		p := &after.Problems[i]
		afterKinds[p.Kind] = true
		if p.ObjectID != "" {
			t.Errorf("problem after the forced logout has an objectId: %+v", *p)
		}
	}
	for _, k := range []diag.ProblemKind{diag.ProblemUnparsableObject, diag.ProblemRejectedWrite, diag.ProblemErrorResponse} {
		if !afterKinds[k] {
			t.Errorf("the report after the forced logout has no %s problem: %+v", k, after.Problems)
		}
	}

	// Nothing a user can download has the canary, and no log line has it, but
	// the security events, which keep the user name.
	for name, body := range map[string]string{
		"report": reportBody, "report after the forced logout": afterBody,
		"skeleton of the broken object": skeletons["broken"], "skeleton of the event": skeletons["event"],
	} {
		if containsCanary(body) {
			t.Errorf("%s contains the canary:\n%s", name, body)
		}
	}
	checkLogs(t, logs.String(), !local)
}

// checkLogs fails t for every log line with the canary, except those of security
// events, and for every line with the password, security events included.
func checkLogs(t *testing.T, logs string, jsonLog bool) {
	t.Helper()
	var lines, security, problems int
	for _, line := range strings.Split(logs, "\n") {
		if line == "" {
			continue
		}
		lines++
		if strings.Contains(strings.ToLower(line), canaryPass) {
			t.Errorf("log line has the password:\n%s", line)
		}
		if isSecurityEvent(line, jsonLog) {
			security++
			continue
		}
		if strings.Contains(line, "caldav problem") {
			problems++
		}
		if containsCanary(line) {
			t.Errorf("log line has the canary:\n%s", line)
		}
	}
	// A log without the lines the flow causes proves nothing.
	if lines < 20 || security < 2 || problems < 3 {
		t.Errorf("log has %d lines, %d of security events and %d of problems; want the flow to have logged more:\n%s",
			lines, security, problems, logs)
	}
}
