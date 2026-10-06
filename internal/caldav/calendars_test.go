package caldav

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"github.com/tbckr/lucid/internal/caldav/caldavtest"
	"github.com/tbckr/lucid/internal/domain"
)

func TestListCalendars(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	got, err := e.svc.ListCalendars(t.Context())
	mustNoErr(t, err)
	want := []domain.Calendar{
		{ID: e.cals["holidays"], Name: "Holidays", Color: defaultColor(e.paths["holidays"]), ReadOnly: true, SupportsEvents: true},
		{ID: e.cals["personal"], Name: "Personal", Color: "#3b82f6", SupportsEvents: true},
		{ID: e.cals["tasks"], Name: "Tasks", Color: "#f97316", SupportsTodos: true},
		{ID: e.cals["work"], Name: "Work", Description: "Job stuff", Color: defaultColor(e.paths["work"]), SupportsEvents: true, SupportsTodos: true},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("ListCalendars =\n%+v\nwant\n%+v", got, want)
	}
}

// calendarListing serves a fixed home-set PROPFIND response.
func calendarListing(t *testing.T, body string) domain.CalendarService {
	t.Helper()
	e := newEnv(t, caldavtest.Options{})
	e.mock.SetHook(func(w http.ResponseWriter, r *http.Request) bool {
		if r.Method == "PROPFIND" && r.URL.Path == e.mock.HomePath() {
			w.WriteHeader(http.StatusMultiStatus)
			_, _ = io.WriteString(w, body)
			return true
		}
		return false
	})
	return e.svc
}

func TestListCalendarsServerVariants(t *testing.T) {
	t.Parallel()
	body := `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/">
 <d:response><d:href>/user/calendars/</d:href>
  <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
 <d:response><d:href>/user/calendars/nocomps</d:href>
  <d:propstat><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><a:calendar-color>#abc</a:calendar-color></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  <d:propstat><d:prop><d:displayname/><c:supported-calendar-component-set/><d:current-user-privilege-set/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>
 <d:response><d:href>/user/calendars/journal/</d:href>
  <d:propstat><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><c:supported-calendar-component-set><c:comp name="VJOURNAL"/></c:supported-calendar-component-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
 <d:response><d:href>/user/calendars/inbox/</d:href>
  <d:propstat><d:prop><d:resourcetype><d:collection/><c:schedule-inbox/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
 <d:response><d:href>https://evil.example/user/calendars/x/</d:href>
  <d:propstat><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
 <d:response><d:href>/other/calendars/x/</d:href>
  <d:propstat><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
 <d:response><d:href>/user/calendars/sub/nested/</d:href>
  <d:propstat><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
 <d:response>
  <d:propstat><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>`
	svc := calendarListing(t, body)
	got, err := svc.ListCalendars(t.Context())
	mustNoErr(t, err)
	want := []domain.Calendar{{
		ID: encodeID("/user/calendars/nocomps/"), Name: "nocomps", Color: "#aabbcc",
		SupportsEvents: true, SupportsTodos: true,
	}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("ListCalendars = %+v; want %+v", got, want)
	}
}

// TestXMLEntitiesNotExpanded shows that DTDs and external entities in server
// responses are never resolved (NFR-24).
func TestXMLEntitiesNotExpanded(t *testing.T) {
	t.Parallel()
	payloads := map[string]string{
		"external entity": `<?xml version="1.0"?>
<!DOCTYPE d [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/user/calendars/x/</d:href>
<d:propstat><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>&xxe;</d:displayname></d:prop>
<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`,
		"internal entity": `<?xml version="1.0"?>
<!DOCTYPE d [<!ENTITY a "AAAAAAAAAAAAAAAAAAAA"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;">]>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/user/calendars/x/</d:href>
<d:propstat><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>&b;</d:displayname></d:prop>
<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`,
	}
	for name, body := range payloads {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			_, err := parseMultistatus([]byte(body))
			mustErr(t, err, domain.ErrUpstream)

			cals, err := calendarListing(t, body).ListCalendars(t.Context())
			if err == nil {
				for _, c := range cals {
					if strings.Contains(c.Name, "root:") || strings.Contains(c.Name, "AAAA") {
						t.Fatalf("entity was expanded: %q", c.Name)
					}
				}
			}
			mustErr(t, err, domain.ErrUpstream)
		})
	}
}

func TestResponseSizeLimit(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	e.mock.SetHook(func(w http.ResponseWriter, r *http.Request) bool {
		if r.Method == "PROPFIND" && r.URL.Path == e.mock.HomePath() {
			w.WriteHeader(http.StatusMultiStatus)
			chunk := bytes.Repeat([]byte(" "), 1<<20)
			for range maxBodySize>>20 + 1 {
				if _, err := w.Write(chunk); err != nil {
					return true
				}
			}
			return true
		}
		return false
	})
	_, err := e.svc.ListCalendars(t.Context())
	mustErr(t, err, domain.ErrUpstream)
	if !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestListCalendarsErrors(t *testing.T) {
	t.Parallel()
	tests := []struct {
		status int
		want   error
	}{
		{http.StatusUnauthorized, domain.ErrUnauthorized},
		{http.StatusNotFound, domain.ErrNotFound},
		{http.StatusBadGateway, domain.ErrUpstream},
	}
	for _, tt := range tests {
		t.Run(http.StatusText(tt.status), func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			e.mock.SetHook(func(w http.ResponseWriter, _ *http.Request) bool {
				w.WriteHeader(tt.status)
				return true
			})
			_, err := e.svc.ListCalendars(t.Context())
			mustErr(t, err, tt.want)
		})
	}
}

func TestInvalidAccount(t *testing.T) {
	t.Parallel()
	p := newProvider(t, http.DefaultClient)
	svc := p.Service(domain.Account{CalendarHomeURL: "::not a url"})
	ctx := t.Context()
	checks := map[string]error{}
	_, checks["ListCalendars"] = svc.ListCalendars(ctx)
	_, checks["ListEvents"] = svc.ListEvents(ctx, "x", date(2025, 1, 1, 0, 0), date(2025, 1, 2, 0, 0))
	_, checks["CreateEvent"] = svc.CreateEvent(ctx, "x", domain.EventInput{})
	_, checks["UpdateEvent"] = svc.UpdateEvent(ctx, "x", "e", domain.EventInput{})
	checks["DeleteEvent"] = svc.DeleteEvent(ctx, "x", "e")
	_, checks["ListTodos"] = svc.ListTodos(ctx, "x")
	_, checks["CreateTodo"] = svc.CreateTodo(ctx, "x", domain.TodoInput{})
	_, _, checks["UpdateTodo"] = svc.UpdateTodo(ctx, "x", "e", domain.TodoInput{})
	_, checks["RestoreTodo"] = svc.RestoreTodo(ctx, domain.Snapshot{Kind: domain.SnapshotTodo, ID: "x"})
	checks["DeleteTodo"] = svc.DeleteTodo(ctx, "x", "e")
	for name, err := range checks {
		if !errors.Is(err, domain.ErrUpstream) {
			t.Errorf("%s: error = %v; want ErrUpstream", name, err)
		}
	}
}

func TestNormalizeColor(t *testing.T) {
	t.Parallel()
	tests := []struct{ in, want string }{
		{"#3B82F6FF", "#3b82f6"},
		{"#3b82f6", "#3b82f6"},
		{"#ABC", "#aabbcc"},
		{" #112233 ", "#112233"},
		{"red", ""},
		{"#12345", ""},
		{"#GGHHII", ""},
		{"", ""},
	}
	for _, tt := range tests {
		in, want := tt.in, tt.want
		t.Run(in, func(t *testing.T) {
			t.Parallel()
			if got := normalizeColor(in); got != want {
				t.Fatalf("normalizeColor(%q) = %q; want %q", in, got, want)
			}
		})
	}
}

func TestDefaultColorDeterministic(t *testing.T) {
	t.Parallel()
	a, b := defaultColor("/a/"), defaultColor("/a/")
	if a != b || normalizeColor(a) != a {
		t.Fatalf("defaultColor not deterministic or invalid: %q %q", a, b)
	}
}
