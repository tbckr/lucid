package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/tbckr/lucid/internal/domain"
	"github.com/tbckr/lucid/internal/middleware"
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
		{method: http.MethodPost, path: "/api/v1/calendars/c1/todos", body: `{"title":"x"}`},
		{method: http.MethodPut, path: "/api/v1/todos/t1", body: `{"title":"x"}`, headers: map[string]string{"If-Match": `"1"`}},
		{method: http.MethodDelete, path: "/api/v1/todos/t1", headers: map[string]string{"If-Match": `"1"`}},
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
			if tt.status < 300 && tt.status != http.StatusNoContent && !strings.Contains(w.Body.String(), `"checklist":[`) {
				t.Errorf("checklist must be an array: %s", w.Body)
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
}
