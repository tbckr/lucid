package caldav

// This file implements the writes to one repeat of a task series that a
// client names by its recurrence ID, as ListTodoOccurrences reports it
// (FR-17): "only this one", detaching or skipping the current repeat.

import (
	"context"
	"fmt"
	"time"

	"github.com/emersion/go-ical"

	"github.com/tbckr/lucid/internal/domain"
)

// repeatPlace is where the repeat a client names lies in its series, see
// loadTodoRepeat (FR-17).
type repeatPlace int

const (
	// repeatCurrent is the current repeat, the first open one, with another
	// open one after it.
	repeatCurrent repeatPlace = iota
	// repeatLast is the current repeat with no open one after it: the
	// series' last.
	repeatLast
	// repeatLater is an open repeat after the current one, on the rule or
	// off it (see todoOcc.offGrid).
	repeatLater
)

// todoRepeat is a recurring todo read for a write to one of its open repeats,
// see loadTodoRepeat (FR-17).
type todoRepeat struct {
	objPath, calPath string
	cal              *ical.Calendar
	raw              []byte          // the resource as read, which a snapshot keeps
	master           *ical.Component // the series
	todo             domain.Todo     // the series as read, see todoFromObject
	series           *todoSeries
	occ              todoOcc // the repeat named
	place            repeatPlace
	// next is the open repeat after occ where occ is the current one, nil at
	// the last; it is nil for a later one too.
	next *todoOcc
}

// errStaleRepeat refuses a write to a repeat that is no open one of its
// series: the view it was picked in is stale (FR-17, NFR-26).
var errStaleRepeat = fmt.Errorf("%w: not an open repeat of the series any more", domain.ErrConflict)

// loadTodoRepeat reads the todo todoID for a write to its repeat at
// recurrenceID and tells where that lies in the series (FR-17): the current
// repeat (repeatCurrent), the current one that is the last (repeatLast), or a
// later open one (repeatLater), which may lie off the rule (occ.offGrid). The
// routes of a single repeat share it, and they all refuse the rest alike.
//
// Like UpdateTodo, it requires etag, a calendar Lucid may write, and a
// resource that still has etag (ErrConflict otherwise), with a VTODO
// (ErrNotFound otherwise). recurrenceID is no open repeat of the series any
// more, as in a view not reloaded since the series changed elsewhere, when it
// is done, lies before the current repeat (done or rolled past), is excluded,
// cancelled or never one of the series, or when the todo does not recur, or
// is completed or cancelled itself: ErrConflict (errStaleRepeat), as for
// events (see UpdateEvent). A rule Lucid cannot evaluate, or not as far as
// recurrenceID, is errRuleUnsupported, which a route may refuse otherwise.
func (s *service) loadTodoRepeat(ctx context.Context, todoID, etag string, recurrenceID time.Time) (todoRepeat, error) {
	objPath, calPath, err := decodeObjectID(s.homePath, todoID)
	if err != nil {
		return todoRepeat{}, err
	}
	if err := requireETag(etag); err != nil {
		return todoRepeat{}, err
	}
	if err := s.checkWritable(ctx, calPath, ""); err != nil {
		return todoRepeat{}, err
	}
	cal, current, raw, err := s.getObject(ctx, objPath)
	if err != nil {
		return todoRepeat{}, err
	}
	if current != "" && current != etag {
		return todoRepeat{}, fmt.Errorf("%w: etag mismatch", domain.ErrConflict)
	}
	c := mainComponent(cal, ical.CompToDo)
	if c == nil {
		return todoRepeat{}, fmt.Errorf("%w: %w", domain.ErrNotFound, errWrongComponent)
	}
	tr := todoRepeat{
		objPath: objPath, calPath: calPath, cal: cal, raw: raw, master: c,
		todo: todoFromObject(calObject{path: objPath, cal: cal}, "", c), series: newTodoSeries(cal, c),
	}
	if tr.series == nil || tr.todo.Status == domain.TodoCompleted || tr.todo.Status == domain.TodoCancelled {
		return todoRepeat{}, errStaleRepeat
	}
	cur, next, err := tr.series.current()
	switch {
	case err != nil:
		return todoRepeat{}, errRuleUnsupported
	case cur.rid.IsZero() || cur.done:
		return todoRepeat{}, errStaleRepeat // every repeat is done
	}
	rid := recurrenceID.UTC()
	switch {
	case rid.Equal(cur.rid) && next == nil:
		tr.occ, tr.place = cur, repeatLast
	case rid.Equal(cur.rid):
		tr.occ, tr.place, tr.next = cur, repeatCurrent, next
	case rid.Before(cur.rid):
		return todoRepeat{}, errStaleRepeat
	default:
		occ, found, err := tr.series.repeatAt(rid)
		switch {
		case err != nil:
			return todoRepeat{}, errRuleUnsupported
		case !found || occ.done:
			return todoRepeat{}, errStaleRepeat
		}
		tr.occ, tr.place = occ, repeatLater
	}
	return tr, nil
}

// repeatAt returns the occurrence of s whose recurrence ID is rid, as walk
// yields it, and false if walk yields none: rid is excluded, cancelled, or no
// occurrence of the series (FR-17). It fails when the rule cannot be walked
// up to rid.
func (s *todoSeries) repeatAt(rid time.Time) (occ todoOcc, found bool, err error) {
	err = s.walk(rid, func(o todoOcc) bool {
		if o.rid.Equal(rid) {
			occ, found = o, true
		}
		return !found && !o.rid.After(rid)
	})
	return occ, found, err
}

// errRepeatNotOpen refuses a status of a write to one repeat of a series that
// completes or cancels it: a repeat is completed as the todo itself, by
// UpdateTodo, and the write keeps it open (FR-17).
var errRepeatNotOpen error = &domain.ValidationError{Msg: "the status must be open: a repeat is completed through the task itself"}

// requireOpen refuses with errRepeatNotOpen an input whose status completes
// or cancels the repeat it is for (FR-17).
func requireOpen(in domain.TodoInput) error {
	if in.Status == domain.TodoCompleted || in.Status == domain.TodoCancelled {
		return errRepeatNotOpen
	}
	return nil
}

// DetachTodoOccurrence implements domain.CalendarService: it detaches the
// current repeat at recurrenceID of a task series as a task of its own,
// changed by in, while the series rolls on (FR-17; spec section 5
// "Ablösen"). The task is the repeat as stored, as completing it would copy
// it, but open, with its alarms and the series' UID as its origin; the series
// rolls as on a completion, keeping its own title, notes and priority, see
// splitOffCurrent. It writes the task, with If-None-Match, and then the
// series, with If-Match etag; if the series cannot be written, the task goes
// again as far as Lucid can tell, see writeCreatedThenMaster (A-01).
//
// in.RRule is the series' and ignored, and in's dates are filled in as
// UpdateTodo fills them in, see fillTodoDates. At the series' last repeat,
// with no next one to roll to, "only this one" is all of it: UpdateTodo with
// in. A status of in that completes or cancels the repeat is refused before
// anything is read (errRepeatNotOpen), and so are, before anything is
// written, a resource with an ORGANIZER or an ATTENDEE
// (ErrSeriesSplitUnsupported), a later repeat than the current one
// (ErrInvalidInput), and the rest loadTodoRepeat refuses. The repeat, still
// open, would leave the attendees: the task is written without ORGANIZER and
// ATTENDEE (see cloneOccurrence), and a server that schedules implicitly
// would tell them only that the series rolled on.
//
// It returns the rolled series with the task as DetachedCopy, and the
// snapshot RestoreTodo undoes the change with, which also deletes the task,
// see snapshot.
func (s *service) DetachTodoOccurrence(ctx context.Context, todoID, etag string, recurrenceID time.Time, in domain.TodoInput) (domain.Todo, *domain.Snapshot, error) {
	if s.err != nil {
		return domain.Todo{}, nil, s.err
	}
	if err := in.Validate(); err != nil {
		return domain.Todo{}, nil, err
	}
	if err := requireOpen(in); err != nil {
		return domain.Todo{}, nil, err
	}
	in.RRule, in.RRuleOmitted = "", true
	tr, err := s.loadTodoRepeat(ctx, todoID, etag, recurrenceID)
	if err != nil {
		return domain.Todo{}, nil, err
	}
	if tr.todo.HasAttendees {
		return domain.Todo{}, nil, fmt.Errorf("%w: the task series has attendees", domain.ErrSeriesSplitUnsupported)
	}
	switch tr.place {
	case repeatLater:
		return domain.Todo{}, nil, &domain.ValidationError{Msg: "only the current repeat can be detached"}
	case repeatLast:
		return s.UpdateTodo(ctx, todoID, etag, in)
	case repeatCurrent:
	}
	if _, err := fillTodoDates(tr.todo, &in); err != nil {
		return domain.Todo{}, nil, err
	}
	t, detached, err := s.writeOffCurrent(ctx, tr.objPath, tr.calPath, etag, tr.cal, tr.master, tr.series, in, false)
	if err != nil {
		return domain.Todo{}, nil, err
	}
	t.DetachedCopy = &detached
	return t, s.snapshot(todoID, tr.todo, tr.raw, t, nil), nil
}

// SkipTodoOccurrence implements domain.CalendarService: it skips the current
// repeat at recurrenceID of a task series, which rolls on as on a completion,
// without a copy, its title, notes and priority as stored and its checklist
// unchecked, see reopen (FR-17; spec section 5 "Überspringen"). The series'
// last repeat is not skipped (ErrInvalidInput): it would leave a series
// without one, and the client deletes the task instead. A later repeat is
// ErrInvalidInput too, and the rest loadTodoRepeat refuses is refused alike;
// nothing is written then. A resource with an ORGANIZER or an ATTENDEE is
// skipped, as nothing new is written for it, but gets no undo, see snapshot.
func (s *service) SkipTodoOccurrence(ctx context.Context, todoID, etag string, recurrenceID time.Time) (domain.Todo, *domain.Snapshot, error) {
	if s.err != nil {
		return domain.Todo{}, nil, s.err
	}
	tr, err := s.loadTodoRepeat(ctx, todoID, etag, recurrenceID)
	if err != nil {
		return domain.Todo{}, nil, err
	}
	switch tr.place {
	case repeatLast:
		return domain.Todo{}, nil, &domain.ValidationError{Msg: "the last repeat cannot be skipped: delete the task instead"}
	case repeatLater:
		return domain.Todo{}, nil, &domain.ValidationError{Msg: "only the current repeat can be skipped"}
	case repeatCurrent:
	}
	if err := tr.series.rollPast(tr.cal, tr.occ, *tr.next); err != nil {
		return domain.Todo{}, nil, err
	}
	reopen(tr.master)
	bumpChangeProps(tr.master, s.p.now().UTC())
	o := calObject{path: tr.objPath, cal: tr.cal}
	o.etag, err = s.putObject(ctx, tr.objPath, tr.cal, etag, false)
	s.invalidate(tr.calPath)
	if err != nil {
		return domain.Todo{}, nil, err
	}
	t := todoFromObject(o, encodeID(tr.calPath), tr.master)
	return t, s.snapshot(todoID, tr.todo, tr.raw, t, nil), nil
}
