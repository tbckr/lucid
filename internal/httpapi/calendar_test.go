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
		{method: http.MethodPut, path: followingPath, body: eventBody, headers: map[string]string{"If-Match": `"1"`}},
		{method: http.MethodDelete, path: followingPath, headers: map[string]string{"If-Match": `"1"`}},
		{method: http.MethodGet, path: "/api/v1/calendars/c1/todos"},
		{method: http.MethodGet, path: "/api/v1/calendars/c1/todos/occurrences?start=2025-01-01T00:00:00Z&end=2025-02-01T00:00:00Z"},
		{method: http.MethodPost, path: "/api/v1/calendars/c1/todos", body: `{"title":"x"}`},
		{method: http.MethodPut, path: "/api/v1/todos/t1", body: `{"title":"x"}`, headers: map[string]string{"If-Match": `"1"`}},
		{method: http.MethodDelete, path: "/api/v1/todos/t1", headers: map[string]string{"If-Match": `"1"`}},
		{method: http.MethodPut, path: todoRepeatPath, body: `{"title":"x"}`, headers: map[string]string{"If-Match": `"1"`}},
		{method: http.MethodDelete, path: todoRepeatPath, headers: map[string]string{"If-Match": `"1"`}},
		{method: http.MethodPut, path: todoFollowingPath, body: `{"title":"x"}`, headers: map[string]string{"If-Match": `"1"`}},
		{method: http.MethodDelete, path: todoFollowingPath, headers: map[string]string{"If-Match": `"1"`}},
		{method: http.MethodPost, path: "/api/v1/todos/t1/undo", body: `{"token":"x"}`},
		{method: http.MethodPost, path: "/api/v1/events/e1/undo", body: `{"token":"x"}`},
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
		{fmt.Errorf("%w: has attendees", domain.ErrSeriesSplitUnsupported), http.StatusBadRequest, codeSeriesSplitUnsupported},
		{fmt.Errorf("x: %w", domain.ErrNotFound), http.StatusNotFound, codeNotFound},
		{domain.ErrConflict, http.StatusConflict, codeConflict},
		{domain.ErrDiscovery, http.StatusUnprocessableEntity, codeDiscoveryFailed},
		{domain.ErrUpstream, http.StatusBadGateway, codeUpstreamError},
		{fmt.Errorf("get: %w", context.DeadlineExceeded), http.StatusBadGateway, codeUpstreamError},
		{errors.New("unexpected"), http.StatusInternalServerError, codeInternal},
	}
	// The messages of the series refusals are neutral, for events and tasks
	// alike (FR-17).
	messages := map[string]string{
		codeSeriesMoveUnsupported:  "this series can't move like this, only this one can",
		codeSeriesSplitUnsupported: "this series can't be split, only this one or all can change",
	}
	for _, tt := range tests {
		t.Run(tt.code+"/"+tt.err.Error(), func(t *testing.T) {
			t.Parallel()
			h := newHarness(t, nil)
			c := h.login(t)
			h.svc.err = tt.err
			w := h.do(t, c, req{method: http.MethodGet, path: "/api/v1/calendars"})
			body := w.Body.String()
			expectError(t, w, tt.status, tt.code)
			if msg, ok := messages[tt.code]; ok && !strings.Contains(body, `"message":"`+msg+`"`) {
				t.Errorf("body = %s; want the message %q", body, msg)
			}
			if strings.Contains(body, "unexpected") {
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

// TestDeleteOccurrenceAnswers checks what deleting one event of a series
// answers: 200 with the series' new ETag in the body and in an ETag header,
// and the undo token if there is a snapshot, while its resource is kept; 204
// without a body or ETag once it is deleted, so the client can send the ETag
// with the series' next write (FR-17, NFR-26).
func TestDeleteOccurrenceAnswers(t *testing.T) {
	t.Parallel()
	const path = "/api/v1/events/e1/occurrences/2025-03-10T08:00:00Z"
	ifMatch := map[string]string{"If-Match": `"etag-1"`}

	t.Run("resource kept", func(t *testing.T) {
		t.Parallel()
		h := newHarness(t, withUndo)
		c := h.login(t)
		h.svc.occurrenceETag = `"5"`
		w := h.do(t, c, req{method: http.MethodDelete, path: path, headers: ifMatch})
		decode(t, w, http.StatusOK, nil)
		if got, want := w.Body.String(), `{"etag":"\"5\""}`; strings.TrimSpace(got) != want {
			t.Errorf("body = %s; want %s", got, want)
		}
		if got := w.Header().Values("ETag"); !slices.Equal(got, []string{`"5"`}) {
			t.Errorf("ETag header = %q; want %q", got, `"5"`)
		}
	})

	t.Run("resource kept with a snapshot", func(t *testing.T) {
		t.Parallel()
		h := newHarness(t, withUndo)
		c := h.login(t)
		h.svc.occurrenceETag = `"5"`
		h.svc.deleteOccurrenceSnapshot = eventSnapshot("e1")
		w := h.do(t, c, req{method: http.MethodDelete, path: path, headers: ifMatch})
		var got struct {
			ETag      string `json:"etag"`
			UndoToken string `json:"undoToken"`
		}
		decode(t, w, http.StatusOK, &got)
		if got.ETag != `"5"` || len(got.UndoToken) != 43 {
			t.Errorf("answer = %+v; want etag %q and a token of length 43", got, `"5"`)
		}
		if hdr := w.Header().Values("ETag"); !slices.Equal(hdr, []string{`"5"`}) {
			t.Errorf("ETag header = %q; want %q", hdr, `"5"`)
		}
	})

	t.Run("resource deleted", func(t *testing.T) {
		t.Parallel()
		h := newHarness(t, withUndo)
		c := h.login(t)
		w := h.do(t, c, req{method: http.MethodDelete, path: path, headers: ifMatch})
		decode(t, w, http.StatusNoContent, nil)
		if w.Body.Len() != 0 {
			t.Errorf("body = %q; want empty", w.Body)
		}
		if got := w.Header().Values("ETag"); got != nil {
			t.Errorf("ETag header = %q; want none", got)
		}
	})
}

// TestDeleteFollowingWrites checks the route that ends a series before an
// occurrence: the path values reach the service, and its errors answer as for
// the other event writes, a series it cannot split as 400
// series_split_unsupported (FR-17).
func TestDeleteFollowingWrites(t *testing.T) {
	t.Parallel()
	const path = followingPath
	ifMatch := map[string]string{"If-Match": `"etag-1"`}
	wantRID := time.Date(2025, 3, 10, 8, 0, 0, 0, time.UTC)
	tests := []struct {
		name   string
		rq     req
		svcErr error
		status int
		code   string
		call   string
	}{
		{"delete", req{method: http.MethodDelete, path: path, headers: ifMatch}, nil, http.StatusNoContent, "", "DeleteFollowing"},
		{"delete encoded", req{method: http.MethodDelete, path: "/api/v1/events/e1/following/2025-03-10T08%3A00%3A00Z", headers: ifMatch}, nil, http.StatusNoContent, "", "DeleteFollowing"},
		{"delete unsupported", req{method: http.MethodDelete, path: path, headers: ifMatch}, fmt.Errorf("%w: has attendees", domain.ErrSeriesSplitUnsupported), http.StatusBadRequest, codeSeriesSplitUnsupported, "DeleteFollowing"},
		{"delete not found", req{method: http.MethodDelete, path: path, headers: ifMatch}, domain.ErrNotFound, http.StatusNotFound, codeNotFound, "DeleteFollowing"},
		{"delete conflict", req{method: http.MethodDelete, path: path, headers: ifMatch}, domain.ErrConflict, http.StatusConflict, codeConflict, "DeleteFollowing"},
		{"delete bad id", req{method: http.MethodDelete, path: "/api/v1/events/e1/following/x", headers: ifMatch}, nil, http.StatusBadRequest, codeInvalidInput, ""},
		{"delete event id too long", req{method: http.MethodDelete, path: "/api/v1/events/" + strings.Repeat("a", maxIDLen+1) + "/following/2025-03-10T08:00:00Z", headers: ifMatch}, nil, http.StatusBadRequest, codeInvalidInput, ""},
		{"delete fractional seconds", req{method: http.MethodDelete, path: "/api/v1/events/e1/following/2025-03-10T08:00:00.5Z", headers: ifMatch}, nil, http.StatusBadRequest, codeInvalidInput, ""},
		{"delete no if-match", req{method: http.MethodDelete, path: path}, nil, http.StatusPreconditionRequired, codePreconditionRequired, ""},
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
			if tt.call != "" && (h.svc.gotID != "e1" || h.svc.gotETag != `"etag-1"` || !h.svc.gotRID.Equal(wantRID)) {
				t.Errorf("got id %q etag %q rid %v", h.svc.gotID, h.svc.gotETag, h.svc.gotRID)
			}
		})
	}
}

// TestUpdateFollowingWrites checks the route that changes an event and the
// following ones as a series of their own: the path values and the body reach
// the service, and its errors answer as for the other event writes, a series
// it cannot split as 400 series_split_unsupported and a move the new series
// cannot follow as 400 series_move_unsupported (FR-17).
func TestUpdateFollowingWrites(t *testing.T) {
	t.Parallel()
	const path = followingPath
	ifMatch := map[string]string{"If-Match": `"etag-1"`}
	wantRID := time.Date(2025, 3, 10, 8, 0, 0, 0, time.UTC)
	put := func(path, body string, headers map[string]string) req {
		return req{method: http.MethodPut, path: path, body: body, headers: headers}
	}
	tests := []struct {
		name   string
		rq     req
		svcErr error
		status int
		code   string
		call   string
	}{
		{"put", put(path, eventBody, ifMatch), nil, http.StatusOK, "", "UpdateFollowing"},
		{"put encoded", put("/api/v1/events/e1/following/2025-03-10T08%3A00%3A00Z", eventBody, ifMatch), nil, http.StatusOK, "", "UpdateFollowing"},
		{"put split unsupported", put(path, eventBody, ifMatch), fmt.Errorf("%w: has attendees", domain.ErrSeriesSplitUnsupported), http.StatusBadRequest, codeSeriesSplitUnsupported, "UpdateFollowing"},
		{"put move unsupported", put(path, eventBody, ifMatch), fmt.Errorf("%w: fixed days", domain.ErrSeriesMoveUnsupported), http.StatusBadRequest, codeSeriesMoveUnsupported, "UpdateFollowing"},
		{"put not found", put(path, eventBody, ifMatch), domain.ErrNotFound, http.StatusNotFound, codeNotFound, "UpdateFollowing"},
		{"put conflict", put(path, eventBody, ifMatch), domain.ErrConflict, http.StatusConflict, codeConflict, "UpdateFollowing"},
		{"put bad id", put("/api/v1/events/e1/following/x", eventBody, ifMatch), nil, http.StatusBadRequest, codeInvalidInput, ""},
		{"put fractional seconds", put("/api/v1/events/e1/following/2025-03-10T08:00:00.5Z", eventBody, ifMatch), nil, http.StatusBadRequest, codeInvalidInput, ""},
		{"put invalid", put(path, `{"title":"x"}`, ifMatch), nil, http.StatusBadRequest, codeInvalidInput, ""},
		{"put no if-match", put(path, eventBody, nil), nil, http.StatusPreconditionRequired, codePreconditionRequired, ""},
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
			if tt.call != "" && (h.svc.gotID != "e1" || h.svc.gotETag != `"etag-1"` || !h.svc.gotRID.Equal(wantRID) ||
				h.svc.gotEvent.Title != "Lunch") {
				t.Errorf("got id %q etag %q rid %v input %+v", h.svc.gotID, h.svc.gotETag, h.svc.gotRID, h.svc.gotEvent)
			}
		})
	}
}

// TestUpdateFollowingAnswer checks what changing an event and the following
// ones answers: 200 with the edited event in the new series, the old series'
// new ETag for the client's next write of it (NFR-26), and the undo token if
// there is a snapshot (FR-17).
func TestUpdateFollowingAnswer(t *testing.T) {
	t.Parallel()
	type answer struct {
		Event     domain.Event `json:"event"`
		ETag      string       `json:"etag"`
		UndoToken *string      `json:"undoToken"`
	}
	for _, withSnapshot := range []bool{true, false} {
		t.Run(fmt.Sprintf("snapshot %v", withSnapshot), func(t *testing.T) {
			t.Parallel()
			h := newHarness(t, withUndo)
			c := h.login(t)
			if withSnapshot {
				h.svc.updateFollowingSnapshot = eventSnapshot("e1")
			}
			var got answer
			decode(t, h.do(t, c, req{method: http.MethodPut, path: followingPath, body: eventBody, headers: eventIfMatch}),
				http.StatusOK, &got)
			if got.Event.ID != "n1" || got.Event.Title != "Lunch" || got.Event.ETag != `"n"` || got.ETag != `"4"` {
				t.Errorf("answer = %+v; want the event in the new series n1 and the old series' etag", got)
			}
			if withSnapshot && (got.UndoToken == nil || len(*got.UndoToken) != 43) {
				t.Errorf("undoToken = %v; want a token of length 43", got.UndoToken)
			}
			if !withSnapshot && got.UndoToken != nil {
				t.Errorf("undoToken = %q; want none without a snapshot", *got.UndoToken)
			}
			if got.Event.UndoToken != "" {
				t.Errorf("event's undoToken = %q; want it on the answer only", got.Event.UndoToken)
			}
		})
	}
}

// TestDeleteFollowingAnswers checks that ending a series answers as deleting
// one of its events does: 200 with the series' new ETag in the body and in an
// ETag header, and the undo token if there is a snapshot, while the resource
// is kept; 204 without either once it is deleted (FR-17, NFR-26).
func TestDeleteFollowingAnswers(t *testing.T) {
	t.Parallel()
	const path = followingPath
	ifMatch := map[string]string{"If-Match": `"etag-1"`}

	t.Run("resource kept", func(t *testing.T) {
		t.Parallel()
		h := newHarness(t, withUndo)
		c := h.login(t)
		h.svc.followingETag = `"5"`
		w := h.do(t, c, req{method: http.MethodDelete, path: path, headers: ifMatch})
		decode(t, w, http.StatusOK, nil)
		if got, want := w.Body.String(), `{"etag":"\"5\""}`; strings.TrimSpace(got) != want {
			t.Errorf("body = %s; want %s", got, want)
		}
		if got := w.Header().Values("ETag"); !slices.Equal(got, []string{`"5"`}) {
			t.Errorf("ETag header = %q; want %q", got, `"5"`)
		}
	})

	t.Run("resource kept with a snapshot", func(t *testing.T) {
		t.Parallel()
		h := newHarness(t, withUndo)
		c := h.login(t)
		h.svc.followingETag = `"5"`
		h.svc.deleteFollowingSnapshot = eventSnapshot("e1")
		w := h.do(t, c, req{method: http.MethodDelete, path: path, headers: ifMatch})
		var got struct {
			ETag      string `json:"etag"`
			UndoToken string `json:"undoToken"`
		}
		decode(t, w, http.StatusOK, &got)
		if got.ETag != `"5"` || len(got.UndoToken) != 43 {
			t.Errorf("answer = %+v; want etag %q and a token of length 43", got, `"5"`)
		}
		if hdr := w.Header().Values("ETag"); !slices.Equal(hdr, []string{`"5"`}) {
			t.Errorf("ETag header = %q; want %q", hdr, `"5"`)
		}
	})

	t.Run("resource deleted, or its new ETag unknown", func(t *testing.T) {
		t.Parallel()
		h := newHarness(t, withUndo)
		c := h.login(t)
		w := h.do(t, c, req{method: http.MethodDelete, path: path, headers: ifMatch})
		decode(t, w, http.StatusNoContent, nil)
		if w.Body.Len() != 0 {
			t.Errorf("body = %q; want empty", w.Body)
		}
		if got := w.Header().Values("ETag"); got != nil {
			t.Errorf("ETag header = %q; want none", got)
		}
	})
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
		{"update move unsupported", req{method: http.MethodPut, path: "/api/v1/todos/t1", body: todoBody, headers: ifMatch}, fmt.Errorf("%w: fixed days", domain.ErrSeriesMoveUnsupported), http.StatusBadRequest, codeSeriesMoveUnsupported, "UpdateTodo"},
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

// A task reports whether it has attendees and the series it was detached
// from, and the detach answer carries the detached copy; the checklists of the
// task and the copy must encode as [] rather than null (FR-17).
func TestTodoOriginFieldsAndDetachedCopy(t *testing.T) {
	t.Parallel()
	h := newHarness(t, nil)
	c := h.login(t)
	h.svc.todos = []domain.Todo{{ID: "t1", Title: "Water plants"}}
	h.svc.updateTodoResult = &domain.Todo{
		ID:           "t1",
		Title:        "Water plants",
		Recurring:    true,
		RRule:        "FREQ=WEEKLY",
		HasAttendees: true,
		DetachedFrom: "series-uid",
		DetachedCopy: &domain.Todo{ID: "t1-copy", Title: "Water plants", DetachedFrom: "series-uid"},
	}
	w := h.do(t, c, req{
		method:  http.MethodPut,
		path:    "/api/v1/todos/t1",
		body:    `{"title":"Water plants"}`,
		headers: map[string]string{"If-Match": `"t-etag"`},
	})
	decode(t, w, http.StatusOK, nil)
	body := w.Body.String()
	for _, want := range []string{`"hasAttendees":true`, `"detachedFrom":"series-uid"`, `"detachedCopy":{`} {
		if !strings.Contains(body, want) {
			t.Errorf("response lacks %s: %s", want, body)
		}
	}
	if strings.Count(body, `"checklist":[]`) != 2 {
		t.Errorf("master and detached copy both need an empty checklist array: %s", body)
	}

	// Plain tasks do not carry the fields at all.
	h.svc.updateTodoResult = &domain.Todo{ID: "t1", Title: "Water plants"}
	w = h.do(t, c, req{
		method:  http.MethodPut,
		path:    "/api/v1/todos/t1",
		body:    `{"title":"Water plants"}`,
		headers: map[string]string{"If-Match": `"t-etag"`},
	})
	decode(t, w, http.StatusOK, nil)
	for _, bad := range []string{"hasAttendees", "detachedFrom", "detachedCopy"} {
		if strings.Contains(w.Body.String(), bad) {
			t.Errorf("response contains %s: %s", bad, w.Body.String())
		}
	}
}

// A task reports the zone its series recurs in, and a repeat whether it lies
// off its series' rule; both are left out where they do not apply (FR-17).
func TestTodoTimezoneAndOffRuleInJSON(t *testing.T) {
	t.Parallel()
	h := newHarness(t, nil)
	c := h.login(t)
	h.svc.todos = []domain.Todo{{ID: "t1", Title: "Zoned", Timezone: "Europe/Berlin"}, {ID: "t2", Title: "Plain"}}
	h.svc.occurrences = []domain.TodoOccurrence{
		{Key: "t1@off", TodoID: "t1", Title: "Off", OffRule: true},
		{Key: "t1@on", TodoID: "t1", Title: "On"},
	}
	w := h.do(t, c, req{method: http.MethodGet, path: "/api/v1/calendars/c1/todos"})
	decode(t, w, http.StatusOK, nil)
	if body := w.Body.String(); strings.Count(body, `"timezone"`) != 1 || !strings.Contains(body, `"timezone":"Europe/Berlin"`) {
		t.Errorf("todos: want the zone of the zoned task only: %s", body)
	}
	w = h.do(t, c, req{method: http.MethodGet, path: "/api/v1/calendars/c1/todos/occurrences?start=2025-01-01T00:00:00Z&end=2025-02-01T00:00:00Z"})
	decode(t, w, http.StatusOK, nil)
	if body := w.Body.String(); strings.Count(body, `"offRule"`) != 1 || !strings.Contains(body, `"offRule":true`) {
		t.Errorf("occurrences: want offRule on the repeat off the rule only: %s", body)
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

const (
	// todoRepeatPath names the repeat of the todo t1 on 10 March 2025, 08:00
	// UTC, for detaching (PUT) or skipping (DELETE) it.
	todoRepeatPath = "/api/v1/todos/t1/occurrences/2025-03-10T08:00:00Z"
	todoRepeatBody = `{"title":"Water plants","start":"2025-03-10T09:00:00Z","rrule":"FREQ=DAILY"}`
)

// TestTodoRepeatWrites checks the routes that detach and skip one repeat of a
// task series: the path values and the body reach the service, and its
// errors answer as for the other todo writes, a series with attendees that
// cannot be detached as 400 series_split_unsupported (FR-17).
func TestTodoRepeatWrites(t *testing.T) {
	t.Parallel()
	ifMatch := map[string]string{"If-Match": `"t-etag"`}
	wantRID := time.Date(2025, 3, 10, 8, 0, 0, 0, time.UTC)
	put := func(path, body string, headers map[string]string) req {
		return req{method: http.MethodPut, path: path, body: body, headers: headers}
	}
	del := func(path string, headers map[string]string) req {
		return req{method: http.MethodDelete, path: path, headers: headers}
	}
	tests := []struct {
		name   string
		rq     req
		svcErr error
		status int
		code   string
		call   string
	}{
		{"detach", put(todoRepeatPath, todoRepeatBody, ifMatch), nil, http.StatusOK, "", "DetachTodoOccurrence"},
		{"detach encoded", put("/api/v1/todos/t1/occurrences/2025-03-10T08%3A00%3A00Z", todoRepeatBody, ifMatch), nil, http.StatusOK, "", "DetachTodoOccurrence"},
		{"detach bad recurrence id", put("/api/v1/todos/t1/occurrences/x", todoRepeatBody, ifMatch), nil, http.StatusBadRequest, codeInvalidInput, ""},
		{"detach fractional seconds", put("/api/v1/todos/t1/occurrences/2025-03-10T08:00:00.5Z", todoRepeatBody, ifMatch), nil, http.StatusBadRequest, codeInvalidInput, ""},
		{"detach no if-match", put(todoRepeatPath, todoRepeatBody, nil), nil, http.StatusPreconditionRequired, codePreconditionRequired, ""},
		{"detach invalid body", put(todoRepeatPath, `{"title":""}`, ifMatch), nil, http.StatusBadRequest, codeInvalidInput, ""},
		{"detach long id", put("/api/v1/todos/"+strings.Repeat("t", 1100)+"/occurrences/2025-03-10T08:00:00Z", todoRepeatBody, ifMatch), nil, http.StatusBadRequest, codeInvalidInput, ""},
		{"detach a later repeat", put(todoRepeatPath, todoRepeatBody, ifMatch), fmt.Errorf("%w: not the current repeat", domain.ErrInvalidInput), http.StatusBadRequest, codeInvalidInput, "DetachTodoOccurrence"},
		{"detach a stale repeat", put(todoRepeatPath, todoRepeatBody, ifMatch), domain.ErrConflict, http.StatusConflict, codeConflict, "DetachTodoOccurrence"},
		{"detach with attendees", put(todoRepeatPath, todoRepeatBody, ifMatch), fmt.Errorf("%w: attendees", domain.ErrSeriesSplitUnsupported), http.StatusBadRequest, codeSeriesSplitUnsupported, "DetachTodoOccurrence"},
		{"detach not found", put(todoRepeatPath, todoRepeatBody, ifMatch), domain.ErrNotFound, http.StatusNotFound, codeNotFound, "DetachTodoOccurrence"},
		{"skip", del(todoRepeatPath, ifMatch), nil, http.StatusOK, "", "SkipTodoOccurrence"},
		{"skip bad recurrence id", del("/api/v1/todos/t1/occurrences/x", ifMatch), nil, http.StatusBadRequest, codeInvalidInput, ""},
		{"skip no if-match", del(todoRepeatPath, nil), nil, http.StatusPreconditionRequired, codePreconditionRequired, ""},
		{"skip long id", del("/api/v1/todos/"+strings.Repeat("t", 1100)+"/occurrences/2025-03-10T08:00:00Z", ifMatch), nil, http.StatusBadRequest, codeInvalidInput, ""},
		{"skip the last repeat", del(todoRepeatPath, ifMatch), fmt.Errorf("%w: the last repeat", domain.ErrInvalidInput), http.StatusBadRequest, codeInvalidInput, "SkipTodoOccurrence"},
		{"skip a stale repeat", del(todoRepeatPath, ifMatch), domain.ErrConflict, http.StatusConflict, codeConflict, "SkipTodoOccurrence"},
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
			if tt.call != "" && (h.svc.gotID != "t1" || h.svc.gotETag != `"t-etag"` || !h.svc.gotRID.Equal(wantRID)) {
				t.Errorf("got id %q etag %q rid %v", h.svc.gotID, h.svc.gotETag, h.svc.gotRID)
			}
			if got := h.svc.gotTodo; tt.call == "DetachTodoOccurrence" && (got.Title != "Water plants" || got.Start == nil) {
				t.Errorf("got body %+v; want the request's", got)
			}
		})
	}
}

// TestTodoRepeatAnswers checks what detaching and skipping a repeat answer:
// 200 with the rolled series, for a detach with the detached task as
// detachedCopy, both with checklists as arrays, and the undo token where the
// service hands out a snapshot (FR-17).
func TestTodoRepeatAnswers(t *testing.T) {
	t.Parallel()
	snap := &domain.Snapshot{Kind: domain.SnapshotTodo, ID: "t1", ETag: `"2"`, Data: []byte("x"), Account: "acct", TakenAt: time.Now()}
	ifMatch := map[string]string{"If-Match": `"t-etag"`}
	for _, tc := range []struct {
		name     string
		rq       req
		snapshot bool
		detached bool
	}{
		{"detach", req{method: http.MethodPut, path: todoRepeatPath, body: todoRepeatBody, headers: ifMatch}, true, true},
		{"detach without a snapshot", req{method: http.MethodPut, path: todoRepeatPath, body: todoRepeatBody, headers: ifMatch}, false, true},
		{"skip", req{method: http.MethodDelete, path: todoRepeatPath, headers: ifMatch}, true, false},
		{"skip without a snapshot", req{method: http.MethodDelete, path: todoRepeatPath, headers: ifMatch}, false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			h := newHarness(t, withUndo)
			c := h.login(t)
			if tc.snapshot {
				h.svc.detachTodoSnapshot, h.svc.skipTodoSnapshot = snap, snap
			}
			w := h.do(t, c, tc.rq)
			body := w.Body.String()
			var got domain.Todo
			decode(t, w, http.StatusOK, &got)
			if got.ID != "t1" || got.ETag == "" || (got.DetachedCopy != nil) != tc.detached ||
				(tc.detached && (got.DetachedCopy.ID != "t-copy" || got.DetachedCopy.Title != "Water plants")) {
				t.Errorf("answer = %+v; want the rolled series, with the detached task: %v", got, tc.detached)
			}
			if tc.snapshot != (len(got.UndoToken) == 43) {
				t.Errorf("undoToken = %q; want one: %v", got.UndoToken, tc.snapshot)
			}
			wantLists := 1
			if tc.detached {
				wantLists = 2
			}
			if n := strings.Count(body, `"checklist":[]`); n != wantLists {
				t.Errorf("%d empty checklist arrays; want %d: %s", n, wantLists, body)
			}
		})
	}

	// A token of a detach undoes it at the todo's own undo route.
	t.Run("the token undoes the detach", func(t *testing.T) {
		t.Parallel()
		h := newHarness(t, withUndo)
		c := h.login(t)
		h.svc.detachTodoSnapshot = snap
		var got domain.Todo
		decode(t, h.do(t, c, req{method: http.MethodPut, path: todoRepeatPath, body: todoRepeatBody, headers: ifMatch}), http.StatusOK, &got)
		w := h.do(t, c, req{method: http.MethodPost, path: "/api/v1/todos/t1/undo", body: `{"token":"` + got.UndoToken + `"}`})
		decode(t, w, http.StatusOK, nil)
		if h.svc.gotSnap.ID != "t1" || h.svc.gotSnap.ETag != `"2"` {
			t.Errorf("RestoreTodo got %+v", h.svc.gotSnap)
		}
	})
}

// todoFollowingPath names the repeat of the todo t1 on 10 March 2025, 08:00
// UTC, for a write to it and the repeats after it.
const todoFollowingPath = "/api/v1/todos/t1/following/2025-03-10T08:00:00Z"

// TestTodoFollowingWrites checks the routes that change or end a task series
// from one of its repeats on: the path values and the body reach the
// service, and its errors answer as for the other todo writes, a series it
// cannot split as 400 series_split_unsupported and a move the new series
// cannot follow as 400 series_move_unsupported (FR-17).
func TestTodoFollowingWrites(t *testing.T) {
	t.Parallel()
	ifMatch := map[string]string{"If-Match": `"t-etag"`}
	wantRID := time.Date(2025, 3, 10, 8, 0, 0, 0, time.UTC)
	put := func(path, body string, headers map[string]string) req {
		return req{method: http.MethodPut, path: path, body: body, headers: headers}
	}
	del := func(path string, headers map[string]string) req {
		return req{method: http.MethodDelete, path: path, headers: headers}
	}
	tests := []struct {
		name   string
		rq     req
		svcErr error
		status int
		code   string
		call   string
	}{
		{"put", put(todoFollowingPath, todoRepeatBody, ifMatch), nil, http.StatusOK, "", "UpdateTodoFollowing"},
		{"put encoded", put("/api/v1/todos/t1/following/2025-03-10T08%3A00%3A00Z", todoRepeatBody, ifMatch), nil, http.StatusOK, "", "UpdateTodoFollowing"},
		{"put bad recurrence id", put("/api/v1/todos/t1/following/x", todoRepeatBody, ifMatch), nil, http.StatusBadRequest, codeInvalidInput, ""},
		{"put fractional seconds", put("/api/v1/todos/t1/following/2025-03-10T08:00:00.5Z", todoRepeatBody, ifMatch), nil, http.StatusBadRequest, codeInvalidInput, ""},
		{"put no if-match", put(todoFollowingPath, todoRepeatBody, nil), nil, http.StatusPreconditionRequired, codePreconditionRequired, ""},
		{"put invalid body", put(todoFollowingPath, `{"title":""}`, ifMatch), nil, http.StatusBadRequest, codeInvalidInput, ""},
		{"put long id", put("/api/v1/todos/"+strings.Repeat("t", 1100)+"/following/2025-03-10T08:00:00Z", todoRepeatBody, ifMatch), nil, http.StatusBadRequest, codeInvalidInput, ""},
		{"put a completing body", put(todoFollowingPath, todoRepeatBody, ifMatch), fmt.Errorf("%w: completes the repeat", domain.ErrInvalidInput), http.StatusBadRequest, codeInvalidInput, "UpdateTodoFollowing"},
		{"put split unsupported", put(todoFollowingPath, todoRepeatBody, ifMatch), fmt.Errorf("%w: attendees", domain.ErrSeriesSplitUnsupported), http.StatusBadRequest, codeSeriesSplitUnsupported, "UpdateTodoFollowing"},
		{"put move unsupported", put(todoFollowingPath, todoRepeatBody, ifMatch), fmt.Errorf("%w: fixed days", domain.ErrSeriesMoveUnsupported), http.StatusBadRequest, codeSeriesMoveUnsupported, "UpdateTodoFollowing"},
		{"put a stale repeat", put(todoFollowingPath, todoRepeatBody, ifMatch), domain.ErrConflict, http.StatusConflict, codeConflict, "UpdateTodoFollowing"},
		{"put not found", put(todoFollowingPath, todoRepeatBody, ifMatch), domain.ErrNotFound, http.StatusNotFound, codeNotFound, "UpdateTodoFollowing"},
		{"delete", del(todoFollowingPath, ifMatch), nil, http.StatusOK, "", "DeleteTodoFollowing"},
		{"delete encoded", del("/api/v1/todos/t1/following/2025-03-10T08%3A00%3A00Z", ifMatch), nil, http.StatusOK, "", "DeleteTodoFollowing"},
		{"delete bad recurrence id", del("/api/v1/todos/t1/following/x", ifMatch), nil, http.StatusBadRequest, codeInvalidInput, ""},
		{"delete no if-match", del(todoFollowingPath, nil), nil, http.StatusPreconditionRequired, codePreconditionRequired, ""},
		{"delete long id", del("/api/v1/todos/"+strings.Repeat("t", 1100)+"/following/2025-03-10T08:00:00Z", ifMatch), nil, http.StatusBadRequest, codeInvalidInput, ""},
		{"delete split unsupported", del(todoFollowingPath, ifMatch), fmt.Errorf("%w: attendees", domain.ErrSeriesSplitUnsupported), http.StatusBadRequest, codeSeriesSplitUnsupported, "DeleteTodoFollowing"},
		{"delete a stale repeat", del(todoFollowingPath, ifMatch), domain.ErrConflict, http.StatusConflict, codeConflict, "DeleteTodoFollowing"},
		{"delete not found", del(todoFollowingPath, ifMatch), domain.ErrNotFound, http.StatusNotFound, codeNotFound, "DeleteTodoFollowing"},
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
			if tt.call != "" && (h.svc.gotID != "t1" || h.svc.gotETag != `"t-etag"` || !h.svc.gotRID.Equal(wantRID)) {
				t.Errorf("got id %q etag %q rid %v", h.svc.gotID, h.svc.gotETag, h.svc.gotRID)
			}
			if got := h.svc.gotTodo; tt.call == "UpdateTodoFollowing" && (got.Title != "Water plants" || got.Start == nil || got.RRule != "FREQ=DAILY") {
				t.Errorf("got body %+v; want the request's, its rule included", got)
			}
		})
	}
}

// TestTodoFollowingAnswers checks what changing or ending a task series from
// one of its repeats on answers (FR-17, NFR-26): the change 200 with the new
// series as todo, the old one as series, for the client's next write of it,
// both with checklists as arrays, and the undo token where the service
// hands out a snapshot; the end 200 with the old series and the undo token,
// and 204 once the task itself is deleted. The token undoes the change at
// the old series' undo route.
func TestTodoFollowingAnswers(t *testing.T) {
	t.Parallel()
	snap := &domain.Snapshot{Kind: domain.SnapshotTodo, ID: "t1", ETag: `"8"`, Data: []byte("x"), Account: "acct", TakenAt: time.Now()}
	ifMatch := map[string]string{"If-Match": `"t-etag"`}
	type answer struct {
		Todo      domain.Todo `json:"todo"`
		Series    domain.Todo `json:"series"`
		UndoToken *string     `json:"undoToken"`
	}
	for _, withSnapshot := range []bool{true, false} {
		t.Run(fmt.Sprintf("change, snapshot %v", withSnapshot), func(t *testing.T) {
			t.Parallel()
			h := newHarness(t, withUndo)
			c := h.login(t)
			if withSnapshot {
				h.svc.updateTodoFollowingSnapshot = snap
			}
			w := h.do(t, c, req{method: http.MethodPut, path: todoFollowingPath, body: todoRepeatBody, headers: ifMatch})
			body := w.Body.String()
			var got answer
			decode(t, w, http.StatusOK, &got)
			if got.Todo.ID != "t-new" || got.Todo.Title != "Water plants" || got.Todo.ETag != `"n"` ||
				got.Series.ID != "t1" || got.Series.ETag != `"8"` {
				t.Errorf("answer = %+v; want the new series t-new and the old series t1 with its etag", got)
			}
			if withSnapshot != (got.UndoToken != nil && len(*got.UndoToken) == 43) {
				t.Errorf("undoToken = %v; want one: %v", got.UndoToken, withSnapshot)
			}
			if got.Todo.UndoToken != "" || got.Series.UndoToken != "" {
				t.Errorf("todos' undoTokens = %q, %q; want it on the answer only", got.Todo.UndoToken, got.Series.UndoToken)
			}
			if n := strings.Count(body, `"checklist":[]`); n != 2 {
				t.Errorf("%d empty checklist arrays; want 2: %s", n, body)
			}
		})
		t.Run(fmt.Sprintf("end, snapshot %v", withSnapshot), func(t *testing.T) {
			t.Parallel()
			h := newHarness(t, withUndo)
			c := h.login(t)
			if withSnapshot {
				h.svc.deleteTodoFollowingSnapshot = snap
			}
			w := h.do(t, c, req{method: http.MethodDelete, path: todoFollowingPath, headers: ifMatch})
			body := w.Body.String()
			var got domain.Todo
			decode(t, w, http.StatusOK, &got)
			if got.ID != "t1" || got.ETag != `"9"` || withSnapshot != (len(got.UndoToken) == 43) {
				t.Errorf("answer = %+v; want the series t1 with its etag, and a token: %v", got, withSnapshot)
			}
			if n := strings.Count(body, `"checklist":[]`); n != 1 {
				t.Errorf("%d empty checklist arrays; want 1: %s", n, body)
			}
		})
	}

	t.Run("end, the task deleted", func(t *testing.T) {
		t.Parallel()
		h := newHarness(t, withUndo)
		c := h.login(t)
		h.svc.todoFollowingDeleted = true
		w := h.do(t, c, req{method: http.MethodDelete, path: todoFollowingPath, headers: ifMatch})
		decode(t, w, http.StatusNoContent, nil)
		if w.Body.Len() != 0 {
			t.Errorf("body = %q; want empty", w.Body)
		}
	})

	// The snapshot is the old series': its token undoes the split at the old
	// series' route, not at the new one's.
	t.Run("the token undoes the change at the old series' route", func(t *testing.T) {
		t.Parallel()
		h := newHarness(t, withUndo)
		c := h.login(t)
		h.svc.updateTodoFollowingSnapshot = snap
		var got answer
		decode(t, h.do(t, c, req{method: http.MethodPut, path: todoFollowingPath, body: todoRepeatBody, headers: ifMatch}),
			http.StatusOK, &got)
		if got.UndoToken == nil {
			t.Fatal("no undoToken")
		}
		body := `{"token":"` + *got.UndoToken + `"}`
		w := h.do(t, c, req{method: http.MethodPost, path: "/api/v1/todos/t-new/undo", body: body})
		expectError(t, w, http.StatusNotFound, codeNotFound)
		if slices.Contains(h.svc.calls, "RestoreTodo") {
			t.Errorf("calls = %v; want no RestoreTodo at the new series' route", h.svc.calls)
		}
		decode(t, h.do(t, c, req{method: http.MethodPost, path: "/api/v1/todos/t1/undo", body: body}), http.StatusOK, nil)
		if h.svc.gotSnap.ID != "t1" || h.svc.gotSnap.ETag != `"8"` {
			t.Errorf("RestoreTodo got %+v", h.svc.gotSnap)
		}
	})
}

// eventSnapshot is a snapshot a fake service hands out for a change of the
// series id.
func eventSnapshot(id string) *domain.Snapshot {
	return &domain.Snapshot{Kind: domain.SnapshotEvent, ID: id, ETag: `"2"`, Data: []byte("x"), Account: "acct", TakenAt: time.Now()}
}

const (
	allEventsPath     = "/api/v1/events/e1"
	onlyThisEventPath = "/api/v1/events/e1/occurrences/2025-03-10T08:00:00Z"
	followingPath     = "/api/v1/events/e1/following/2025-03-10T08:00:00Z"
	occurrenceBody    = `{"title":"Lunch","start":"2025-03-10T08:00:00Z","end":"2025-03-10T09:00:00Z","allDay":false,"timezone":"Europe/Berlin"}`
)

var eventIfMatch = map[string]string{"If-Match": `"etag-1"`}

// eventChange is one of the event routes that answer with an undo
// token: the change of a whole series, of one occurrence, the deletion of
// one occurrence, and the end of a series before one (FR-17).
type eventChange struct {
	name string
	// setSnapshot hands the fake the snapshot its next change returns.
	setSnapshot func(f *fakeService, snap *domain.Snapshot)
	rq          req
}

var eventChanges = []eventChange{
	{
		"all events",
		func(f *fakeService, snap *domain.Snapshot) { f.updateEventSnapshot = snap },
		req{
			method: http.MethodPut, path: allEventsPath, headers: eventIfMatch,
			body: strings.TrimSuffix(eventBody, "}") + `,"instanceStart":"2025-01-06T12:00:00Z"}`,
		},
	},
	{
		"only this event",
		func(f *fakeService, snap *domain.Snapshot) { f.occurrenceSnapshot = snap },
		req{method: http.MethodPut, path: onlyThisEventPath, headers: eventIfMatch, body: occurrenceBody},
	},
	{
		"delete only this event",
		func(f *fakeService, snap *domain.Snapshot) {
			f.deleteOccurrenceSnapshot = snap
			f.occurrenceETag = `"5"`
		},
		req{method: http.MethodDelete, path: onlyThisEventPath, headers: eventIfMatch},
	},
	{
		"delete this and following events",
		func(f *fakeService, snap *domain.Snapshot) {
			f.deleteFollowingSnapshot = snap
			f.followingETag = `"5"`
		},
		req{method: http.MethodDelete, path: followingPath, headers: eventIfMatch},
	},
	{
		"change this and following events",
		func(f *fakeService, snap *domain.Snapshot) { f.updateFollowingSnapshot = snap },
		req{method: http.MethodPut, path: followingPath, headers: eventIfMatch, body: eventBody},
	},
}

// undoTokenOf performs the change and returns the undoToken of its answer.
func undoTokenOf(t *testing.T, h *harness, c *client, ch eventChange, snap *domain.Snapshot) string {
	t.Helper()
	ch.setSnapshot(h.svc, snap)
	var got struct {
		UndoToken string `json:"undoToken"`
	}
	decode(t, h.do(t, c, ch.rq), http.StatusOK, &got)
	return got.UndoToken
}

func TestEventChangesReturnUndoToken(t *testing.T) {
	t.Parallel()
	for _, ch := range eventChanges {
		t.Run(ch.name, func(t *testing.T) {
			t.Parallel()
			h := newHarness(t, withUndo)
			if got := undoTokenOf(t, h, h.login(t), ch, eventSnapshot("e1")); len(got) != 43 {
				t.Errorf("undoToken = %q, want length 43", got)
			}

			// Options.Undo == nil: no token at all.
			h2 := newHarness(t, nil)
			if got := undoTokenOf(t, h2, h2.login(t), ch, eventSnapshot("e1")); got != "" {
				t.Errorf("undoToken = %q, want empty with Options.Undo == nil", got)
			}

			// No snapshot (a single event, or no ETag to undo with): no token.
			h3 := newHarness(t, withUndo)
			if got := undoTokenOf(t, h3, h3.login(t), ch, nil); got != "" {
				t.Errorf("undoToken = %q, want empty without a snapshot", got)
			}
		})
	}
}

// TestUndoTokenTooLarge covers a series whose resource exceeds the undo
// store's limit, such as one with years of overrides: the change succeeds
// all the same, it just has no undo (FR-17).
func TestUndoTokenTooLarge(t *testing.T) {
	t.Parallel()
	for _, ch := range eventChanges {
		t.Run(ch.name, func(t *testing.T) {
			t.Parallel()
			h := newHarness(t, withUndo)
			snap := eventSnapshot("e1")
			snap.Data = make([]byte, undo.DefaultMaxSnapshot+1)
			if got := undoTokenOf(t, h, h.login(t), ch, snap); got != "" {
				t.Errorf("undoToken = %q, want none for a snapshot over the limit", got)
			}
		})
	}
}

func TestUndoEvent(t *testing.T) {
	t.Parallel()
	h := newHarness(t, withUndo)
	c := h.login(t)
	token := undoTokenOf(t, h, c, eventChanges[1], eventSnapshot("e1"))
	if token == "" {
		t.Fatalf("no undo token")
	}

	w := h.do(t, c, req{method: http.MethodPost, path: "/api/v1/events/e1/undo", body: `{"token":"` + token + `"}`})
	decode(t, w, http.StatusOK, nil)
	if got, want := strings.TrimSpace(w.Body.String()), `{"etag":"\"9\""}`; got != want {
		t.Errorf("body = %s; want %s", got, want)
	}
	if h.svc.gotSnap.ID != "e1" || string(h.svc.gotSnap.Data) != "x" || h.svc.gotSnap.ETag != `"2"` {
		t.Errorf("RestoreEvent got %+v", h.svc.gotSnap)
	}

	// Single use: a second POST with the same token finds nothing to undo.
	w = h.do(t, c, req{method: http.MethodPost, path: "/api/v1/events/e1/undo", body: `{"token":"` + token + `"}`})
	expectError(t, w, http.StatusNotFound, codeNotFound)
	if !strings.Contains(w.Body.String(), "nothing to undo") {
		t.Errorf("message = %s", w.Body)
	}
}

func TestUndoEventErrors(t *testing.T) {
	t.Parallel()

	// tokenHarness logs in, performs a change that yields a token, and
	// returns the harness, its client and the token.
	tokenHarness := func(t *testing.T) (*harness, *client, string) {
		t.Helper()
		h := newHarness(t, withUndo)
		c := h.login(t)
		token := undoTokenOf(t, h, c, eventChanges[1], eventSnapshot("e1"))
		if token == "" {
			t.Fatalf("no undo token")
		}
		return h, c, token
	}
	undoReq := func(id, body string) req {
		return req{method: http.MethodPost, path: "/api/v1/events/" + id + "/undo", body: body}
	}

	t.Run("unknown token", func(t *testing.T) {
		t.Parallel()
		h := newHarness(t, withUndo)
		c := h.login(t)
		// Well-formed (right length, right charset) but never issued.
		w := h.do(t, c, undoReq("e1", `{"token":"`+strings.Repeat("A", 43)+`"}`))
		expectError(t, w, http.StatusNotFound, codeNotFound)
	})

	t.Run("malformed token", func(t *testing.T) {
		t.Parallel()
		h := newHarness(t, withUndo)
		c := h.login(t)
		// Syntactically invalid (wrong length/charset), as opposed to a
		// well-formed but unknown one above: invalid input, not "not found".
		w := h.do(t, c, undoReq("e1", `{"token":"x"}`))
		expectError(t, w, http.StatusBadRequest, codeInvalidInput)
	})

	t.Run("token for another event", func(t *testing.T) {
		t.Parallel()
		h, c, token := tokenHarness(t)
		w := h.do(t, c, undoReq("other", `{"token":"`+token+`"}`))
		expectError(t, w, http.StatusNotFound, codeNotFound)
		// The token still works for its own event.
		w = h.do(t, c, undoReq("e1", `{"token":"`+token+`"}`))
		decode(t, w, http.StatusOK, nil)
	})

	t.Run("conflict consumes the token", func(t *testing.T) {
		t.Parallel()
		h, c, token := tokenHarness(t)
		h.svc.err = domain.ErrConflict
		w := h.do(t, c, undoReq("e1", `{"token":"`+token+`"}`))
		expectError(t, w, http.StatusConflict, codeConflict)
		h.svc.err = nil
		w = h.do(t, c, undoReq("e1", `{"token":"`+token+`"}`))
		expectError(t, w, http.StatusNotFound, codeNotFound)
	})

	t.Run("upstream error keeps the token", func(t *testing.T) {
		t.Parallel()
		h, c, token := tokenHarness(t)
		h.svc.err = domain.ErrUpstream
		w := h.do(t, c, undoReq("e1", `{"token":"`+token+`"}`))
		expectError(t, w, http.StatusBadGateway, codeUpstreamError)
		h.svc.err = nil
		w = h.do(t, c, undoReq("e1", `{"token":"`+token+`"}`))
		decode(t, w, http.StatusOK, nil)
	})

	t.Run("malformed body", func(t *testing.T) {
		t.Parallel()
		h, c, _ := tokenHarness(t)
		w := h.do(t, c, undoReq("e1", `{"token":`))
		expectError(t, w, http.StatusBadRequest, codeInvalidInput)
	})

	t.Run("extra field", func(t *testing.T) {
		t.Parallel()
		h, c, token := tokenHarness(t)
		w := h.do(t, c, undoReq("e1", `{"token":"`+token+`","extra":1}`))
		expectError(t, w, http.StatusBadRequest, codeInvalidInput)
	})

	t.Run("no session cookie", func(t *testing.T) {
		t.Parallel()
		h := newHarness(t, withUndo)
		anon := h.anonymous(t)
		w := h.do(t, anon, undoReq("e1", `{"token":"`+strings.Repeat("A", 43)+`"}`))
		expectError(t, w, http.StatusUnauthorized, codeUnauthenticated)
	})

	t.Run("missing csrf token", func(t *testing.T) {
		t.Parallel()
		h, c, token := tokenHarness(t)
		rq := undoReq("e1", `{"token":"`+token+`"}`)
		rq.noCSRF = true
		expectError(t, h.do(t, c, rq), http.StatusForbidden, middleware.CodeCSRFInvalid)
	})

	// A token a todo change returned never undoes an event, even for the same
	// ID: the kind is part of what it was issued for.
	t.Run("token of a todo change", func(t *testing.T) {
		t.Parallel()
		h := newHarness(t, withUndo)
		c := h.login(t)
		todo := putTodoSnapshot(t, h, c, "e1", &domain.Snapshot{Kind: domain.SnapshotTodo, ID: "e1", ETag: `"2"`, Data: []byte("x"), Account: "acct", TakenAt: time.Now()})
		if todo.UndoToken == "" {
			t.Fatalf("no undo token")
		}
		w := h.do(t, c, undoReq("e1", `{"token":"`+todo.UndoToken+`"}`))
		expectError(t, w, http.StatusNotFound, codeNotFound)
		if slices.Contains(h.svc.calls, "RestoreEvent") {
			t.Errorf("calls = %v; want no RestoreEvent", h.svc.calls)
		}
	})

	t.Run("token from another session", func(t *testing.T) {
		t.Parallel()
		h, _, token := tokenHarness(t)
		other := h.login(t)
		w := h.do(t, other, undoReq("e1", `{"token":"`+token+`"}`))
		expectError(t, w, http.StatusNotFound, codeNotFound)
	})
}
