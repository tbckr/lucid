package caldav

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"maps"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/emersion/go-ical"

	"github.com/tbckr/lucid/internal/domain"
)

// ListTodos implements domain.CalendarService. A recurring todo is listed
// once, at its current occurrence (FR-17).
func (s *service) ListTodos(ctx context.Context, calendarID string) ([]domain.Todo, error) {
	if s.err != nil {
		return nil, s.err
	}
	calPath, err := decodeCalendarID(s.homePath, calendarID)
	if err != nil {
		return nil, err
	}
	objs, err := s.objects(ctx, calPath, ical.CompToDo)
	if err != nil {
		return nil, err
	}
	todos := []domain.Todo{}
	for _, o := range objs {
		if c := mainComponent(o.cal, ical.CompToDo); c != nil {
			todos = append(todos, todoFromObject(o, calendarID, c))
		}
	}
	slices.SortStableFunc(todos, func(a, b domain.Todo) int {
		return cmp.Or(cmp.Compare(strings.ToLower(a.Title), strings.ToLower(b.Title)), cmp.Compare(a.ID, b.ID))
	})
	return todos, nil
}

// todoFromObject converts the todo c of o into a Todo. A recurring todo
// reports its current and next occurrence; any todo of the resource, c or one
// of its overrides, with an ORGANIZER or an ATTENDEE makes it report
// attendees (FR-16, FR-17).
func todoFromObject(o calObject, calendarID string, c *ical.Component) domain.Todo {
	desc, checklist := splitChecklist(text(c.Props, ical.PropDescription))
	t := domain.Todo{
		ID:           encodeID(o.path),
		CalendarID:   calendarID,
		UID:          text(c.Props, ical.PropUID),
		ETag:         o.etag,
		Title:        text(c.Props, ical.PropSummary),
		Description:  desc,
		Checklist:    checklist,
		Status:       strings.ToUpper(cmp.Or(text(c.Props, ical.PropStatus), domain.TodoNeedsAction)),
		HasAttendees: hasAttendees(o.cal, ical.CompToDo),
		DetachedFrom: text(c.Props, propDetachedFrom),
	}
	start, startErr := parseDateProp(c.Props.Get(ical.PropDateTimeStart))
	if startErr == nil {
		st := start.t.UTC()
		t.Start, t.StartAllDay = &st, start.allDay
	}
	if d, err := parseDateProp(c.Props.Get(ical.PropDue)); err == nil {
		due := d.t.UTC()
		t.Due, t.DueAllDay = &due, d.allDay
	} else if p := c.Props.Get(ical.PropDuration); p != nil && startErr == nil {
		// DUE and DURATION are exclusive (RFC 5545); report the end as due (FR-16).
		if dur, err := parseDuration(p.Value); err == nil {
			due := dur.addTo(start.t).UTC()
			t.Due, t.DueAllDay = &due, start.allDay
		}
	}
	if p := c.Props.Get(ical.PropPriority); p != nil {
		if n, err := strconv.Atoi(strings.TrimSpace(p.Value)); err == nil && n >= 0 && n <= 9 {
			t.Priority = n
		}
	}
	if d, err := parseDateProp(c.Props.Get(ical.PropCompleted)); err == nil {
		completed := d.t.UTC()
		t.Completed = &completed
	}
	if s := newTodoSeries(o.cal, c); s != nil {
		s.setSeries(&t)
	}
	return t
}

// ListTodoOccurrences implements domain.CalendarService. It returns the
// occurrences of open, readable recurring todos overlapping [start, end)
// (FR-16, FR-17).
func (s *service) ListTodoOccurrences(ctx context.Context, calendarID string, start, end time.Time) ([]domain.TodoOccurrence, error) {
	if s.err != nil {
		return nil, s.err
	}
	calPath, err := decodeCalendarID(s.homePath, calendarID)
	if err != nil {
		return nil, err
	}
	if !end.After(start) {
		return nil, &domain.ValidationError{Msg: "end must be after start"}
	}
	objs, err := s.objects(ctx, calPath, ical.CompToDo)
	if err != nil {
		return nil, err
	}
	occs := []domain.TodoOccurrence{}
	for _, o := range objs {
		c := mainComponent(o.cal, ical.CompToDo)
		if c == nil {
			continue
		}
		// Only open, readable recurring series with a rule Lucid can
		// evaluate: todoFromObject already resolves that via setSeries (FR-17).
		t := todoFromObject(o, calendarID, c)
		if !t.Recurring || t.RuleUnsupported || t.Status == domain.TodoCompleted || t.Status == domain.TodoCancelled {
			continue
		}
		series := newTodoSeries(o.cal, c)
		if series == nil {
			continue
		}
		got, err := seriesOccurrences(series, encodeID(o.path), calendarID, t.Title, start, end)
		if err != nil {
			s.p.log.WarnContext(ctx, "skipping unevaluable recurring todo", "path", o.path, "error", err)
		}
		occs = append(occs, got...)
	}
	slices.SortFunc(occs, func(a, b domain.TodoOccurrence) int {
		return cmp.Or(occAnchorTime(a).Compare(occAnchorTime(b)), cmp.Compare(a.Key, b.Key))
	})
	return occs, nil
}

// occAnchorTime returns the anchor of a reported occurrence: its start, else
// its due (FR-17).
func occAnchorTime(o domain.TodoOccurrence) time.Time {
	if o.Start != nil {
		return *o.Start
	}
	if o.Due != nil {
		return *o.Due
	}
	return o.RecurrenceID
}

// seriesOccurrences returns the occurrences of the open recurring series s
// overlapping [start, end), up to maxInstancesPerSeries, walking from its
// anchor (and KDE's pending occurrence), overrides off the rule included
// (A-10): occurrences before the current one are done by construction, the
// current one is reported as such, and later ones are upcoming unless a
// completed override marks them done too. Completed overrides recorded
// before the anchor are also reported as done: history kept after the
// series rolled past them (FR-17).
//
// The walk itself is bounded by RECURRENCE-ID, not by an occurrence's
// effective (possibly override-shifted) dates, so it can stop before
// reaching an override whose moved DTSTART/DUE would still fall inside the
// window. A second pass over the overrides the walk never reached catches
// those (FR-17).
func seriesOccurrences(s *todoSeries, todoID, calendarID, title string, start, end time.Time) ([]domain.TodoOccurrence, error) {
	occs := []domain.TodoOccurrence{}
	add := func(o todoOcc, state string) {
		if len(occs) >= maxInstancesPerSeries || !occOverlaps(o, start, end) {
			return
		}
		occs = append(occs, todoOccurrenceOf(o, todoID, calendarID, title, state))
	}

	cur, _, err := s.current()
	if err != nil {
		return occs, err
	}
	// stateOf classifies any occurrence of the series, whether reached by the
	// bounded walk below or picked up separately: done occurrences (by
	// construction, everything before cur) stay done, cur is current,
	// everything else is upcoming (FR-17).
	stateOf := func(o todoOcc) string {
		switch {
		case o.done:
			return domain.OccurrenceDone
		case !cur.rid.IsZero() && o.rid.Equal(cur.rid):
			return domain.OccurrenceCurrent
		default:
			return domain.OccurrenceUpcoming
		}
	}

	for _, o := range s.overrides {
		if s.place(o, s.anchor.t) >= 0 || !strings.EqualFold(text(o.c.Props, ical.PropStatus), domain.TodoCompleted) {
			continue
		}
		if occ, ok := s.overrideOcc(o); ok {
			add(occ, domain.OccurrenceDone)
		}
	}

	from := s.anchor.t
	if s.pending.After(from) {
		from = s.pending
	}
	var stopRid time.Time
	walkErr := s.walk(from, func(o todoOcc) bool {
		if len(occs) >= maxInstancesPerSeries {
			return false
		}
		stopRid = o.rid
		add(o, stateOf(o))
		return o.rid.Before(end)
	})
	if walkErr != nil {
		return occs, walkErr
	}

	// Overrides beyond the RECURRENCE-ID the walk stopped at: it never
	// visited them, so they were not yet checked against the window.
	for _, o := range s.overrides {
		if len(occs) >= maxInstancesPerSeries {
			break
		}
		if s.place(o, s.anchor.t) < 0 || s.place(o, stopRid) <= 0 {
			continue
		}
		if occ, ok := s.overrideOcc(o); ok {
			add(occ, stateOf(occ))
		}
	}
	return occs, nil
}

// occAnchor returns the anchor of an occurrence: its start, else its due
// (FR-17).
func occAnchor(o todoOcc) time.Time {
	if o.start != nil {
		return *o.start
	}
	return *o.due
}

// occOverlaps reports whether the occurrence's span overlaps [from, to): the
// span runs from its anchor to its due, with a day added to the end when the
// due is all-day; an occurrence with no due, or whose due equals its anchor
// and is not all-day, is a single point in time (FR-16, FR-17).
func occOverlaps(o todoOcc, from, to time.Time) bool {
	anchor := occAnchor(o)
	if o.due == nil || (o.due.Equal(anchor) && !o.dueAllDay) {
		return !anchor.Before(from) && anchor.Before(to)
	}
	end := *o.due
	if o.dueAllDay {
		end = end.AddDate(0, 0, 1)
	}
	return anchor.Before(to) && end.After(from)
}

// todoOccurrenceOf converts one occurrence of the series identified by
// todoID into a TodoOccurrence. Title is the override's SUMMARY, else the
// master's (FR-16, FR-17).
func todoOccurrenceOf(o todoOcc, todoID, calendarID, masterTitle, state string) domain.TodoOccurrence {
	rid := o.rid.UTC()
	title := masterTitle
	if o.override != nil {
		if t := text(o.override.Props, ical.PropSummary); t != "" {
			title = t
		}
	}
	return domain.TodoOccurrence{
		Key:          todoID + "@" + rid.Format(time.RFC3339),
		TodoID:       todoID,
		CalendarID:   calendarID,
		RecurrenceID: rid,
		Title:        title,
		Start:        utcPtr(o.start),
		StartAllDay:  o.startAllDay,
		Due:          utcPtr(o.due),
		DueAllDay:    o.dueAllDay,
		State:        state,
	}
}

// CreateTodo implements domain.CalendarService.
func (s *service) CreateTodo(ctx context.Context, calendarID string, in domain.TodoInput) (domain.Todo, error) {
	if s.err != nil {
		return domain.Todo{}, s.err
	}
	calPath, err := decodeCalendarID(s.homePath, calendarID)
	if err != nil {
		return domain.Todo{}, err
	}
	if err := in.Validate(); err != nil {
		return domain.Todo{}, err
	}
	if err := in.ValidateDates(); err != nil {
		return domain.Todo{}, err
	}
	rr, err := newTodoRule(in)
	if err != nil {
		return domain.Todo{}, err
	}
	if err := s.checkWritable(ctx, calPath, ical.CompToDo); err != nil {
		return domain.Todo{}, err
	}
	now := s.p.now().UTC()
	uid := newUID()
	cal := newCalendar()
	c := newComponent(ical.CompToDo, uid, now)
	cal.Children = append(cal.Children, c)
	if rr == "" {
		applyTodoDates(c.Props, in)
	} else {
		// A series is written like an event's: timed dates in the browser's
		// zone, so that it recurs at the same wall-clock time (FR-17).
		c.Props.Set(rawProp(ical.PropRecurrenceRule, rr))
		writeSeriesDates(cal, c, in, false)
	}
	applyTodoFields(c, in, now)

	o := calObject{path: objectPath(calPath, uid+".ics"), cal: cal}
	o.etag, err = s.putObject(ctx, o.path, cal, "", true)
	s.invalidate(calPath)
	if err != nil {
		return domain.Todo{}, err
	}
	return todoFromObject(o, calendarID, c), nil
}

// UpdateTodo implements domain.CalendarService. Unknown properties and
// components are preserved. The change of a recurring todo returns a
// snapshot of the resource as read, see snapshot (FR-17).
func (s *service) UpdateTodo(ctx context.Context, todoID, etag string, in domain.TodoInput) (_ domain.Todo, _ *domain.Snapshot, err error) {
	if s.err != nil {
		return domain.Todo{}, nil, s.err
	}
	objPath, calPath, err := decodeObjectID(s.homePath, todoID)
	if err != nil {
		return domain.Todo{}, nil, err
	}
	if err := requireETag(etag); err != nil {
		return domain.Todo{}, nil, err
	}
	if err := in.Validate(); err != nil {
		return domain.Todo{}, nil, err
	}
	if err := s.checkWritable(ctx, calPath, ""); err != nil {
		return domain.Todo{}, nil, err
	}
	cal, current, raw, err := s.getObject(ctx, objPath)
	if err != nil {
		return domain.Todo{}, nil, err
	}
	if current != "" && current != etag {
		return domain.Todo{}, nil, fmt.Errorf("%w: etag mismatch", domain.ErrConflict)
	}
	c := mainComponent(cal, ical.CompToDo)
	if c == nil {
		return domain.Todo{}, nil, fmt.Errorf("%w: %w", domain.ErrNotFound, errWrongComponent)
	}
	cur := todoFromObject(calObject{path: objPath, cal: cal}, "", c)
	edit, err := newTodoEdit(cal, c, cur, in)
	if err != nil {
		return domain.Todo{}, nil, err
	}

	now := s.p.now().UTC()
	// The completions other apps recorded in the overrides a rule edit drops
	// become entries of their own first, cloned from the series as read.
	// They go again when the master is not written: every error from here on
	// comes before its PUT or from it, and a PUT whose new ETag is unknown is
	// no error (A-01, A-18). One that may have been applied all the same
	// keeps them (see settleWrite).
	var entries []calObject
	defer func() {
		if err != nil && !errors.Is(err, errWriteUnverified) {
			s.removeEntries(ctx, calPath, entries)
		}
	}()
	if edit.drop != nil {
		if entries, err = s.convertDoneOverrides(ctx, calPath, cal, edit.series, edit.drop, now); err != nil {
			return domain.Todo{}, nil, err
		}
	}
	series, complete, err := applyTodoEdit(cal, c, edit, now)
	if err != nil {
		return domain.Todo{}, nil, err
	}
	if complete {
		t, err := s.completeOccurrence(ctx, objPath, calPath, etag, cal, c, series, edit.in)
		if err != nil {
			return domain.Todo{}, nil, err
		}
		return t, s.snapshot(todoID, cur, raw, t, entries), nil
	}
	bumpChangeProps(c, now)

	o := calObject{path: objPath, cal: cal}
	if o.etag, err = s.putAfterEntries(ctx, objPath, calPath, cal, etag, entries); err != nil {
		return domain.Todo{}, nil, err
	}
	t := todoFromObject(o, encodeID(calPath), c)
	return t, s.snapshot(todoID, cur, raw, t, entries), nil
}

// putAfterEntries writes the series cal at objPath in calPath with If-Match
// etag, after the entries entries a change created before it (FR-17, A-01):
// with entries, a failure is settled, see settleWrite, and without, it is
// returned as it is. It returns the series' new ETag, "" where the server
// tells none or where settleWrite counts the failed write as applied.
func (s *service) putAfterEntries(ctx context.Context, objPath, calPath string, cal *ical.Calendar, etag string, entries []calObject) (string, error) {
	next, err := s.putObject(ctx, objPath, cal, etag, false)
	s.invalidate(calPath)
	if err != nil && len(entries) > 0 {
		err = s.settleWrite(ctx, objPath, etag, err)
	}
	return next, err
}

// todoEdit is an update of a todo as UpdateTodo makes it, decided on the todo
// as read, before anything changes, see newTodoEdit (FR-17).
type todoEdit struct {
	cur    domain.Todo      // the todo as read, see todoFromObject
	in     domain.TodoInput // the update, with the dates fillTodoDates fills in
	series *todoSeries      // the todo's series as read, nil if it does not recur
	rule   ruleEdit
	rr     string  // the rule ruleSet sets, normalized
	from   todoOcc // the occurrence ruleSet sets it from: the one cur reports
	// unchanged reports that in has cur's dates.
	unchanged bool
	// drop reports the RECURRENCE-IDs of the overrides the rule edit drops,
	// nil where it drops none: all of them for ruleRemove, and for ruleSet of
	// a series those from the occurrence it is set from on (see refsFrom).
	// The completions other apps recorded in them become entries of their
	// own before, see convertDoneOverrides.
	drop func(rid dateValue) bool
}

// newTodoEdit decides the update in of the todo c in cal, read as cur
// (FR-17): the dates in takes from cur where it leaves them out, see
// fillTodoDates, what it does to the rule, see ruleEditOf, and the overrides
// that drops. It refuses, before anything changes, dates that are not valid
// where they differ from cur's, a rule that is not valid, and a move or a new
// rule of a series whose rule Lucid cannot evaluate (errRuleUnsupported).
func newTodoEdit(cal *ical.Calendar, c *ical.Component, cur domain.Todo, in domain.TodoInput) (todoEdit, error) {
	e := todoEdit{cur: cur, in: in, series: newTodoSeries(cal, c)}
	var err error
	if e.unchanged, err = fillTodoDates(cur, &e.in); err != nil {
		return todoEdit{}, err
	}
	if e.rule, e.rr, err = ruleEditOf(c, e.in); err != nil {
		return todoEdit{}, err
	}
	// A rule Lucid cannot evaluate can be kept or removed, but moving its
	// series or replacing it needs its occurrences (FR-17).
	if cur.RuleUnsupported && (e.rule == ruleSet || (e.rule == ruleKeep && !e.unchanged)) {
		return todoEdit{}, errRuleUnsupported
	}
	switch {
	case e.rule == ruleRemove:
		// Only a recurring todo has a rule to remove: e.series is set.
		e.drop = func(dateValue) bool { return true }
	case e.rule == ruleSet && e.series != nil:
		e.from, _ = e.series.reported(cur.Status)
		e.drop = e.series.refsFrom(e.from.rid)
	}
	return e, nil
}

// applyTodoEdit applies the update e to the todo c in cal, in memory, as
// UpdateTodo writes it (FR-17): the rule edit, then the dates, then the
// fields, see applyTodoFields. It does no I/O: before it, the caller turns
// the completions other apps recorded in the overrides e.drop reports into
// entries of their own, see convertDoneOverrides, cloned from e.series as
// read; after it, the caller bumps the change properties and writes. It
// returns the todo's series as edited, nil once it does not recur.
//
// An update that completes the current occurrence of an open series with a
// next one stops after the rule edit, and reports complete: the caller
// completes that occurrence, see completeOccurrence, which writes. The last
// occurrence has no next one to roll to: its fields complete the series
// itself.
//
// It fails, with the dates and fields as they were, for a completion of a
// series whose rule Lucid cannot evaluate (errRuleUnsupported), and for a
// move the series cannot follow, see todoSeries.move; the rule edit stays
// applied in cal then, which the caller does not write.
func applyTodoEdit(cal *ical.Calendar, c *ical.Component, e todoEdit, now time.Time) (series *todoSeries, complete bool, err error) {
	series = e.series
	switch e.rule {
	case ruleRemove:
		// The task stays at the current occurrence, whose dates in carries
		// (FR-17).
		removeRecurrence(cal, c)
		c.Props.Del(propKDEPending)
		series = nil
	case ruleSet:
		setTodoRule(cal, c, series, e.from, e.rr, e.in)
		series = newTodoSeries(cal, c)
	case ruleKeep:
	}

	// Completing an open series completes its current occurrence: a copy
	// keeps it, and the series rolls on. Its last occurrence completes the
	// series itself, below (FR-15, FR-17).
	if series != nil && e.in.Status == domain.TodoCompleted &&
		e.cur.Status != domain.TodoCompleted && e.cur.Status != domain.TodoCancelled {
		if e.cur.RuleUnsupported {
			return nil, false, errRuleUnsupported
		}
		_, next, err := series.current()
		if err != nil {
			return nil, false, errRuleUnsupported
		}
		if next != nil {
			return series, true, nil
		}
	}

	switch {
	case series == nil:
		applyTodoDates(c.Props, e.in)
	case e.rule == ruleKeep && !e.unchanged:
		// A move the rule cannot follow, or one onto a repeat another app
		// changed, fails before anything is written; an undo restores the
		// resource as read and is no move (FR-17).
		if err := series.move(cal, e.cur.Status, e.in); err != nil {
			return nil, false, err
		}
	default:
		// A series reports its current occurrence, not its stored dates.
		// Sent back unchanged, they must not overwrite DTSTART/DUE: the rule
		// would restart there and lose its overrides. A new rule wrote them
		// already (FR-17).
	}
	applyTodoFields(c, e.in, now)
	return series, false, nil
}

// fillTodoDates fills in the dates a change of the todo cur, as read, leaves
// out of in (FR-16): a body without start keeps cur's, for clients that
// predate it, and so does a recurring todo sent without any date, as RFC 5545
// requires DTSTART with RRULE; for an open series, cur's dates are those of
// its current occurrence. It reports whether in then has cur's dates, and
// checks them only where it does not, so that todos from other clients can
// still be completed.
func fillTodoDates(cur domain.Todo, in *domain.TodoInput) (unchanged bool, err error) {
	if in.StartOmitted || (in.Start == nil && in.Due == nil && cur.Recurring) {
		in.Start, in.StartAllDay = cur.Start, cur.StartAllDay
	}
	if sameDates(cur, *in) {
		return true, nil
	}
	return false, in.ValidateDates()
}

// snapshot returns what undoes a change of the todo todoID, read as cur from
// raw, that left t (FR-17): raw itself, the ETag the change gave it and the
// todo the change created, the completed copy, which may stay when it changed
// since, or the detached one, which may not (see domain.CreatedRef.MayStay).
// Only the change of a recurring todo gets one, and only when its new ETag is
// known: without it, an undo could not tell another client's change from its
// own. Neither is there one when the ETag of a detached todo is unknown: an
// undo could never tell it unchanged, and would always be refused. A change
// that turned completed overrides into the entries entries gets none:
// restoring raw would bring the overrides back next to their entries (A-18).
// There is none either if the resource as read has attendees
// (cur.HasAttendees, also in an override the change dropped): the server may
// have sent them the change with the SEQUENCE it carries, and a restore would
// write an older one back (RFC 5545 section 3.8.7.4), as for events (see
// eventSnapshot). The undo store stamps when it took the snapshot in, by its
// own clock.
func (s *service) snapshot(todoID string, cur domain.Todo, raw []byte, t domain.Todo, entries []calObject) *domain.Snapshot {
	detached := t.DetachedCopy
	if !cur.Recurring || cur.HasAttendees || t.ETag == "" || len(entries) > 0 || (detached != nil && detached.ETag == "") {
		return nil
	}
	snap := &domain.Snapshot{Kind: domain.SnapshotTodo, ID: todoID, ETag: t.ETag, Data: raw, Account: s.identity()}
	if c := t.CompletedCopy; c != nil {
		snap.Created = append(snap.Created, domain.CreatedRef{ID: c.ID, ETag: c.ETag, MayStay: true})
	}
	if detached != nil {
		snap.Created = append(snap.Created, domain.CreatedRef{ID: detached.ID, ETag: detached.ETag})
	}
	return snap
}

// RestoreTodo implements domain.CalendarService. It writes the resource of
// snap back as it is, if it still has the ETag the change gave it, and then
// removes the completed copy the change left, see restoreResource (FR-17).
func (s *service) RestoreTodo(ctx context.Context, snap domain.Snapshot) (domain.Todo, error) {
	o, c, calPath, createdKept, err := s.restoreResource(ctx, snap, domain.SnapshotTodo, ical.CompToDo)
	if err != nil {
		return domain.Todo{}, err
	}
	t := todoFromObject(o, encodeID(calPath), c)
	t.CopyKept = createdKept
	return t, nil
}

// ruleEdit is what an update does to the rule of a todo (FR-17).
type ruleEdit int

const (
	ruleKeep   ruleEdit = iota // rrule omitted, the stored rule, or nothing to remove
	ruleRemove                 // rrule "" on a recurring todo
	ruleSet                    // another rule
)

// ruleEditOf returns what in does to the rule of c and, for ruleSet, the
// normalized rule. A rule that differs from the stored one only in case is
// the stored rule: it stays as it is, with its overrides (FR-17).
func ruleEditOf(c *ical.Component, in domain.TodoInput) (ruleEdit, string, error) {
	rr := trimRRule(in.RRule)
	switch {
	case in.RRuleOmitted:
		return ruleKeep, "", nil
	case rr == "" && isRecurring(c):
		return ruleRemove, "", nil
	case rr == "" || strings.EqualFold(rr, rruleString(c)):
		return ruleKeep, "", nil
	}
	rr, err := newTodoRule(in)
	if err != nil {
		return ruleKeep, "", err
	}
	return ruleSet, rr, nil
}

// newTodoRule returns the normalized rule of in, "" for none. A rule needs a
// start or due to recur from (FR-17).
func newTodoRule(in domain.TodoInput) (string, error) {
	if trimRRule(in.RRule) == "" {
		return "", nil
	}
	anchor := cmp.Or(in.Start, in.Due)
	if anchor == nil {
		return "", errRuleNeedsDate
	}
	return normalizeRRule(in.RRule, anchor.UTC())
}

// setTodoRule gives the todo c, with the series s (nil if it does not recur
// yet), the rule rr from the occurrence from on, the one the todo reports
// (see reported) (FR-17): the dates of in, which describe that occurrence,
// become DTSTART and DUE; overrides from it on (see refsFrom) and KDE's
// pending occurrence go, the completed ones turned into entries of their own
// before (see convertDoneOverrides); the EXDATEs go too, as they would
// exclude the new rule's instances on the old rule's dates (A-17); completed
// overrides before it stay as history, and with an UNTIL they take the
// value type of in's dates when it changes (see retypeRefs). A todo that
// did not recur yet takes the zone of in for timed dates without a TZID. A
// todo detached from another series (see propDetachedFrom) loses that origin:
// with a rule it is a series of its own.
func setTodoRule(cal *ical.Calendar, c *ical.Component, s *todoSeries, from todoOcc, rr string, in domain.TodoInput) {
	if s != nil {
		dropOverrides(cal, c, s.refsFrom(from.rid))
		dropOccurrence(cal, c, from)
	}
	c.Props.Del(ical.PropExceptionDates)
	c.Props.Set(rawProp(ical.PropRecurrenceRule, rr))
	writeSeriesDates(cal, c, in, s != nil)
	c.Props.Del(propKDEPending)
	// With a rule the todo is a series of its own, no longer the copy of a
	// repeat of another one.
	c.Props.Del(propDetachedFrom)
	if to, err := parseDateProp(c.Props.Get(ical.PropDateTimeStart)); s != nil && err == nil {
		s.retypeRefs(cal, to)
	}
}

// completeOccurrence completes the current occurrence of the open series c
// (FR-15, FR-17), as Apple Reminders, Tasks.org and OpenTasks do:
//
//  1. a completed copy of the occurrence becomes a todo of its own: a clone
//     of the occurrence as stored (see cloneOccurrence), with the fields the
//     client changed (see applyChangedFields) and with in's dates if the
//     client sent other dates than it was given;
//  2. the master rolls to the next occurrence with in's fields, an open
//     checklist and STATUS:NEEDS-ACTION;
//  3. if the master is known not to have been written, or the copy's create
//     failed after the server may have stored it, the copy is removed again
//     (see writeCreatedThenMaster).
//
// The master rolls only onto an instance of the rule (see roll), also from
// an occurrence off the rule (see todoOcc.offGrid), whose override goes
// with the roll (A-10). When the next occurrence lies off the rule, the
// master stays where it is: a completed occurrence off the rule only loses
// its override, and a completed instance gets an EXDATE (see exclude).
//
// It returns the rolled series with the copy as CompletedCopy.
func (s *service) completeOccurrence(ctx context.Context, objPath, calPath, etag string, cal *ical.Calendar, c *ical.Component, series *todoSeries, in domain.TodoInput) (domain.Todo, error) {
	t, copyTodo, err := s.writeOffCurrent(ctx, objPath, calPath, etag, cal, c, series, in, true)
	if err != nil {
		return domain.Todo{}, err
	}
	t.CompletedCopy = &copyTodo
	return t, nil
}

// writeOffCurrent splits the current occurrence of the open series c in cal
// off as a todo of its own, completed or not, see splitOffCurrent, and writes
// it and then the rolled series, see writeCreatedThenMaster (FR-17). It
// returns both as written: the series, with its new ETag if the server tells
// it, and the todo split off.
func (s *service) writeOffCurrent(ctx context.Context, objPath, calPath, etag string, cal *ical.Calendar, c *ical.Component, series *todoSeries, in domain.TodoInput, completed bool) (t, split domain.Todo, err error) {
	cur := todoFromObject(calObject{path: objPath, cal: cal}, "", c)
	cc, copyCal, err := s.splitOffCurrent(cal, c, series, in, cur, completed, s.p.now().UTC())
	if err != nil {
		return domain.Todo{}, domain.Todo{}, err
	}
	defer s.invalidate(calPath)
	calendarID := encodeID(calPath)
	copyObj := calObject{path: objectPath(calPath, text(cc.Props, ical.PropUID)+".ics"), cal: copyCal}
	o := calObject{path: objPath, cal: cal}
	if o.etag, err = s.writeCreatedThenMaster(ctx, calPath, &copyObj, objPath, cal, etag); err != nil {
		return domain.Todo{}, domain.Todo{}, err
	}
	return todoFromObject(o, calendarID, c), todoFromObject(copyObj, calendarID, cc), nil
}

// splitOffCurrent splits the current occurrence of the open series c in cal,
// the todo cur as read, off as a todo of its own, and rolls the series on to
// its next occurrence, all in memory (FR-15, FR-17). It is what completing
// and detaching the current occurrence share; the copy and the series differ
// by completed:
//
//   - The copy, a clone of the occurrence as stored (see cloneOccurrence),
//     takes the dates of in where they differ from cur's, the occurrence's,
//     and the fields of in that differ from cur's (see applyChangedFields),
//     the checklist with its state. A completed one is marked completed and
//     has no alarms, since a done task must not ring. A detached one keeps
//     the occurrence's alarms, stays open with the progress it has (see
//     keepOpen), with in's status where it differs from cur's, and carries
//     the UID of the series it was detached from (propDetachedFrom), set
//     over one it may have cloned from the series, never added next to it.
//   - The series rolls on, see rollPast, and is open (STATUS:NEEDS-ACTION,
//     without COMPLETED or PERCENT-COMPLETE). On a completion it takes in's
//     fields, its checklist unchecked: the client edited the series it was
//     given. On a detach its title, notes and priority stay as stored, as
//     in's fields are the detached occurrence's, and only its own checklist
//     is unchecked, see reopen.
//
// It returns the copy and a calendar of its own for it, with the VTIMEZONEs
// of the series as read (see entryCalendar). The series has a next
// occurrence, or it is ErrInvalidInput: the last one has nothing to roll to.
// It fails, with cal unchanged, when the rule cannot be evaluated as far as
// the roll needs it, see rollPast.
func (s *service) splitOffCurrent(cal *ical.Calendar, c *ical.Component, series *todoSeries, in domain.TodoInput, cur domain.Todo, completed bool, now time.Time) (cc *ical.Component, copyCal *ical.Calendar, err error) {
	occ, next, err := series.current()
	if err != nil {
		return nil, nil, errRuleUnsupported
	}
	if next == nil {
		// UpdateTodo completes the master itself for the last occurrence.
		return nil, nil, fmt.Errorf("%w: the series has no next occurrence", domain.ErrInvalidInput)
	}

	// The copy is the occurrence as stored, changed where the client changed
	// the series as it was given: its dates, its fields.
	cc = cloneOccurrence(series, occ, newUID(), now, !completed)
	if !sameDates(cur, in) {
		series.setEntryDates(cc, todoOcc{start: in.Start, startAllDay: in.StartAllDay, due: in.Due, dueAllDay: in.DueAllDay})
	}
	applyChangedFields(cc, in, cur, now)
	if completed {
		markCompleted(cc, now)
	} else {
		keepOpen(cc)
		// The status is the series' as read, unless the client changed it,
		// as for the other fields; it leaves the repeat open (requireOpen).
		if status := cmp.Or(in.Status, domain.TodoNeedsAction); status != cur.Status {
			cc.Props.Set(rawProp(ical.PropStatus, status))
		}
		// TEXT is the value type of an X- property (RFC 5545 section
		// 3.8.8.2), which go-ical would write out as VALUE=TEXT.
		origin := ical.NewProp(propDetachedFrom)
		origin.SetText(text(c.Props, ical.PropUID))
		origin.Params.Del(ical.ParamValue)
		cc.Props.Set(origin)
	}
	copyCal = entryCalendar(cal, cc)

	// Roll the master in memory first: a rule that cannot be evaluated to its
	// end fails before anything is written.
	if err := series.rollPast(cal, occ, *next); err != nil {
		return nil, nil, err
	}
	if completed {
		applyTodoFields(c, rolledInput(in), now)
		c.Props.Del(ical.PropPercentComplete)
	} else {
		reopen(c)
	}
	bumpChangeProps(c, now)
	return cc, copyCal, nil
}

// rolledInput returns in as the fields of a series that rolls on to its
// next occurrence take it (FR-17): open (STATUS:NEEDS-ACTION), with in's
// checklist unchecked, as its progress belongs to the occurrence the series
// rolled past.
func rolledInput(in domain.TodoInput) domain.TodoInput {
	in.Status = domain.TodoNeedsAction
	list := make([]domain.ChecklistItem, len(in.Checklist))
	for i, it := range in.Checklist {
		it.Done = false
		list[i] = it
	}
	in.Checklist = list
	return in
}

// keepOpen leaves c, the clone of an open repeat, open with the progress
// it has (FR-17): a STATUS of NEEDS-ACTION or IN-PROCESS and a
// PERCENT-COMPLETE below 100 stay; any other status becomes NEEDS-ACTION,
// and COMPLETED and a PERCENT-COMPLETE of 100 go.
func keepOpen(c *ical.Component) {
	switch strings.ToUpper(strings.TrimSpace(text(c.Props, ical.PropStatus))) {
	case domain.TodoNeedsAction, domain.TodoInProcess:
	default:
		c.Props.Set(rawProp(ical.PropStatus, domain.TodoNeedsAction))
	}
	c.Props.Del(ical.PropCompleted)
	if p := c.Props.Get(ical.PropPercentComplete); p != nil {
		if n, err := strconv.Atoi(strings.TrimSpace(p.Value)); err == nil && n >= 100 {
			c.Props.Del(ical.PropPercentComplete)
		}
	}
}

// markOpen sets STATUS:NEEDS-ACTION and removes COMPLETED and
// PERCENT-COMPLETE: c is a todo nothing has been done of (FR-17).
func markOpen(c *ical.Component) {
	c.Props.Set(rawProp(ical.PropStatus, domain.TodoNeedsAction))
	c.Props.Del(ical.PropCompleted)
	c.Props.Del(ical.PropPercentComplete)
}

// reopen opens the master c of a series rolled past an occurrence that left
// without a change of the series, detached or skipped, for its next one, as
// a completion does (FR-17): STATUS:NEEDS-ACTION, without COMPLETED or
// PERCENT-COMPLETE, and its own checklist unchecked, which belongs to the
// next occurrence now. Its title, notes and priority stay as stored, and so
// does DESCRIPTION while nothing on its checklist is checked.
func reopen(c *ical.Component) {
	markOpen(c)
	notes, list := splitChecklist(text(c.Props, ical.PropDescription))
	if !slices.ContainsFunc(list, func(it domain.ChecklistItem) bool { return it.Done }) {
		return
	}
	for i := range list {
		list[i].Done = false
	}
	setText(c.Props, ical.PropDescription, joinChecklist(notes, list))
}

// convertDoneOverrides creates a completed entry (cloneOccurrence) for every
// override of series in cal with STATUS:COMPLETED whose RECURRENCE-ID drop
// reports, before the master is written; it returns their paths and ETags
// so a failed master write can remove them again (FR-17, A-18, see
// removeEntries). Another app's completion never goes with a rule.
//
// An entry is the occurrence as stored, with the other app's COMPLETED (see
// markCompleted). It takes nothing of the request, which edits the series,
// not a past completion. An override that an EXDATE excludes is no done
// occurrence and records no completion. Each entry is created with
// If-None-Match; if one cannot be, those created before go again, and so does
// that one if its create failed without the server's refusal, which can come
// after the server stored it, see removeIfStored.
func (s *service) convertDoneOverrides(ctx context.Context, calPath string, cal *ical.Calendar, series *todoSeries, drop func(rid dateValue) bool, now time.Time) ([]calObject, error) {
	var entries []calObject
	for _, occ := range series.completions(drop) {
		uid := newUID()
		c := cloneOccurrence(series, occ, uid, now, false)
		markCompleted(c, now)
		entry := calObject{path: objectPath(calPath, uid+".ics"), cal: entryCalendar(cal, c)}
		var err error
		if entry.etag, err = s.putObject(ctx, entry.path, entry.cal, "", true); err != nil {
			if !writeRefused(err) {
				s.removeIfStored(ctx, calPath, entry.path)
			}
			s.removeEntries(ctx, calPath, entries)
			return nil, err
		}
		entries = append(entries, entry)
	}
	return entries, nil
}

// completions returns the occurrences of s that another app completed by an
// override whose RECURRENCE-ID drop reports, the ones convertDoneOverrides
// turns into entries, in RECURRENCE-ID order (FR-17, A-18). An override an
// EXDATE excludes is none, nor is one of the other value type behind an
// override of the same repeat, see newTodoSeries.
func (s *todoSeries) completions(drop func(rid dateValue) bool) []todoOcc {
	var out []todoOcc
	for _, o := range s.overrides {
		rid, err := parseDateProp(o.c.Props.Get(ical.PropRecurrenceID))
		if err != nil || !drop(rid) {
			continue
		}
		if occ, ok := s.overrideOcc(o); ok && occ.done {
			out = append(out, occ)
		}
	}
	return out
}

// propExRule is RFC 2445's EXRULE, which RFC 5545 deprecates but which is a
// rule part all the same.
const propExRule = "EXRULE"

// cloneOccurrence returns a new VTODO for occ of series s (FR-17): the master's
// properties overlaid with occ's override, without RRULE, RDATE, EXDATE,
// EXRULE, RECURRENCE-ID, X-KDE-LIBKCAL-DTRECURRENCE, RELATED-TO;RELTYPE=CHILD,
// ORGANIZER and ATTENDEE, with a new UID and fresh
// DTSTAMP/CREATED/LAST-MODIFIED/SEQUENCE, and occ's dates in the series' form.
//
// An override's property replaces all of the master's with its name, so a
// full override, as Thunderbird writes it, is cloned as it is, and a minimal
// one keeps the series' title and categories. A completed entry is a private
// record: a new resource with ORGANIZER and ATTENDEE could make the server
// send scheduling messages for every completion (RFC 6638). A VTODO holds
// only VALARMs as children: the clone has none, since a done task must not
// ring, unless keepAlarms is set, for an occurrence that stays open; then it
// has copies of occ's alarms, its override's own where it has any, else the
// series'. Its VTIMEZONEs are entryCalendar's.
func cloneOccurrence(s *todoSeries, occ todoOcc, uid string, now time.Time, keepAlarms bool) *ical.Component {
	c := ical.NewComponent(ical.CompToDo)
	for name, props := range s.master.Props {
		c.Props[name] = cloneProps(props)
	}
	if occ.override != nil {
		for name, props := range occ.override.Props {
			c.Props[name] = cloneProps(props)
		}
	}
	for _, name := range []string{
		ical.PropRecurrenceRule, ical.PropRecurrenceDates, ical.PropExceptionDates, propExRule, ical.PropRecurrenceID,
		propKDEPending, ical.PropOrganizer, ical.PropAttendee,
	} {
		c.Props.Del(name)
	}
	// The series' subtasks belong to the series, not to one done occurrence.
	dropChildLinks(c)
	maps.Copy(c.Props, newComponent(ical.CompToDo, uid, now).Props)
	s.setEntryDates(c, occ)
	if keepAlarms {
		isAlarm := func(a *ical.Component) bool { return a.Name == ical.CompAlarm }
		from := s.master
		if occ.override != nil && slices.ContainsFunc(occ.override.Children, isAlarm) {
			from = occ.override
		}
		for _, a := range from.Children {
			if isAlarm(a) {
				c.Children = append(c.Children, copyComponent(a))
			}
		}
	}
	return c
}

// dropChildLinks removes the links of c, a clone of a series, to the
// series' subtasks (RELATED-TO;RELTYPE=CHILD), which stay with the series it
// was cloned from, and keeps its other relations (FR-17).
func dropChildLinks(c *ical.Component) {
	if rel := slices.DeleteFunc(c.Props[ical.PropRelatedTo], func(p ical.Prop) bool {
		return strings.EqualFold(p.Params.Get(ical.ParamRelationshipType), "CHILD")
	}); len(rel) > 0 {
		c.Props[ical.PropRelatedTo] = rel
	} else {
		c.Props.Del(ical.PropRelatedTo)
	}
}

// cloneProps returns a copy of props that shares nothing with them.
func cloneProps(props []ical.Prop) []ical.Prop {
	out := make([]ical.Prop, len(props))
	for i, p := range props {
		params := make(ical.Params, len(p.Params))
		for k, v := range p.Params {
			params[k] = slices.Clone(v)
		}
		p.Params = params
		out[i] = p
	}
	return out
}

// setEntryDates writes the start and due of occ as DTSTART and DUE of c, an
// entry of its own for an occurrence of s or the override of one off the
// rule (FR-16, FR-17): in the form the series writes them, a DATE or UTC
// where the value type differs from the series'. Without a start, a series
// anchored on DUE gives it DTSTART = DUE, as it has itself. DUE replaces a
// DURATION, which RFC 5545 does not allow next to it. The VTIMEZONEs are
// entryCalendar's.
func (s *todoSeries) setEntryDates(c *ical.Component, occ todoOcc) {
	start, startAllDay, due, dueAllDay := occ.start, occ.startAllDay, occ.due, occ.dueAllDay
	if start == nil && s.onDue {
		start, startAllDay = due, dueAllDay
	}
	startForm, dueForm := s.startForm, s.dueForm
	if startForm.allDay != startAllDay {
		startForm = dateForm{allDay: startAllDay}
	}
	if dueForm.allDay != dueAllDay {
		dueForm = dateForm{allDay: dueAllDay}
	}
	setSeriesDate(nil, c, ical.PropDateTimeStart, start, startForm)
	setSeriesDate(nil, c, ical.PropDue, due, dueForm)
	c.Props.Del(ical.PropDuration)
}

// entryCalendar returns a calendar of its own for c, an entry cloned from a
// series in src, with the VTIMEZONEs its DTSTART and DUE refer to (FR-17):
// src's, which Lucid may not be able to generate, else generated ones.
func entryCalendar(src *ical.Calendar, c *ical.Component) *ical.Calendar {
	cal := newCalendar()
	for _, name := range []string{ical.PropDateTimeStart, ical.PropDue} {
		p := c.Props.Get(name)
		if p == nil {
			continue
		}
		tzid := p.Params.Get(ical.ParamTimezoneID)
		if tzid == "" || findVTimezone(cal, tzid) != nil {
			continue
		}
		if tz := findVTimezone(src, tzid); tz != nil {
			cal.Children = append(cal.Children, tz)
		} else if loc := loadLocation(tzid); loc != nil && loc != time.UTC {
			if d, err := parseDateProp(p); err == nil {
				ensureVTimezoneAs(cal, tzid, loc, d.t.In(loc).Year())
			}
		}
	}
	cal.Children = append(cal.Children, c)
	return cal
}

// applyChangedFields writes the fields of in that differ from cur (the master
// as read), so an override's own title or notes survive an unchanged request.
// The notes and the checklist, which share DESCRIPTION, count on their own:
// a checked item keeps the notes of c. Status and dates are the caller's, so
// the time, which only a status needs, goes unused (FR-17).
func applyChangedFields(c *ical.Component, in domain.TodoInput, cur domain.Todo, _ time.Time) {
	if in.Title != cur.Title {
		setText(c.Props, ical.PropSummary, in.Title)
	}
	notesChanged, listChanged := in.Description != cur.Description, !slices.Equal(in.Checklist, cur.Checklist)
	if notesChanged || listChanged {
		notes, list := splitChecklist(text(c.Props, ical.PropDescription))
		if notesChanged {
			notes = in.Description
		}
		if listChanged {
			list = in.Checklist
		}
		setText(c.Props, ical.PropDescription, joinChecklist(notes, list))
	}
	if in.Priority != cur.Priority {
		setPriority(c.Props, in.Priority)
	}
}

// DeleteTodo implements domain.CalendarService.
func (s *service) DeleteTodo(ctx context.Context, todoID, etag string) error {
	return s.deleteByID(ctx, todoID, etag)
}

// applyTodoFields writes the TodoInput fields other than the dates into c.
func applyTodoFields(c *ical.Component, in domain.TodoInput, now time.Time) {
	setText(c.Props, ical.PropSummary, in.Title)
	setText(c.Props, ical.PropDescription, joinChecklist(in.Description, in.Checklist))
	setPriority(c.Props, in.Priority)

	status := cmp.Or(in.Status, domain.TodoNeedsAction)
	if status == domain.TodoCompleted {
		markCompleted(c, now)
		return
	}
	c.Props.Set(rawProp(ical.PropStatus, status))
	c.Props.Del(ical.PropCompleted)
	if p := c.Props.Get(ical.PropPercentComplete); p != nil && strings.TrimSpace(p.Value) == "100" {
		c.Props.Del(ical.PropPercentComplete)
	}
}

// setPriority writes PRIORITY, removing it for 0 (undefined).
func setPriority(props ical.Props, priority int) {
	if priority == 0 {
		props.Del(ical.PropPriority)
		return
	}
	props.Set(rawProp(ical.PropPriority, strconv.Itoa(priority)))
}

// markCompleted sets STATUS:COMPLETED, PERCENT-COMPLETE:100 and COMPLETED at
// now; a todo completed before keeps its COMPLETED (FR-15).
func markCompleted(c *ical.Component, now time.Time) {
	wasCompleted := strings.EqualFold(text(c.Props, ical.PropStatus), domain.TodoCompleted)
	c.Props.Set(rawProp(ical.PropStatus, domain.TodoCompleted))
	if !wasCompleted || c.Props.Get(ical.PropCompleted) == nil {
		setUTCNow(c.Props, ical.PropCompleted, now)
	}
	c.Props.Set(rawProp(ical.PropPercentComplete, "100"))
}

// applyTodoDates writes the start and due of in (FR-16).
func applyTodoDates(props ical.Props, in domain.TodoInput) {
	setTodoDate(props, ical.PropDateTimeStart, in.Start, in.StartAllDay)
	setTodoDate(props, ical.PropDue, in.Due, in.DueAllDay)
	// A DURATION read before is written back as DUE.
	props.Del(ical.PropDuration)
}

// sameDates reports whether in carries the start and due cur already has.
func sameDates(cur domain.Todo, in domain.TodoInput) bool {
	return sameInstant(cur.Start, in.Start) && cur.StartAllDay == in.StartAllDay &&
		sameInstant(cur.Due, in.Due) && cur.DueAllDay == in.DueAllDay
}

func sameInstant(a, b *time.Time) bool {
	if a == nil || b == nil {
		return a == b
	}
	return a.Equal(*b)
}

// setTodoDate sets or removes a date property. An unchanged value keeps the
// stored property, so completing a task from another client does not rewrite
// its TZID-anchored DTSTART/DUE to UTC.
func setTodoDate(props ical.Props, name string, t *time.Time, allDay bool) {
	if t == nil {
		props.Del(name)
		return
	}
	if d, err := parseDateProp(props.Get(name)); err == nil && d.allDay == allDay && d.t.Equal(*t) {
		return
	}
	props.Set(newDateProp(name, *t, allDay, nil))
}

// checklistLine matches a Markdown task list item.
var checklistLine = regexp.MustCompile(`^\s*[-*+]\s+\[([ xX])\]\s?(.*)$`)

// splitChecklist separates the free-text description from the trailing block
// of Markdown task lines.
func splitChecklist(desc string) (string, []domain.ChecklistItem) {
	desc = strings.ReplaceAll(desc, "\r\n", "\n")
	lines := strings.Split(strings.TrimRight(desc, " \t\n"), "\n")
	i := len(lines)
	for i > 0 && checklistLine.MatchString(lines[i-1]) {
		i--
	}
	items := []domain.ChecklistItem{}
	for _, l := range lines[i:] {
		m := checklistLine.FindStringSubmatch(l)
		txt := strings.TrimSpace(m[2])
		if txt == "" {
			continue
		}
		items = append(items, domain.ChecklistItem{Text: txt, Done: m[1] != " "})
	}
	return strings.TrimRight(strings.Join(lines[:i], "\n"), " \t\n"), items
}

// joinChecklist appends the checklist as Markdown task lines to desc.
func joinChecklist(desc string, items []domain.ChecklistItem) string {
	desc = strings.TrimRight(strings.ReplaceAll(desc, "\r\n", "\n"), " \t\n")
	if len(items) == 0 {
		return desc
	}
	var b strings.Builder
	b.WriteString(desc)
	if desc != "" {
		b.WriteString("\n\n")
	}
	for i, it := range items {
		if i > 0 {
			b.WriteByte('\n')
		}
		mark := " "
		if it.Done {
			mark = "x"
		}
		// Newlines inside an item would break the list structure.
		b.WriteString("- [" + mark + "] " + strings.Join(strings.Fields(it.Text), " "))
	}
	return b.String()
}
