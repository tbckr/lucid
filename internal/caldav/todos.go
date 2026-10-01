package caldav

import (
	"bytes"
	"cmp"
	"context"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/emersion/go-ical"

	"github.com/tbckr/lucid/internal/domain"
)

// copyRemovalTimeout bounds the compensating DELETE of a completed copy,
// which runs on after the request that started it is cancelled (FR-17).
const copyRemovalTimeout = 10 * time.Second

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
// reports its current and next occurrence (FR-16, FR-17).
func todoFromObject(o calObject, calendarID string, c *ical.Component) domain.Todo {
	desc, checklist := splitChecklist(text(c.Props, ical.PropDescription))
	t := domain.Todo{
		ID:          encodeID(o.path),
		CalendarID:  calendarID,
		UID:         text(c.Props, ical.PropUID),
		ETag:        o.etag,
		Title:       text(c.Props, ical.PropSummary),
		Description: desc,
		Checklist:   checklist,
		Status:      strings.ToUpper(cmp.Or(text(c.Props, ical.PropStatus), domain.TodoNeedsAction)),
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
// anchor (and KDE's pending occurrence): occurrences before the current one
// are done by construction, the current one is reported as such, and later
// ones are upcoming unless a completed override marks them done too.
// Completed overrides recorded before the anchor are also reported as done:
// history kept after the series rolled past them (FR-17).
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

	for ridUnix, c := range s.overrides {
		if ridUnix >= s.anchor.t.Unix() || !strings.EqualFold(text(c.Props, ical.PropStatus), domain.TodoCompleted) {
			continue
		}
		if occ, ok := s.occurrence(time.Unix(ridUnix, 0).UTC()); ok {
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
	for ridUnix := range s.overrides {
		if len(occs) >= maxInstancesPerSeries {
			break
		}
		if ridUnix < s.anchor.t.Unix() || ridUnix <= stopRid.Unix() {
			continue
		}
		if occ, ok := s.occurrence(time.Unix(ridUnix, 0).UTC()); ok {
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
func (s *service) UpdateTodo(ctx context.Context, todoID, etag string, in domain.TodoInput) (domain.Todo, *domain.TodoSnapshot, error) {
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
	// Keep DTSTART for clients that predate `start`, and for recurring todos
	// sent without any date: RFC 5545 requires DTSTART with RRULE (FR-16).
	if in.StartOmitted || (in.Start == nil && in.Due == nil && cur.Recurring) {
		in.Start, in.StartAllDay = cur.Start, cur.StartAllDay
	}
	unchanged := sameDates(cur, in)
	if !unchanged {
		if err := in.ValidateDates(); err != nil {
			return domain.Todo{}, nil, err
		}
	}
	edit, rr, err := ruleEditOf(c, in)
	if err != nil {
		return domain.Todo{}, nil, err
	}
	// A rule Lucid cannot evaluate can be kept or removed, but moving its
	// series or replacing it needs its occurrences (FR-17).
	if cur.RuleUnsupported && (edit == ruleSet || (edit == ruleKeep && !unchanged)) {
		return domain.Todo{}, nil, errRuleUnsupported
	}

	series := newTodoSeries(cal, c)
	switch edit {
	case ruleRemove:
		// The task stays at the current occurrence, whose dates in carries
		// (FR-17).
		removeRecurrence(cal, c)
		c.Props.Del(propKDEPending)
		series = nil
	case ruleSet:
		setTodoRule(cal, c, series, cur.Status, rr, in)
		series = newTodoSeries(cal, c)
	case ruleKeep:
	}

	// Completing an open series completes its current occurrence: a copy
	// keeps it, and the series rolls on. Its last occurrence completes the
	// series itself, below (FR-15, FR-17).
	if series != nil && in.Status == domain.TodoCompleted &&
		cur.Status != domain.TodoCompleted && cur.Status != domain.TodoCancelled {
		if cur.RuleUnsupported {
			return domain.Todo{}, nil, errRuleUnsupported
		}
		_, next, err := series.current()
		if err != nil {
			return domain.Todo{}, nil, errRuleUnsupported
		}
		if next != nil {
			t, err := s.completeOccurrence(ctx, objPath, calPath, etag, cal, c, series, in)
			if err != nil {
				return domain.Todo{}, nil, err
			}
			return t, s.snapshot(todoID, cur, raw, t), nil
		}
	}

	now := s.p.now().UTC()
	switch {
	case series == nil:
		applyTodoDates(c.Props, in)
	case edit == ruleKeep && !unchanged:
		if err := series.move(cal, cur.Status, in); err != nil {
			return domain.Todo{}, nil, err
		}
	default:
		// A series reports its current occurrence, not its stored dates.
		// Sent back unchanged, they must not overwrite DTSTART/DUE: the rule
		// would restart there and lose its overrides. A new rule wrote them
		// already (FR-17).
	}
	applyTodoFields(c, in, now)
	bumpChangeProps(c, now)

	o := calObject{path: objPath, cal: cal}
	o.etag, err = s.putObject(ctx, objPath, cal, etag, false)
	s.invalidate(calPath)
	if err != nil {
		return domain.Todo{}, nil, err
	}
	t := todoFromObject(o, encodeID(calPath), c)
	return t, s.snapshot(todoID, cur, raw, t), nil
}

// snapshot returns what undoes a change of the todo todoID, read as cur from
// raw, that left t (FR-17): raw itself, the ETag the change gave it and the
// completed copy the change left. Only the change of a recurring todo gets
// one, and only when its new ETag is known: without it, an undo could not
// tell another client's change from its own.
func (s *service) snapshot(todoID string, cur domain.Todo, raw []byte, t domain.Todo) *domain.TodoSnapshot {
	if !cur.Recurring || t.ETag == "" {
		return nil
	}
	snap := &domain.TodoSnapshot{TodoID: todoID, ETag: t.ETag, Data: raw, Account: s.identity(), TakenAt: s.p.now()}
	if c := t.CompletedCopy; c != nil {
		snap.CopyID, snap.CopyETag = c.ID, c.ETag
	}
	return snap
}

// RestoreTodo implements domain.CalendarService. It writes the resource of
// snap back as it is, if it still has the ETag the change gave it, and then
// removes the completed copy the change left, see removeCopy (FR-17).
func (s *service) RestoreTodo(ctx context.Context, snap domain.TodoSnapshot) (domain.Todo, error) {
	if s.err != nil {
		return domain.Todo{}, s.err
	}
	objPath, calPath, err := decodeObjectID(s.homePath, snap.TodoID)
	if err != nil {
		return domain.Todo{}, err
	}
	if snap.Account != s.identity() {
		return domain.Todo{}, fmt.Errorf("%w: snapshot of another account", domain.ErrNotFound)
	}
	if err := s.checkWritable(ctx, calPath, ""); err != nil {
		return domain.Todo{}, err
	}
	// Parsed before the write, so that nothing is written that could not be
	// reported; UpdateTodo parsed the same data when it read it.
	cal, err := ical.NewDecoder(bytes.NewReader(snap.Data)).Decode()
	if err != nil {
		return domain.Todo{}, fmt.Errorf("%w: invalid iCalendar data: %w", domain.ErrUpstream, err)
	}
	c := mainComponent(cal, ical.CompToDo)
	if c == nil {
		return domain.Todo{}, fmt.Errorf("%w: %w", domain.ErrNotFound, errWrongComponent)
	}

	defer s.invalidate(calPath)
	o := calObject{path: objPath, cal: cal}
	if o.etag, err = s.putBytes(ctx, objPath, snap.Data, snap.ETag, false); err != nil {
		return domain.Todo{}, err
	}
	t := todoFromObject(o, encodeID(calPath), c)
	if snap.CopyID != "" {
		t.CopyKept = !s.removeCopy(ctx, snap.CopyID, snap.CopyETag)
	}
	return t, nil
}

// removeCopy deletes the completed copy copyID a change left, unless it no
// longer has the ETag etag (unknown: any), and reports whether it is gone
// (FR-17). It runs on after the request is cancelled: the series is
// restored, and a closed tab would leave the copy next to its occurrence.
func (s *service) removeCopy(ctx context.Context, copyID, etag string) bool {
	copyPath, _, err := decodeObjectID(s.homePath, copyID)
	if err == nil {
		dctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), copyRemovalTimeout)
		defer cancel()
		err = s.deleteObject(dctx, copyPath, cmp.Or(etag, "*"))
	}
	if err == nil || errors.Is(err, domain.ErrNotFound) {
		return true
	}
	// Paths and errors only, never task content.
	s.p.log.WarnContext(ctx, "keeping the copy of a completed occurrence on undo", "path", copyPath, "error", err)
	return false
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
// yet), the rule rr from its current occurrence on (FR-17): the dates of in,
// which describe that occurrence, become DTSTART and DUE; overrides from it
// on and KDE's pending occurrence go; completed overrides before it stay as
// history. A todo that did not recur yet takes the zone of in for timed
// dates without a TZID.
func setTodoRule(cal *ical.Calendar, c *ical.Component, s *todoSeries, status, rr string, in domain.TodoInput) {
	if s != nil {
		from := s.reportedRid(status)
		dropOverrides(cal, c, func(rid time.Time) bool { return !rid.Before(from) })
	}
	c.Props.Set(rawProp(ical.PropRecurrenceRule, rr))
	writeSeriesDates(cal, c, in, s != nil)
	c.Props.Del(propKDEPending)
}

// completeOccurrence completes the current occurrence of the open series c
// (FR-15, FR-17), as Apple Reminders, Tasks.org and OpenTasks do:
//
//  1. a completed copy of the occurrence becomes a todo of its own, with the
//     fields of in, the occurrence's dates in the series' form (or in's, if
//     the client changed them) and no rule or alarms;
//  2. the master rolls to the next occurrence with in's other fields, an
//     open checklist and STATUS:NEEDS-ACTION;
//  3. if the master cannot be written, the copy is removed again.
//
// It returns the rolled series with the copy as CompletedCopy.
func (s *service) completeOccurrence(ctx context.Context, objPath, calPath, etag string, cal *ical.Calendar, c *ical.Component, series *todoSeries, in domain.TodoInput) (domain.Todo, error) {
	occ, next, err := series.current()
	if err != nil {
		return domain.Todo{}, errRuleUnsupported
	}
	if next == nil {
		// UpdateTodo completes the master itself for the last occurrence.
		return domain.Todo{}, fmt.Errorf("%w: the series has no next occurrence", domain.ErrInvalidInput)
	}
	now := s.p.now().UTC()
	calendarID := encodeID(calPath)

	// The copy is the occurrence as the client describes it: the stored
	// occurrence unless the client sent other dates than it was given.
	start, startAllDay, due, dueAllDay := occ.start, occ.startAllDay, occ.due, occ.dueAllDay
	if !sameDates(todoFromObject(calObject{path: objPath, cal: cal}, "", c), in) {
		start, startAllDay, due, dueAllDay = in.Start, in.StartAllDay, in.Due, in.DueAllDay
	}
	if start == nil && series.onDue {
		start, startAllDay = due, dueAllDay
	}
	// Written like the series' own dates, with the VTIMEZONE a TZID refers
	// to, which Lucid may not be able to generate.
	startForm, dueForm := series.startForm, series.dueForm
	if startForm.allDay != startAllDay {
		startForm = dateForm{allDay: startAllDay}
	}
	if dueForm.allDay != dueAllDay {
		dueForm = dateForm{allDay: dueAllDay}
	}
	uid := newUID()
	copyCal := newCalendar()
	for _, tz := range cal.Children {
		if id := text(tz.Props, ical.PropTimezoneID); tz.Name == ical.CompTimezone && id != "" &&
			(id == startForm.param || id == dueForm.param) {
			copyCal.Children = append(copyCal.Children, tz)
		}
	}
	cc := newComponent(ical.CompToDo, uid, now)
	copyCal.Children = append(copyCal.Children, cc)
	setSeriesDate(copyCal, cc, ical.PropDateTimeStart, start, startForm)
	setSeriesDate(copyCal, cc, ical.PropDue, due, dueForm)
	applyTodoFields(cc, in, now)

	// Roll the master in memory first: a rule that cannot be evaluated to its
	// end fails before anything is written.
	if err := series.roll(cal, occ, *next); err != nil {
		return domain.Todo{}, errRuleUnsupported
	}
	rolled := in
	rolled.Status = domain.TodoNeedsAction
	rolled.Checklist = make([]domain.ChecklistItem, len(in.Checklist))
	for i, it := range in.Checklist {
		it.Done = false
		rolled.Checklist[i] = it
	}
	applyTodoFields(c, rolled, now)
	c.Props.Del(ical.PropPercentComplete)
	bumpChangeProps(c, now)

	defer s.invalidate(calPath)
	copyObj := calObject{path: objectPath(calPath, uid+".ics"), cal: copyCal}
	if copyObj.etag, err = s.putObject(ctx, copyObj.path, copyCal, "", true); err != nil {
		return domain.Todo{}, err
	}
	o := calObject{path: objPath, cal: cal}
	if o.etag, err = s.putObject(ctx, objPath, cal, etag, false); err != nil {
		// The copy goes even when the client has gone: on the request's
		// context, a closed tab would leave it next to the open occurrence.
		dctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), copyRemovalTimeout)
		defer cancel()
		// Paths and errors only, never task content.
		if derr := s.deleteObject(dctx, copyObj.path, cmp.Or(copyObj.etag, "*")); derr != nil {
			s.p.log.WarnContext(ctx, "could not remove the copy of a completed occurrence", "path", copyObj.path, "error", derr)
		}
		return domain.Todo{}, err
	}
	copyTodo := todoFromObject(copyObj, calendarID, cc)
	t := todoFromObject(o, calendarID, c)
	t.CompletedCopy = &copyTodo
	return t, nil
}

// DeleteTodo implements domain.CalendarService.
func (s *service) DeleteTodo(ctx context.Context, todoID, etag string) error {
	return s.deleteByID(ctx, todoID, etag)
}

// applyTodoFields writes the TodoInput fields other than the dates into c.
func applyTodoFields(c *ical.Component, in domain.TodoInput, now time.Time) {
	setText(c.Props, ical.PropSummary, in.Title)
	setText(c.Props, ical.PropDescription, joinChecklist(in.Description, in.Checklist))
	if in.Priority == 0 {
		c.Props.Del(ical.PropPriority)
	} else {
		c.Props.Set(rawProp(ical.PropPriority, strconv.Itoa(in.Priority)))
	}

	status := cmp.Or(in.Status, domain.TodoNeedsAction)
	wasCompleted := strings.EqualFold(text(c.Props, ical.PropStatus), domain.TodoCompleted)
	c.Props.Set(rawProp(ical.PropStatus, status))
	if status == domain.TodoCompleted {
		if !wasCompleted || c.Props.Get(ical.PropCompleted) == nil {
			setUTCNow(c.Props, ical.PropCompleted, now)
		}
		c.Props.Set(rawProp(ical.PropPercentComplete, "100"))
		return
	}
	c.Props.Del(ical.PropCompleted)
	if p := c.Props.Get(ical.PropPercentComplete); p != nil && strings.TrimSpace(p.Value) == "100" {
		c.Props.Del(ical.PropPercentComplete)
	}
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
