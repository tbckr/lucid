package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/tbckr/lucid/internal/domain"
	"github.com/tbckr/lucid/internal/middleware"
	"github.com/tbckr/lucid/internal/session"
	"github.com/tbckr/lucid/internal/undo"
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

// pathRecurrenceID returns the path parameter recurrenceId, an occurrence's
// recurrence ID, parsed as RFC 3339. The API only ever emits whole seconds,
// so a value with fractional seconds is rejected too, even though time.Parse
// would otherwise accept it.
func pathRecurrenceID(w http.ResponseWriter, r *http.Request) (time.Time, bool) {
	t, err := time.Parse(time.RFC3339, r.PathValue("recurrenceId"))
	if err != nil || t.Nanosecond() != 0 {
		middleware.WriteError(w, http.StatusBadRequest, codeInvalidInput, "invalid recurrenceId")
		return time.Time{}, false
	}
	return t, true
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
	events, err := svc.ListEvents(revalidating(r.Context(), r.Header), calID, start, end)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	middleware.WriteJSON(w, http.StatusOK, eventsResponse{Events: nonNil(events)})
}

// revalidateHeader asks a list request to check with the CalDAV server past
// the cache freshness, as a manual refresh does (FR-23). Not Cache-Control:
// no-cache: browsers add that to every fetch with cache: 'no-store', as the
// frontend makes them.
const revalidateHeader = "X-Lucid-Revalidate"

// revalidating returns ctx asking the service to revalidate its cache when h
// carries revalidateHeader.
func revalidating(ctx context.Context, h http.Header) context.Context {
	if h.Get(revalidateHeader) == "1" {
		return domain.WithRevalidation(ctx)
	}
	return ctx
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
	ev, snap, err := svc.UpdateEvent(r.Context(), id, etag, in)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	ev.UndoToken = s.storeUndo(r, snap)
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

// handleUpdateOccurrence changes only one occurrence of a recurring series
// ("only this event"), writing or editing an override (FR-17).
func (s *Server) handleUpdateOccurrence(w http.ResponseWriter, r *http.Request) {
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
	rid, ok := pathRecurrenceID(w, r)
	if !ok {
		return
	}
	var in domain.OccurrenceInput
	if !s.decodeValid(w, r, &in) {
		return
	}
	ev, snap, err := svc.UpdateOccurrence(r.Context(), id, etag, rid, in)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	ev.UndoToken = s.storeUndo(r, snap)
	middleware.WriteJSON(w, http.StatusOK, ev)
}

// deletedOccurrence answers a delete of one occurrence whose series is kept:
// the series' new ETag, and the token that undoes the delete (FR-17).
type deletedOccurrence struct {
	ETag      string `json:"etag"`
	UndoToken string `json:"undoToken,omitempty"`
}

// handleDeleteOccurrence excludes only one occurrence of a recurring series
// ("only this event"), via EXDATE (FR-17). While the series' resource is
// kept, it answers 200 with the series' new ETag, in the body and in an ETag
// header, for the client's next write of the series (NFR-26), and with the
// undo token if there is one. Once the last occurrence is gone and the
// resource is deleted, it answers 204 with neither, and so it does for a
// series that is kept but whose new ETag the server did not tell.
func (s *Server) handleDeleteOccurrence(w http.ResponseWriter, r *http.Request) {
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
	rid, ok := pathRecurrenceID(w, r)
	if !ok {
		return
	}
	next, snap, err := svc.DeleteOccurrence(r.Context(), id, etag, rid)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.answerDeleted(w, r, next, snap)
}

// answerDeleted answers a delete that ends in the series' new ETag next, which
// is "" once the resource is deleted or when the server told none, and in the
// snapshot that undoes it (FR-17, NFR-26; see handleDeleteOccurrence).
func (s *Server) answerDeleted(w http.ResponseWriter, r *http.Request, next string, snap *domain.Snapshot) {
	if next == "" {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	w.Header().Set("ETag", next)
	middleware.WriteJSON(w, http.StatusOK, deletedOccurrence{ETag: next, UndoToken: s.storeUndo(r, snap)})
}

// followingResponse answers a change of an occurrence and the following ones
// (FR-17): the edited occurrence in the new series, the old series' new ETag,
// "" when the server told none, for the client's next write of it (NFR-26),
// and the token that undoes the split.
type followingResponse struct {
	Event     domain.Event `json:"event"`
	ETag      string       `json:"etag"`
	UndoToken string       `json:"undoToken,omitempty"`
}

// handleUpdateFollowing changes an occurrence of a recurring series and the
// following ones as a series of their own ("this and following events"): the
// series ends before it, and a new one goes on from it with the change
// (FR-17). At the series' first event that is all events. instanceStart in
// the body is ignored: recurrenceId is the occurrence.
func (s *Server) handleUpdateFollowing(w http.ResponseWriter, r *http.Request) {
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
	rid, ok := pathRecurrenceID(w, r)
	if !ok {
		return
	}
	var in domain.EventInput
	if !s.decodeValid(w, r, &in) {
		return
	}
	res, snap, err := svc.UpdateFollowing(r.Context(), id, etag, rid, in)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	middleware.WriteJSON(w, http.StatusOK, followingResponse{Event: res.Event, ETag: res.ETag, UndoToken: s.storeUndo(r, snap)})
}

// handleDeleteFollowing ends a recurring series before one of its occurrences
// ("this and following events"): the rule ends just before it, and the later
// exceptions and overrides go. It answers as handleDeleteOccurrence does:
// 200 with the series' new ETag and the undo token while the resource is
// kept, 204 once it is deleted, as it is at the series' first event, or when
// the server told no new ETag (FR-17).
func (s *Server) handleDeleteFollowing(w http.ResponseWriter, r *http.Request) {
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
	rid, ok := pathRecurrenceID(w, r)
	if !ok {
		return
	}
	next, snap, err := svc.DeleteFollowing(r.Context(), id, etag, rid)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.answerDeleted(w, r, next, snap)
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
	todos, err := svc.ListTodos(revalidating(r.Context(), r.Header), calID)
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
	occurrences, err := svc.ListTodoOccurrences(revalidating(r.Context(), r.Header), calID, start, end)
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
	todo, snap, err := svc.UpdateTodo(r.Context(), id, etag, in)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	todo.UndoToken = s.storeUndo(r, snap)
	middleware.WriteJSON(w, http.StatusOK, normalizeTodo(todo))
}

// handleDetachTodoOccurrence detaches the current repeat of a task series as
// a task of its own, changed by the body, while the series rolls on ("only
// this one", FR-17). It answers 200 with the rolled series, the new task as
// detachedCopy, and the undo token if there is one; at the series' last
// repeat it answers as handleUpdateTodo does. The body's rrule is ignored: the
// rule is the series'.
func (s *Server) handleDetachTodoOccurrence(w http.ResponseWriter, r *http.Request) {
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
	rid, ok := pathRecurrenceID(w, r)
	if !ok {
		return
	}
	var in domain.TodoInput
	if !s.decodeValid(w, r, &in) {
		return
	}
	todo, snap, err := svc.DetachTodoOccurrence(r.Context(), id, etag, rid, in)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	todo.UndoToken = s.storeUndo(r, snap)
	middleware.WriteJSON(w, http.StatusOK, normalizeTodo(todo))
}

// handleSkipTodoOccurrence skips the current repeat of a task series, which
// rolls on to its next one (FR-17). It answers 200 with the rolled series,
// its new ETag for the client's next write of it (NFR-26), and the undo token
// if there is one.
func (s *Server) handleSkipTodoOccurrence(w http.ResponseWriter, r *http.Request) {
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
	rid, ok := pathRecurrenceID(w, r)
	if !ok {
		return
	}
	todo, snap, err := svc.SkipTodoOccurrence(r.Context(), id, etag, rid)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	todo.UndoToken = s.storeUndo(r, snap)
	middleware.WriteJSON(w, http.StatusOK, normalizeTodo(todo))
}

// todoFollowingResponse answers a change of a repeat of a task series and
// the following ones (FR-17): the new series, the old series as written,
// whose new ETag the client's next write of it needs (NFR-26), and the token
// that undoes the split, at the old series' undo route.
type todoFollowingResponse struct {
	Todo      domain.Todo `json:"todo"`
	Series    domain.Todo `json:"series"`
	UndoToken string      `json:"undoToken,omitempty"`
}

// handleUpdateTodoFollowing changes a repeat of a task series and the
// following ones as a series of their own ("this and following"): the
// series ends before it, and a new one goes on from it with the change
// (FR-17). It answers 200 with the new series as todo, the old one as
// series, and the undo token if there is one; at the series' current repeat
// that is all of it, and both are the series as written.
func (s *Server) handleUpdateTodoFollowing(w http.ResponseWriter, r *http.Request) {
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
	rid, ok := pathRecurrenceID(w, r)
	if !ok {
		return
	}
	var in domain.TodoInput
	if !s.decodeValid(w, r, &in) {
		return
	}
	res, snap, err := svc.UpdateTodoFollowing(r.Context(), id, etag, rid, in)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	middleware.WriteJSON(w, http.StatusOK, todoFollowingResponse{
		Todo: normalizeTodo(res.Todo), Series: normalizeTodo(res.Series), UndoToken: s.storeUndo(r, snap),
	})
}

// handleDeleteTodoFollowing ends a task series before one of its repeats
// ("this and following"): the rule ends just before it, and the later
// exceptions and overrides go (FR-17). It answers 200 with the series, its
// new ETag for the client's next write of it (NFR-26), and the undo token if
// there is one, and 204 once the task itself is deleted, as it is at the
// series' current repeat, where nothing comes before it.
func (s *Server) handleDeleteTodoFollowing(w http.ResponseWriter, r *http.Request) {
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
	rid, ok := pathRecurrenceID(w, r)
	if !ok {
		return
	}
	todo, snap, err := svc.DeleteTodoFollowing(r.Context(), id, etag, rid)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if todo.ID == "" {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	todo.UndoToken = s.storeUndo(r, snap)
	middleware.WriteJSON(w, http.StatusOK, normalizeTodo(todo))
}

// storeUndo keeps snap in the undo store for the caller's session and returns
// the token that undoes it (FR-17). It returns "" when snap is nil, when undo
// is off, when the request has no session cookie, or when the store refuses
// the snapshot as too large: the change has succeeded all the same, it just
// has no undo.
func (s *Server) storeUndo(r *http.Request, snap *domain.Snapshot) string {
	if snap == nil || s.undo == nil {
		return ""
	}
	c, err := r.Cookie(CookieName)
	if err != nil {
		return ""
	}
	token, ok := s.undo.Put(c.Value, *snap)
	if !ok {
		return ""
	}
	return token
}

// undoRequest is the strictly decoded body of an undo route.
type undoRequest struct {
	Token string `json:"token"`
}

// takeUndo is what an undo route of resources of kind does before it calls
// the service: it resolves the path parameter idParam, the session's service
// and the token of the body, and looks up the snapshot of the token (FR-17).
// owner and token identify the entry for settleUndo. There is no If-Match:
// the token itself, single-use and short-lived, is the concurrency control.
// A token that is unknown, expired, used, another session's, of another kind
// or for another resource is "nothing to undo" (404). On failure it writes
// the response and returns ok=false.
func (s *Server) takeUndo(w http.ResponseWriter, r *http.Request, idParam string, kind domain.SnapshotKind) (svc domain.CalendarService, snap domain.Snapshot, owner, token string, ok bool) {
	id, ok := pathID(w, r, idParam)
	if !ok {
		return nil, domain.Snapshot{}, "", "", false
	}
	svc, ok = s.service(w, r)
	if !ok {
		return nil, domain.Snapshot{}, "", "", false
	}
	var in undoRequest
	if err := decodeJSON(r, &in); err != nil {
		s.writeError(w, r, err)
		return nil, domain.Snapshot{}, "", "", false
	}
	// A malformed token is invalid input, distinct from a well-formed one
	// that is simply unknown/expired/used/foreign (404 below). Checked
	// before s.undo == nil too, since it is a property of the request, not
	// of whether undo is wired up.
	if !undo.ValidToken(in.Token) {
		middleware.WriteError(w, http.StatusBadRequest, codeInvalidInput, "malformed token")
		return nil, domain.Snapshot{}, "", "", false
	}
	if s.undo == nil {
		middleware.WriteError(w, http.StatusNotFound, codeNotFound, "nothing to undo")
		return nil, domain.Snapshot{}, "", "", false
	}
	// s.service above already required a valid session cookie, so this
	// cannot actually fail; kept defensive rather than ignoring the error.
	c, err := r.Cookie(CookieName)
	if err != nil {
		middleware.WriteError(w, http.StatusUnauthorized, codeUnauthenticated, "not logged in")
		return nil, domain.Snapshot{}, "", "", false
	}
	snap, ok = s.undo.Get(c.Value, in.Token)
	if !ok || snap.Kind != kind || snap.ID != id {
		middleware.WriteError(w, http.StatusNotFound, codeNotFound, "nothing to undo")
		return nil, domain.Snapshot{}, "", "", false
	}
	return svc, snap, c.Value, in.Token, true
}

// settleUndo settles the token of an undo that the service answered with err.
// A temporary upstream failure keeps the snapshot so the client can retry;
// everything else (success, conflict, gone) consumes it.
func (s *Server) settleUndo(owner, token string, err error) {
	if err == nil || errors.Is(err, domain.ErrConflict) || errors.Is(err, domain.ErrNotFound) {
		s.undo.Delete(owner, token)
	}
}

// handleUndoTodo undoes the recurring-todo change that returned Token, by
// restoring the snapshot it is associated with (FR-17), see takeUndo.
func (s *Server) handleUndoTodo(w http.ResponseWriter, r *http.Request) {
	svc, snap, owner, token, ok := s.takeUndo(w, r, "todoId", domain.SnapshotTodo)
	if !ok {
		return
	}
	restored, err := svc.RestoreTodo(r.Context(), snap)
	s.settleUndo(owner, token, err)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	middleware.WriteJSON(w, http.StatusOK, normalizeTodo(restored))
}

// handleUndoEvent undoes the change of an event series that returned Token,
// by restoring the snapshot it is associated with (FR-17), see takeUndo.
func (s *Server) handleUndoEvent(w http.ResponseWriter, r *http.Request) {
	svc, snap, owner, token, ok := s.takeUndo(w, r, "eventId", domain.SnapshotEvent)
	if !ok {
		return
	}
	restored, err := svc.RestoreEvent(r.Context(), snap)
	s.settleUndo(owner, token, err)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	middleware.WriteJSON(w, http.StatusOK, restored)
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
// for the todo itself and, if present, its CompletedCopy and DetachedCopy
// (FR-17).
func normalizeTodo(t domain.Todo) domain.Todo {
	if t.Checklist == nil {
		t.Checklist = []domain.ChecklistItem{}
	}
	if t.CompletedCopy != nil {
		copyTodo := normalizeTodo(*t.CompletedCopy)
		t.CompletedCopy = &copyTodo
	}
	if t.DetachedCopy != nil {
		copyTodo := normalizeTodo(*t.DetachedCopy)
		t.DetachedCopy = &copyTodo
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
