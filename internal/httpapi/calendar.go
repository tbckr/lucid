package httpapi

import (
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/tbckr/lucid/internal/domain"
	"github.com/tbckr/lucid/internal/middleware"
	"github.com/tbckr/lucid/internal/session"
)

const (
	// maxEventRange bounds recurrence expansion (docs/API.md: 366 days).
	maxEventRange = 366 * 24 * time.Hour
	// maxIDLen bounds opaque IDs taken from the path.
	maxIDLen = 1024
)

// service resolves the caller's session to a CalendarService. On failure
// it writes the response and returns false.
func (s *Server) service(w http.ResponseWriter, r *http.Request) (domain.CalendarService, bool) {
	c, err := r.Cookie(CookieName)
	if err != nil {
		middleware.WriteError(w, http.StatusUnauthorized, codeUnauthenticated, "not logged in")
		return nil, false
	}
	acct, err := s.sessions.Account(c.Value)
	if err != nil {
		switch {
		case errors.Is(err, session.ErrExpired):
			s.sec.Log(r, middleware.EventSessionExpired)
		case errors.Is(err, session.ErrNotFound), errors.Is(err, session.ErrNotAuthenticated):
		default:
			s.logger.LogAttrs(r.Context(), slog.LevelError, "loading session account",
				slog.String("request_id", middleware.RequestID(r.Context())), slog.String("error", err.Error()))
		}
		middleware.WriteError(w, http.StatusUnauthorized, codeUnauthenticated, "not logged in")
		return nil, false
	}
	return s.provider.Service(acct), true
}

// fail writes err. If the CalDAV server no longer accepts the stored
// credentials (e.g. password changed), the session is destroyed so the UI
// shows the login form.
func (s *Server) fail(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, domain.ErrUnauthorized) {
		if c, cerr := r.Cookie(CookieName); cerr == nil {
			s.sessions.Delete(c.Value)
		}
		s.clearCookie(w)
	}
	s.writeError(w, r, err)
}

// pathID returns the path parameter name, validated.
func pathID(w http.ResponseWriter, r *http.Request, name string) (string, bool) {
	id := r.PathValue(name)
	if id == "" || len(id) > maxIDLen {
		middleware.WriteError(w, http.StatusBadRequest, codeInvalidInput, "invalid "+name)
		return "", false
	}
	return id, true
}

// ifMatch returns the required If-Match header.
func ifMatch(w http.ResponseWriter, r *http.Request) (string, bool) {
	etag := r.Header.Get("If-Match")
	if etag == "" {
		middleware.WriteError(w, http.StatusPreconditionRequired, codePreconditionRequired, "If-Match header is required")
		return "", false
	}
	return etag, true
}

type calendarsResponse struct {
	Calendars []domain.Calendar `json:"calendars"`
}

func (s *Server) handleListCalendars(w http.ResponseWriter, r *http.Request) {
	svc, ok := s.service(w, r)
	if !ok {
		return
	}
	cals, err := svc.ListCalendars(r.Context())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	middleware.WriteJSON(w, http.StatusOK, calendarsResponse{Calendars: nonNil(cals)})
}

type eventsResponse struct {
	Events []domain.Event `json:"events"`
}

func (s *Server) handleListEvents(w http.ResponseWriter, r *http.Request) {
	calID, ok := pathID(w, r, "calendarId")
	if !ok {
		return
	}
	svc, ok := s.service(w, r)
	if !ok {
		return
	}
	start, end, msg := parseRange(r)
	if msg != "" {
		middleware.WriteError(w, http.StatusBadRequest, codeInvalidInput, msg)
		return
	}
	events, err := svc.ListEvents(r.Context(), calID, start, end)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	middleware.WriteJSON(w, http.StatusOK, eventsResponse{Events: nonNil(events)})
}

func parseRange(r *http.Request) (start, end time.Time, msg string) {
	q := r.URL.Query()
	if q.Get("start") == "" || q.Get("end") == "" {
		return start, end, "start and end query parameters are required"
	}
	start, err := time.Parse(time.RFC3339, q.Get("start"))
	if err != nil {
		return start, end, "start must be an RFC 3339 timestamp"
	}
	end, err = time.Parse(time.RFC3339, q.Get("end"))
	if err != nil {
		return start, end, "end must be an RFC 3339 timestamp"
	}
	switch {
	case !start.Before(end):
		return start, end, "start must be before end"
	case end.Sub(start) > maxEventRange:
		return start, end, "the range must not exceed 366 days"
	}
	return start.UTC(), end.UTC(), ""
}

func (s *Server) handleCreateEvent(w http.ResponseWriter, r *http.Request) {
	calID, ok := pathID(w, r, "calendarId")
	if !ok {
		return
	}
	svc, ok := s.service(w, r)
	if !ok {
		return
	}
	var in domain.EventInput
	if !s.decodeValid(w, r, &in) {
		return
	}
	ev, err := svc.CreateEvent(r.Context(), calID, in)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	middleware.WriteJSON(w, http.StatusCreated, ev)
}

func (s *Server) handleUpdateEvent(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "eventId")
	if !ok {
		return
	}
	svc, ok := s.service(w, r)
	if !ok {
		return
	}
	etag, ok := ifMatch(w, r)
	if !ok {
		return
	}
	var in domain.EventInput
	if !s.decodeValid(w, r, &in) {
		return
	}
	ev, err := svc.UpdateEvent(r.Context(), id, etag, in)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	middleware.WriteJSON(w, http.StatusOK, ev)
}

func (s *Server) handleDeleteEvent(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "eventId")
	if !ok {
		return
	}
	svc, ok := s.service(w, r)
	if !ok {
		return
	}
	etag, ok := ifMatch(w, r)
	if !ok {
		return
	}
	if err := svc.DeleteEvent(r.Context(), id, etag); err != nil {
		s.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type todosResponse struct {
	Todos []domain.Todo `json:"todos"`
}

func (s *Server) handleListTodos(w http.ResponseWriter, r *http.Request) {
	calID, ok := pathID(w, r, "calendarId")
	if !ok {
		return
	}
	svc, ok := s.service(w, r)
	if !ok {
		return
	}
	todos, err := svc.ListTodos(r.Context(), calID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	todos = nonNil(todos)
	for i := range todos {
		todos[i] = normalizeTodo(todos[i])
	}
	middleware.WriteJSON(w, http.StatusOK, todosResponse{Todos: todos})
}

type occurrencesResponse struct {
	Occurrences []domain.TodoOccurrence `json:"occurrences"`
}

// handleListTodoOccurrences serves the occurrences of open recurring todos
// overlapping the requested range (FR-16, FR-17), the same shape as
// handleListEvents.
func (s *Server) handleListTodoOccurrences(w http.ResponseWriter, r *http.Request) {
	calID, ok := pathID(w, r, "calendarId")
	if !ok {
		return
	}
	svc, ok := s.service(w, r)
	if !ok {
		return
	}
	start, end, msg := parseRange(r)
	if msg != "" {
		middleware.WriteError(w, http.StatusBadRequest, codeInvalidInput, msg)
		return
	}
	occurrences, err := svc.ListTodoOccurrences(r.Context(), calID, start, end)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	middleware.WriteJSON(w, http.StatusOK, occurrencesResponse{Occurrences: nonNil(occurrences)})
}

func (s *Server) handleCreateTodo(w http.ResponseWriter, r *http.Request) {
	calID, ok := pathID(w, r, "calendarId")
	if !ok {
		return
	}
	svc, ok := s.service(w, r)
	if !ok {
		return
	}
	var in domain.TodoInput
	if !s.decodeValid(w, r, &in) {
		return
	}
	todo, err := svc.CreateTodo(r.Context(), calID, in)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	middleware.WriteJSON(w, http.StatusCreated, normalizeTodo(todo))
}

func (s *Server) handleUpdateTodo(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "todoId")
	if !ok {
		return
	}
	svc, ok := s.service(w, r)
	if !ok {
		return
	}
	etag, ok := ifMatch(w, r)
	if !ok {
		return
	}
	var in domain.TodoInput
	if !s.decodeValid(w, r, &in) {
		return
	}
	todo, _, err := svc.UpdateTodo(r.Context(), id, etag, in)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	middleware.WriteJSON(w, http.StatusOK, normalizeTodo(todo))
}

func (s *Server) handleDeleteTodo(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "todoId")
	if !ok {
		return
	}
	svc, ok := s.service(w, r)
	if !ok {
		return
	}
	etag, ok := ifMatch(w, r)
	if !ok {
		return
	}
	if err := svc.DeleteTodo(r.Context(), id, etag); err != nil {
		s.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// validator is implemented by the domain input types.
type validator interface{ Validate() error }

// decodeValid strictly decodes the body into v and validates it. On
// failure it writes the response and returns false.
func (s *Server) decodeValid(w http.ResponseWriter, r *http.Request, v validator) bool {
	err := decodeJSON(r, v)
	if err == nil {
		err = v.Validate()
	}
	if err != nil {
		s.writeError(w, r, err)
		return false
	}
	return true
}

// normalizeTodo makes sure the checklist is encoded as [] rather than null,
// for the todo itself and, if present, its CompletedCopy (FR-17).
func normalizeTodo(t domain.Todo) domain.Todo {
	if t.Checklist == nil {
		t.Checklist = []domain.ChecklistItem{}
	}
	if t.CompletedCopy != nil {
		copyTodo := normalizeTodo(*t.CompletedCopy)
		t.CompletedCopy = &copyTodo
	}
	return t
}

// nonNil makes sure lists are encoded as [] rather than null.
func nonNil[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}
