package caldav

import (
	"cmp"
	"context"
	"crypto/rand"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/emersion/go-ical"
	"github.com/teambition/rrule-go"

	"github.com/tbckr/lucid/internal/diag"
	"github.com/tbckr/lucid/internal/domain"
)

// Bounds for recurrence expansion (PRD risk 1: expensive infinite series).
const (
	// maxInstancesPerSeries caps the occurrences returned per series and window.
	maxInstancesPerSeries = 1000
	// maxRRuleIterations caps the RRULE iterations per series, including
	// those before the window.
	maxRRuleIterations = 100_000
)

// ListEvents implements domain.CalendarService.
func (s *service) ListEvents(ctx context.Context, calendarID string, start, end time.Time) ([]domain.Event, error) {
	if s.err != nil {
		return nil, s.err
	}
	calPath, err := s.p.ids.decodeCalendarID(s.homePath, calendarID)
	if err != nil {
		return nil, err
	}
	if !end.After(start) {
		return nil, &domain.ValidationError{Msg: "end must be after start"}
	}
	objs, err := s.objects(ctx, calPath, ical.CompEvent)
	if err != nil {
		return nil, err
	}
	events := []domain.Event{}
	for _, o := range objs {
		evs, err := expandObject(o, s.ref(o.path, calendarID), start, end)
		if err != nil {
			// The event stays out of the listing, or is shown as far as it can be.
			s.objectProblem(ctx, diag.ProblemInvalidObject, o.path, encodeForSkeleton(o.cal), err)
		}
		events = append(events, evs...)
	}
	slices.SortFunc(events, func(a, b domain.Event) int {
		return cmp.Or(a.Start.Compare(b.Start), cmp.Compare(a.Key, b.Key))
	})
	return events, nil
}

// timing is the parsed start and duration of a VEVENT.
type timing struct {
	start dateValue
	dur   span
}

func parseTiming(c *ical.Component) (timing, error) {
	st, err := parseDateProp(c.Props.Get(ical.PropDateTimeStart))
	if err != nil {
		return timing{}, fmt.Errorf("DTSTART: %w", err)
	}
	tm := timing{start: st}
	switch {
	case c.Props.Get(ical.PropDateTimeEnd) != nil:
		en, err := parseDateProp(c.Props.Get(ical.PropDateTimeEnd))
		if err != nil {
			return timing{}, fmt.Errorf("DTEND: %w", err)
		}
		if st.allDay && en.allDay {
			tm.dur.days = int(en.t.Sub(st.t).Round(24*time.Hour) / (24 * time.Hour))
		} else {
			tm.dur.exact = en.t.Sub(st.t)
		}
	case c.Props.Get(ical.PropDuration) != nil:
		d, err := parseDuration(c.Props.Get(ical.PropDuration).Value)
		if err != nil {
			return timing{}, fmt.Errorf("DURATION: %w", err)
		}
		tm.dur = d
	case st.allDay:
		tm.dur.days = 1
	}
	if tm.dur.days < 0 || tm.dur.exact < 0 {
		tm.dur = span{}
		if st.allDay {
			tm.dur.days = 1
		}
	}
	return tm, nil
}

// baseEvent fills the fields shared by all occurrences of a component.
func baseEvent(o calObject, ref objRef, c *ical.Component) domain.Event {
	return domain.Event{
		ID:          ref.id,
		Key:         ref.id,
		CalendarID:  ref.calendarID,
		UID:         text(c.Props, ical.PropUID),
		ETag:        o.etag,
		Title:       text(c.Props, ical.PropSummary),
		Description: text(c.Props, ical.PropDescription),
		Location:    text(c.Props, ical.PropLocation),
		RRule:       rruleString(c),
	}
}

func rruleString(c *ical.Component) string {
	if p := c.Props.Get(ical.PropRecurrenceRule); p != nil {
		return strings.TrimSpace(p.Value)
	}
	return ""
}

func isRecurring(c *ical.Component) bool {
	return c.Props.Get(ical.PropRecurrenceRule) != nil || c.Props.Get(ical.PropRecurrenceDates) != nil
}

// at returns ev placed at occStart with the given timing.
func at(ev domain.Event, tm timing, occStart time.Time) domain.Event {
	occStart = occStart.In(tm.start.loc())
	ev.Start = occStart.UTC()
	ev.End = tm.dur.addTo(occStart).UTC()
	ev.AllDay = tm.start.allDay
	ev.Timezone = tm.start.tzid
	return ev
}

// asOccurrence marks ev as the occurrence with the given recurrence ID.
func asOccurrence(ev domain.Event, rid time.Time) domain.Event {
	rid = rid.UTC()
	ev.Recurring = true
	ev.RecurrenceID = &rid
	ev.Key = ev.ID + "@" + rid.Format(time.RFC3339)
	return ev
}

func overlaps(ev domain.Event, from, to time.Time) bool {
	if !ev.End.After(ev.Start) {
		return !ev.Start.Before(from) && ev.Start.Before(to)
	}
	return ev.Start.Before(to) && ev.End.After(from)
}

// expandObject returns all occurrences of the events in o overlapping
// [from, to).
func expandObject(o calObject, ref objRef, from, to time.Time) ([]domain.Event, error) {
	var master *ical.Component
	var orphans []*ical.Component
	for _, c := range o.cal.Children {
		if c.Name != ical.CompEvent {
			continue
		}
		if c.Props.Get(ical.PropRecurrenceID) != nil {
			orphans = append(orphans, c)
			continue
		}
		if master == nil {
			master = c
		}
	}
	if master == nil {
		// Only overridden instances (e.g. a single invitation): show them as-is.
		var out []domain.Event
		attendees := hasAttendees(o.cal, ical.CompEvent)
		for _, c := range orphans {
			tm, err := parseTiming(c)
			if err != nil {
				return out, err
			}
			ev := at(baseEvent(o, ref, c), tm, tm.start.t)
			ev.HasAttendees = attendees
			if rid, err := parseDateProp(c.Props.Get(ical.PropRecurrenceID)); err == nil {
				t := rid.t.UTC()
				ev.RecurrenceID = &t
			}
			if overlaps(ev, from, to) {
				out = append(out, ev)
			}
		}
		return out, nil
	}

	tm, err := parseTiming(master)
	if err != nil {
		return nil, err
	}
	base := baseEvent(o, ref, master)
	// Judged on the whole resource, once, for each of its events (FR-17).
	base.HasAttendees = hasAttendees(o.cal, ical.CompEvent)
	if !isRecurring(master) {
		ev := at(base, tm, tm.start.t)
		if overlaps(ev, from, to) {
			return []domain.Event{ev}, nil
		}
		return nil, nil
	}

	overrides := recurrenceOverrides(o.cal, master)
	exdates := exceptionDates(master)

	occs, err := expandSeries(master, tm.start, from.Add(-tm.dur.approx()), to)
	var out []domain.Event
	for _, occ := range occs {
		if exdates[occ.Unix()] || overrides[occ.Unix()] != nil {
			continue
		}
		ev := asOccurrence(at(base, tm, occ), occ)
		if overlaps(ev, from, to) {
			out = append(out, ev)
		}
	}
	for ridUnix, c := range overrides {
		if exdates[ridUnix] || isCancelled(c) {
			continue
		}
		rid := time.Unix(ridUnix, 0)
		otm, oerr := parseTiming(c)
		if oerr != nil {
			otm = instanceTiming(tm, rid)
		}
		ev := base
		ev.Title = textOr(c.Props, ical.PropSummary, base.Title)
		ev.Description = textOr(c.Props, ical.PropDescription, base.Description)
		ev.Location = textOr(c.Props, ical.PropLocation, base.Location)
		ev.Modified = overrideModified(c, otm, rid, master, tm)
		ev = asOccurrence(at(ev, otm, otm.start.t), rid)
		// The series' zone, which its rule recurs in and a move of it is
		// judged in, also for an exception another client wrote in another
		// (#6, FR-17, FR-18).
		ev.Timezone = tm.start.tzid
		if overlaps(ev, from, to) {
			out = append(out, ev)
		}
	}
	if len(out) > 0 {
		// Looked up once for the series, not for each occurrence (FR-17).
		first := firstOccurrence(o.cal, master, tm)
		for i := range out {
			out[i].First = out[i].RecurrenceID.Equal(first)
		}
	}
	return out, err
}

// exceptionDates returns the instants of the EXDATEs of the series master, as
// Unix seconds. An EXDATE property that cannot be read is left out (FR-17).
func exceptionDates(master *ical.Component) map[int64]bool {
	exdates := map[int64]bool{}
	for _, p := range master.Props.Values(ical.PropExceptionDates) {
		dvs, err := parseDateList(&p)
		if err != nil {
			continue
		}
		for _, d := range dvs {
			exdates[d.t.Unix()] = true
		}
	}
	return exdates
}

// recurrenceOverrides returns the events of cal that override an occurrence
// of the series master, by the instant of their RECURRENCE-ID as Unix
// seconds. An override whose RECURRENCE-ID cannot be read is left out, and of
// two for the same instant the later wins (FR-17).
func recurrenceOverrides(cal *ical.Calendar, master *ical.Component) map[int64]*ical.Component {
	overrides := map[int64]*ical.Component{}
	for _, c := range cal.Children {
		if c == master || c.Name != master.Name || c.Props.Get(ical.PropRecurrenceID) == nil {
			continue
		}
		if rid, err := parseDateProp(c.Props.Get(ical.PropRecurrenceID)); err == nil {
			overrides[rid.t.Unix()] = c
		}
	}
	return overrides
}

// isCancelled reports whether the override c has STATUS:CANCELLED, which
// ListEvents shows as no event, like an EXDATE (FR-17).
func isCancelled(c *ical.Component) bool {
	return strings.EqualFold(text(c.Props, ical.PropStatus), "CANCELLED")
}

// overrideModified reports whether an override visibly changes its
// occurrence from what the series would otherwise give: a start that differs
// from rid, a different duration or all-day flag, or an effective title,
// location or description that differs from the master's. Invisible
// differences, such as PARTSTAT or an added VALARM, do not count (FR-17).
func overrideModified(c *ical.Component, otm timing, rid time.Time, master *ical.Component, tm timing) bool {
	switch {
	case !otm.start.t.Equal(rid):
		return true
	case otm.dur != tm.dur:
		return true
	case otm.start.allDay != tm.start.allDay:
		return true
	}
	masterTitle := text(master.Props, ical.PropSummary)
	masterLocation := text(master.Props, ical.PropLocation)
	masterDescription := text(master.Props, ical.PropDescription)
	return textOr(c.Props, ical.PropSummary, masterTitle) != masterTitle ||
		textOr(c.Props, ical.PropLocation, masterLocation) != masterLocation ||
		textOr(c.Props, ical.PropDescription, masterDescription) != masterDescription
}

// expandSeries returns the start times of the series in [from, to): DTSTART
// and the RRULE instances after it, counted as ruleInstances does, and
// RDATEs, in the series' location, sorted and unique.
func expandSeries(c *ical.Component, st dateValue, from, to time.Time) ([]time.Time, error) {
	loc := st.loc()
	var out []time.Time
	seen := map[int64]bool{}
	add := func(t time.Time) {
		if !t.Before(from) && t.Before(to) && len(out) < maxInstancesPerSeries && !seen[t.Unix()] {
			seen[t.Unix()] = true
			out = append(out, t.In(loc))
		}
	}

	next, err := ruleInstances(rruleString(c), st)
	if err != nil {
		add(st.t)
	} else {
		for range maxRRuleIterations {
			ev, ok := next()
			if !ok || !ev.t.Before(to) || len(out) >= maxInstancesPerSeries {
				break
			}
			add(ev.t)
		}
	}
	for _, p := range c.Props.Values(ical.PropRecurrenceDates) {
		dvs, perr := parseDateList(&p)
		if perr != nil {
			continue
		}
		for _, d := range dvs {
			add(d.t)
		}
	}
	slices.SortFunc(out, time.Time.Compare)
	return out, err
}

// ruleInstances returns an iterator over the occurrences of a series from
// DTSTART start with the RRULE value rule ("" for none), in order: start,
// then the rule's instances after it (FR-17). DTSTART is the first occurrence
// also where the rule does not match it, and it counts against a COUNT (RFC
// 5545 3.3.10), so a COUNT rule yields COUNT occurrences in all. rrule-go
// leaves such a DTSTART out and yields COUNT instances besides it, so after
// it at most COUNT − 1 follow. A series without a rule yields start only.
//
// The rule recurs on start's wall clock: rrule-go runs on that clock read as
// UTC, which no daylight-saving change moves, and each event is the instant
// zoned reads its wall clock as, also one the zone skips, which is kept,
// counted and shows an hour later (RFC 5545 3.3.10 as erratum 4271 corrects
// it). In start's zone, rrule-go would build them with time.Date, which reads
// such a time one way east of UTC and the other west of it, and a DTSTART at
// a skipped time would put every event an hour off. UNTIL bounds the events
// by instant: one in UTC as it is, any other read on the series' wall clock
// as zoned reads it. Each event comes with its wall clock and start's form
// (#8, FR-18).
func ruleInstances(rule string, start dateValue) (next func() (dateValue, bool), err error) {
	loc := start.loc()
	dtstart := start.wallIn(loc)
	event := func(w time.Time) dateValue {
		ev := atWall(w, loc)
		ev.allDay, ev.tzid, ev.param, ev.floating = start.allDay, start.tzid, start.param, start.floating
		return ev
	}
	var ruleNext func() (time.Time, bool)
	var until time.Time // the last instant an event may have; zero: none
	left := -1          // instances still allowed after dtstart; < 0: no COUNT
	if rule != "" {
		opt, err := rrule.StrToROptionInLocation(rule, time.UTC)
		if err != nil {
			return nil, fmt.Errorf("invalid RRULE: %w", err)
		}
		if !opt.Until.IsZero() {
			until = opt.Until
			if !strings.HasSuffix(strings.ToUpper(rulePart(rule, "UNTIL")), "Z") {
				until = zoned(opt.Until, loc)
			}
			opt.Until = time.Time{}
		}
		opt.Dtstart = dtstart
		r, err := rrule.NewRRule(*opt)
		if err != nil {
			return nil, fmt.Errorf("invalid RRULE: %w", err)
		}
		ruleNext = r.Iterator()
		if n := r.OrigOptions.Count; n > 0 {
			left = n - 1
		}
	}
	started := false
	return func() (dateValue, bool) {
		if !started {
			started = true
			return event(dtstart), true
		}
		if ruleNext == nil || left == 0 {
			return dateValue{}, false
		}
		w, ok := ruleNext()
		if ok && w.Equal(dtstart) { // the rule's first instance: DTSTART on the rule
			w, ok = ruleNext()
		}
		var ev dateValue
		if ok {
			ev = event(w)
		}
		if !ok || !until.IsZero() && ev.t.After(until) {
			ruleNext = nil
			return dateValue{}, false
		}
		if left > 0 {
			left--
		}
		return ev, true
	}, nil
}

// ruleEvent returns the event of the series from DTSTART start with the RRULE
// value rule at the instant t, as ruleInstances yields it: with the wall clock
// its rule gives it, also one its zone skips, where it shows an hour later,
// so that Lucid writes it, and moves the series from it, at the series' time
// (#8, FR-17). An instant that is no event of the rule, such as an RDATE or an
// override off it, or one of a rule Lucid cannot read, is t on its own wall
// clock, in start's zone and form.
func ruleEvent(rule string, start dateValue, t time.Time) dateValue {
	if next, err := ruleInstances(rule, start); err == nil {
		for range maxRRuleIterations {
			ev, ok := next()
			if !ok || ev.t.After(t) {
				break
			}
			if ev.t.Equal(t) {
				return ev
			}
		}
	}
	return dateValue{t: t.In(start.loc()), allDay: start.allDay, tzid: start.tzid, param: start.param, floating: start.floating}
}

// normalizeEventInput validates in and returns the normalized RRULE.
func normalizeEventInput(in domain.EventInput) (string, error) {
	if err := in.Validate(); err != nil {
		return "", err
	}
	return normalizeRRule(in.RRule, in.Start.UTC())
}

// trimRRule strips surrounding space and an "RRULE:" prefix from raw.
func trimRRule(raw string) string {
	rr := strings.TrimSpace(raw)
	if len(rr) >= 6 && strings.EqualFold(rr[:6], "RRULE:") {
		rr = strings.TrimSpace(rr[6:])
	}
	return rr
}

// normalizeRRule strips "RRULE:", rejects line breaks and validates the rule
// against dtstart; "" stays "" (FR-17).
func normalizeRRule(raw string, dtstart time.Time) (string, error) {
	rr := trimRRule(raw)
	if rr == "" {
		return "", nil
	}
	if strings.ContainsAny(rr, "\r\n") {
		return "", &domain.ValidationError{Msg: "invalid rrule"}
	}
	if _, err := ruleInstances(rr, dateValue{t: dtstart}); err != nil {
		return "", &domain.ValidationError{Msg: "invalid rrule"}
	}
	return rr, nil
}

// CreateEvent implements domain.CalendarService.
func (s *service) CreateEvent(ctx context.Context, calendarID string, in domain.EventInput) (domain.Event, error) {
	if s.err != nil {
		return domain.Event{}, s.err
	}
	calPath, err := s.p.ids.decodeCalendarID(s.homePath, calendarID)
	if err != nil {
		return domain.Event{}, err
	}
	rr, err := normalizeEventInput(in)
	if err != nil {
		return domain.Event{}, err
	}
	if err := s.checkWritable(ctx, calPath, ical.CompEvent); err != nil {
		return domain.Event{}, err
	}

	now := s.p.now().UTC()
	uid := newUID()
	cal := newCalendar()
	ev := newComponent(ical.CompEvent, uid, now)
	cal.Children = append(cal.Children, ev)
	applyEventFields(cal, ev, in, rr, in.Start, in.End, in.Timezone)

	o := calObject{path: objectPath(calPath, uid+".ics"), cal: cal}
	o.etag, err = s.putObject(ctx, o.path, cal, "", true)
	s.invalidate(calPath)
	if err != nil {
		return domain.Event{}, err
	}
	return eventAt(o, s.ref(o.path, calendarID), ev, nil)
}

// UpdateEvent implements domain.CalendarService. Unknown properties and
// components (alarms, attendees, X- properties) are preserved. "All events"
// from an instanceStart the series no longer shows is ErrConflict, with
// nothing written (see checkShown). The change of a series that was
// recurring before it, also one that removes the rule, returns the snapshot
// RestoreEvent undoes it with, see eventSnapshot (FR-17).
func (s *service) UpdateEvent(ctx context.Context, eventID, etag string, in domain.EventInput) (domain.Event, *domain.Snapshot, error) {
	if s.err != nil {
		return domain.Event{}, nil, s.err
	}
	objPath, calPath, err := s.p.ids.decodeObjectID(s.homePath, eventID)
	if err != nil {
		return domain.Event{}, nil, err
	}
	if err := requireETag(etag); err != nil {
		return domain.Event{}, nil, err
	}
	rr, err := normalizeEventInput(in)
	if err != nil {
		return domain.Event{}, nil, err
	}
	if err := s.checkWritable(ctx, calPath, ""); err != nil {
		return domain.Event{}, nil, err
	}
	cal, current, raw, err := s.getObject(ctx, objPath)
	if err != nil {
		return domain.Event{}, nil, err
	}
	if current != "" && current != etag {
		return domain.Event{}, nil, fmt.Errorf("%w: etag mismatch", domain.ErrConflict)
	}
	master := mainComponent(cal, ical.CompEvent)
	if master == nil {
		return domain.Event{}, nil, fmt.Errorf("%w: %w", domain.ErrNotFound, errWrongComponent)
	}
	if err := checkShown(cal, master, in.InstanceStart); err != nil {
		return domain.Event{}, nil, err
	}

	// Judged before the change, which may remove the rule.
	wasRecurring, attendees := isRecurring(master), hasAttendees(cal, ical.CompEvent)
	now := s.p.now().UTC()
	instance, moved, err := applySeriesEdit(cal, master, in, rr, now)
	if err != nil {
		return domain.Event{}, nil, err
	}
	bumpChangeProps(master, now)
	masterFirst(cal, master)

	o := calObject{path: objPath, cal: cal}
	o.etag, err = s.putObject(ctx, objPath, cal, etag, false)
	s.invalidate(calPath)
	if err != nil {
		return domain.Event{}, nil, err
	}
	var snap *domain.Snapshot
	if wasRecurring {
		snap = s.eventSnapshot(eventID, raw, o.etag, attendees)
	}
	ev, err := editedEvent(o, s.ref(objPath, s.p.ids.encode(calPath)), master, instance, moved, in)
	if err != nil {
		return domain.Event{}, nil, err
	}
	return ev, snap, nil
}

// checkShown refuses "all events" from instanceStart, if set, where the
// series master in cal no longer has that occurrence, as loadSeries checks
// it: an instance of its rule, or one with an override (FR-17, NFR-26).
// Sent from a view not reloaded since the series ended or split before it,
// with the ETag that change gave, the edit would write the view's old rule
// back, bringing deleted events back or showing those of a new series
// twice. The series changed since the view was loaded, so it is
// ErrConflict, which reloads the view, as an ETag that no longer matches
// does. A single event, and a series whose timing Lucid cannot read,
// applySeriesEdit edits as entered.
func checkShown(cal *ical.Calendar, master *ical.Component, instanceStart *time.Time) error {
	if instanceStart == nil || !isRecurring(master) {
		return nil
	}
	tm, tmErr := parseTiming(master)
	rid := instanceStart.UTC()
	if tmErr == nil && findOverride(cal, master, rid) == nil && !isInstance(master, tm, rid) {
		return fmt.Errorf("%w: not an occurrence of the series", domain.ErrConflict)
	}
	return nil
}

// editedEvent returns the event that a change through applySeriesEdit left
// in o, whose master is master, for the answer (FR-17): after a move of the
// series, the event ListEvents shows at moved, else eventAt's event at
// instance, with First and HasAttendees as expandObject sets them, so the
// answer tells the client what the list does.
func editedEvent(o calObject, ref objRef, master *ical.Component, instance, moved *time.Time, in domain.EventInput) (domain.Event, error) {
	if moved != nil {
		if ev, ok := shownAt(o, ref, *moved, in.Start, in.End); ok {
			return ev, nil
		}
	}
	ev, err := eventAt(o, ref, master, instance)
	if err != nil {
		return domain.Event{}, err
	}
	// As expandObject sets them; eventAt parsed the timing already.
	ev.HasAttendees = hasAttendees(o.cal, ical.CompEvent)
	if tm, err := parseTiming(master); err == nil && ev.RecurrenceID != nil {
		ev.First = ev.RecurrenceID.Equal(firstOccurrence(o.cal, master, tm))
	}
	return ev, nil
}

// applySeriesEdit applies the change in, whose normalized rule is rr, to the
// event master in cal, in memory, as UpdateEvent saves it (FR-17), and
// returns where the edited event is then:
//   - "all events" from the occurrence in.InstanceStart of a series whose
//     rule and all-day flag stay as they are: the series moves as moveSeries
//     moves it, instance is in.Start and moved the occurrence's recurrence ID
//     after the move;
//   - from such an occurrence with a changed rule or all-day flag: the series
//     moves as the edited event moved and takes the rule rr, and instance is
//     in.Start;
//   - otherwise, for a single event and a series whose rule goes (rr == ""):
//     the fields and dates of in, as entered, and both are nil.
//
// A move the series cannot follow is domain.ErrSeriesMoveUnsupported, see
// moveSeries, and cal may be changed in part then: the caller writes nothing.
// It neither bumps master nor puts it first: the caller does.
func applySeriesEdit(cal *ical.Calendar, master *ical.Component, in domain.EventInput, rr string, now time.Time) (instance, moved *time.Time, err error) {
	start, end := in.Start, in.End
	oldTm, tmErr := parseTiming(master)
	tz := in.Timezone
	if tmErr == nil {
		tz = cmp.Or(tz, oldTm.start.tzid)
	}
	series := in.InstanceStart != nil && isRecurring(master) && tmErr == nil
	switch {
	case series && rr == rruleString(master) && in.AllDay == oldTm.start.allDay:
		// "All events" with the rule and all-day flag as they are (spec
		// section 3, FR-17).
		rid, err := moveSeries(cal, master, oldTm, in, now)
		if err != nil {
			return nil, nil, err
		}
		instance, moved = &in.Start, &rid
	case series && rr != "":
		// A changed rule or all-day flag applies to the whole series as
		// entered: move it as the edited event moved from where it was
		// shown (see wallShift), and take the new duration (spec section 3
		// item 4, FR-17). A changed all-day flag moves DTSTART by dates
		// instead (see toggledStart); the references keep their value type
		// and move by the shift (docs/RECURRING-EVENTS.md, Limits). A timed
		// series that goes into the request's zone, or form, from another
		// goes there by date, see zoneMove, and its references with it, in
		// its new form (see rezoneRecurrenceRefs, FR-18). A move the series
		// cannot follow is refused as in moveSeries, judged on DTSTART and
		// the references, since the rule is the one entered, and nothing is
		// written. Of title, description and location only what changed from
		// the event as shown goes into the series, see
		// applyChangedEventFields.
		rid := *in.InstanceStart
		ov, shown := shownOccurrence(cal, master, oldTm, rid)
		mv, err := wallShift(rruleString(master), oldTm.start, rid, shown.start, dateValue{t: in.Start})
		if err != nil {
			return nil, nil, err
		}
		// DTSTART moves on its wall clock as written, which can be one its
		// zone skips (#8), in the series' zone whatever its form.
		at := dateValue{t: oldTm.start.t, wall: oldTm.start.wall}
		if in.AllDay == oldTm.start.allDay {
			at = mv.shift(at)
		} else {
			at, err = toggledStart(rruleString(master), oldTm.start, rid, shown.start, in, tz)
			if err != nil {
				return nil, nil, err
			}
		}
		shiftRecurrenceRefs(cal, master, mv.shift)
		if mv.lost {
			return nil, nil, errMoveOffMonth
		}
		if loc := seriesZone(tz); !in.AllDay && !oldTm.start.allDay && !writtenIn(oldTm.start.form(), loc) {
			zm := newZoneMove(oldTm.start.loc(), loc, rid, shown.start.t, in.Start)
			at = zm.at(at)
			rezoneRecurrenceRefs(cal, master, zm)
		}
		end = at.t.Add(in.End.Sub(in.Start))
		instance = &in.Start
		applyEventSchedule(cal, master, in, rr, at, end, tz)
		if applyChangedEventFields(master, ov, in) {
			bumpChangeProps(ov, now)
		}
	default:
		if rr == "" {
			removeRecurrence(cal, master)
		}
		applyEventFields(cal, master, in, rr, start, end, tz)
	}
	return instance, moved, nil
}

// shownOccurrence returns the override of the series master at the
// occurrence rid, nil if there is none, and the timing ListEvents shows that
// event with: the override's own, else the series' at rid, as expandObject
// does (spec section 3 item 1, FR-17), with the wall clock its rule gives it,
// which can be one its zone skips (see ruleEvent, #8).
func shownOccurrence(cal *ical.Calendar, master *ical.Component, tm timing, rid time.Time) (*ical.Component, timing) {
	ov := findOverride(cal, master, rid)
	if ov != nil {
		if otm, err := parseTiming(ov); err == nil {
			return ov, otm
		}
	}
	return ov, timing{start: ruleEvent(rruleString(master), tm.start, rid), dur: tm.dur}
}

// instanceTiming returns the timing of the series tm at its occurrence rid.
func instanceTiming(tm timing, rid time.Time) timing {
	return timing{start: dateValue{t: rid.In(tm.start.loc()), allDay: tm.start.allDay, tzid: tm.start.tzid}, dur: tm.dur}
}

// moveSeries applies an "all events" edit of the occurrence
// in.InstanceStart to the series master in cal whose rule and all-day flag
// stay as they are (spec section 3, FR-17), and returns that occurrence's
// recurrence ID after the move.
//
//   - The series moves as the event moved from where it was shown (the
//     override's DTSTART for an exception): by the same change of date (in
//     calendar months and days for a monthly or yearly rule without BY
//     parts, else in calendar days, see dateShift) and of clock time in the
//     series' zone, see wallShift. Its rule follows as seriesShift says,
//     and UNTIL, EXDATE, RDATE and the RECURRENCE-IDs move the same way;
//     DTEND moves as DTSTART did.
//   - A move the series cannot follow is domain.ErrSeriesMoveUnsupported,
//     and UpdateEvent writes nothing: one seriesShift refuses (a rule on
//     fixed days or times), a change of date dateShift refuses, or one that
//     puts DTSTART, an event of the rule or a reference on a day its month
//     lacks (see seriesMove.at).
//   - Of title, description, location and duration, only what changed from
//     the event as shown is written into the series, so an exception's own
//     title does not replace the series'.
//   - An exception edited this way takes the change too: in.Start, in.End
//     and the changed fields. Other exceptions keep their own times and
//     fields, as with Apple, SOGo, InfCloud and Thunderbird.
func moveSeries(cal *ical.Calendar, master *ical.Component, tm timing, in domain.EventInput, now time.Time) (time.Time, error) {
	rid := in.InstanceStart.UTC()
	ov, shown := shownOccurrence(cal, master, tm, rid)
	oldRule := rruleString(master)
	mv, err := wallShift(oldRule, tm.start, rid, shown.start, dateValue{t: in.Start})
	if err != nil {
		return time.Time{}, err
	}
	dur := in.End.Sub(in.Start)
	durChanged := dur != shown.dur.addTo(shown.start.t).Sub(shown.start.t)

	// In the series' zone, on its wall clock as written, which can be one
	// the zone skips (#8), as seriesShift wants.
	newStart := mv.shift(tm.start)
	rule, ok := seriesShift(oldRule, tm.start.wallIn(mv.loc), newStart.wallIn(mv.loc))
	if !ok {
		return time.Time{}, errMoveFixedDays
	}
	rule = mapRulePart(rule, "UNTIL", func(v string) string {
		p := ical.Prop{Value: v}
		shiftDatePropBy(&p, mv.shift)
		return p.Value
	})
	shiftRecurrenceRefs(cal, master, mv.shift)
	mv.shiftEvents(oldRule, tm.start)
	if mv.lost {
		return time.Time{}, errMoveOffMonth
	}
	if rule != "" {
		p := ical.NewProp(ical.PropRecurrenceRule)
		p.Value = rule
		master.Props.Set(p)
	}

	f := tm.start.form()
	master.Props.Set(seriesValueProp(cal, ical.PropDateTimeStart, newStart, f))
	if durChanged {
		master.Props.Del(ical.PropDuration)
		master.Props.Set(seriesDateProp(cal, ical.PropDateTimeEnd, newStart.t.Add(dur), f))
	} else if p := master.Props.Get(ical.PropDateTimeEnd); p != nil {
		// DTEND moves as DTSTART did, so the series keeps its duration, also
		// where a move by months puts the two in months of other lengths.
		// Without a rule the move counts days, which cannot fail.
		asStart, _ := wallShift("", tm.start, tm.start.t, tm.start, newStart)
		shiftDatePropBy(p, asStart.shift)
	}

	applyChangedEventFields(master, ov, in)

	if ov != nil {
		ov.Props.Set(seriesDateProp(cal, ical.PropDateTimeStart, in.Start, f))
		ov.Props.Set(seriesDateProp(cal, ical.PropDateTimeEnd, in.End, f))
		ov.Props.Del(ical.PropDuration)
		bumpChangeProps(ov, now)
	}
	return mv.shift(ruleEvent(oldRule, tm.start, rid)).t, nil
}

// applyChangedEventFields writes the title, description and location of in
// into the series master, each only where it differs from the event as shown:
// the override ov's own value, else the master's. An exception's own title
// does not replace the series' title that way. A changed field goes into ov,
// the exception edited, too (spec section 3 items 3 and 5, FR-17). ov is nil
// where the edited event is no exception. It returns whether it wrote a field
// into ov, which the caller then bumps (see bumpChangeProps).
func applyChangedEventFields(master, ov *ical.Component, in domain.EventInput) (changedOverride bool) {
	for _, field := range []struct{ name, value string }{
		{ical.PropSummary, in.Title},
		{ical.PropDescription, in.Description},
		{ical.PropLocation, in.Location},
	} {
		shownValue := text(master.Props, field.name)
		if ov != nil {
			shownValue = textOr(ov.Props, field.name, shownValue)
		}
		if field.value == shownValue {
			continue
		}
		setText(master.Props, field.name, field.value)
		if ov != nil {
			setTextKept(ov.Props, field.name, field.value)
			changedOverride = true
		}
	}
	return changedOverride
}

// Why "all events" refuses to move a series, besides errMoveFixedDays
// (FR-17). Each is a domain.ErrSeriesMoveUnsupported: only the edited event
// can move there.
var (
	errMoveOffDay = fmt.Errorf("%w: the event is not on the day of the month its series repeats on",
		domain.ErrSeriesMoveUnsupported)
	errMoveOffMonth = fmt.Errorf("%w: the move puts a date of the series on a day its month lacks",
		domain.ErrSeriesMoveUnsupported)
)

// wallShift returns how "all events" moves the values of the series whose
// rule is rule and whose DTSTART is st when its occurrence rid, shown at
// from, moves to to (spec section 3 items 1 and 2, FR-17): by the same
// change of date (see dateShift) and the same change of clock time, from the
// shown start, both measured in the series' zone. The series repeats on that
// wall clock, so a move by the absolute time in between would put EXDATEs,
// RECURRENCE-IDs and DTSTART itself an hour off across a daylight-saving
// change. Each value is read on the wall clock it is written with, which can
// be one its zone skips (#8). It fails where dateShift does.
func wallShift(rule string, st dateValue, rid time.Time, from, to dateValue) (*seriesMove, error) {
	loc := st.loc()
	f, t := from.wallIn(loc), to.wallIn(loc)
	change, err := dateShift(rule, st.wallIn(loc), wallClock(rid, loc), f, t)
	if err != nil {
		return nil, err
	}
	return &seriesMove{loc: loc, date: change, secs: secondOfDay(t) - secondOfDay(f), day: st.wallIn(loc).Day()}, nil
}

// seriesMove is how "all events" moves the values of a series, see
// wallShift (FR-17).
type seriesMove struct {
	loc  *time.Location // the series' zone
	date dateMove       // the change of date
	secs int            // the change of clock time, in seconds
	day  int            // DTSTART's day of the month in the series' zone
	// lost tells that shift moved a value onto a day its month lacks (see
	// at): the series cannot follow the move.
	lost bool
}

// shift returns the value d moved, and sets lost where its date leaves the
// month the move counts it into (see at, FR-17). A DATE moves by the change
// of date only. A UTC or TZID value names an instant, which moves with the
// series' wall clock, from the one it is written with where that is the
// series' zone, which can be one the zone skips (#8), and is then written in
// its own form again; a floating value, or one with a TZID Lucid cannot
// resolve, moves on its own wall clock.
func (mv *seriesMove) shift(d dateValue) dateValue {
	if d.allDay {
		return mv.at(d.t, 0, time.UTC)
	}
	zone := mv.loc
	if d.floating || d.tzid == "" && d.param != "" {
		zone = d.t.Location() // its wall clock, read as UTC
	}
	return mv.at(d.wallIn(zone), mv.secs, zone)
}

// at returns w moved by the change of date and then by secs seconds on its
// own wall clock, and sets lost where the date leaves its month (see
// dateMove.date, FR-17): on DTSTART's day of the month, the rule's day,
// whose events would not follow, or with a change of month, which would
// put the value elsewhere than the events. A value on another day, such as
// an UNTIL at the end of a month or an RDATE on the 31st, that a move of
// days alone carries into the next month moves exactly as by calendar
// days, which keeps it with the events. w is a wall clock, read as UTC, in
// loc, and so is the result, also one loc skips (see atWall, #8).
func (mv *seriesMove) at(w time.Time, secs int, loc *time.Location) dateValue {
	y, m, d, ok := mv.date.date(w)
	if !ok && (mv.date.months != 0 || w.Day() == mv.day) {
		mv.lost = true
	}
	return atWall(time.Date(y, m, d, w.Hour(), w.Minute(), w.Second()+secs, w.Nanosecond(), time.UTC), loc)
}

// eventsChecked is how many events of a series shiftEvents moves (FR-17).
// While every fourth year is a leap year, the months a monthly rule meets,
// and whether they fall in a leap year, repeat every 48 of its steps, and a
// yearly rule's every 4. A century year without February 29, such as 2100,
// breaks that cycle and counts only among the first 48 events.
const eventsChecked = 48

// shiftEvents moves the events of the series with the rule rule from DTSTART
// st as shift does, only so that lost tells of one moved onto a day its
// month lacks (FR-17): a monthly series moved from its 15th to the 31st
// would lose its events in the months without a 31st. A move in calendar
// days loses none. The first eventsChecked events stand for all, and a rule
// Lucid cannot read has only DTSTART, which the caller moves itself.
func (mv *seriesMove) shiftEvents(rule string, st dateValue) {
	if !mv.date.byMonth {
		return
	}
	next, err := ruleInstances(rule, st)
	if err != nil {
		return
	}
	for range eventsChecked {
		ev, ok := next()
		if !ok {
			return
		}
		mv.shift(ev)
	}
}

// dateMove is a change of date, see dateShift (FR-17).
type dateMove struct {
	months, days int
	// byMonth: counted in calendar months and then days of the month, which
	// can name a day the month lacks; else in calendar days, months 0.
	byMonth bool
}

// date returns the date of t moved by mv, as the year, month and day to pass
// to time.Date, and whether those name a day of that month (FR-17). A move
// counted in months and days can name a day the month lacks, the 29th to
// 31st, or February 29 in a common year, which time.Date carries into the
// next month: the value would land elsewhere than the move counts it. A
// move in calendar days always lands where it counts.
func (mv dateMove) date(t time.Time) (y int, m time.Month, d int, ok bool) {
	y, m, d = t.Date()
	m += time.Month(mv.months)
	d += mv.days
	return y, m, d, !mv.byMonth || time.Date(y, m, d, 0, 0, 0, 0, time.UTC).Day() == d
}

// dateShift returns the change of date by which a series with the rule rule
// and DTSTART start moves when its occurrence rid, shown at from, moves to
// to, each read in its own location (spec section 3 items 1 and 2, FR-17).
// The occurrence moves from its own date, rid's, by the calendar days from
// from to to: an exception can be shown on another day than its
// RECURRENCE-ID, and the rule's instances move from the latter. For a
// MONTHLY or YEARLY rule without BY parts, whose events keep the day of the
// month of DTSTART, the change is counted from rid to where it moves in
// calendar months and then days of the month, as todoSeries.refShift counts
// it, so that a move across a month end keeps each later event on the moved
// one's day of the month. Such a rule refuses to change the date from an
// occurrence on another day of the month than DTSTART's, such as an RDATE
// (errMoveOffDay): counted in months and days from there, the rule's events
// would move by another number of days than the edited one, and counted in
// days, they would leave their day of the month. For any other rule the
// change is those calendar days.
func dateShift(rule string, start, rid, from, to time.Time) (dateMove, error) {
	moved := dateDays(to) - dateDays(from)
	if freq := strings.ToUpper(rulePart(rule, "FREQ")); (freq != "MONTHLY" && freq != "YEARLY") ||
		ruleHasFixedDays(rule, false) {
		return dateMove{days: moved}, nil
	}
	if moved != 0 && rid.Day() != start.Day() {
		return dateMove{}, errMoveOffDay
	}
	y, m, d := rid.Date()
	dest := time.Date(y, m, d+moved, 0, 0, 0, 0, time.UTC)
	return dateMove{months: (dest.Year()-y)*12 + int(dest.Month()) - int(m), days: dest.Day() - d, byMonth: true}, nil
}

// toggledStart returns the new DTSTART of the series with the rule rule and
// DTSTART st whose all-day flag "all events" changes, from its occurrence
// rid shown at from, as in sets it (spec section 3 item 4, FR-17). DTSTART's
// date moves by the change of date (see dateShift) between the dates the
// user saw and entered, each read where it is meant, rather than measured in
// one zone and written in another, which put it off by a daylight-saving
// change between DTSTART and the edited event:
//   - made all-day, from the edited event's date in the series' zone to the
//     date entered (in.Start's in UTC), DTSTART's own date and rid's read
//     in the series' zone too;
//   - made timed, from the all-day date shown to in.Start's date in the
//     request's zone tz, at in.Start's clock time there, so the series shows
//     the time entered on both sides of a daylight-saving change.
//
// The timed DTSTART is that wall clock, also one the zone skips, as written
// (#8). It fails where dateShift does, and where DTSTART's date would land on
// a day its month lacks (errMoveOffMonth).
func toggledStart(rule string, st dateValue, rid time.Time, from dateValue, in domain.EventInput, tz string) (dateValue, error) {
	loc := st.loc() // the series' zone, UTC for an all-day series
	to := in.Start.UTC()
	if !in.AllDay {
		to = in.Start.In(seriesZone(tz))
	}
	start := st.wallIn(loc)
	change, err := dateShift(rule, start, wallClock(rid, loc), from.wallIn(loc), to)
	if err != nil {
		return dateValue{}, err
	}
	y, m, d, ok := change.date(start)
	if !ok {
		return dateValue{}, errMoveOffMonth
	}
	if in.AllDay {
		day := time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
		return dateValue{t: day, wall: day, allDay: true}, nil
	}
	return atWall(time.Date(y, m, d, to.Hour(), to.Minute(), to.Second(), 0, time.UTC), to.Location()), nil
}

// seriesZone returns the zone applyEventSchedule writes a timed series in
// for the request's zone tz: the one tz names, else UTC (FR-18).
func seriesZone(tz string) *time.Location {
	if loc := loadLocation(tz); loc != nil {
		return loc
	}
	return time.UTC
}

// writtenIn reports whether a DATE-TIME of the form f is written as
// applyEventSchedule writes a series in the zone loc: in UTC, or with loc's
// name as TZID (FR-18).
func writtenIn(f dateForm, loc *time.Location) bool {
	if loc == time.UTC {
		return f.param == "" && !f.floating
	}
	return f.param == loc.String()
}

// zoneMove carries the values of a timed series whose changed rule moves it
// from the zone it recurs in to another (FR-17, FR-18), by date: each keeps
// its date and clock time there, moved by the same number of seconds, so
// the series recurs on the new zone's wall clock as the editor showed it
// there (see newZoneMove), and every value stays with its event. Kept as
// instants, DTSTART and the references would be off wherever the two zones'
// UTC offsets differ by another amount than at the edited event: by an hour
// where only one of them has changed to summer time, which also puts an
// event near midnight on another date, such as a New York series at 18:00
// seen in Berlin while New York has changed to summer time and Berlin has
// not.
type zoneMove struct {
	from, to *time.Location
	secs     int // added to the wall clock, see newZoneMove
}

// newZoneMove returns the zoneMove from the zone from to the zone to for
// the event at rid in the rule, shown at shown and entered at entered
// (FR-17): the series is read in to at rid, by the difference of the two
// zones' UTC offsets there, as the editor reads its rule there (see
// ruleInZone in web/src/lib/seriesShift.ts), and then moves as the event
// moved on to's wall clock. An event of the rule is so where it was entered,
// and an exception moved into a week where the zones are another amount
// apart leaves the series on the days the editor showed.
func newZoneMove(from, to *time.Location, rid, shown, entered time.Time) zoneMove {
	apart := func(t time.Time) int {
		_, fromOff := t.In(from).Zone()
		_, toOff := t.In(to).Zone()
		return toOff - fromOff
	}
	return zoneMove{from: from, to: to, secs: apart(rid) + apart(entered) - apart(shown)}
}

// at returns the value d, read on z.from's wall clock, carried into z.to
// (see zoneMove): from the wall clock it is written with where that is
// z.from's, which can be one z.from skips, to one z.to may skip (#8).
func (z zoneMove) at(d dateValue) dateValue {
	w := d.wallIn(z.from)
	return atWall(time.Date(w.Year(), w.Month(), w.Day(), w.Hour(), w.Minute(), w.Second()+z.secs, w.Nanosecond(), time.UTC), z.to)
}

// rezoneRecurrenceRefs carries the DATE-TIME values of EXDATE, RDATE and
// RECURRENCE-ID by zm and writes them in the series' new form, in UTC or
// with zm.to's TZID, as applyEventSchedule writes DTSTART (FR-17, FR-18).
// Left in their own zone, or floating, next to a DTSTART in another, they
// would be the mixed forms Nextcloud Calendar drops, InfCloud duplicates,
// Roundcube misdates, and Radicale and SabreDAV reject (see
// docs/RECURRING-EVENTS.md). A value read as UTC, a floating one or one
// with a TZID Lucid cannot resolve, is carried as the instant Lucid matches
// it by. DATE and PERIOD values stay as they are.
func rezoneRecurrenceRefs(cal *ical.Calendar, master *ical.Component, zm zoneMove) {
	for _, name := range []string{ical.PropExceptionDates, ical.PropRecurrenceDates} {
		vals := master.Props[name]
		for i := range vals {
			rezoneDateProp(&vals[i], zm)
		}
	}
	for _, c := range cal.Children {
		if c == master || c.Name != master.Name {
			continue
		}
		vals := c.Props[ical.PropRecurrenceID]
		for i := range vals {
			rezoneDateProp(&vals[i], zm)
		}
	}
}

// rezoneDateProp writes the DATE-TIME values of p carried by zm, see
// rezoneRecurrenceRefs. It leaves p as it is if it has a value of another
// type, a DATE or a PERIOD, which does not parse as a date, since its values
// share its parameters.
func rezoneDateProp(p *ical.Prop, zm zoneMove) {
	parts := strings.Split(p.Value, ",")
	for i, v := range parts {
		d, err := parseDateValue(v, p.Params)
		if err != nil || d.allDay {
			return
		}
		t := zm.at(d)
		if zm.to == time.UTC {
			parts[i] = t.t.UTC().Format(icalDateTimeUTC)
		} else {
			parts[i] = t.wallIn(zm.to).Format(icalDateTime)
		}
	}
	if zm.to == time.UTC {
		p.Params.Del(ical.ParamTimezoneID)
	} else {
		p.Params.Set(ical.ParamTimezoneID, zm.to.String())
	}
	p.Value = strings.Join(parts, ",")
}

// shownAt returns the event of o with the recurrence ID rid as ListEvents
// shows it in [start, end], if it is there (FR-17).
func shownAt(o calObject, ref objRef, rid, start, end time.Time) (domain.Event, bool) {
	evs, _ := expandObject(o, ref, start, end.Add(time.Second))
	for i := range evs {
		if evs[i].RecurrenceID != nil && evs[i].RecurrenceID.Equal(rid) {
			return evs[i], true
		}
	}
	return domain.Event{}, false
}

// DeleteEvent implements domain.CalendarService. For recurring events the
// whole series is deleted.
func (s *service) DeleteEvent(ctx context.Context, eventID, etag string) error {
	return s.deleteByID(ctx, eventID, etag)
}

func (s *service) deleteByID(ctx context.Context, id, etag string) error {
	if s.err != nil {
		return s.err
	}
	objPath, calPath, err := s.p.ids.decodeObjectID(s.homePath, id)
	if err != nil {
		return err
	}
	if err := requireETag(etag); err != nil {
		return err
	}
	if err := s.checkWritable(ctx, calPath, ""); err != nil {
		return err
	}
	err = s.deleteObject(ctx, objPath, etag)
	s.invalidate(calPath)
	return err
}

// applyEventFields writes the EventInput fields into c. start/end may differ
// from in.Start/in.End for series updates; tz is the timezone for recurring
// timed events.
func applyEventFields(cal *ical.Calendar, c *ical.Component, in domain.EventInput, rr string, start, end time.Time, tz string) {
	setText(c.Props, ical.PropSummary, in.Title)
	setText(c.Props, ical.PropDescription, in.Description)
	setText(c.Props, ical.PropLocation, in.Location)
	applyEventSchedule(cal, c, in, rr, dateValue{t: start}, end, tz)
}

// applyEventSchedule writes the rule rr (unless empty) and the dates of
// applyEventFields into c, and leaves its title, description and location
// alone (FR-17). A timed DTSTART in a zone is written with start's wall
// clock there, which can be one the zone skips (#8).
func applyEventSchedule(cal *ical.Calendar, c *ical.Component, in domain.EventInput, rr string, start dateValue, end time.Time, tz string) {
	if rr != "" {
		p := ical.NewProp(ical.PropRecurrenceRule)
		p.Value = rr
		c.Props.Set(p)
	}

	// Non-recurring events are stored in UTC (FR-18). Recurring timed events
	// keep their TZID so that the recurrence is DST-correct.
	var loc *time.Location
	if rr != "" && !in.AllDay && tz != "" {
		loc = loadLocation(tz)
	}
	c.Props.Del(ical.PropDuration)
	if in.AllDay {
		sd, ed := dateOnly(start.t), dateOnly(end)
		if !end.UTC().Equal(ed) {
			ed = ed.AddDate(0, 0, 1) // round a partial last day up
		}
		if !ed.After(sd) {
			ed = sd.AddDate(0, 0, 1)
		}
		c.Props.Set(newDateProp(ical.PropDateTimeStart, sd, true, nil))
		c.Props.Set(newDateProp(ical.PropDateTimeEnd, ed, true, nil))
		return
	}
	dtstart := newDateProp(ical.PropDateTimeStart, start.t, false, loc)
	if loc != nil && loc != time.UTC {
		dtstart.Value = start.wallIn(loc).Truncate(time.Second).Format(icalDateTime)
	}
	c.Props.Set(dtstart)
	c.Props.Set(newDateProp(ical.PropDateTimeEnd, end, false, loc))
	if loc != nil && loc != time.UTC {
		ensureVTimezone(cal, loc, start.wallIn(loc).Year())
	}
}

// removeRecurrence turns a series into a single event.
func removeRecurrence(cal *ical.Calendar, master *ical.Component) {
	master.Props.Del(ical.PropRecurrenceRule)
	master.Props.Del(ical.PropRecurrenceDates)
	master.Props.Del(ical.PropExceptionDates)
	cal.Children = slices.DeleteFunc(cal.Children, func(c *ical.Component) bool {
		return c != master && c.Name == master.Name && c.Props.Get(ical.PropRecurrenceID) != nil
	})
}

// shiftRecurrenceRefs moves EXDATE, RDATE and RECURRENCE-ID values by shift
// (see wallShift) so that exceptions and overrides stay attached to the
// shifted series (FR-17).
func shiftRecurrenceRefs(cal *ical.Calendar, master *ical.Component, shift func(dateValue) dateValue) {
	for _, name := range []string{ical.PropExceptionDates, ical.PropRecurrenceDates} {
		vals := master.Props[name]
		for i := range vals {
			shiftDatePropBy(&vals[i], shift)
		}
	}
	for _, c := range cal.Children {
		if c == master || c.Name != master.Name {
			continue
		}
		vals := c.Props[ical.PropRecurrenceID]
		for i := range vals {
			shiftDatePropBy(&vals[i], shift)
		}
	}
}

// shiftDatePropBy replaces each DATE or DATE-TIME value of p by shift's
// result, written in the value's own form (FR-17): a local one with the
// result's wall clock in its zone, which can be one the zone skips (#8).
func shiftDatePropBy(p *ical.Prop, shift func(dateValue) dateValue) {
	parts := strings.Split(p.Value, ",")
	for i, v := range parts {
		if strings.Contains(v, "/") {
			continue // PERIOD values are left alone
		}
		d, err := parseDateValue(v, p.Params)
		if err != nil {
			continue
		}
		r := shift(d)
		loc := d.t.Location()
		if r.t.Equal(d.t) && r.wallIn(loc).Equal(d.wallIn(loc)) {
			continue // kept verbatim
		}
		switch {
		case d.allDay:
			parts[i] = r.t.UTC().Format(icalDate)
		case strings.HasSuffix(strings.TrimSpace(v), "Z"):
			parts[i] = r.t.UTC().Format(icalDateTimeUTC)
		default:
			parts[i] = r.wallIn(loc).Format(icalDateTime)
		}
	}
	p.Value = strings.Join(parts, ",")
}

// eventAt converts component c of o into an Event. For recurring events it
// returns the occurrence at occ (or at DTSTART if occ is nil).
func eventAt(o calObject, ref objRef, c *ical.Component, occ *time.Time) (domain.Event, error) {
	tm, err := parseTiming(c)
	if err != nil {
		return domain.Event{}, invalidData("invalid event", err)
	}
	start := tm.start.t
	if occ != nil {
		start = *occ
	}
	ev := at(baseEvent(o, ref, c), tm, start)
	if isRecurring(c) {
		ev = asOccurrence(ev, ev.Start)
	}
	return ev, nil
}

// newUID returns a random RFC 4122 version 4 UUID.
func newUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}
