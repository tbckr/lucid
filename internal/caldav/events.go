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
	calPath, err := decodeCalendarID(s.homePath, calendarID)
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
		evs, err := expandObject(o, calendarID, start, end)
		if err != nil {
			s.p.log.WarnContext(ctx, "skipping invalid event", "path", o.path, "error", err)
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
func baseEvent(o calObject, calendarID string, c *ical.Component) domain.Event {
	return domain.Event{
		ID:          encodeID(o.path),
		Key:         encodeID(o.path),
		CalendarID:  calendarID,
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
func expandObject(o calObject, calendarID string, from, to time.Time) ([]domain.Event, error) {
	var master *ical.Component
	overrides := map[int64]*ical.Component{}
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
		for _, c := range orphans {
			tm, err := parseTiming(c)
			if err != nil {
				return out, err
			}
			ev := at(baseEvent(o, calendarID, c), tm, tm.start.t)
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
	base := baseEvent(o, calendarID, master)
	if !isRecurring(master) {
		ev := at(base, tm, tm.start.t)
		if overlaps(ev, from, to) {
			return []domain.Event{ev}, nil
		}
		return nil, nil
	}

	for _, c := range orphans {
		rid, err := parseDateProp(c.Props.Get(ical.PropRecurrenceID))
		if err == nil {
			overrides[rid.t.Unix()] = c
		}
	}
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
		if exdates[ridUnix] || strings.EqualFold(text(c.Props, ical.PropStatus), "CANCELLED") {
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
		if overlaps(ev, from, to) {
			out = append(out, ev)
		}
	}
	return out, err
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

	next, err := ruleInstances(rruleString(c), st.t)
	if err != nil {
		add(st.t)
	} else {
		for range maxRRuleIterations {
			t, ok := next()
			if !ok || !t.Before(to) || len(out) >= maxInstancesPerSeries {
				break
			}
			add(t)
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

// newRRule parses an RRULE value for a series starting at dtstart.
func newRRule(value string, dtstart time.Time) (*rrule.RRule, error) {
	opt, err := rrule.StrToROptionInLocation(value, dtstart.Location())
	if err != nil {
		return nil, fmt.Errorf("invalid RRULE: %w", err)
	}
	opt.Dtstart = dtstart
	r, err := rrule.NewRRule(*opt)
	if err != nil {
		return nil, fmt.Errorf("invalid RRULE: %w", err)
	}
	return r, nil
}

// ruleInstances returns an iterator over the occurrences of a series from
// dtstart with the RRULE value rule ("" for none), in order: dtstart, then
// the rule's instances after it (FR-17). DTSTART is the first occurrence also
// where the rule does not match it, and it counts against a COUNT (RFC 5545
// 3.3.10), so a COUNT rule yields COUNT occurrences in all. rrule-go leaves
// such a DTSTART out and yields COUNT instances besides it, so after it at
// most COUNT − 1 follow. A series without a rule yields dtstart only.
func ruleInstances(rule string, dtstart time.Time) (next func() (time.Time, bool), err error) {
	var ruleNext func() (time.Time, bool)
	left := -1 // instances still allowed after dtstart; < 0: no COUNT
	if rule != "" {
		r, err := newRRule(rule, dtstart)
		if err != nil {
			return nil, err
		}
		ruleNext = r.Iterator()
		if n := r.OrigOptions.Count; n > 0 {
			left = n - 1
		}
	}
	started := false
	return func() (time.Time, bool) {
		if !started {
			started = true
			return dtstart, true
		}
		if ruleNext == nil || left == 0 {
			return time.Time{}, false
		}
		t, ok := ruleNext()
		if ok && t.Equal(dtstart) { // the rule's first instance: DTSTART on the rule
			t, ok = ruleNext()
		}
		if !ok {
			return time.Time{}, false
		}
		if left > 0 {
			left--
		}
		return t, true
	}, nil
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
	if _, err := newRRule(rr, dtstart); err != nil {
		return "", &domain.ValidationError{Msg: "invalid rrule"}
	}
	return rr, nil
}

// CreateEvent implements domain.CalendarService.
func (s *service) CreateEvent(ctx context.Context, calendarID string, in domain.EventInput) (domain.Event, error) {
	if s.err != nil {
		return domain.Event{}, s.err
	}
	calPath, err := decodeCalendarID(s.homePath, calendarID)
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
	return eventAt(o, calendarID, ev, nil)
}

// UpdateEvent implements domain.CalendarService. Unknown properties and
// components (alarms, attendees, X- properties) are preserved.
func (s *service) UpdateEvent(ctx context.Context, eventID, etag string, in domain.EventInput) (domain.Event, error) {
	if s.err != nil {
		return domain.Event{}, s.err
	}
	objPath, calPath, err := decodeObjectID(s.homePath, eventID)
	if err != nil {
		return domain.Event{}, err
	}
	if err := requireETag(etag); err != nil {
		return domain.Event{}, err
	}
	rr, err := normalizeEventInput(in)
	if err != nil {
		return domain.Event{}, err
	}
	if err := s.checkWritable(ctx, calPath, ""); err != nil {
		return domain.Event{}, err
	}
	cal, current, _, err := s.getObject(ctx, objPath)
	if err != nil {
		return domain.Event{}, err
	}
	if current != "" && current != etag {
		return domain.Event{}, fmt.Errorf("%w: etag mismatch", domain.ErrConflict)
	}
	master := mainComponent(cal, ical.CompEvent)
	if master == nil {
		return domain.Event{}, fmt.Errorf("%w: %w", domain.ErrNotFound, errWrongComponent)
	}

	start, end := in.Start, in.End
	var instance, moved *time.Time
	oldTm, tmErr := parseTiming(master)
	tz := in.Timezone
	if tmErr == nil {
		tz = cmp.Or(tz, oldTm.start.tzid)
	}
	now := s.p.now().UTC()
	series := in.InstanceStart != nil && isRecurring(master) && tmErr == nil
	switch {
	case series && rr == rruleString(master) && in.AllDay == oldTm.start.allDay:
		// "All events" with the rule and all-day flag as they are (spec
		// section 3, FR-17).
		rid, err := moveSeries(cal, master, oldTm, in, now)
		if err != nil {
			return domain.Event{}, err
		}
		instance, moved = &in.Start, &rid
	case series && rr != "":
		// A changed rule or all-day flag applies to the whole series as
		// entered: move it as the edited event moved from where it was
		// shown (see wallShift), and take the new duration (spec section 3
		// item 4, FR-17). A changed all-day flag moves DTSTART by dates
		// instead (see toggledStart); the references keep their value type
		// and move by the shift (docs/RECURRING-EVENTS.md, Limits).
		_, shown := shownOccurrence(cal, master, oldTm, *in.InstanceStart)
		shift := wallShift(rruleString(master), oldTm.start, shown.start.t, in.Start)
		if in.AllDay == oldTm.start.allDay {
			start = shift(dateValue{t: oldTm.start.t})
		} else {
			start = toggledStart(rruleString(master), oldTm.start, shown.start.t, in, tz)
		}
		end = start.Add(in.End.Sub(in.Start))
		shiftRecurrenceRefs(cal, master, shift)
		instance = &in.Start
		applyEventFields(cal, master, in, rr, start, end, tz)
	default:
		if rr == "" {
			removeRecurrence(cal, master)
		}
		applyEventFields(cal, master, in, rr, start, end, tz)
	}
	bumpChangeProps(master, now)
	masterFirst(cal, master)

	o := calObject{path: objPath, cal: cal}
	o.etag, err = s.putObject(ctx, objPath, cal, etag, false)
	s.invalidate(calPath)
	if err != nil {
		return domain.Event{}, err
	}
	calendarID := encodeID(calPath)
	if moved != nil {
		if ev, ok := shownAt(o, calendarID, *moved, in.Start, in.End); ok {
			return ev, nil
		}
	}
	return eventAt(o, calendarID, master, instance)
}

// shownOccurrence returns the override of the series master at the
// occurrence rid, nil if there is none, and the timing ListEvents shows that
// event with: the override's own, else the series' at rid, as expandObject
// does (spec section 3 item 1, FR-17).
func shownOccurrence(cal *ical.Calendar, master *ical.Component, tm timing, rid time.Time) (*ical.Component, timing) {
	ov := findOverride(cal, master, rid)
	if ov != nil {
		if otm, err := parseTiming(ov); err == nil {
			return ov, otm
		}
	}
	return ov, instanceTiming(tm, rid)
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
//     parts, else in calendar days) and of clock time in the series' zone,
//     see wallShift. Its rule follows as seriesShift says, and UNTIL,
//     EXDATE, RDATE and the RECURRENCE-IDs move the same way; DTEND moves
//     as DTSTART did. A rule seriesShift refuses, one on fixed days or
//     times, is an invalid input error, and cal is left as it was.
//   - Of title, description, location and duration, only what changed from
//     the event as shown is written into the series, so an exception's own
//     title does not replace the series'.
//   - An exception edited this way takes the change too: in.Start, in.End
//     and the changed fields. Other exceptions keep their own times and
//     fields, as with Apple, SOGo, InfCloud and Thunderbird.
func moveSeries(cal *ical.Calendar, master *ical.Component, tm timing, in domain.EventInput, now time.Time) (time.Time, error) {
	rid := in.InstanceStart.UTC()
	ov, shown := shownOccurrence(cal, master, tm, rid)
	shift := wallShift(rruleString(master), tm.start, shown.start.t, in.Start)
	dur := in.End.Sub(in.Start)
	durChanged := dur != shown.dur.addTo(shown.start.t).Sub(shown.start.t)

	newStart := shift(tm.start) // in the series' zone, as seriesShift wants
	rule, ok := seriesShift(rruleString(master), tm.start.t, newStart)
	if !ok {
		return time.Time{}, &domain.ValidationError{Msg: "the series' rule fixes its days or times, so only this event can move there"}
	}
	rule = mapRulePart(rule, "UNTIL", func(v string) string {
		p := ical.Prop{Value: v}
		shiftDatePropBy(&p, shift)
		return p.Value
	})
	if rule != "" {
		p := ical.NewProp(ical.PropRecurrenceRule)
		p.Value = rule
		master.Props.Set(p)
	}

	f := tm.start.form()
	master.Props.Set(seriesDateProp(cal, ical.PropDateTimeStart, newStart, f))
	if durChanged {
		master.Props.Del(ical.PropDuration)
		master.Props.Set(seriesDateProp(cal, ical.PropDateTimeEnd, newStart.Add(dur), f))
	} else if p := master.Props.Get(ical.PropDateTimeEnd); p != nil {
		// DTEND moves as DTSTART did, so the series keeps its duration, also
		// where a move by months puts the two in months of other lengths.
		shiftDatePropBy(p, wallShift("", tm.start, tm.start.t, newStart))
	}
	shiftRecurrenceRefs(cal, master, shift)

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
		}
	}

	if ov != nil {
		ov.Props.Set(seriesDateProp(cal, ical.PropDateTimeStart, in.Start, f))
		ov.Props.Set(seriesDateProp(cal, ical.PropDateTimeEnd, in.End, f))
		ov.Props.Del(ical.PropDuration)
		bumpChangeProps(ov, now)
	}
	return shift(dateValue{t: rid, allDay: tm.start.allDay}), nil
}

// wallShift returns how "all events" moves the values of the series whose
// rule is rule and whose DTSTART is st when its event shown at from moves to
// to (spec section 3 item 2, FR-17): by the same change of date (see
// dateShift) and the same change of clock time, both measured in the
// series' zone. The series repeats on that wall clock, so a move by the
// absolute time in between would put EXDATEs, RECURRENCE-IDs and DTSTART
// itself an hour off across a daylight-saving change. A DATE moves by the
// change of date only. A UTC or TZID value names an instant, which moves
// with the series' wall clock and is then written in its own form again; a
// floating value, or one with a TZID Lucid cannot resolve, moves on its own
// wall clock.
func wallShift(rule string, st dateValue, from, to time.Time) func(dateValue) time.Time {
	loc := st.loc()
	f, t := from.In(loc), to.In(loc)
	months, days := dateShift(rule, f, t)
	secs := secondOfDay(t) - secondOfDay(f)
	return func(d dateValue) time.Time {
		if d.allDay {
			return d.t.AddDate(0, months, days)
		}
		zone := loc
		if d.floating || d.tzid == "" && d.param != "" {
			zone = d.t.Location() // its wall clock, read as UTC
		}
		w := d.t.In(zone)
		return time.Date(w.Year(), w.Month()+time.Month(months), w.Day()+days,
			w.Hour(), w.Minute(), w.Second()+secs, w.Nanosecond(), zone)
	}
}

// dateShift returns the change of date from from to to, each read in its
// own location, as a series with the rule rule moves (spec section 3 item
// 2, FR-17): for a MONTHLY or YEARLY rule without BY parts, whose events
// keep the day of the month of DTSTART, in calendar months and then days of
// the month, as todoSeries.refShift counts them, so that a move across a
// month end keeps each later event on the moved one's day of the month; for
// any other rule in calendar days.
func dateShift(rule string, from, to time.Time) (months, days int) {
	if freq := strings.ToUpper(rulePart(rule, "FREQ")); (freq == "MONTHLY" || freq == "YEARLY") && !ruleHasFixedDays(rule, false) {
		return (to.Year()-from.Year())*12 + int(to.Month()) - int(from.Month()), to.Day() - from.Day()
	}
	return 0, dateDays(to) - dateDays(from)
}

// toggledStart returns the new DTSTART of the series with the rule rule and
// DTSTART st whose all-day flag "all events" changes, from its event shown
// at from, as in sets it (spec section 3 item 4, FR-17). DTSTART's date
// moves by the change of date (see dateShift) between the dates the user
// saw and entered, each read where it is meant, rather than measured in one
// zone and written in another, which put it off by a daylight-saving change
// between DTSTART and the edited event:
//   - made all-day, from the edited event's date in the series' zone to the
//     date entered (in.Start's in UTC), DTSTART's own date read in the
//     series' zone too;
//   - made timed, from the all-day date shown to in.Start's date in the
//     request's zone tz, at in.Start's clock time there, so the series shows
//     the time entered on both sides of a daylight-saving change.
func toggledStart(rule string, st dateValue, from time.Time, in domain.EventInput, tz string) time.Time {
	if in.AllDay {
		loc := st.loc()
		months, days := dateShift(rule, from.In(loc), in.Start.UTC())
		y, m, d := st.t.In(loc).Date()
		return time.Date(y, m+time.Month(months), d+days, 0, 0, 0, 0, time.UTC)
	}
	loc := loadLocation(tz)
	if loc == nil {
		loc = time.UTC // as applyEventFields writes it then
	}
	to := in.Start.In(loc)
	months, days := dateShift(rule, from.UTC(), to)
	y, m, d := st.t.UTC().Date()
	return time.Date(y, m+time.Month(months), d+days, to.Hour(), to.Minute(), to.Second(), 0, loc)
}

// shownAt returns the event of o with the recurrence ID rid as ListEvents
// shows it in [start, end], if it is there (FR-17).
func shownAt(o calObject, calendarID string, rid, start, end time.Time) (domain.Event, bool) {
	evs, _ := expandObject(o, calendarID, start, end.Add(time.Second))
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
	objPath, calPath, err := decodeObjectID(s.homePath, id)
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
		sd, ed := dateOnly(start), dateOnly(end)
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
	c.Props.Set(newDateProp(ical.PropDateTimeStart, start, false, loc))
	c.Props.Set(newDateProp(ical.PropDateTimeEnd, end, false, loc))
	if loc != nil && loc != time.UTC {
		ensureVTimezone(cal, loc, start.In(loc).Year())
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
func shiftRecurrenceRefs(cal *ical.Calendar, master *ical.Component, shift func(dateValue) time.Time) {
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
// result, written in the value's own form (FR-17).
func shiftDatePropBy(p *ical.Prop, shift func(dateValue) time.Time) {
	parts := strings.Split(p.Value, ",")
	for i, v := range parts {
		if strings.Contains(v, "/") {
			continue // PERIOD values are left alone
		}
		d, err := parseDateValue(v, p.Params)
		if err != nil {
			continue
		}
		t := shift(d)
		if t.Equal(d.t) {
			continue // kept verbatim
		}
		switch {
		case d.allDay:
			parts[i] = t.UTC().Format(icalDate)
		case strings.HasSuffix(strings.TrimSpace(v), "Z"):
			parts[i] = t.UTC().Format(icalDateTimeUTC)
		default:
			parts[i] = t.In(d.t.Location()).Format(icalDateTime)
		}
	}
	p.Value = strings.Join(parts, ",")
}

// eventAt converts component c of o into an Event. For recurring events it
// returns the occurrence at occ (or at DTSTART if occ is nil).
func eventAt(o calObject, calendarID string, c *ical.Component, occ *time.Time) (domain.Event, error) {
	tm, err := parseTiming(c)
	if err != nil {
		return domain.Event{}, fmt.Errorf("%w: %w", domain.ErrUpstream, err)
	}
	start := tm.start.t
	if occ != nil {
		start = *occ
	}
	ev := at(baseEvent(o, calendarID, c), tm, start)
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
