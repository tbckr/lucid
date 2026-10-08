package caldav

// This file implements the writes to a repeat R of a task series and the
// repeats after it ("this and following", FR-17; spec section 5 "Teilen und
// Beenden"): the series S ends before R, and for a change a new series N, a
// resource of its own, goes on from R, split off in memory first. It is the
// task form of the events' split (see splitOff, endBefore and
// UpdateFollowing), on a todoSeries.

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/emersion/go-ical"

	"github.com/tbckr/lucid/internal/domain"
)

// errSplitOffRule refuses to split a task series at a repeat that is no
// instance of its rule after its anchor (FR-17): an override off the rule
// (see todoOcc.offGrid), from which N could not recur without moving the
// rule, and the anchor, before which S cannot end, as the anchor is always an
// occurrence (RFC 5545 section 3.8.5.3). Like every split Lucid cannot
// compute, it is domain.ErrSeriesSplitUnsupported.
var errSplitOffRule = fmt.Errorf("%w: the repeat is no instance of the rule after its start",
	domain.ErrSeriesSplitUnsupported)

// splitPlace returns the number of occurrences of the rule of s before rid,
// counted as instancesBefore counts them, the anchor first (FR-17). It
// fails, as domain.ErrSeriesSplitUnsupported, for an rid that is no instance
// of the rule after the anchor (errSplitOffRule), and for a rule Lucid
// cannot walk to rid (see unsplittable): one it cannot read, a series with
// RDATE included, or one that does not reach rid within maxRRuleIterations.
func (s *todoSeries) splitPlace(rid time.Time) (int, error) {
	next, err := s.ruleIterator()
	if err != nil {
		return 0, unsplittable(err)
	}
	for before := range maxRRuleIterations {
		t, ok := next()
		if ok && t.Before(rid) {
			continue
		}
		if !ok || !t.Equal(rid) || before == 0 {
			return 0, errSplitOffRule
		}
		return before, nil
	}
	return 0, unsplittable(errRRuleCap)
}

// endTodoBefore ends the task series series, read from cal, just before its
// repeat rid, a later instance of its rule, in place (FR-17; spec section 5
// "Teilen und Beenden"), as endBefore ends an event series:
//   - The rule ends with an UNTIL just before rid, in the form RFC 5545
//     section 3.3.10 wants for the anchor's (see untilValue): for a DATE the
//     day before rid, for a floating DATE-TIME rid - 1 s floating, otherwise
//     rid - 1 s in UTC, which keeps the repeat a week before rid across a
//     change of summer time. It replaces a COUNT, and an UNTIL, which lies
//     at rid or later, as rid is an instance. In a zone Lucid cannot resolve
//     (see todoSeries.zoneKnown), such an UNTIL would be off by the zone's
//     offset, so the rule ends with a COUNT of its occurrences before rid
//     instead (see splitPlace), as roll keeps a COUNT there.
//   - The references from rid on go, placed as refsFrom places them, by date
//     for the other value type (A-11): EXDATE values, and a property left
//     without values, while a value Lucid cannot read stays (see
//     dropExdates); and the overrides, by their RECURRENCE-ID, whatever
//     their own dates: a repeat before rid moved past it stays.
//
// It fails, changing nothing, for an rid splitPlace refuses, as
// domain.ErrSeriesSplitUnsupported. It neither bumps SEQUENCE nor writes:
// the caller does. A caller that splits N off too calls splitTodoOff first,
// on the series as read.
func endTodoBefore(cal *ical.Calendar, series *todoSeries, rid time.Time) error {
	before, err := series.splitPlace(rid)
	if err != nil {
		return err
	}
	end := "COUNT=" + strconv.Itoa(before)
	if series.zoneKnown() {
		end = "UNTIL=" + untilValue(rid.Add(-time.Second), series.startForm)
	}
	// The series recurs by its RRULE: one with RDATE fails splitPlace.
	series.master.Props.Get(ical.PropRecurrenceRule).Value = withEnd(series.rrule, end)
	from := series.refsFrom(rid)
	dropExdates(series.master, from)
	dropOverrides(cal, series.master, from)
	return nil
}

// splitTodoOff returns the new task series N that goes on from the repeat
// rid of the series series, read from cal, a later instance of its rule, as
// the calendar of a resource of its own (FR-17; spec section 5 "Teilen und
// Beenden"), as splitOff does for an event series. cal stays as it is: N is
// a deep copy (see copySeries) that a caller can change freely.
//   - The calendar's VTIMEZONEs come along, all of them, as for an event
//     series.
//   - The master is copied with all its properties and components, its
//     alarms included, with the UID uid, SEQUENCE:0 and DTSTAMP, CREATED and
//     LAST-MODIFIED at now. It comes first, as SOGo reads the first VTODO as
//     the series (see masterFirst).
//   - DTSTART and DUE lie at rid in the form they are written in, see
//     anchorAt: DUE keeps its distance to DTSTART, and a series anchored on
//     DUE gets DTSTART = DUE, as on a roll.
//   - The rule's COUNT is lowered by its occurrences before rid (see
//     splitPlace), so that S and N together have as many as the series had;
//     an UNTIL stays.
//   - The references from rid on come along, placed as refsFrom places them,
//     by date for the other value type (A-11): EXDATE values, while a value
//     Lucid cannot read comes along and stays in S as well (see
//     dropExdates), as another client may read it and outside a series'
//     range it excludes nothing; and the overrides, by their RECURRENCE-ID,
//     whatever their own dates, done ones included, with N's UID.
//   - N is a series of its own and open: KDE's pending occurrence and the
//     origin of a detached task (X-LUCID-DETACHED-FROM) go, and N is
//     STATUS:NEEDS-ACTION without COMPLETED and PERCENT-COMPLETE, its own
//     checklist unchecked, as on a roll (see reopen): the progress belongs
//     to S's current repeat. The links to the series' subtasks
//     (RELATED-TO;RELTYPE=CHILD) stay with S, as they do for a completed
//     copy (see dropChildLinks); N keeps the other relations.
//
// It fails for an rid splitPlace refuses, as
// domain.ErrSeriesSplitUnsupported. A caller that ends S too calls it before
// endTodoBefore, which changes cal in place.
func splitTodoOff(cal *ical.Calendar, series *todoSeries, rid time.Time, uid string, now time.Time) (*ical.Calendar, error) {
	before, err := series.splitPlace(rid)
	if err != nil {
		return nil, err
	}
	from := series.refsFrom(rid)
	n, nm := copySeries(cal, series.master, uid, now, from)
	dropExdates(nm, func(d dateValue) bool { return !from(d) })
	nm.Props.Del(propKDEPending)
	nm.Props.Del(propDetachedFrom)
	reopen(nm)
	dropChildLinks(nm)
	// N's series, as copied, has the forms and the distance of DUE of s.
	newTodoSeries(n, nm).anchorAt(n, rid)
	nm.Props.Get(ical.PropRecurrenceRule).Value = lowerCount(series.rrule, before)
	masterFirst(n, nm)
	return n, nil
}

// errSplitRuleUnsupported refuses to split a task series whose rule Lucid
// cannot evaluate, or not as far as the repeat named, as it cannot tell
// where that repeat lies in the series (FR-17). Like every split Lucid
// cannot compute, it is domain.ErrSeriesSplitUnsupported, never the
// errRuleUnsupported a change of the whole series answers with.
var errSplitRuleUnsupported = fmt.Errorf("%w: the repeat rule cannot be evaluated", domain.ErrSeriesSplitUnsupported)

// loadTodoFollowing reads the todo todoID for a write to its repeat at
// recurrenceID and the repeats after it, as loadTodoRepeat reads it, and
// checks that its series can be split there, as loadFollowing checks an
// event series (FR-17; spec section 5 "Teilen und Beenden"):
//   - The series has no ORGANIZER or ATTENDEE in any VTODO, since a server
//     that schedules implicitly would tell them of a series that ends and of
//     another with a UID of its own; no EXRULE, which Lucid does not read
//     and a new series would count from its own start; at most one RRULE, as
//     Lucid reads and ends only the first; and a rule Lucid can evaluate as
//     far as recurrenceID (errSplitRuleUnsupported).
//   - Else ErrSeriesSplitUnsupported, also at the current repeat, where the
//     write is one of the whole series, as for events.
//
// A recurrenceID that is no open repeat of the series any more is
// ErrConflict, before the rest is checked, as loadTodoRepeat refuses it.
func (s *service) loadTodoFollowing(ctx context.Context, todoID, etag string, recurrenceID time.Time) (todoRepeat, error) {
	tr, err := s.loadTodoRepeat(ctx, todoID, etag, recurrenceID)
	switch {
	case errors.Is(err, errRuleUnsupported):
		return todoRepeat{}, errSplitRuleUnsupported
	case err != nil:
		return todoRepeat{}, err
	case tr.todo.HasAttendees:
		return todoRepeat{}, fmt.Errorf("%w: the task series has attendees", domain.ErrSeriesSplitUnsupported)
	case tr.master.Props.Get(propExRule) != nil:
		return todoRepeat{}, fmt.Errorf("%w: the task series has an EXRULE", domain.ErrSeriesSplitUnsupported)
	case len(tr.master.Props[ical.PropRecurrenceRule]) > 1:
		return todoRepeat{}, fmt.Errorf("%w: the task series has more than one RRULE", domain.ErrSeriesSplitUnsupported)
	}
	return tr, nil
}

// leaveCompletions removes from the series s in cal the overrides of the
// completions other apps recorded that from reports, those
// convertDoneOverrides turns into entries (see completions), so that a split
// keeps them in neither series (FR-17, A-18). A completed instance of the
// rule is excluded instead, as a roll leaves a completed one behind (see
// exclude), so that it shows once, done, as its entry, and not open again in
// the new series; a completed repeat off the rule only loses its override,
// as on a roll (see rollPast). It fails, changing nothing, as
// ErrSeriesSplitUnsupported, when the rule cannot be walked to a completion,
// as it cannot tell whether that lies on the rule.
func (s *todoSeries) leaveCompletions(cal *ical.Calendar, from func(rid dateValue) bool) error {
	done := s.completions(from)
	onRule := make([]bool, len(done))
	for i, occ := range done {
		on, err := s.onInstance(dateValue{t: occ.rid, allDay: s.anchor.allDay})
		if err != nil {
			return unsplittable(err)
		}
		onRule[i] = on
	}
	for i, occ := range done {
		if onRule[i] {
			s.exclude(cal, occ)
		} else {
			dropOccurrence(cal, s.master, occ)
		}
	}
	return nil
}

// UpdateTodoFollowing implements domain.CalendarService: it changes the
// repeat at recurrenceID of a task series and the repeats after it as a
// series of their own (FR-17; spec section 5 "Teilen und Beenden"), as
// UpdateFollowing changes an event series:
//   - The series S ends before the repeat R, as DeleteTodoFollowing ends it
//     (see endTodoBefore).
//   - The new series N, a resource with a UID of its own, goes on from R
//     (see splitTodoOff), changed by in as UpdateTodo changes a series from
//     its current repeat, which R is in N: the rule edit, the move and the
//     fields, see applyTodoEdit. in carries S's fields with the user's
//     edits, and only those that differ from S's go into N's master and R's
//     override, see applyEditedFields, so that R keeps what another app gave
//     it alone; where in removes the rule, N is R alone and takes them all.
//     N is open, its checklist unchecked, as a series a completion rolls on
//     (see rolledInput): in echoes S's progress, which belongs to S's
//     current repeat.
//   - in's rule is N's, except that S's rule as read, sent unchanged or
//     left out, keeps the rule N inherits, with its COUNT lowered: an edit
//     that keeps the rule does not take N's lower COUNT for a new one. A
//     rule removed makes N the single task at in's dates.
//   - The completions other apps recorded from R on become todos of their
//     own (see convertDoneOverrides), as for a rule change, and leave S and
//     N (see leaveCompletions): N's edit could drop or move them, and in S
//     they would lie past its end (A-18).
//
// At S's current repeat, its last one too, nothing comes before it: it is
// UpdateTodo with in, and both todos of the answer are S as written.
//
// Nothing is written for a change it refuses: a status of in that completes
// or cancels the repeat (errRepeatNotOpen), what loadTodoFollowing refuses,
// a split it cannot compute (ErrSeriesSplitUnsupported, see splitTodoOff)
// and a change of N that UpdateTodo would refuse, such as a move N's rule
// cannot follow (ErrSeriesMoveUnsupported). Then it writes the todos of the
// completions, N, with If-None-Match, and S, with If-Match etag; if N or S
// cannot be written, what it wrote before goes again as far as Lucid can
// tell, see writeCreatedThenMaster (A-01).
//
// It returns N and S as written, S with its new ETag, so that the client's
// next write of S does not conflict with this one (NFR-26), and the
// snapshot RestoreTodo undoes the split with: S as read, and N as a
// resource that may not stay, which the undo deletes, see
// domain.CreatedRef. There is none when the ETag of S or N is unknown, or
// when completions became todos, see snapshot.
func (s *service) UpdateTodoFollowing(ctx context.Context, todoID, etag string, recurrenceID time.Time, in domain.TodoInput) (_ domain.TodoFollowing, _ *domain.Snapshot, err error) {
	if s.err != nil {
		return domain.TodoFollowing{}, nil, s.err
	}
	if err := in.Validate(); err != nil {
		return domain.TodoFollowing{}, nil, err
	}
	if err := requireOpen(in); err != nil {
		return domain.TodoFollowing{}, nil, err
	}
	tr, err := s.loadTodoFollowing(ctx, todoID, etag, recurrenceID)
	if err != nil {
		return domain.TodoFollowing{}, nil, err
	}
	if tr.place != repeatLater {
		t, snap, err := s.UpdateTodo(ctx, todoID, etag, in)
		if err != nil {
			return domain.TodoFollowing{}, nil, err
		}
		return domain.TodoFollowing{Todo: t, Series: t}, snap, nil
	}

	cal, master, series, rid := tr.cal, tr.master, tr.series, tr.occ.rid
	// Judged on S as read, before endTodoBefore ends its rule. Rule parts
	// are case-insensitive (RFC 5545 section 3.1).
	if in.RRuleOmitted || strings.EqualFold(trimRRule(in.RRule), series.rrule) {
		in.RRule, in.RRuleOmitted = "", true
	}
	from := series.refsFrom(rid)
	if err := series.leaveCompletions(cal, from); err != nil {
		return domain.TodoFollowing{}, nil, err
	}
	now := s.p.now().UTC()
	uid := newUID()
	// splitTodoOff reads the series as it is; endTodoBefore changes it in
	// place.
	n, err := splitTodoOff(cal, series, rid, uid, now)
	if err != nil {
		return domain.TodoFollowing{}, nil, err
	}
	if err := endTodoBefore(cal, series, rid); err != nil {
		return domain.TodoFollowing{}, nil, err
	}
	nm := mainComponent(n, ical.CompToDo)
	created := calObject{path: objectPath(tr.calPath, uid+".ics"), cal: n}
	edit, err := newTodoEdit(n, nm, todoFromObject(created, "", nm), rolledInput(in))
	if err != nil {
		return domain.TodoFollowing{}, nil, err
	}
	edit.onlyEdited = true
	// N has no completions of other apps to turn into entries: they left
	// the series above. And the edit, open, completes nothing.
	if _, _, err := applyTodoEdit(n, nm, edit, now); err != nil {
		return domain.TodoFollowing{}, nil, err
	}
	// N is new: its SEQUENCE stays 0, while S's goes up.
	bumpChangeProps(master, now)
	masterFirst(cal, master)

	// The completions' todos go again when the split is not written, as
	// for UpdateTodo.
	var entries []calObject
	defer func() {
		if err != nil && !errors.Is(err, errWriteUnverified) {
			s.removeEntries(ctx, tr.calPath, entries)
		}
	}()
	// Cloned from S's master as ended, whose rule parts and change
	// properties a clone does not take (see cloneOccurrence), and from the
	// overrides as read.
	if entries, err = s.convertDoneOverrides(ctx, tr.calPath, cal, series, from, now); err != nil {
		return domain.TodoFollowing{}, nil, err
	}
	defer s.invalidate(tr.calPath)
	next, err := s.writeCreatedThenMaster(ctx, tr.calPath, &created, tr.objPath, cal, etag)
	if err != nil {
		return domain.TodoFollowing{}, nil, err
	}
	calendarID := encodeID(tr.calPath)
	res := domain.TodoFollowing{
		Todo:   todoFromObject(created, calendarID, nm),
		Series: todoFromObject(calObject{path: tr.objPath, cal: cal, etag: next}, calendarID, master),
	}
	// An undo needs both ETags: without S's it could not tell its own
	// change from another client's, and without N's it could not delete N,
	// which would then stand next to S restored, every repeat from R on
	// twice. The series has no attendees, or loadTodoFollowing had refused
	// it.
	var snap *domain.Snapshot
	if created.etag != "" {
		snap = s.snapshot(todoID, tr.todo, tr.raw, res.Series, entries)
	}
	if snap != nil {
		snap.Created = []domain.CreatedRef{{ID: res.Todo.ID, ETag: created.etag}}
	}
	return res, snap, nil
}

// DeleteTodoFollowing implements domain.CalendarService: it ends a task
// series before its repeat at recurrenceID, in one write (FR-17; spec
// section 5 "Teilen und Beenden"), as DeleteFollowing ends an event series,
// see endTodoBefore. The completions other apps recorded from the repeat on
// become todos of their own first, as for a rule change (see
// convertDoneOverrides, A-18), and go again where the series is known not
// to have been written. The series keeps its current repeat, which lies
// before the repeat named, so it is never left without an open one. At the
// current repeat, its last one too, nothing comes before it: the resource
// is deleted, as DeleteTodo deletes it, and it returns a zero Todo and no
// snapshot.
//
// Nothing is written or deleted for what loadTodoFollowing refuses, or for
// a split it cannot compute (ErrSeriesSplitUnsupported, see endTodoBefore).
// It returns the series as written, with its new ETag (NFR-26), and the
// snapshot RestoreTodo undoes the change with, as UpdateTodo does, see
// snapshot.
func (s *service) DeleteTodoFollowing(ctx context.Context, todoID, etag string, recurrenceID time.Time) (_ domain.Todo, _ *domain.Snapshot, err error) {
	if s.err != nil {
		return domain.Todo{}, nil, s.err
	}
	tr, err := s.loadTodoFollowing(ctx, todoID, etag, recurrenceID)
	if err != nil {
		return domain.Todo{}, nil, err
	}
	if tr.place != repeatLater {
		err := s.deleteObject(ctx, tr.objPath, etag)
		s.invalidate(tr.calPath)
		return domain.Todo{}, nil, err
	}
	rid := tr.occ.rid
	if err := endTodoBefore(tr.cal, tr.series, rid); err != nil {
		return domain.Todo{}, nil, err
	}
	now := s.p.now().UTC()
	bumpChangeProps(tr.master, now)
	masterFirst(tr.cal, tr.master)

	var entries []calObject
	defer func() {
		if err != nil && !errors.Is(err, errWriteUnverified) {
			s.removeEntries(ctx, tr.calPath, entries)
		}
	}()
	if entries, err = s.convertDoneOverrides(ctx, tr.calPath, tr.cal, tr.series, tr.series.refsFrom(rid), now); err != nil {
		return domain.Todo{}, nil, err
	}
	o := calObject{path: tr.objPath, cal: tr.cal}
	if o.etag, err = s.putAfterEntries(ctx, tr.objPath, tr.calPath, tr.cal, etag, entries); err != nil {
		return domain.Todo{}, nil, err
	}
	t := todoFromObject(o, encodeID(tr.calPath), tr.master)
	return t, s.snapshot(todoID, tr.todo, tr.raw, t, entries), nil
}
