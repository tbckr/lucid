package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/tbckr/lucid/internal/domain"
	"github.com/tbckr/lucid/internal/middleware"
	"github.com/tbckr/lucid/internal/undo"
)

const eventBody = `{"title":"Lunch","start":"2025-01-06T12:00:00Z","end":"2025-01-06T13:00:00Z","allDay":false,"timezone":"Europe/Berlin"}`

func TestUnauthenticated(t *testing.T) {
	t.Parallel()
	h := newHarness(t, nil)
	anon := h.anonymous(t)
	for _, rq := range []req{
		{method: http.MethodGet, path: "/api/v1/calendars"},
		{method: http.MethodGet, path: "/api/v1/calendars/c1/events?start=2025-01-01T00:00:00Z&end=2025-02-01T00:00:00Z"},
		{method: http.MethodPost, path: "/api/v1/calendars/c1/events", body: eventBody},
		{method: http.MethodPut, path: "/api/v1/events/e1", body: eventBody, headers: map[string]string{"If-Match": `"1"`}},
		{method: http.MethodDelete, path: "/api/v1/events/e1", headers: map[string]string{"If-Match": `"1"`}},
		{method: http.MethodGet, path: "/api/v1/calendars/c1/todos"},
		{method: http.MethodGet, path: "/api/v1/calendars/c1/todos/occurrences?start=2025-01-01T00:00:00Z&end=2025-02-01T00:00:00Z"},
		{method: http.MethodPost, path: "/api/v1/calendars/c1/todos", body: `{"title":"x"}`},
		{method: http.MethodPut, path: "/api/v1/todos/t1", body: `{"title":"x"}`, headers: map[string]string{"If-Match": `"1"`}},
		{method: http.MethodDelete, path: "/api/v1/todos/t1", headers: map[string]string{"If-Match": `"1"`}},
		{method: http.MethodPost, path: "/api/v1/todos/t1/undo", body: `{"token":"x"}`},
	} {
		// Anonymous session (valid CSRF token) but not logged in.
		expectError(t, h.do(t, anon, rq), http.StatusUnauthorized, codeUnauthenticated)
		if rq.method == http.MethodGet {
			// No cookie at all.
			expectError(t, h.do(t, nil, rq), http.StatusUnauthorized, codeUnauthenticated)
		}
	}
	if len(h.svc.calls) != 0 {
		t.Errorf("service called: %v", h.svc.calls)
	}
}

func TestListCalendars(t *testing.T) {
	t.Parallel()
	h := newHarness(t, nil)
	c := h.login(t)

	var resp struct {
		Calendars []domain.Calendar `json:"calendars"`
	}
	w := h.do(t, c, req{method: http.MethodGet, path: "/api/v1/calendars"})
	decode(t, w, http.StatusOK, nil)
	if !strings.Contains(w.Body.String(), `"calendars":[]`) {
		t.Errorf("nil list must encode as []: %s", w.Body)
	}
	if h.prov.gotAcct.Password != "hunter2-secret" || h.prov.gotAcct.EndpointURL != "https://dav.example.com/" {
		t.Errorf("service bound to %+v", h.prov.gotAcct)
	}

	h.svc.calendars = []domain.Calendar{{ID: "c1", Name: "Personal", Color: "#3b82f6"}}
	decode(t, h.do(t, c, req{method: http.MethodGet, path: "/api/v1/calendars"}), http.StatusOK, &resp)
	if len(resp.Calendars) != 1 || resp.Calendars[0].ID != "c1" {
		t.Errorf("calendars = %+v", resp.Calendars)
	}
}

func TestErrorMapping(t *testing.T) {
	t.Parallel()
	tests := []struct {
		err    error
		status int
		code   string
	}{
		{&domain.ValidationError{Msg: "bad rrule"}, http.StatusBadRequest, codeInvalidInput},
		{fmt.Errorf("x: %w", domain.ErrInvalidInput), http.StatusBadRequest, codeInvalidInput},
		{domain.ErrForbiddenTarget, http.StatusBadRequest, codeForbiddenTarget},
		{domain.ErrUnauthorized, http.StatusUnauthorized, codeUnauthenticated},
		{domain.ErrReadOnly, http.StatusForbidden, codeReadOnly},
		{fmt.Errorf("%w: VTODO", domain.ErrUnsupportedComponent), http.StatusUnprocessableEntity, codeUnsupportedComponent},
		{fmt.Errorf("%w: off its day", domain.ErrSeriesMoveUnsupported), http.StatusBadRequest, codeSeriesMoveUnsupported},
		{fmt.Errorf("x: %w", domain.ErrNotFound), http.StatusNotFound, codeNotFound},
		{domain.ErrConflict, http.StatusConflict, codeConflict},
		{domain.ErrDiscovery, http.StatusUnprocessableEntity, codeDiscoveryFailed},
		{domain.ErrUpstream, http.StatusBadGateway, codeUpstreamError},
		{fmt.Errorf("get: %w", context.DeadlineExceeded), http.StatusBadGateway, codeUpstreamError},
		{errors.New("unexpected"), http.StatusInternalServerError, codeInternal},
	}
	for _, tt := range tests {
		t.Run(tt.code+"/"+tt.err.Error(), func(t *testing.T) {
			t.Parallel()
			h := newHarness(t, nil)
			c := h.login(t)
			h.svc.err = tt.err
			w := h.do(t, c, req{method: http.MethodGet, path: "/api/v1/calendars"})
			expectError(t, w, tt.status, tt.code)
			if strings.Contains(w.Body.String(), "unexpected") {
				t.Error("internal error details leaked")
			}
			if errors.Is(tt.err, domain.ErrForbiddenTarget) && !strings.Contains(h.logs.String(), middleware.EventSSRFBlocked) {
				t.Error("SSRF block not logged")
			}
			if errors.Is(tt.err, domain.ErrUnauthorized) {
				// Upstream rejected stored credentials: session destroyed.
				if len(w.Result().Cookies()) != 1 || w.Result().Cookies()[0].MaxAge >= 0 {
					t.Error("cookie not cleared")
				}
				h.svc.err = nil
				expectError(t, h.do(t, c, req{method: http.MethodGet, path: "/api/v1/calendars"}), http.StatusUnauthorized, codeUnauthenticated)
			}
		})
	}
}

func TestAccountDecryptFailure(t *testing.T) {
	t.Parallel()
	h := newHarness(t, nil)
	c := h.login(t)
	h.srv.sessions = brokenAccountStore{h.store}
	expectError(t, h.do(t, c, req{method: http.MethodGet, path: "/api/v1/calendars"}), http.StatusUnauthorized, codeUnauthenticated)
	if !strings.Contains(h.logs.String(), "loading session account") {
		t.Error("decrypt failure not logged")
	}
}

type brokenAccountStore struct{ SessionStore }

func (brokenAccountStore) Account(string) (domain.Account, error) {
	return domain.Account{}, errors.New("cipher: message authentication failed")
}

func TestListEvents(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name  string
		query string
		want  string // "" = OK
	}{
		{"ok", "start=2025-01-01T00:00:00Z&end=2025-02-01T00:00:00Z", ""},
		{"offset converted to UTC", "start=2025-01-01T01:00:00%2B01:00&end=2025-02-01T00:00:00Z", ""},
		{"max range", "start=2025-01-01T00:00:00Z&end=2026-01-02T00:00:00Z", ""},
		{"range too long", "start=2025-01-01T00:00:00Z&end=2026-01-02T00:00:01Z", "366 days"},
		{"missing start", "end=2025-02-01T00:00:00Z", "required"},
		{"missing end", "start=2025-02-01T00:00:00Z", "required"},
		{"bad start", "start=yesterday&end=2025-02-01T00:00:00Z", "start must be"},
		{"bad end", "start=2025-01-01T00:00:00Z&end=2025-02-01", "end must be"},
		{"start after end", "start=2025-02-01T00:00:00Z&end=2025-01-01T00:00:00Z", "before end"},
		{"empty range", "start=2025-01-01T00:00:00Z&end=2025-01-01T00:00:00Z", "before end"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			h := newHarness(t, nil)
			c := h.login(t)
			h.svc.events = []domain.Event{{ID: "e1", Key: "e1", Title: "Standup"}}
			w := h.do(t, c, req{method: http.MethodGet, path: "/api/v1/calendars/cal-1/events?" + tt.query})
			if tt.want != "" {
				expectError(t, w, http.StatusBadRequest, codeInvalidInput)
				if !strings.Contains(w.Body.String(), tt.want) {
					t.Errorf("message %s does not mention %q", w.Body, tt.want)
				}
				return
			}
			var resp struct {
				Events []domain.Event `json:"events"`
			}
			decode(t, w, http.StatusOK, &resp)
			if len(resp.Events) != 1 || h.svc.gotCal != "cal-1" {
				t.Errorf("events = %+v, cal = %q", resp.Events, h.svc.gotCal)
			}
			if h.svc.gotStart.Location() != time.UTC || !h.svc.gotStart.Equal(time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC)) {
				t.Errorf("start = %v", h.svc.gotStart)
			}
		})
	}

	h := newHarness(t, nil)
	c := h.login(t)
	h.svc.err = domain.ErrNotFound
	expectError(t, h.do(t, c, req{method: http.MethodGet, path: "/api/v1/calendars/x/events?start=2025-01-01T00:00:00Z&end=2025-01-02T00:00:00Z"}), http.StatusNotFound, codeNotFound)
	h.svc.err = nil
	w := h.do(t, c, req{method: http.MethodGet, path: "/api/v1/calendars/x/events?start=2025-01-01T00:00:00Z&end=2025-01-02T00:00:00Z"})
	decode(t, w, http.StatusOK, nil)
	if !strings.Contains(w.Body.String(), `"events":[]`) {
		t.Errorf("nil list must encode as []: %s", w.Body)
	}
}

func TestEventWrites(t *testing.T) {
	t.Parallel()
	ifMatch := map[string]string{"If-Match": `"etag-1"`}
	tests := []struct {
		name   string
		rq     req
		svcErr error
		status int
		code   string
		call   string
	}{
		{"create", req{method: http.MethodPost, path: "/api/v1/calendars/c1/events", body: eventBody}, nil, http.StatusCreated, "", "CreateEvent"},
		{"create invalid", req{method: http.MethodPost, path: "/api/v1/calendars/c1/events", body: `{"title":"x"}`}, nil, http.StatusBadRequest, codeInvalidInput, ""},
		{"create bad tz", req{method: http.MethodPost, path: "/api/v1/calendars/c1/events", body: strings.Replace(eventBody, "Europe/Berlin", "Mars/Olympus", 1)}, nil, http.StatusBadRequest, codeInvalidInput, ""},
		{"create unknown field", req{method: http.MethodPost, path: "/api/v1/calendars/c1/events", body: `{"title":"x","color":"red"}`}, nil, http.StatusBadRequest, codeInvalidInput, ""},
		{"create empty body", req{method: http.MethodPost, path: "/api/v1/calendars/c1/events"}, nil, http.StatusBadRequest, codeInvalidInput, ""},
		{"create read-only", req{method: http.MethodPost, path: "/api/v1/calendars/c1/events", body: eventBody}, domain.ErrReadOnly, http.StatusForbidden, codeReadOnly, "CreateEvent"},
		{"create no csrf", req{method: http.MethodPost, path: "/api/v1/calendars/c1/events", body: eventBody, noCSRF: true}, nil, http.StatusForbidden, middleware.CodeCSRFInvalid, ""},
		{"create long id", req{method: http.MethodPost, path: "/api/v1/calendars/" + strings.Repeat("c", 1100) + "/events", body: eventBody}, nil, http.StatusBadRequest, codeInvalidInput, ""},
		{"update", req{method: http.MethodPut, path: "/api/v1/events/e1", body: eventBody, headers: ifMatch}, nil, http.StatusOK, "", "UpdateEvent"},
		{"update instance", req{method: http.MethodPut, path: "/api/v1/events/e1", body: strings.TrimSuffix(eventBody, "}") + `,"instanceStart":"2025-01-06T12:00:00Z"}`, headers: ifMatch}, nil, http.StatusOK, "", "UpdateEvent"},
		{"update no if-match", req{method: http.MethodPut, path: "/api/v1/events/e1", body: eventBody}, nil, http.StatusPreconditionRequired, codePreconditionRequired, ""},
		{"update conflict", req{method: http.MethodPut, path: "/api/v1/events/e1", body: eventBody, headers: ifMatch}, domain.ErrConflict, http.StatusConflict, codeConflict, "UpdateEvent"},
		{"update invalid", req{method: http.MethodPut, path: "/api/v1/events/e1", body: `{"title":"x"}`, headers: ifMatch}, nil, http.StatusBadRequest, codeInvalidInput, ""},
		{"update long id", req{method: http.MethodPut, path: "/api/v1/events/" + strings.Repeat("e", 1100), body: eventBody, headers: ifMatch}, nil, http.StatusBadRequest, codeInvalidInput, ""},
		{"delete", req{method: http.MethodDelete, path: "/api/v1/events/e1", headers: ifMatch}, nil, http.StatusNoContent, "", "DeleteEvent"},
		{"delete no if-match", req{method: http.MethodDelete, path: "/api/v1/events/e1"}, nil, http.StatusPreconditionRequired, codePreconditionRequired, ""},
		{"delete not found", req{method: http.MethodDelete, path: "/api/v1/events/e1", headers: ifMatch}, domain.ErrNotFound, http.StatusNotFound, codeNotFound, "DeleteEvent"},
		{"delete long id", req{method: http.MethodDelete, path: "/api/v1/events/" + strings.Repeat("e", 1100), headers: ifMatch}, nil, http.StatusBadRequest, codeInvalidInput, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			h := newHarness(t, nil)
			c := h.login(t)
			h.svc.err = tt.svcErr
			w := h.do(t, c, tt.rq)
			if tt.code != "" {
				expectError(t, w, tt.status, tt.code)
			} else {
				decode(t, w, tt.status, nil)
			}
			if got := strings.Join(h.svc.calls, ","); got != tt.call {
				t.Fatalf("calls = %q, want %q", got, tt.call)
			}
			switch tt.call {
			case "CreateEvent":
				if h.svc.gotCal != "c1" || h.svc.gotEvent.Title != "Lunch" {
					t.Errorf("create got cal %q input %+v", h.svc.gotCal, h.svc.gotEvent)
				}
			case "UpdateEvent", "DeleteEvent":
				if h.svc.gotID != "e1" || h.svc.gotETag != `"etag-1"` {
					t.Errorf("got id %q etag %q", h.svc.gotID, h.svc.gotETag)
				}
			}
			if tt.name == "update instance" && (h.svc.gotEvent.InstanceStart == nil || h.svc.gotEvent.InstanceStart.Hour() != 12) {
				t.Errorf("instanceStart = %v", h.svc.gotEvent.InstanceStart)
			}
		})
	}
}

func TestOccurrenceWrites(t *testing.T) {
	t.Parallel()
	ifMatch := map[string]string{"If-Match": `"etag-1"`}
	const occBody = `{"title":"Lunch","start":"2025-03-10T08:00:00Z","end":"2025-03-10T09:00:00Z","allDay":false,"timezone":"Europe/Berlin"}`
	wantRID := time.Date(2025, 3, 10, 8, 0, 0, 0, time.UTC)
	tests := []struct {
		name   string
		rq     req
		svcErr error
		status int
		code   string
		call   string
	}{
		{"put", req{method: http.MethodPut, path: "/api/v1/events/e1/occurrences/2025-03-10T08:00:00Z", body: occBody, headers: ifMatch}, nil, http.StatusOK, "", "UpdateOccurrence"},
		{"put encoded", req{method: http.MethodPut, path: "/api/v1/events/e1/occurrences/2025-03-10T08%3A00%3A00Z", body: occBody, headers: ifMatch}, nil, http.StatusOK, "", "UpdateOccurrence"},
		{"put bad id", req{method: http.MethodPut, path: "/api/v1/events/e1/occurrences/x", body: occBody, headers: ifMatch}, nil, http.StatusBadRequest, codeInvalidInput, ""},
		{"put fractional seconds", req{method: http.MethodPut, path: "/api/v1/events/e1/occurrences/2025-03-10T08:00:00.5Z", body: occBody, headers: ifMatch}, nil, http.StatusBadRequest, codeInvalidInput, ""},
		{"put no if-match", req{method: http.MethodPut, path: "/api/v1/events/e1/occurrences/2025-03-10T08:00:00Z", body: occBody}, nil, http.StatusPreconditionRequired, codePreconditionRequired, ""},
		{"put end before start", req{method: http.MethodPut, path: "/api/v1/events/e1/occurrences/2025-03-10T08:00:00Z", body: `{"title":"Lunch","start":"2025-03-10T09:00:00Z","end":"2025-03-10T08:00:00Z","allDay":false}`, headers: ifMatch}, nil, http.StatusBadRequest, codeInvalidInput, ""},
		{"put with rrule", req{method: http.MethodPut, path: "/api/v1/events/e1/occurrences/2025-03-10T08:00:00Z", body: strings.TrimSuffix(occBody, "}") + `,"rrule":"FREQ=DAILY"}`, headers: ifMatch}, nil, http.StatusBadRequest, codeInvalidInput, ""},
		{"put not found", req{method: http.MethodPut, path: "/api/v1/events/e1/occurrences/2025-03-10T08:00:00Z", body: occBody, headers: ifMatch}, domain.ErrNotFound, http.StatusNotFound, codeNotFound, "UpdateOccurrence"},
		{"delete", req{method: http.MethodDelete, path: "/api/v1/events/e1/occurrences/2025-03-10T08:00:00Z", headers: ifMatch}, nil, http.StatusNoContent, "", "DeleteOccurrence"},
		{"delete conflict", req{method: http.MethodDelete, path: "/api/v1/events/e1/occurrences/2025-03-10T08:00:00Z", headers: ifMatch}, domain.ErrConflict, http.StatusConflict, codeConflict, "DeleteOccurrence"},
		{"delete bad id", req{method: http.MethodDelete, path: "/api/v1/events/e1/occurrences/x", headers: ifMatch}, nil, http.StatusBadRequest, codeInvalidInput, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			h := newHarness(t, nil)
			c := h.login(t)
			h.svc.err = tt.svcErr
			w := h.do(t, c, tt.rq)
			if tt.code != "" {
				expectError(t, w, tt.status, tt.code)
			} else {
				decode(t, w, tt.status, nil)
			}
			if got := strings.Join(h.svc.calls, ","); got != tt.call {
				t.Fatalf("calls = %q, want %q", got, tt.call)
			}
			if tt.call == "UpdateOccurrence" || tt.call == "DeleteOccurrence" {
				if h.svc.gotID != "e1" || h.svc.gotETag != `"etag-1"` || !h.svc.gotRID.Equal(wantRID) {
					t.Errorf("got id %q etag %q rid %v", h.svc.gotID, h.svc.gotETag, h.svc.gotRID)
				}
			}
		})
	}
}

// TestDeleteOccurrenceETag checks that deleting one event of a series
// answers with the series' new ETag in an ETag header while its resource is
// kept, and with none once it is deleted, so the client can send it with
// the series' next write (FR-17, NFR-26).
func TestDeleteOccurrenceETag(t *testing.T) {
	t.Parallel()
	for _, tt := range []struct {
		name string
		etag string
		want []string
	}{
		{"resource kept", `"4"`, []string{`"4"`}},
		{"resource deleted", "", nil},
	} {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			h := newHarness(t, nil)
			c := h.login(t)
			h.svc.occurrenceETag = tt.etag
			w := h.do(t, c, req{
				method: http.MethodDelete, path: "/api/v1/events/e1/occurrences/2025-03-10T08:00:00Z",
				headers: map[string]string{"If-Match": `"etag-1"`},
			})
			decode(t, w, http.StatusNoContent, nil)
			if got := w.Header().Values("ETag"); !slices.Equal(got, tt.want) {
				t.Errorf("ETag header = %q; want %q", got, tt.want)
			}
		})
	}
}

func TestTodos(t *testing.T) {
	t.Parallel()
	ifMatch := map[string]string{"If-Match": `"t-etag"`}
	const todoBody = `{"title":"Buy milk","checklist":[{"text":"oat","done":false}],"priority":1,"status":"NEEDS-ACTION"}`
	tests := []struct {
		name   string
		rq     req
		svcErr error
		status int
		code   string
		call   string
	}{
		{"list", req{method: http.MethodGet, path: "/api/v1/calendars/c1/todos"}, nil, http.StatusOK, "", "ListTodos"},
		{"list error", req{method: http.MethodGet, path: "/api/v1/calendars/c1/todos"}, domain.ErrUpstream, http.StatusBadGateway, codeUpstreamError, "ListTodos"},
		{"list long id", req{method: http.MethodGet, path: "/api/v1/calendars/" + strings.Repeat("c", 1100) + "/todos"}, nil, http.StatusBadRequest, codeInvalidInput, ""},
		{"occurrences", req{method: http.MethodGet, path: "/api/v1/calendars/c1/todos/occurrences?start=2025-01-01T00:00:00Z&end=2025-02-01T00:00:00Z"}, nil, http.StatusOK, "", "ListTodoOccurrences"},
		{"occurrences no range", req{method: http.MethodGet, path: "/api/v1/calendars/c1/todos/occurrences"}, nil, http.StatusBadRequest, codeInvalidInput, ""},
		{"occurrences too long", req{method: http.MethodGet, path: "/api/v1/calendars/c1/todos/occurrences?start=2025-01-01T00:00:00Z&end=2026-01-03T00:00:00Z"}, nil, http.StatusBadRequest, codeInvalidInput, ""},
		{"occurrences error", req{method: http.MethodGet, path: "/api/v1/calendars/c1/todos/occurrences?start=2025-01-01T00:00:00Z&end=2025-02-01T00:00:00Z"}, domain.ErrUpstream, http.StatusBadGateway, codeUpstreamError, "ListTodoOccurrences"},
		{"occurrences long id", req{method: http.MethodGet, path: "/api/v1/calendars/" + strings.Repeat("c", 1100) + "/todos/occurrences?start=2025-01-01T00:00:00Z&end=2025-02-01T00:00:00Z"}, nil, http.StatusBadRequest, codeInvalidInput, ""},
		{"create", req{method: http.MethodPost, path: "/api/v1/calendars/c1/todos", body: `{"title":"Buy milk"}`}, nil, http.StatusCreated, "", "CreateTodo"},
		{"create invalid", req{method: http.MethodPost, path: "/api/v1/calendars/c1/todos", body: `{"title":"x","priority":10}`}, nil, http.StatusBadRequest, codeInvalidInput, ""},
		{"create error", req{method: http.MethodPost, path: "/api/v1/calendars/c1/todos", body: todoBody}, domain.ErrReadOnly, http.StatusForbidden, codeReadOnly, "CreateTodo"},
		{"create long id", req{method: http.MethodPost, path: "/api/v1/calendars/" + strings.Repeat("c", 1100) + "/todos", body: todoBody}, nil, http.StatusBadRequest, codeInvalidInput, ""},
		{"update", req{method: http.MethodPut, path: "/api/v1/todos/t1", body: todoBody, headers: ifMatch}, nil, http.StatusOK, "", "UpdateTodo"},
		{"update no if-match", req{method: http.MethodPut, path: "/api/v1/todos/t1", body: todoBody}, nil, http.StatusPreconditionRequired, codePreconditionRequired, ""},
		{"update invalid", req{method: http.MethodPut, path: "/api/v1/todos/t1", body: `{"title":""}`, headers: ifMatch}, nil, http.StatusBadRequest, codeInvalidInput, ""},
		{"update conflict", req{method: http.MethodPut, path: "/api/v1/todos/t1", body: todoBody, headers: ifMatch}, domain.ErrConflict, http.StatusConflict, codeConflict, "UpdateTodo"},
		{"update long id", req{method: http.MethodPut, path: "/api/v1/todos/" + strings.Repeat("t", 1100), body: todoBody, headers: ifMatch}, nil, http.StatusBadRequest, codeInvalidInput, ""},
		{"delete", req{method: http.MethodDelete, path: "/api/v1/todos/t1", headers: ifMatch}, nil, http.StatusNoContent, "", "DeleteTodo"},
		{"delete no if-match", req{method: http.MethodDelete, path: "/api/v1/todos/t1"}, nil, http.StatusPreconditionRequired, codePreconditionRequired, ""},
		{"delete error", req{method: http.MethodDelete, path: "/api/v1/todos/t1", headers: ifMatch}, domain.ErrConflict, http.StatusConflict, codeConflict, "DeleteTodo"},
		{"delete long id", req{method: http.MethodDelete, path: "/api/v1/todos/" + strings.Repeat("t", 1100), headers: ifMatch}, nil, http.StatusBadRequest, codeInvalidInput, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			h := newHarness(t, nil)
			c := h.login(t)
			h.svc.err = tt.svcErr
			h.svc.todos = []domain.Todo{{ID: "t1", Title: "no checklist"}}
			w := h.do(t, c, tt.rq)
			if tt.code != "" {
				expectError(t, w, tt.status, tt.code)
			} else {
				decode(t, w, tt.status, nil)
			}
			if got := strings.Join(h.svc.calls, ","); got != tt.call {
				t.Fatalf("calls = %q, want %q", got, tt.call)
			}
			if tt.status < 300 && tt.status != http.StatusNoContent && tt.call != "ListTodoOccurrences" &&
				!strings.Contains(w.Body.String(), `"checklist":[`) {
				t.Errorf("checklist must be an array: %s", w.Body)
			}
			if tt.call == "ListTodoOccurrences" && tt.code == "" && !strings.Contains(w.Body.String(), `"occurrences":`) {
				t.Errorf("response missing occurrences: %s", w.Body)
			}
			if tt.call == "UpdateTodo" || tt.call == "DeleteTodo" {
				if h.svc.gotID != "t1" || h.svc.gotETag != `"t-etag"` {
					t.Errorf("got id %q etag %q", h.svc.gotID, h.svc.gotETag)
				}
			}
		})
	}

	h := newHarness(t, nil)
	c := h.login(t)
	w := h.do(t, c, req{method: http.MethodGet, path: "/api/v1/calendars/c1/todos"})
	decode(t, w, http.StatusOK, nil)
	if !strings.Contains(w.Body.String(), `"todos":[]`) {
		t.Errorf("nil list must encode as []: %s", w.Body)
	}

	w = h.do(t, c, req{method: http.MethodGet, path: "/api/v1/calendars/c1/todos/occurrences?start=2025-01-01T00:00:00Z&end=2025-02-01T00:00:00Z"})
	decode(t, w, http.StatusOK, nil)
	if !strings.Contains(w.Body.String(), `"occurrences":[]`) {
		t.Errorf("nil list must encode as []: %s", w.Body)
	}
}

// Clients that predate `start` omit it; only an explicit null removes it (FR-16).
func TestUpdateTodoStartPresence(t *testing.T) {
	t.Parallel()
	for _, tt := range []struct {
		name, body   string
		status       int
		omitted      bool
		start        bool
		rruleOmitted bool
	}{
		{"omitted", `{"title":"x"}`, http.StatusOK, true, false, true},
		{"null", `{"title":"x","start":null}`, http.StatusOK, false, false, true},
		{"value", `{"title":"x","start":"2025-03-10T08:00:00Z"}`, http.StatusOK, false, true, true},
		{"unknown field", `{"title":"x","bogus":1}`, http.StatusBadRequest, false, false, true},
		{"rrule empty", `{"title":"x","rrule":""}`, http.StatusOK, true, false, false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			h := newHarness(t, nil)
			c := h.login(t)
			h.svc.todos = []domain.Todo{{ID: "t1", Title: "x"}}
			w := h.do(t, c, req{method: http.MethodPut, path: "/api/v1/todos/t1", body: tt.body, headers: map[string]string{"If-Match": `"t-etag"`}})
			if tt.status != http.StatusOK {
				expectError(t, w, tt.status, codeInvalidInput)
				return
			}
			decode(t, w, http.StatusOK, nil)
			if got := h.svc.gotTodo; got.StartOmitted != tt.omitted || (got.Start != nil) != tt.start || got.RRuleOmitted != tt.rruleOmitted {
				t.Errorf("StartOmitted = %v, Start = %v, RRuleOmitted = %v; want %v, set %v, %v",
					got.StartOmitted, got.Start, got.RRuleOmitted, tt.omitted, tt.start, tt.rruleOmitted)
			}
		})
	}
}

// Completing an occurrence of a recurring todo returns the rolled master
// with the completed occurrence attached as CompletedCopy (FR-17), and both
// checklists (master and copy) must encode as [] rather than null.
func TestUpdateTodoCompletedCopy(t *testing.T) {
	t.Parallel()
	h := newHarness(t, nil)
	c := h.login(t)
	h.svc.todos = []domain.Todo{{ID: "t1", Title: "Water plants"}}
	h.svc.updateTodoResult = &domain.Todo{
		ID:        "t1",
		Title:     "Water plants",
		Recurring: true,
		RRule:     "FREQ=WEEKLY",
		CompletedCopy: &domain.Todo{
			ID:     "t1-copy",
			Title:  "Water plants",
			Status: domain.TodoCompleted,
		},
	}
	w := h.do(t, c, req{
		method:  http.MethodPut,
		path:    "/api/v1/todos/t1",
		body:    `{"title":"Water plants","status":"COMPLETED"}`,
		headers: map[string]string{"If-Match": `"t-etag"`},
	})
	decode(t, w, http.StatusOK, nil)
	body := w.Body.String()
	if !strings.Contains(body, `"completedCopy":{`) {
		t.Errorf("response missing completedCopy: %s", body)
	}
	if strings.Count(body, `"checklist":[]`) != 2 {
		t.Errorf("master and copy both need an empty checklist array: %s", body)
	}
}

// withUndo gives a harness an undo store, the way cmd/lucid/main.go does.
func withUndo(o *Options) { o.Undo = undo.New(undo.Options{}) }

const completeBody = `{"title":"Water plants","status":"COMPLETED"}`

var completeIfMatch = map[string]string{"If-Match": `"t-etag"`}

// putTodoSnapshot drives a PUT that the fake answers with snap as the
// change's snapshot, and returns the decoded response.
func putTodoSnapshot(t *testing.T, h *harness, c *client, id string, snap *domain.Snapshot) domain.Todo {
	t.Helper()
	h.svc.todos = []domain.Todo{{ID: id, Title: "Water plants"}}
	h.svc.updateTodoSnapshot = snap
	w := h.do(t, c, req{method: http.MethodPut, path: "/api/v1/todos/" + id, body: completeBody, headers: completeIfMatch})
	var todo domain.Todo
	decode(t, w, http.StatusOK, &todo)
	return todo
}

func TestUpdateTodoReturnsUndoToken(t *testing.T) {
	t.Parallel()
	snap := &domain.Snapshot{Kind: domain.SnapshotTodo, ID: "t1", ETag: `"2"`, Data: []byte("snapshot bytes"), Account: "acct", TakenAt: time.Now()}

	h := newHarness(t, withUndo)
	c := h.login(t)
	todo := putTodoSnapshot(t, h, c, "t1", snap)
	if len(todo.UndoToken) != 43 {
		t.Fatalf("undoToken = %q, want length 43", todo.UndoToken)
	}

	// Options.Undo == nil: no token at all.
	h2 := newHarness(t, nil)
	c2 := h2.login(t)
	todo2 := putTodoSnapshot(t, h2, c2, "t1", snap)
	if todo2.UndoToken != "" {
		t.Errorf("undoToken = %q, want empty with Options.Undo == nil", todo2.UndoToken)
	}
}

func TestUndoTodo(t *testing.T) {
	t.Parallel()
	snap := &domain.Snapshot{Kind: domain.SnapshotTodo, ID: "t1", ETag: `"2"`, Data: []byte("snapshot bytes"), Account: "acct", TakenAt: time.Now()}

	h := newHarness(t, withUndo)
	c := h.login(t)
	todo := putTodoSnapshot(t, h, c, "t1", snap)
	token := todo.UndoToken
	if token == "" {
		t.Fatalf("no undo token")
	}

	w := h.do(t, c, req{method: http.MethodPost, path: "/api/v1/todos/t1/undo", body: `{"token":"` + token + `"}`})
	var restored domain.Todo
	decode(t, w, http.StatusOK, &restored)
	if restored.ID != "t1" {
		t.Errorf("restored = %+v", restored)
	}
	if h.svc.gotSnap.ID != "t1" || string(h.svc.gotSnap.Data) != "snapshot bytes" || h.svc.gotSnap.ETag != `"2"` {
		t.Errorf("RestoreTodo got %+v", h.svc.gotSnap)
	}

	// Single use: a second POST with the same token finds nothing to undo.
	w = h.do(t, c, req{method: http.MethodPost, path: "/api/v1/todos/t1/undo", body: `{"token":"` + token + `"}`})
	expectError(t, w, http.StatusNotFound, codeNotFound)
	if !strings.Contains(w.Body.String(), "nothing to undo") {
		t.Errorf("message = %s", w.Body)
	}
}

func TestUndoTodoErrors(t *testing.T) {
	t.Parallel()
	snap := &domain.Snapshot{Kind: domain.SnapshotTodo, ID: "t1", ETag: `"2"`, Data: []byte("x"), Account: "acct", TakenAt: time.Now()}

	// tokenHarness logs in, performs a PUT that yields a token, and returns
	// the harness, its client and the token.
	tokenHarness := func(t *testing.T) (*harness, *client, string) {
		t.Helper()
		h := newHarness(t, withUndo)
		c := h.login(t)
		todo := putTodoSnapshot(t, h, c, "t1", snap)
		if todo.UndoToken == "" {
			t.Fatalf("no undo token")
		}
		return h, c, todo.UndoToken
	}

	t.Run("unknown token", func(t *testing.T) {
		t.Parallel()
		h := newHarness(t, withUndo)
		c := h.login(t)
		// Well-formed (right length, right charset) but never issued.
		w := h.do(t, c, req{method: http.MethodPost, path: "/api/v1/todos/t1/undo", body: `{"token":"` + strings.Repeat("A", 43) + `"}`})
		expectError(t, w, http.StatusNotFound, codeNotFound)
	})

	t.Run("malformed token", func(t *testing.T) {
		t.Parallel()
		h := newHarness(t, withUndo)
		c := h.login(t)
		// Syntactically invalid (wrong length/charset), as opposed to a
		// well-formed but unknown one above: invalid input, not "not found".
		w := h.do(t, c, req{method: http.MethodPost, path: "/api/v1/todos/t1/undo", body: `{"token":"x"}`})
		expectError(t, w, http.StatusBadRequest, codeInvalidInput)
	})

	t.Run("token for another todo", func(t *testing.T) {
		t.Parallel()
		h, c, token := tokenHarness(t)
		w := h.do(t, c, req{method: http.MethodPost, path: "/api/v1/todos/other/undo", body: `{"token":"` + token + `"}`})
		expectError(t, w, http.StatusNotFound, codeNotFound)
		// The token still works for its own todo.
		w = h.do(t, c, req{method: http.MethodPost, path: "/api/v1/todos/t1/undo", body: `{"token":"` + token + `"}`})
		decode(t, w, http.StatusOK, nil)
	})

	t.Run("conflict consumes the token", func(t *testing.T) {
		t.Parallel()
		h, c, token := tokenHarness(t)
		h.svc.err = domain.ErrConflict
		w := h.do(t, c, req{method: http.MethodPost, path: "/api/v1/todos/t1/undo", body: `{"token":"` + token + `"}`})
		expectError(t, w, http.StatusConflict, codeConflict)
		h.svc.err = nil
		w = h.do(t, c, req{method: http.MethodPost, path: "/api/v1/todos/t1/undo", body: `{"token":"` + token + `"}`})
		expectError(t, w, http.StatusNotFound, codeNotFound)
	})

	t.Run("upstream error keeps the token", func(t *testing.T) {
		t.Parallel()
		h, c, token := tokenHarness(t)
		h.svc.err = domain.ErrUpstream
		w := h.do(t, c, req{method: http.MethodPost, path: "/api/v1/todos/t1/undo", body: `{"token":"` + token + `"}`})
		expectError(t, w, http.StatusBadGateway, codeUpstreamError)
		h.svc.err = nil
		w = h.do(t, c, req{method: http.MethodPost, path: "/api/v1/todos/t1/undo", body: `{"token":"` + token + `"}`})
		decode(t, w, http.StatusOK, nil)
	})

	t.Run("malformed body", func(t *testing.T) {
		t.Parallel()
		h, c, _ := tokenHarness(t)
		w := h.do(t, c, req{method: http.MethodPost, path: "/api/v1/todos/t1/undo", body: `{"token":`})
		expectError(t, w, http.StatusBadRequest, codeInvalidInput)
	})

	t.Run("extra field", func(t *testing.T) {
		t.Parallel()
		h, c, token := tokenHarness(t)
		w := h.do(t, c, req{method: http.MethodPost, path: "/api/v1/todos/t1/undo", body: `{"token":"` + token + `","extra":1}`})
		expectError(t, w, http.StatusBadRequest, codeInvalidInput)
	})

	t.Run("no session cookie", func(t *testing.T) {
		t.Parallel()
		h := newHarness(t, withUndo)
		anon := h.anonymous(t)
		w := h.do(t, anon, req{method: http.MethodPost, path: "/api/v1/todos/t1/undo", body: `{"token":"` + strings.Repeat("A", 43) + `"}`})
		expectError(t, w, http.StatusUnauthorized, codeUnauthenticated)
	})

	t.Run("missing csrf token", func(t *testing.T) {
		t.Parallel()
		h, c, token := tokenHarness(t)
		w := h.do(t, c, req{method: http.MethodPost, path: "/api/v1/todos/t1/undo", body: `{"token":"` + token + `"}`, noCSRF: true})
		expectError(t, w, http.StatusForbidden, middleware.CodeCSRFInvalid)
	})

	// A token an event change returned never undoes a todo, even for the same
	// ID: the kind is part of what it was issued for.
	t.Run("token of an event change", func(t *testing.T) {
		t.Parallel()
		h := newHarness(t, withUndo)
		c := h.login(t)
		todo := putTodoSnapshot(t, h, c, "t1", &domain.Snapshot{Kind: domain.SnapshotEvent, ID: "t1", ETag: `"2"`, Data: []byte("x"), Account: "acct", TakenAt: time.Now()})
		if todo.UndoToken == "" {
			t.Fatalf("no undo token")
		}
		w := h.do(t, c, req{method: http.MethodPost, path: "/api/v1/todos/t1/undo", body: `{"token":"` + todo.UndoToken + `"}`})
		expectError(t, w, http.StatusNotFound, codeNotFound)
		if slices.Contains(h.svc.calls, "RestoreTodo") {
			t.Errorf("calls = %v; want no RestoreTodo", h.svc.calls)
		}
	})

	t.Run("token from another session", func(t *testing.T) {
		t.Parallel()
		h, _, token := tokenHarness(t)
		other := h.login(t)
		w := h.do(t, other, req{method: http.MethodPost, path: "/api/v1/todos/t1/undo", body: `{"token":"` + token + `"}`})
		expectError(t, w, http.StatusNotFound, codeNotFound)
	})
}
