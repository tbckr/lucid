package caldav

import (
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/emersion/go-ical"

	"github.com/tbckr/lucid/internal/caldav/caldavtest"
	"github.com/tbckr/lucid/internal/diag"
	"github.com/tbckr/lucid/internal/domain"
)

// canary is in every value a problem must not show: of an object, of an XML
// body, of an error message (NFR-36).
const canary = "zz-canary"

// sabreError is the error body of Sabre/dav (Nextcloud, Baikal): the class of
// the exception is what a problem should keep, its message is the server's
// free text.
const sabreError = `<?xml version="1.0" encoding="utf-8"?>
<d:error xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns">
  <s:sabredav-version>4.6.0</s:sabredav-version>
  <s:exception>Sabre\DAV\Exception\Forbidden</s:exception>
  <s:message>` + canary + ` may not be written</s:message>
</d:error>`

// brokenObject is iCalendar that does not parse, and whose END line puts a
// value of the object into the error of the parser.
const brokenObject = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:" + canary + " secret\r\nEND:" + canary + "\r\n"

// noCanary fails t if s shows the canary, in any case.
func noCanary(t *testing.T, what, s string) {
	t.Helper()
	if strings.Contains(strings.ToLower(s), canary) {
		t.Errorf("%s contains the canary:\n%s", what, s)
	}
}

// problemRun is a provider on a mock that logs at debug, and the service of
// its account, with the context and the buffer that a request carries.
type problemRun struct {
	*traceEnv
	acct domain.Account
	svc  domain.CalendarService
	buf  *diag.Buffer
	ctx  context.Context
}

func newProblemRun(t *testing.T) *problemRun {
	t.Helper()
	e := newTraceEnv(t, caldavtest.Options{})
	buf := diag.NewBuffer(diag.SessionLimits)
	acct := e.connect(t.Context(), t)
	return &problemRun{
		traceEnv: e,
		acct:     acct,
		svc:      e.p.Service(acct),
		buf:      buf,
		ctx:      scopedCtx(t.Context(), buf, "req-1"),
	}
}

func (r *problemRun) problems() []diag.Problem { return r.buf.Snapshot().Problems }

// calPath is the path of the calendar slug.
func (r *problemRun) calPath(slug string) string { return r.mock.HomePath() + slug + "/" }

// problemLines are the log lines of the problems.
func (r *problemRun) problemLines(t *testing.T) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, m := range logLines(t, r.logs) {
		if m["msg"] == "caldav problem" {
			out = append(out, m)
		}
	}
	return out
}

// answerReport makes the REPORT of the calendar slug answer with objs.
func (r *problemRun) answerReport(slug string, objs ...reportObject) {
	r.hook(func(w http.ResponseWriter, req *http.Request) bool {
		if req.Method != "REPORT" || req.URL.Path != r.calPath(slug) {
			return false
		}
		w.Header().Set("Content-Type", "application/xml; charset=utf-8")
		w.WriteHeader(http.StatusMultiStatus)
		_, _ = io.WriteString(w, reportBody(r.calPath(slug), objs...))
		return true
	})
}

// reportObject is one object of a REPORT answer: its name and its data as
// calendar-data.
type reportObject struct{ name, data string }

func reportBody(calPath string, objs ...reportObject) string {
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">`)
	for _, o := range objs {
		fmt.Fprintf(&b, `<d:response><d:href>%s%s</d:href><d:propstat><d:prop><d:getetag>"1"</d:getetag><c:calendar-data>`, calPath, o.name)
		_ = xml.EscapeText(&b, []byte(o.data))
		b.WriteString(`</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`)
	}
	b.WriteString(`</d:multistatus>`)
	return b.String()
}

// canaryEvent is a small event with the canary in every value.
func canaryEvent(uid string, extra ...string) string {
	lines := []string{
		"BEGIN:VEVENT", "UID:" + uid, "DTSTAMP:20250301T000000Z", "DTSTART:20250302T100000Z", "DTEND:20250302T110000Z",
		"SUMMARY:" + canary + " title", "DESCRIPTION:" + canary + " notes", "LOCATION:" + canary + " place",
		"ATTENDEE:mailto:" + canary + "@example.test",
	}
	lines = append(lines, extra...)
	return ics(append(lines, "END:VEVENT")...)
}

// putCanaryEvent stores a canaryEvent in the calendar slug as name and returns
// its path.
func (r *problemRun) putCanaryEvent(t *testing.T, slug, name string, extra ...string) string {
	t.Helper()
	p, err := r.mock.PutObject(r.calPath(slug), name, canaryEvent(canary+"-uid", extra...))
	if err != nil {
		t.Fatalf("PutObject: %v", err)
	}
	return p
}

// listEvents lists the events of the calendar slug around the test events.
func (r *problemRun) listEvents(t *testing.T, slug string) ([]domain.Event, error) {
	t.Helper()
	id := r.calendarID(t, r.svc, strings.ToUpper(slug[:1])+slug[1:])
	return r.svc.ListEvents(r.ctx, id, date(2025, 3, 1, 0, 0), date(2025, 3, 8, 0, 0))
}

var (
	objectPseudonym = regexp.MustCompile(`^\{home\}/cal-[0-9a-f]{8}/obj-[0-9a-f]{8}\.ics$`)
	calendarPseudo  = regexp.MustCompile(`^\{home\}/cal-[0-9a-f]{8}/$`)
)

func TestProblemUnparsableObject(t *testing.T) {
	t.Parallel()
	r := newProblemRun(t)
	r.answerReport("personal",
		reportObject{"good.ics", canaryEvent("good")},
		reportObject{canary + "-broken.ics", brokenObject})

	evs, err := r.listEvents(t, "personal")

	mustNoErr(t, err)
	if len(evs) != 1 || evs[0].Title != canary+" title" {
		t.Fatalf("events = %+v; want the one good event", evs)
	}
	got := r.problems()
	if len(got) != 1 {
		t.Fatalf("problems = %+v; want one", got)
	}
	pr := got[0]
	if pr.Kind != diag.ProblemUnparsableObject || pr.RequestID != "req-1" || pr.At.IsZero() {
		t.Errorf("problem = %+v; want unparsable_object of req-1, with a time", pr)
	}
	if !objectPseudonym.MatchString(pr.Path) {
		t.Errorf("Path = %q; want a pseudonymised object path", pr.Path)
	}
	if objPath, ok := r.p.ids.open(pr.ObjectID); !ok || objPath != r.calPath("personal")+canary+"-broken.ics" {
		t.Errorf("ObjectID decodes to %q, %v; want the broken object", objPath, ok)
	}
	if pr.Reason == "" || !strings.Contains(pr.Skeleton.Text, "BEGIN:VCALENDAR") || !strings.Contains(pr.Skeleton.Text, "SUMMARY:") {
		t.Errorf("Reason, Skeleton = %q, %q; want a reason and the shape of the object", pr.Reason, pr.Skeleton.Text)
	}
	noCanary(t, "Path", pr.Path)
	noCanary(t, "Reason", pr.Reason)
	noCanary(t, "Skeleton", pr.Skeleton.Text)
	noCanary(t, "log", r.logs.String())

	// The log says the same at warn.
	lines := r.problemLines(t)
	if len(lines) != 1 {
		t.Fatalf("problem log lines = %v; want one", lines)
	}
	m := lines[0]
	if m["level"] != "WARN" || m["kind"] != "unparsable_object" || m["path"] != pr.Path ||
		m["reason"] != pr.Reason || m["skeleton"] != pr.Skeleton.Text || m["truncated"] != false {
		t.Errorf("problem line = %v; want the problem as it was recorded", m)
	}
	if _, ok := m["object_id"]; ok {
		t.Errorf("problem line has the object ID: %v", m)
	}
}

func TestProblemUnparsableObjectOnRead(t *testing.T) {
	t.Parallel()
	r := newProblemRun(t)
	objPath := r.putCanaryEvent(t, "personal", canary+"-obj.ics")
	evs, err := r.listEvents(t, "personal")
	mustNoErr(t, err)
	r.hook(func(w http.ResponseWriter, req *http.Request) bool {
		if req.Method != http.MethodGet || req.URL.Path != objPath {
			return false
		}
		w.Header().Set("Content-Type", "text/calendar")
		_, _ = io.WriteString(w, brokenObject)
		return true
	})

	_, _, err = r.svc.UpdateEvent(r.ctx, evs[0].ID, evs[0].ETag, domain.EventInput{
		Title: "x", Start: date(2025, 3, 2, 10, 0), End: date(2025, 3, 2, 11, 0),
	})

	mustErr(t, err, domain.ErrUpstream)
	noCanary(t, "error", err.Error())
	got := r.problems()
	if len(got) != 1 || got[0].Kind != diag.ProblemUnparsableObject {
		t.Fatalf("problems = %+v; want one unparsable_object", got)
	}
	if id, ok := r.p.ids.open(got[0].ObjectID); !ok || id != objPath {
		t.Errorf("ObjectID decodes to %q, %v; want %q", id, ok, objPath)
	}
	noCanary(t, "Skeleton", got[0].Skeleton.Text)
	noCanary(t, "log", r.logs.String())
}

func TestProblemInvalidXML(t *testing.T) {
	t.Parallel()
	r := newProblemRun(t)
	r.hook(func(w http.ResponseWriter, req *http.Request) bool {
		if req.Method != "REPORT" {
			return false
		}
		w.Header().Set("Content-Type", "application/xml")
		w.WriteHeader(http.StatusMultiStatus)
		_, _ = io.WriteString(w, `<d:multistatus xmlns:d="DAV:"><d:response><d:href>/`+canary+`/x.ics</d:href><d:status>&`+canary+`;</d:status></d:response></d:multistatus>`)
		return true
	})

	_, err := r.listEvents(t, "personal")

	mustErr(t, err, domain.ErrUpstream)
	noCanary(t, "error", err.Error())
	got := r.problems()
	if len(got) != 1 {
		t.Fatalf("problems = %+v; want one", got)
	}
	pr := got[0]
	if pr.Kind != diag.ProblemInvalidXML || pr.RequestID != "req-1" || !calendarPseudo.MatchString(pr.Path) || pr.ObjectID != "" {
		t.Errorf("problem = %+v; want invalid_xml of req-1 for a pseudonymised calendar path, with no object", pr)
	}
	if !strings.Contains(pr.Reason, "XML") {
		t.Errorf("Reason = %q; want what the XML decoder said", pr.Reason)
	}
	for _, want := range []string{"d:multistatus", "d:response", "d:href"} {
		if !strings.Contains(pr.Skeleton.Text, want) {
			t.Errorf("Skeleton lacks %q:\n%s", want, pr.Skeleton.Text)
		}
	}
	noCanary(t, "Reason", pr.Reason)
	noCanary(t, "Skeleton", pr.Skeleton.Text)
	noCanary(t, "log", r.logs.String())
	if lines := r.problemLines(t); len(lines) != 1 || lines[0]["kind"] != "invalid_xml" {
		t.Errorf("problem log lines = %v; want one invalid_xml", lines)
	}
}

// answerPut makes the PUT of any object answer with status and body, and
// returns the data it was sent.
func (r *problemRun) answerPut(status int, ctype, body string) *atomic.Value {
	sent := &atomic.Value{}
	r.hook(func(w http.ResponseWriter, req *http.Request) bool {
		if req.Method != http.MethodPut {
			return false
		}
		data, _ := io.ReadAll(req.Body)
		sent.Store(string(data))
		if ctype != "" {
			w.Header().Set("Content-Type", ctype)
		}
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
		return true
	})
	return sent
}

func TestProblemRejectedWrite(t *testing.T) {
	t.Parallel()
	in := domain.EventInput{
		Title: canary + " title", Description: canary + " notes", Location: canary + " place",
		Start: date(2025, 3, 2, 10, 0), End: date(2025, 3, 2, 11, 0),
	}
	tests := []struct {
		name string
		// do refuses the write it makes with 403 and a Sabre body, and returns
		// the data it sent and its error.
		do           func(t *testing.T, r *problemRun) (*atomic.Value, error)
		wantObjectID bool // an update has an object on the server, a create has not
	}{
		{"create", func(t *testing.T, r *problemRun) (*atomic.Value, error) {
			t.Helper()
			sent := r.answerPut(http.StatusForbidden, "application/xml; charset=utf-8", sabreError)
			_, err := r.svc.CreateEvent(r.ctx, r.calendarID(t, r.svc, "Personal"), in)
			return sent, err
		}, false},
		{"update", func(t *testing.T, r *problemRun) (*atomic.Value, error) {
			t.Helper()
			r.putCanaryEvent(t, "personal", canary+"-obj.ics")
			evs, err := r.listEvents(t, "personal")
			mustNoErr(t, err)
			sent := r.answerPut(http.StatusForbidden, "application/xml; charset=utf-8", sabreError)
			_, _, err = r.svc.UpdateEvent(r.ctx, evs[0].ID, evs[0].ETag, in)
			return sent, err
		}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			r := newProblemRun(t)

			sent, err := tt.do(t, r)

			mustErr(t, err, domain.ErrReadOnly)
			got := r.problems()
			if len(got) != 2 || got[0].Kind != diag.ProblemErrorResponse || got[1].Kind != diag.ProblemRejectedWrite {
				t.Fatalf("problems = %+v; want error_response, then rejected_write", got)
			}
			resp, write := got[0], got[1]
			for _, pr := range got {
				if pr.RequestID != "req-1" || !objectPseudonym.MatchString(pr.Path) || pr.Reason != "HTTP 403" {
					t.Errorf("problem = %+v; want req-1, a pseudonymised object path and the reason HTTP 403", pr)
				}
				noCanary(t, string(pr.Kind)+" Skeleton", pr.Skeleton.Text)
			}
			// The class of the exception stays, the message of the server goes.
			if !strings.Contains(resp.Skeleton.Text, `Sabre\DAV\Exception\Forbidden`) || resp.ObjectID != "" {
				t.Errorf("error_response = %+v; want the exception class and no object", resp)
			}
			// The write is what Lucid sent, in its shape.
			data, _ := sent.Load().(string)
			if !strings.Contains(data, "BEGIN:VEVENT") || write.Skeleton != diag.ICalSkeleton([]byte(data)) ||
				!strings.Contains(write.Skeleton.Text, "BEGIN:VEVENT") || !strings.Contains(write.Skeleton.Text, "DTSTART") {
				t.Errorf("rejected_write skeleton = %q; want that of what was sent:\n%s", write.Skeleton.Text, data)
			}
			if _, ok := r.p.ids.open(write.ObjectID); ok != tt.wantObjectID {
				t.Errorf("ObjectID %q opens: %v; want %v", write.ObjectID, ok, tt.wantObjectID)
			}
			noCanary(t, "log", r.logs.String())
			if lines := r.problemLines(t); len(lines) != 2 {
				t.Errorf("problem log lines = %v; want two", lines)
			}
		})
	}
}

func TestNoProblemOn412(t *testing.T) {
	t.Parallel()
	r := newProblemRun(t)
	r.putCanaryEvent(t, "personal", canary+"-obj.ics")
	evs, err := r.listEvents(t, "personal")
	mustNoErr(t, err)
	r.answerPut(http.StatusPreconditionFailed, "application/xml; charset=utf-8", sabreError)

	_, _, err = r.svc.UpdateEvent(r.ctx, evs[0].ID, evs[0].ETag, domain.EventInput{
		Title: "x", Start: date(2025, 3, 2, 10, 0), End: date(2025, 3, 2, 11, 0),
	})

	mustErr(t, err, domain.ErrConflict)
	if got := r.problems(); len(got) != 0 {
		t.Errorf("problems = %+v; want none: a lost race is no problem of the server", got)
	}
	if lines := r.problemLines(t); len(lines) != 0 {
		t.Errorf("problem log lines = %v; want none", lines)
	}
}

func TestProblemErrorResponseRules(t *testing.T) {
	t.Parallel()
	const xmlType = "application/xml; charset=utf-8"
	tests := []struct {
		name   string
		status int
		ctype  string
		body   string
		want   bool
	}{
		{"403 with XML", http.StatusForbidden, xmlType, sabreError, true},
		{"500 with XML", http.StatusInternalServerError, xmlType, sabreError, true},
		{"400 with text/xml", http.StatusBadRequest, "text/xml", sabreError, true},
		{"422 with +xml", http.StatusUnprocessableEntity, "application/problem+xml", sabreError, true},
		{"401 is the login", http.StatusUnauthorized, xmlType, sabreError, false},
		{"404 is a missing object", http.StatusNotFound, xmlType, sabreError, false},
		{"412 is a lost race", http.StatusPreconditionFailed, xmlType, sabreError, false},
		{"HTML is not XML", http.StatusForbidden, "text/html", "<html><body>" + canary + "</body></html>", false},
		{"no content type", http.StatusForbidden, "", sabreError, false},
		{"no body", http.StatusForbidden, xmlType, "", false},
		{"a success", http.StatusOK, xmlType, "<ok/>", false},
		{"300 is no error", http.StatusMultipleChoices, xmlType, sabreError, false},
		{"399 is no error", 399, xmlType, sabreError, false},
		{"400 is the first error", http.StatusBadRequest, xmlType, sabreError, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			r := newProblemRun(t)
			r.hook(func(w http.ResponseWriter, req *http.Request) bool {
				if req.Method != "PROPFIND" || req.URL.Path != r.mock.HomePath() {
					return false
				}
				if tt.ctype != "" {
					w.Header().Set("Content-Type", tt.ctype)
				} else {
					w.Header()["Content-Type"] = nil // no sniffing either
				}
				w.WriteHeader(tt.status)
				_, _ = io.WriteString(w, tt.body)
				return true
			})

			_, _ = r.svc.ListCalendars(r.ctx)

			got := r.problems()
			if !tt.want {
				for _, pr := range got {
					if pr.Kind == diag.ProblemErrorResponse {
						t.Errorf("problems = %+v; want no error_response", got)
					}
				}
				return
			}
			if len(got) != 1 || got[0].Kind != diag.ProblemErrorResponse {
				t.Fatalf("problems = %+v; want one error_response", got)
			}
			if want := fmt.Sprintf("HTTP %d", tt.status); got[0].Reason != want || got[0].Path != "{home}/" {
				t.Errorf("Reason, Path = %q, %q; want %q, {home}/", got[0].Reason, got[0].Path, want)
			}
			noCanary(t, "Skeleton", got[0].Skeleton.Text)
			noCanary(t, "log", r.logs.String())
		})
	}
}

// Of the answers to a PUT, every error status but 401, 404 and 412 is a
// refusal to record: those are a failed login, an object that is gone and a
// lost race, as for error_response.
func TestProblemRejectedWriteStatuses(t *testing.T) {
	t.Parallel()
	tests := []struct {
		status int
		want   bool
	}{
		{http.StatusCreated, false},
		{http.StatusNoContent, false},
		{http.StatusBadRequest, true},
		{http.StatusUnauthorized, false},
		{http.StatusForbidden, true},
		{http.StatusNotFound, false},
		{http.StatusConflict, true},
		{http.StatusPreconditionFailed, false},
		{http.StatusUnsupportedMediaType, true},
		{http.StatusUnprocessableEntity, true},
		{http.StatusInternalServerError, true},
		{http.StatusBadGateway, true},
	}
	for _, tt := range tests {
		t.Run(strconv.Itoa(tt.status), func(t *testing.T) {
			t.Parallel()
			r := newProblemRun(t)
			r.answerPut(tt.status, "", "")

			_, _ = r.svc.CreateEvent(r.ctx, r.calendarID(t, r.svc, "Personal"), domain.EventInput{
				Title: canary, Start: date(2025, 3, 2, 10, 0), End: date(2025, 3, 2, 11, 0),
			})

			var writes int
			for _, pr := range r.problems() {
				if pr.Kind == diag.ProblemRejectedWrite {
					writes++
					if want := fmt.Sprintf("HTTP %d", tt.status); pr.Reason != want {
						t.Errorf("Reason = %q; want %q", pr.Reason, want)
					}
				}
			}
			if got := writes > 0; got != tt.want {
				t.Errorf("rejected_write problems = %d; want one: %v", writes, tt.want)
			}
		})
	}
}

func TestProblemInvalidObject(t *testing.T) {
	t.Parallel()
	r := newProblemRun(t)
	objPath := r.putCanaryEvent(t, "personal", canary+"-obj.ics", "RRULE:FREQ=ZZ")

	evs, err := r.listEvents(t, "personal")

	mustNoErr(t, err)
	if len(evs) != 1 {
		t.Fatalf("events = %+v; want the event still shown at its start", evs)
	}
	got := r.problems()
	if len(got) != 1 {
		t.Fatalf("problems = %+v; want one", got)
	}
	pr := got[0]
	if pr.Kind != diag.ProblemInvalidObject || pr.RequestID != "req-1" || !objectPseudonym.MatchString(pr.Path) {
		t.Errorf("problem = %+v; want invalid_object of req-1 with a pseudonymised object path", pr)
	}
	if id, ok := r.p.ids.open(pr.ObjectID); !ok || id != objPath {
		t.Errorf("ObjectID decodes to %q, %v; want %q", id, ok, objPath)
	}
	if !strings.Contains(pr.Reason, "RRULE") {
		t.Errorf("Reason = %q; want it to name the RRULE", pr.Reason)
	}
	// The object was parsed: its skeleton is that of the object as Lucid holds it.
	for _, want := range []string{"BEGIN:VCALENDAR", "BEGIN:VEVENT", "RRULE:", "SUMMARY:"} {
		if !strings.Contains(pr.Skeleton.Text, want) {
			t.Errorf("Skeleton lacks %q:\n%s", want, pr.Skeleton.Text)
		}
	}
	noCanary(t, "Reason", pr.Reason)
	noCanary(t, "Skeleton", pr.Skeleton.Text)
	noCanary(t, "log", r.logs.String())
	if lines := r.problemLines(t); len(lines) != 1 || lines[0]["kind"] != "invalid_object" {
		t.Errorf("problem log lines = %v; want one invalid_object", lines)
	}
}

func TestProblemInvalidTodo(t *testing.T) {
	t.Parallel()
	r := newProblemRun(t)
	// A rule that has not reached the window after the iterations Lucid allows.
	objPath, err := r.mock.PutObject(r.calPath("tasks"), canary+"-todo.ics", ics(
		"BEGIN:VTODO", "UID:"+canary, "DTSTAMP:20250301T000000Z", "DTSTART:20250310T090000Z",
		"SUMMARY:"+canary+" title", "RRULE:FREQ=SECONDLY", "END:VTODO"))
	mustNoErr(t, err)

	_, err = r.svc.ListTodoOccurrences(r.ctx, r.calendarID(t, r.svc, "Tasks"), date(2025, 6, 1, 0, 0), date(2025, 6, 8, 0, 0))

	mustNoErr(t, err)
	got := r.problems()
	if len(got) != 1 || got[0].Kind != diag.ProblemInvalidObject {
		t.Fatalf("problems = %+v; want one invalid_object", got)
	}
	if id, ok := r.p.ids.open(got[0].ObjectID); !ok || id != objPath {
		t.Errorf("ObjectID decodes to %q, %v; want %q", id, ok, objPath)
	}
	if !strings.Contains(got[0].Skeleton.Text, "BEGIN:VTODO") {
		t.Errorf("Skeleton = %q; want the shape of the todo", got[0].Skeleton.Text)
	}
	noCanary(t, "Skeleton", got[0].Skeleton.Text)
	noCanary(t, "log", r.logs.String())
}

func TestProblemWithoutScope(t *testing.T) {
	t.Parallel()
	for name, scoped := range map[string]func(context.Context) context.Context{
		"no scope":        func(ctx context.Context) context.Context { return ctx },
		"scope no buffer": func(ctx context.Context) context.Context { return diag.WithScope(ctx, diag.Scope{RequestID: "req-2"}) },
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			r := newProblemRun(t)
			r.ctx = scoped(t.Context())
			r.answerReport("personal", reportObject{canary + "-broken.ics", brokenObject})

			if _, err := r.listEvents(t, "personal"); err != nil {
				t.Fatalf("ListEvents: %v", err)
			}

			// The log does not depend on a scope.
			if lines := r.problemLines(t); len(lines) != 1 {
				t.Errorf("problem log lines = %v; want one", lines)
			}
			noCanary(t, "log", r.logs.String())
		})
	}
}

func TestCaldavLogsWithoutContents(t *testing.T) {
	t.Parallel()
	r := newProblemRun(t)
	slug := canary + "-cal"
	r.mock.AddCalendar(caldavtest.Calendar{Slug: slug, Name: canary + " name"})
	r.putCanaryEvent(t, slug, canary+"-obj.ics")
	ctx := r.ctx
	calID := r.calendarID(t, r.svc, canary+" name")
	in := domain.EventInput{
		Title: canary + " title", Description: canary + " notes", Location: canary + " place",
		Start: date(2025, 3, 3, 10, 0), End: date(2025, 3, 3, 11, 0),
	}

	evs, err := r.svc.ListEvents(ctx, calID, date(2025, 3, 1, 0, 0), date(2025, 3, 8, 0, 0))
	mustNoErr(t, err)
	created, err := r.svc.CreateEvent(ctx, calID, in)
	mustNoErr(t, err)
	in.Title = canary + " changed"
	updated, _, err := r.svc.UpdateEvent(ctx, created.ID, created.ETag, in)
	mustNoErr(t, err)
	mustNoErr(t, r.svc.DeleteEvent(ctx, updated.ID, updated.ETag))
	if len(evs) != 1 {
		t.Fatalf("events = %+v; want the seeded one", evs)
	}

	// A refused write and a read that fails, with the canary in what the server says.
	r.hook(func(w http.ResponseWriter, req *http.Request) bool {
		if req.Method != http.MethodPut && req.Method != "REPORT" {
			return false
		}
		w.Header().Set("Content-Type", "application/xml; charset=utf-8")
		w.WriteHeader(http.StatusForbidden)
		_, _ = io.WriteString(w, sabreError)
		return true
	})
	_, err = r.svc.CreateEvent(ctx, calID, in)
	mustErr(t, err, domain.ErrReadOnly)
	r.svc.(*service).invalidate(r.calPath(slug))
	if _, err = r.svc.ListEvents(ctx, calID, date(2025, 3, 1, 0, 0), date(2025, 3, 8, 0, 0)); err == nil {
		t.Fatal("ListEvents succeeded; want the server's refusal")
	}

	// Failed discoveries: wrong credentials, at the root and where a server answers with a body.
	r.hook(func(w http.ResponseWriter, req *http.Request) bool {
		if !strings.HasPrefix(req.URL.Path, "/"+canary+"-dir/") {
			return false
		}
		w.Header().Set("Content-Type", "application/xml; charset=utf-8")
		w.WriteHeader(http.StatusForbidden)
		_, _ = io.WriteString(w, sabreError)
		return true
	})
	for _, creds := range []domain.Credentials{
		{ServerURL: r.ts.URL, Username: traceUser, Password: "wrong"},
		{ServerURL: r.ts.URL + "/" + canary + "-dir/", Username: traceUser, Password: "wrong"},
	} {
		if _, err := r.p.Connect(ctx, creds); err == nil {
			t.Errorf("Connect(%s) succeeded; want it to fail", creds.ServerURL)
		}
	}

	out := r.logs.String()
	if !strings.Contains(out, `"caldav exchange"`) || !strings.Contains(out, `"caldav problem"`) {
		t.Fatalf("log has no exchange and problem lines; the test checks nothing:\n%s", out)
	}
	noCanary(t, "log", out)
	for _, leak := range []string{traceUser, tracePass, "wrong", "personal", "work", "holidays", "tasks", "example.test"} {
		if strings.Contains(out, leak) {
			t.Errorf("log contains %q:\n%s", leak, out)
		}
	}
	for _, pr := range r.problems() {
		noCanary(t, string(pr.Kind), pr.Path+pr.Reason+pr.Skeleton.Text)
	}
}

// A problem with a long skeleton says so, and the log carries what the buffer
// keeps.
func TestProblemTruncated(t *testing.T) {
	t.Parallel()
	r := newProblemRun(t)
	var b strings.Builder
	b.WriteString("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\n")
	for range 2000 {
		b.WriteString("X-" + "LINE:" + canary + "\r\n")
	}
	b.WriteString("END:" + canary + "\r\n")
	r.answerReport("personal", reportObject{"big.ics", b.String()})

	_, err := r.listEvents(t, "personal")

	mustNoErr(t, err)
	got := r.problems()
	if len(got) != 1 || !got[0].Skeleton.Truncated || len(got[0].Skeleton.Text) > diag.MaxSkeleton {
		t.Fatalf("problems = %+v; want one with a truncated skeleton of at most %d bytes", got, diag.MaxSkeleton)
	}
	lines := r.problemLines(t)
	if len(lines) != 1 || lines[0]["truncated"] != true || len(lines[0]["skeleton"].(string)) > diag.MaxSkeleton {
		t.Errorf("problem log lines = %v; want one that says truncated", lines)
	}
	noCanary(t, "log", r.logs.String())
}

// The warnings of a change that could not undo itself carry the pseudonymised
// path and the reason of the failure, never the object or what failed it
// (NFR-36).
func TestWriteWarningsCarryNoContents(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	var logs bytes.Buffer
	e.p.log = slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	id := e.put(t, "tasks", canary+"-series.ics",
		"BEGIN:VTODO", "UID:"+canary, "DTSTAMP:20240101T000000Z", "SUMMARY:"+canary+" series",
		"DTSTART:20250310T090000Z", "RRULE:FREQ=DAILY", "END:VTODO")
	f := listedTodo(t, e, id)
	objPath, _, _ := e.p.ids.decodeObjectID(e.mock.HomePath(), id)
	e.mock.SetHook(func(w http.ResponseWriter, r *http.Request) bool {
		switch {
		case r.Method == http.MethodPut && r.URL.Path == objPath:
			w.WriteHeader(http.StatusPreconditionFailed)
			return true
		case r.Method == http.MethodDelete:
			w.Header().Set("Content-Type", "application/xml")
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = io.WriteString(w, sabreError)
			return true
		}
		return false
	})

	_, _, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, completeInput(&f))

	mustErr(t, err, domain.ErrConflict)
	out := logs.String()
	checkStored(t, "log", out, []string{"could not remove an entry a change created", "error=\"HTTP 500\"", "{home}/cal-"}, nil)
	noCanary(t, "log", out)
	for _, raw := range []string{e.paths["tasks"], "/calendars/"} {
		if strings.Contains(out, raw) {
			t.Errorf("log contains the real path %q:\n%s", raw, out)
		}
	}
}

func TestEncodeForSkeleton(t *testing.T) {
	t.Parallel()
	t.Run("a parsed object", func(t *testing.T) {
		t.Parallel()
		cal, err := ical.NewDecoder(strings.NewReader(canaryEvent("uid", "RRULE:FREQ=WEEKLY"))).Decode()
		mustNoErr(t, err)

		data := encodeForSkeleton(cal)

		sk := diag.ICalSkeleton(data)
		for _, want := range []string{"BEGIN:VCALENDAR", "BEGIN:VEVENT", "RRULE:FREQ=WEEKLY", "END:VEVENT", "END:VCALENDAR"} {
			if !strings.Contains(sk.Text, want) {
				t.Errorf("skeleton lacks %q:\n%s", want, sk.Text)
			}
		}
		noCanary(t, "skeleton", sk.Text)
	})
	t.Run("nothing", func(t *testing.T) {
		t.Parallel()
		if data := encodeForSkeleton(nil); data != nil {
			t.Errorf("encodeForSkeleton(nil) = %q; want nil", data)
		}
	})

	// Objects go-ical's encoder refuses, as they do not conform to RFC 5545,
	// are the ones whose problem is worth a skeleton.
	event := func(props ...[2]string) *ical.Component {
		c := ical.NewComponent(ical.CompEvent)
		for _, p := range props {
			c.Props.Add(&ical.Prop{Name: p[0], Value: p[1], Params: ical.Params{}})
		}
		return c
	}
	calendar := func(children ...*ical.Component) *ical.Calendar {
		cal := ical.NewCalendar()
		cal.Children = children
		return cal
	}
	quoted := event([2]string{"UID", "a"}, [2]string{"DTSTAMP", "20250301T000000Z"})
	quoted.Props.Add(&ical.Prop{Name: "ATTENDEE", Value: "mailto:" + canary + "@example.test", Params: ical.Params{
		"CN":             {`Bob "` + canary + `" Builder`},
		"DELEGATED-FROM": {"mailto:" + canary + "@example.test", "x;y,z"},
	}})
	nested := event([2]string{"UID", "a"}, [2]string{"DTSTAMP", "20250301T000000Z"})
	nested.Children = []*ical.Component{event()}
	versioned := calendar(event([2]string{"UID", "a"}, [2]string{"DTSTAMP", "20250301T000000Z"}))
	versioned.Props.SetText(ical.PropVersion, "2.0")
	versioned.Props.SetText(ical.PropProductID, "-//a//EN")
	versioned.Props.Add(ical.NewProp(ical.PropProductID))
	tests := []struct {
		name string
		cal  *ical.Calendar
		want []string
	}{
		{"no VERSION or PRODID", calendar(event([2]string{"UID", "a"}, [2]string{"DTSTAMP", "20250301T000000Z"})), []string{"BEGIN:VEVENT"}},
		{"no UID or DTSTAMP", calendar(event([2]string{"SUMMARY", canary})), []string{"BEGIN:VEVENT", "SUMMARY:"}},
		{"two UIDs", calendar(event([2]string{"UID", "a"}, [2]string{"UID", "b"}, [2]string{"DTSTAMP", "20250301T000000Z"})), []string{"BEGIN:VEVENT", "UID:"}},
		{"two RRULEs", calendar(event([2]string{"RRULE", "FREQ=DAILY"}, [2]string{"RRULE", "FREQ=WEEKLY"})), []string{"RRULE:FREQ=DAILY", "RRULE:FREQ=WEEKLY"}},
		{"two SUMMARYs and DESCRIPTIONs", calendar(event([2]string{"SUMMARY", canary}, [2]string{"SUMMARY", canary}, [2]string{"DESCRIPTION", canary}, [2]string{"DESCRIPTION", canary})), []string{"SUMMARY:", "DESCRIPTION:"}},
		{"DTEND and DURATION", calendar(event([2]string{"DTEND", "20250301T000000Z"}, [2]string{"DURATION", "PT1H"})), []string{"DTEND:", "DURATION:"}},
		{"a child that is no VALARM", calendar(nested), []string{"BEGIN:VEVENT"}},
		{"a quote in a parameter", calendar(quoted), []string{"ATTENDEE;CN=", "DELEGATED-FROM="}},
		{"two PRODIDs", versioned, []string{"PRODID:", "VERSION:"}},
		{"no components", calendar(), []string{"BEGIN:VCALENDAR", "END:VCALENDAR"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			data := encodeForSkeleton(tt.cal)

			sk := diag.ICalSkeleton(data)
			for _, want := range append([]string{"BEGIN:VCALENDAR", "END:VCALENDAR"}, tt.want...) {
				if !strings.Contains(sk.Text, want) {
					t.Errorf("skeleton lacks %q:\n%s", want, sk.Text)
				}
			}
			noCanary(t, "skeleton", sk.Text)
			// The same object, the same skeleton: a repeat of a problem is told by it.
			if again := encodeForSkeleton(tt.cal); !bytes.Equal(data, again) {
				t.Errorf("encoded twice differently:\n%s\n%s", data, again)
			}
		})
	}
}

func TestReasons(t *testing.T) {
	t.Parallel()
	parseErr := errors.New(`ical: malformed component: expected END property for "VEVENT", got "` + canary + `"`)
	status := func(code int) error {
		return &statusError{Method: "PUT", URL: "http://host/{home}/cal-00000000/obj-00000000.ics", Code: code}
	}
	tests := []struct {
		name        string
		err         error
		wantProblem string
		wantFailure string
	}{
		{"nil", nil, "", ""},
		{"a refusal", mapWriteError(status(http.StatusForbidden)), "HTTP 403", "HTTP 403"},
		{"a failure", mapError(status(http.StatusBadGateway)), "HTTP 502", "HTTP 502"},
		{"too many redirects", fmt.Errorf("%w: %w", domain.ErrUpstream, errTooManyRedirects), "upstream error: too many redirects", "redirect"},
		{"no name", mapError(&net.DNSError{Err: "no such host", Name: canary + ".example.test"}), "upstream error", "dns"},
		{"a parser", parseErr, "ical: malformed component", "ical: malformed component"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := problemReason(tt.err); got != tt.wantProblem {
				t.Errorf("problemReason = %q; want %q", got, tt.wantProblem)
			}
			if got := failureReason(tt.err); got != tt.wantFailure {
				t.Errorf("failureReason = %q; want %q", got, tt.wantFailure)
			}
			noCanary(t, "reason", problemReason(tt.err)+failureReason(tt.err))
		})
	}
}

// An error for data that cannot be read has the fixed wording of the cause and
// no more: it reaches the logs through the API (NFR-36).
func TestInvalidData(t *testing.T) {
	t.Parallel()
	cause := fmt.Errorf("DTSTART: invalid date-time %q: %w", canary, io.ErrUnexpectedEOF)

	err := invalidData("invalid event", cause)

	mustErr(t, err, domain.ErrUpstream)
	if errors.Is(err, io.ErrUnexpectedEOF) {
		t.Errorf("error %q wraps its cause; want the wording only", err)
	}
	noCanary(t, "error", err.Error())
	if !strings.Contains(err.Error(), "invalid event") {
		t.Errorf("error %q; want it to say what was invalid", err)
	}
}

func TestIsXMLType(t *testing.T) {
	t.Parallel()
	for ctype, want := range map[string]bool{
		"application/xml":                       true,
		"application/xml; charset=utf-8":        true,
		"Text/XML":                              true,
		" text/xml ;charset=UTF-8":              true,
		"application/problem+xml":               true,
		"application/calendar+xml; charset=utf": true,
		"text/html":                             false,
		"application/json":                      false,
		"text/calendar":                         false,
		"":                                      false,
		"xml":                                   false,
	} {
		if got := isXMLType(ctype); got != want {
			t.Errorf("isXMLType(%q) = %v; want %v", ctype, got, want)
		}
	}
}

// Reading a calendar again does not record its problems again: the objects come
// from the cache and are expanded on every request, and one bad series would
// fill the buffer (FR-36).
func TestProblemRecordedOncePerBuffer(t *testing.T) {
	t.Parallel()
	r := newProblemRun(t)
	r.putCanaryEvent(t, "personal", canary+"-obj.ics", "RRULE:FREQ=ZZ")
	_, err := r.listEvents(t, "personal")
	mustNoErr(t, err)
	first := r.problems()
	calID := r.calendarID(t, r.svc, "Personal")

	for _, ctx := range []context.Context{
		scopedCtx(t.Context(), r.buf, "req-2"),
		domain.WithRevalidation(scopedCtx(t.Context(), r.buf, "req-3")),
	} {
		_, err = r.svc.ListEvents(ctx, calID, date(2025, 3, 1, 0, 0), date(2025, 3, 8, 0, 0))
		mustNoErr(t, err)
	}

	got := r.problems()
	if len(got) != 1 || got[0].Kind != diag.ProblemInvalidObject || got[0].Path != first[0].Path || got[0].ObjectID != first[0].ObjectID {
		t.Fatalf("problems = %+v; want the one problem of before", got)
	}
	if got[0].RequestID != "req-3" || got[0].At.Before(first[0].At) {
		t.Errorf("problem = %+v; want it refreshed by the last request", got[0])
	}
	if lines := r.problemLines(t); len(lines) != 1 {
		t.Errorf("problem log lines = %d; want the one of the first time", len(lines))
	}
}

// The cache belongs to the provider and outlives the sessions: an object that
// did not parse is dropped from it, so a session served from the cache would
// never hear of it unless the cache remembers the problem (FR-36).
func TestProblemUnparsableObjectReplayed(t *testing.T) {
	t.Parallel()
	for _, tt := range []struct {
		name  string
		scope func(context.Context) context.Context
	}{
		{"fresh entry", func(ctx context.Context) context.Context { return ctx }},
		{"entry checked and unchanged", domain.WithRevalidation},
	} {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			r := newProblemRun(t)
			r.answerReport("personal",
				reportObject{"good.ics", canaryEvent("good")},
				reportObject{canary + "-broken.ics", brokenObject})
			_, err := r.listEvents(t, "personal")
			mustNoErr(t, err)
			if n := r.mock.Count("REPORT"); n != 1 {
				t.Fatalf("REPORTs = %d; want the one that filled the cache", n)
			}

			// Another session of the account, with a buffer of its own.
			other := diag.NewBuffer(diag.SessionLimits)
			svc := r.p.Service(r.acct)
			evs, err := svc.ListEvents(tt.scope(scopedCtx(t.Context(), other, "req-2")),
				r.calendarID(t, svc, "Personal"), date(2025, 3, 1, 0, 0), date(2025, 3, 8, 0, 0))

			mustNoErr(t, err)
			if n := r.mock.Count("REPORT"); n != 1 || len(evs) != 1 {
				t.Fatalf("REPORTs, events = %d, %d; want 1 and 1: served from the cache", n, len(evs))
			}
			got := other.Snapshot().Problems
			if len(got) != 1 {
				t.Fatalf("problems of the other session = %+v; want one", got)
			}
			pr := got[0]
			if pr.Kind != diag.ProblemUnparsableObject || pr.RequestID != "req-2" || !objectPseudonym.MatchString(pr.Path) {
				t.Errorf("problem = %+v; want unparsable_object of req-2 with a pseudonymised path", pr)
			}
			if id, ok := r.p.ids.open(pr.ObjectID); !ok || id != r.calPath("personal")+canary+"-broken.ics" {
				t.Errorf("ObjectID decodes to %q, %v; want the broken object", id, ok)
			}
			if first := r.problems(); len(first) != 1 || first[0].Reason != pr.Reason || first[0].Skeleton != pr.Skeleton || first[0].Path != pr.Path {
				t.Errorf("problem of the first session = %+v; want what the other got: %+v", first, pr)
			}
			// The problem is logged once by the process, not once by each session.
			if lines := r.problemLines(t); len(lines) != 1 {
				t.Errorf("problem log lines = %d; want the one of the read that filled the cache", len(lines))
			}
			noCanary(t, "log", r.logs.String())
		})
	}
}

// Without a buffer a request has nothing to replay into: a warm cache must not
// log the same warning on every read.
func TestProblemReplayNeedsABuffer(t *testing.T) {
	t.Parallel()
	r := newProblemRun(t)
	r.ctx = t.Context()
	r.answerReport("personal", reportObject{canary + "-broken.ics", brokenObject})

	for range 3 {
		_, err := r.listEvents(t, "personal")
		mustNoErr(t, err)
	}

	if n := r.mock.Count("REPORT"); n != 1 {
		t.Fatalf("REPORTs = %d; want 1", n)
	}
	if lines := r.problemLines(t); len(lines) != 1 {
		t.Errorf("problem log lines = %d; want the one of the read that filled the cache", len(lines))
	}
}

// A task whose rule Lucid cannot evaluate is skipped from the occurrences, as
// an event with such a rule is a problem: the same for tasks as for events.
func TestProblemUnsupportedTodoRule(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name       string
		lines      []string
		wantReason string
	}{
		{"unknown frequency", []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=ZZ"}, "RRULE"},
		{"unparsable rule", []string{"DTSTART:20250310T090000Z", "RRULE:" + canary}, "RRULE"},
		{"RDATE", []string{"DTSTART:20250310T090000Z", "RDATE:20250312T090000Z"}, "RDATE"},
		{"no anchor", []string{"RRULE:FREQ=DAILY"}, "without DTSTART or DUE"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			r := newProblemRun(t)
			objPath, err := r.mock.PutObject(r.calPath("tasks"), canary+"-todo.ics", ics(append([]string{
				"BEGIN:VTODO", "UID:" + canary, "DTSTAMP:20250301T000000Z", "SUMMARY:" + canary + " title",
			}, append(tt.lines, "END:VTODO")...)...))
			mustNoErr(t, err)

			occs, err := r.svc.ListTodoOccurrences(r.ctx, r.calendarID(t, r.svc, "Tasks"), date(2025, 6, 1, 0, 0), date(2025, 6, 8, 0, 0))

			mustNoErr(t, err)
			if len(occs) != 0 {
				t.Errorf("occurrences = %+v; want the task skipped", occs)
			}
			got := r.problems()
			if len(got) != 1 || got[0].Kind != diag.ProblemInvalidObject {
				t.Fatalf("problems = %+v; want one invalid_object", got)
			}
			pr := got[0]
			if id, ok := r.p.ids.open(pr.ObjectID); !ok || id != objPath {
				t.Errorf("ObjectID decodes to %q, %v; want %q", id, ok, objPath)
			}
			if pr.Reason == "" || !strings.Contains(pr.Reason, tt.wantReason) || !strings.Contains(pr.Skeleton.Text, "BEGIN:VTODO") {
				t.Errorf("Reason, Skeleton = %q, %q; want a reason with %q and the shape of the task", pr.Reason, pr.Skeleton.Text, tt.wantReason)
			}
			noCanary(t, "Reason", pr.Reason)
			noCanary(t, "Skeleton", pr.Skeleton.Text)
			noCanary(t, "log", r.logs.String())
		})
	}
}

// What is not XML is not a failed multistatus but the answer of something else,
// a web server that does not speak CalDAV: no problem, no warning (FR-36).
func TestProblemInvalidXMLNeedsXML(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name       string
		status     int
		ctype      string // "" sends none
		body       string
		wantReason string // "" for no problem
	}{
		{"broken XML", http.StatusMultiStatus, "application/xml", "<d:multistatus xmlns:d=\"DAV:\"><d:response></d:multistatus>", "XML syntax error"},
		{"broken text/xml", http.StatusMultiStatus, "text/xml; charset=utf-8", "<d:multistatus", "XML syntax error"},
		{"another root element", http.StatusOK, "application/xml", "<html><body>" + canary + "</body></html>", "unexpected root element"},
		{"an HTML page", http.StatusOK, "text/html; charset=utf-8", "<html><body>" + canary + "</body></html>", ""},
		{"plain text", http.StatusOK, "text/plain", "hello " + canary, ""},
		{"no content type", http.StatusOK, "", "<d:multistatus", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			r := newProblemRun(t)
			r.hook(func(w http.ResponseWriter, req *http.Request) bool {
				if req.Method != "PROPFIND" || req.URL.Path != r.mock.HomePath() {
					return false
				}
				if tt.ctype != "" {
					w.Header().Set("Content-Type", tt.ctype)
				} else {
					w.Header()["Content-Type"] = nil // no sniffing either
				}
				w.WriteHeader(tt.status)
				_, _ = io.WriteString(w, tt.body)
				return true
			})

			_, err := r.svc.ListCalendars(r.ctx)

			mustErr(t, err, domain.ErrUpstream)
			noCanary(t, "error", err.Error())
			got := r.problems()
			if tt.wantReason == "" {
				if len(got) != 0 {
					t.Errorf("problems = %+v; want none", got)
				}
				for _, m := range logLines(t, r.logs) {
					if m["level"] == "WARN" {
						t.Errorf("warning %v; want none", m)
					}
				}
				return
			}
			if len(got) != 1 || got[0].Kind != diag.ProblemInvalidXML || !strings.Contains(got[0].Reason, tt.wantReason) {
				t.Fatalf("problems = %+v; want one invalid_xml with %q", got, tt.wantReason)
			}
			noCanary(t, "log", r.logs.String())
		})
	}
}

func TestDiscoveryOfAWebsiteRecordsNoProblem(t *testing.T) {
	t.Parallel()
	r := newProblemRun(t)
	r.hook(func(w http.ResponseWriter, req *http.Request) bool {
		if req.Method != "PROPFIND" {
			return false
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = io.WriteString(w, "<html><body>Welcome to "+canary+"</body></html>")
		return true
	})
	buf := diag.NewBuffer(diag.AnonymousLimits)

	_, err := r.p.Connect(scopedCtx(t.Context(), buf, "req-9"),
		domain.Credentials{ServerURL: r.ts.URL, Username: traceUser, Password: tracePass})

	mustErr(t, err, domain.ErrDiscovery)
	if got := buf.Snapshot().Problems; len(got) != 0 {
		t.Errorf("problems = %+v; want none", got)
	}
	if got := len(buf.Snapshot().Exchanges); got == 0 {
		t.Errorf("exchanges = %d; want the trace of the attempts", got)
	}
	for _, m := range logLines(t, r.logs) {
		if m["level"] == "WARN" {
			t.Errorf("warning %v; want none", m)
		}
	}
}

// An error body to a DELETE is the server's error answer, but no write of Lucid's
// own payload was refused: error_response, not rejected_write (FR-36).
func TestProblemDeleteErrorIsNoRejectedWrite(t *testing.T) {
	t.Parallel()
	r := newProblemRun(t)
	r.putCanaryEvent(t, "personal", canary+"-obj.ics")
	evs, err := r.listEvents(t, "personal")
	mustNoErr(t, err)
	r.hook(func(w http.ResponseWriter, req *http.Request) bool {
		if req.Method != http.MethodDelete {
			return false
		}
		w.Header().Set("Content-Type", "application/xml; charset=utf-8")
		w.WriteHeader(http.StatusForbidden)
		_, _ = io.WriteString(w, sabreError)
		return true
	})

	err = r.svc.DeleteEvent(r.ctx, evs[0].ID, evs[0].ETag)

	mustErr(t, err, domain.ErrReadOnly)
	got := r.problems()
	if len(got) != 1 || got[0].Kind != diag.ProblemErrorResponse || !strings.Contains(got[0].Skeleton.Text, `Sabre\DAV\Exception\Forbidden`) {
		t.Fatalf("problems = %+v; want one error_response with the exception class", got)
	}
	noCanary(t, "log", r.logs.String())
}

// A server decides how many objects of a calendar do not parse: the cache keeps
// the problems of no more than a buffer holds.
func TestProblemUnreadableObjectsAreCapped(t *testing.T) {
	t.Parallel()
	r := newProblemRun(t)
	r.buf = diag.NewBuffer(diag.Limits{Problems: 100})
	r.ctx = scopedCtx(t.Context(), r.buf, "req-1")
	var objs []reportObject
	for i := range 2 * maxUnreadable {
		objs = append(objs, reportObject{fmt.Sprintf("broken-%d.ics", i), brokenObject})
	}
	r.answerReport("personal", objs...)

	_, err := r.listEvents(t, "personal")

	mustNoErr(t, err)
	if got := len(r.problems()); got != maxUnreadable {
		t.Errorf("problems = %d; want the %d the cache keeps", got, maxUnreadable)
	}
}

// putBrokenEvents stores n events with a rule Lucid cannot evaluate in the
// calendar slug, each a problem of its own.
func (r *problemRun) putBrokenEvents(t *testing.T, slug string, n int) {
	t.Helper()
	for i := range n {
		r.putCanaryEvent(t, slug, fmt.Sprintf("broken-%d.ics", i), "RRULE:FREQ=ZZ")
	}
}

// A problem of an object comes back on every read of its calendar, and a
// calendar can have more of them than a buffer holds: each is logged once by
// the process (FR-36).
func TestProblemRecurringLoggedOnce(t *testing.T) {
	t.Parallel()
	r := newProblemRun(t)
	const n = 30 // more than the buffer holds
	r.putBrokenEvents(t, "personal", n)

	for _, revalidate := range []bool{false, false, true, false} {
		ctx := scopedCtx(t.Context(), r.buf, "req-x")
		if revalidate {
			ctx = domain.WithRevalidation(ctx)
		}
		_, err := r.svc.ListEvents(ctx, r.calendarID(t, r.svc, "Personal"), date(2025, 3, 1, 0, 0), date(2025, 3, 8, 0, 0))
		mustNoErr(t, err)
	}

	paths := map[string]bool{}
	for _, m := range r.problemLines(t) {
		path, _ := m["path"].(string)
		if m["kind"] != "invalid_object" || paths[path] {
			t.Errorf("problem line %v; want an invalid_object, once for each path", m)
		}
		paths[path] = true
	}
	if len(paths) != n {
		t.Errorf("logged problems = %d; want %d, each once", len(paths), n)
	}
	if got := len(r.problems()); got != diag.SessionLimits.Problems {
		t.Errorf("problems in the buffer = %d; want the limit, %d", got, diag.SessionLimits.Problems)
	}
	noCanary(t, "log", r.logs.String())
}

// With no buffer to tell a repeat, a read still logs a problem of an object once.
func TestProblemRecurringWithoutScopeLoggedOnce(t *testing.T) {
	t.Parallel()
	r := newProblemRun(t)
	r.ctx = t.Context()
	r.putBrokenEvents(t, "personal", 1)

	for range 3 {
		_, err := r.listEvents(t, "personal")
		mustNoErr(t, err)
	}

	if lines := r.problemLines(t); len(lines) != 1 {
		t.Errorf("problem log lines = %d; want one for the three reads", len(lines))
	}
}

// What a server refused is gone from the report the moment it is pushed out, so
// the reads that bring the problems of the calendar back must not do it: more
// of them than the buffer holds, and a refused write the user has just seen
// (FR-36).
func TestProblemOneOffSurvivesReads(t *testing.T) {
	t.Parallel()
	r := newProblemRun(t)
	r.putBrokenEvents(t, "personal", 2*diag.SessionLimits.Problems)
	_, err := r.listEvents(t, "personal")
	mustNoErr(t, err)
	r.answerPut(http.StatusForbidden, "application/xml; charset=utf-8", sabreError)
	_, err = r.svc.CreateEvent(r.ctx, r.calendarID(t, r.svc, "Personal"), domain.EventInput{
		Title: canary, Start: date(2025, 3, 2, 10, 0), End: date(2025, 3, 2, 11, 0),
	})
	mustErr(t, err, domain.ErrReadOnly)

	for range 3 {
		_, err = r.listEvents(t, "personal")
		mustNoErr(t, err)
	}

	kinds := map[diag.ProblemKind]int{}
	for _, pr := range r.problems() {
		kinds[pr.Kind]++
	}
	if kinds[diag.ProblemErrorResponse] != 1 || kinds[diag.ProblemRejectedWrite] != 1 ||
		len(r.problems()) != diag.SessionLimits.Problems {
		t.Errorf("problems by kind = %v; want the refused write kept, among %d in all", kinds, diag.SessionLimits.Problems)
	}
}

func TestRecentSet(t *testing.T) {
	t.Parallel()
	t.Run("a key is new once", func(t *testing.T) {
		t.Parallel()
		s := newRecentSet(3)
		for _, key := range []string{"a", "b", "c"} {
			if !s.add(key) {
				t.Errorf("add(%q) = false; want new", key)
			}
		}
		for _, key := range []string{"a", "b", "c"} {
			if s.add(key) {
				t.Errorf("add(%q) again = true; want known", key)
			}
		}
	})
	t.Run("the oldest is forgotten at the limit", func(t *testing.T) {
		t.Parallel()
		s := newRecentSet(3)
		for _, key := range []string{"a", "b", "c", "d"} {
			s.add(key)
		}
		// d took the place of a; b, c and d are known.
		for _, key := range []string{"b", "c", "d"} {
			if s.add(key) {
				t.Errorf("add(%q) = true; want known", key)
			}
		}
		if !s.add("a") {
			t.Error("add(a) = false; want it forgotten")
		}
		// a took the place of b, the oldest then.
		if !s.add("b") || s.add("d") {
			t.Error("b known or d forgotten; want b forgotten and d known")
		}
		if got := len(s.set); got != 3 {
			t.Errorf("set holds %d keys; want 3", got)
		}
	})
	t.Run("a limit below one is one", func(t *testing.T) {
		t.Parallel()
		s := newRecentSet(0)
		if !s.add("a") || s.add("a") || !s.add("b") || !s.add("a") {
			t.Error("a set of one key did not behave as one")
		}
	})
	t.Run("concurrent adds tell each key new once", func(t *testing.T) {
		t.Parallel()
		const keys = 200
		s := newRecentSet(1000)
		var news atomic.Int64
		var wg sync.WaitGroup
		for range 8 {
			wg.Go(func() {
				for i := range 4 * keys {
					if s.add(strconv.Itoa(i % keys)) {
						news.Add(1)
					}
				}
			})
		}
		wg.Wait()
		if got := news.Load(); got != keys {
			t.Errorf("new keys = %d; want %d", got, keys)
		}
	})
}

// The set of a provider holds as many recurring problems as it says.
func TestProviderRemembersLoggedProblems(t *testing.T) {
	t.Parallel()
	p := newProvider(t, http.DefaultClient)
	if got := cap(p.logged.order); got != maxLoggedProblems || maxLoggedProblems != 1024 {
		t.Errorf("provider remembers %d problems; want 1024", got)
	}
}

// panickingObject is iCalendar that go-ical panics on rather than reject: a
// quoted parameter value followed by more text. The panic's value names the
// character after the quote, here one of the canary.
const panickingObject = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\nBEGIN:VEVENT\r\nUID:" + canary + "-uid\r\n" +
	"DTSTAMP:20250301T000000Z\r\nDTSTART:20250302T100000Z\r\n" +
	`ATTENDEE;CN="Bob"` + canary + ":mailto:" + canary + "@example.test\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"

func TestDecodeICal(t *testing.T) {
	t.Parallel()
	t.Run("a panic of the decoder is an error of fixed wording", func(t *testing.T) {
		t.Parallel()
		cal, err := decodeICal([]byte(panickingObject))
		if cal != nil || !errors.Is(err, errDecoderPanic) {
			t.Fatalf("decodeICal = %v, %v; want nil, errDecoderPanic", cal, err)
		}
		noCanary(t, "error", err.Error())
	})
	t.Run("an error of the decoder stays its own", func(t *testing.T) {
		t.Parallel()
		_, err := decodeICal([]byte(brokenObject))
		if err == nil || errors.Is(err, errDecoderPanic) {
			t.Errorf("decodeICal = %v; want the decoder's error", err)
		}
	})
	t.Run("data that parse", func(t *testing.T) {
		t.Parallel()
		cal, err := decodeICal([]byte(canaryEvent("a")))
		if err != nil || cal == nil || len(cal.Children) != 1 {
			t.Errorf("decodeICal = %v, %v; want the calendar with its event", cal, err)
		}
	})
}

// An object go-ical panics on is one that does not parse: skipped from the
// listing with a problem, the other objects listed, and nothing of the panic,
// which names a character of the object, in the log (FR-36, NFR-36).
func TestProblemDecoderPanicInListing(t *testing.T) {
	t.Parallel()
	r := newProblemRun(t)
	r.answerReport("personal",
		reportObject{"good.ics", canaryEvent("good")},
		reportObject{canary + "-panic.ics", panickingObject})

	evs, err := r.listEvents(t, "personal")

	mustNoErr(t, err)
	if len(evs) != 1 || evs[0].UID != "good" {
		t.Fatalf("events = %+v; want the one good event", evs)
	}
	got := r.problems()
	if len(got) != 1 || got[0].Kind != diag.ProblemUnparsableObject || got[0].Reason != diag.Reason(errDecoderPanic) {
		t.Fatalf("problems = %+v; want one unparsable_object with the fixed reason", got)
	}
	if id, ok := r.p.ids.open(got[0].ObjectID); !ok || id != r.calPath("personal")+canary+"-panic.ics" {
		t.Errorf("ObjectID decodes to %q, %v; want the object", id, ok)
	}
	noCanary(t, "Skeleton", got[0].Skeleton.Text)
	if out := r.logs.String(); strings.Contains(out, "unexpected character") || strings.Contains(out, "panic") {
		t.Errorf("log carries the panic:\n%s", out)
	}
	noCanary(t, "log", r.logs.String())
}

// The same for an object read on its own, as a change reads it.
func TestProblemDecoderPanicOnRead(t *testing.T) {
	t.Parallel()
	r := newProblemRun(t)
	objPath := r.putCanaryEvent(t, "personal", canary+"-obj.ics")
	evs, err := r.listEvents(t, "personal")
	mustNoErr(t, err)
	r.hook(func(w http.ResponseWriter, req *http.Request) bool {
		if req.Method != http.MethodGet || req.URL.Path != objPath {
			return false
		}
		w.Header().Set("Content-Type", "text/calendar")
		_, _ = io.WriteString(w, panickingObject)
		return true
	})

	_, _, err = r.svc.UpdateEvent(r.ctx, evs[0].ID, evs[0].ETag, domain.EventInput{
		Title: "x", Start: date(2025, 3, 2, 10, 0), End: date(2025, 3, 2, 11, 0),
	})

	mustErr(t, err, domain.ErrUpstream)
	noCanary(t, "error", err.Error())
	got := r.problems()
	if len(got) != 1 || got[0].Kind != diag.ProblemUnparsableObject || got[0].Reason != diag.Reason(errDecoderPanic) {
		t.Fatalf("problems = %+v; want one unparsable_object with the fixed reason", got)
	}
	if out := r.logs.String(); strings.Contains(out, "unexpected character") || strings.Contains(out, "panic") {
		t.Errorf("log carries the panic:\n%s", out)
	}
	noCanary(t, "log", r.logs.String())
}

// The longest object path is the longest whose ID the routes take.
func TestMaxObjectPath(t *testing.T) {
	t.Parallel()
	c := newTestCodec(t)
	if n := len(c.encode(strings.Repeat("a", maxObjectPath))); n != domain.MaxIDLen {
		t.Errorf("ID of the longest path has %d characters; want %d", n, domain.MaxIDLen)
	}
	if n := len(c.encode(strings.Repeat("a", maxObjectPath+1))); n <= domain.MaxIDLen {
		t.Errorf("ID of a longer path has %d characters; want more than %d", n, domain.MaxIDLen)
	}
	// A buffer keeps every ID a route takes whole.
	if diag.MaxObjectID != domain.MaxIDLen {
		t.Errorf("diag.MaxObjectID = %d; want domain.MaxIDLen, %d", diag.MaxObjectID, domain.MaxIDLen)
	}
}

// objectNamed is a name for an object of the calendar at calPath whose path is
// n bytes long.
func objectNamed(t *testing.T, calPath string, n int) string {
	t.Helper()
	name := strings.Repeat("d", n-len(calPath)-len(".ics")) + ".ics"
	if got := len(calPath + name); got != n {
		t.Fatalf("path has %d bytes; want %d", got, n)
	}
	return name
}

// A server chooses how long the hrefs of its objects are, and the work of a
// problem grows with that length on every read. An object no route could
// address by its ID is left out, without a problem and without a log line; one
// at the limit is not (NFR-24, FR-36).
func TestQueryLeavesOutTooLongPaths(t *testing.T) {
	t.Parallel()
	r := newProblemRun(t)
	cal := r.calPath("personal")
	atLimit := objectNamed(t, cal, maxObjectPath)
	tooLong := "x" + atLimit
	r.answerReport("personal",
		reportObject{"good.ics", canaryEvent("good")},
		reportObject{"y" + atLimit, canaryEvent("deep")},
		reportObject{atLimit, brokenObject},
		reportObject{tooLong, brokenObject},
		reportObject{strings.Repeat("x/", 5000) + "deeper.ics", brokenObject},
	)

	evs, err := r.listEvents(t, "personal")

	mustNoErr(t, err)
	if len(evs) != 1 || evs[0].UID != "good" {
		t.Fatalf("events = %+v; want only the good one", evs)
	}
	got := r.problems()
	if len(got) != 1 {
		t.Fatalf("problems = %+v; want the one of the object at the limit", got)
	}
	if id, ok := r.p.ids.open(got[0].ObjectID); !ok || id != cal+atLimit || len(got[0].ObjectID) != domain.MaxIDLen {
		t.Errorf("ObjectID (%d characters) decodes to a path of %d bytes, %v; want the object at the limit", len(got[0].ObjectID), len(id), ok)
	}
	if lines := r.problemLines(t); len(lines) != 1 {
		t.Errorf("problem log lines = %d; want the one at the limit", len(lines))
	}
	if notes := r.buf.Snapshot().Calendars; len(notes) != 1 || notes[0].Objects != 2 {
		t.Errorf("notes = %+v; want 2 objects, the ones too long left out", notes)
	}
}

// A cache entry keeps its problems as they were made: a read from the cache
// replays them without pseudonymising and encrypting their paths again. With
// the provider's keys changed after the entry was made, a problem made anew
// would differ from the one the first read recorded.
func TestProblemReplayedAsMade(t *testing.T) {
	t.Parallel()
	r := newProblemRun(t)
	r.answerReport("personal",
		reportObject{"good.ics", canaryEvent("good")},
		reportObject{canary + "-broken.ics", brokenObject})
	_, err := r.listEvents(t, "personal")
	mustNoErr(t, err)
	first := r.problems()
	if len(first) != 1 {
		t.Fatalf("problems = %+v; want one", first)
	}

	r.p.ids = newTestCodec(t)
	r.p.pseudo = diag.NewPseudonymizer([]byte("another key"))
	other := diag.NewBuffer(diag.SessionLimits)
	svc := r.p.Service(r.acct)
	_, err = svc.ListEvents(scopedCtx(t.Context(), other, "req-2"), r.calendarID(t, svc, "Personal"),
		date(2025, 3, 1, 0, 0), date(2025, 3, 8, 0, 0))

	mustNoErr(t, err)
	if n := r.mock.Count("REPORT"); n != 1 {
		t.Fatalf("REPORTs = %d; want the read served from the cache", n)
	}
	got := other.Snapshot().Problems
	if len(got) != 1 || got[0].Path != first[0].Path || got[0].ObjectID != first[0].ObjectID {
		t.Errorf("replayed problem = %+v; want the one made with the entry: %+v", got, first)
	}
	if r.p.pseudo.Path(r.names(), r.calPath("personal")+canary+"-broken.ics") == first[0].Path {
		t.Error("the new key gives the same pseudonym; the test checks nothing")
	}
}

// The provider remembers the problems it logged by keys of a fixed size,
// whatever the length of their paths.
func TestLoggedKeys(t *testing.T) {
	t.Parallel()
	base := diag.Problem{Kind: diag.ProblemInvalidObject, Path: "{home}/cal-1/obj-1.ics", Reason: "r"}
	long := base
	long.Path = strings.Repeat("seg-12345678/", 1000)
	keys := map[string]bool{}
	for _, pr := range []diag.Problem{
		base, long,
		{Kind: diag.ProblemUnparsableObject, Path: base.Path, Reason: base.Reason},
		{Kind: base.Kind, Path: base.Path + "x", Reason: base.Reason},
		{Kind: base.Kind, Path: base.Path, Reason: base.Reason + "x"},
		// The parts are kept apart: a reason cannot pass for the end of a path.
		{Kind: base.Kind, Path: base.Path + "\x00r", Reason: ""},
	} {
		key := loggedKey(pr)
		if len(key) != loggedKeySize {
			t.Errorf("key of %.40q has %d bytes; want %d", pr.Path, len(key), loggedKeySize)
		}
		if keys[key] {
			t.Errorf("key of %+v is that of another problem", pr)
		}
		keys[key] = true
	}
	again := diag.Problem{Kind: diag.ProblemInvalidObject, Path: strings.Repeat("seg-12345678/", 1000), Reason: "r"}
	if loggedKey(again) != loggedKey(long) {
		t.Error("the same problem has another key")
	}

	r := newProblemRun(t)
	r.putBrokenEvents(t, "personal", 3)
	_, err := r.listEvents(t, "personal")
	mustNoErr(t, err)
	if n := len(r.p.logged.set); n != 3 {
		t.Fatalf("logged set holds %d keys; want one per problem, 3", n)
	}
	for key := range r.p.logged.set {
		if len(key) != loggedKeySize {
			t.Errorf("logged key has %d bytes; want %d", len(key), loggedKeySize)
		}
	}
}
