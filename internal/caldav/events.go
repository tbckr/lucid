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
			otm = timing{start: dateValue{t: rid.In(tm.start.loc()), allDay: tm.start.allDay, tzid: tm.start.tzid}, dur: tm.dur}
		}
		ev := base
		ev.Title = cmp.Or(text(c.Props, ical.PropSummary), base.Title)
		ev.Description = cmp.Or(text(c.Props, ical.PropDescription), base.Description)
		ev.Location = cmp.Or(text(c.Props, ical.PropLocation), base.Location)
		ev = asOccurrence(at(ev, otm, otm.start.t), rid)
		if overlaps(ev, from, to) {
			out = append(out, ev)
		}
	}
	return out, err
}

// expandSeries returns the start times of the series in [from, to): DTSTART,
// RRULE instances and RDATEs, in the series' location, sorted and unique.
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
	add(st.t)

	var err error
	if rr := rruleString(c); rr != "" {
		var r *rrule.RRule
		if r, err = newRRule(rr, st.t); err == nil {
			next := r.Iterator()
			for range maxRRuleIterations {
				t, ok := next()
				if !ok || !t.Before(to) || len(out) >= maxInstancesPerSeries {
					break
				}
				add(t)
			}
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
	cal, current, err := s.getObject(ctx, objPath)
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
	var instance *time.Time
	oldTm, tmErr := parseTiming(master)
	tz := in.Timezone
	if tmErr == nil {
		tz = cmp.Or(tz, oldTm.start.tzid)
	}
	if in.InstanceStart != nil && isRecurring(master) && tmErr == nil && rr != "" {
		// Apply the change to the whole series: shift it by the distance the
		// edited occurrence moved and take the new duration.
		delta := in.Start.Sub(*in.InstanceStart)
		start = oldTm.start.t.Add(delta)
		end = start.Add(in.End.Sub(in.Start))
		if delta != 0 {
			shiftRecurrenceRefs(cal, master, delta)
		}
		instance = &in.Start
	}
	if rr == "" {
		removeRecurrence(cal, master)
	}
	applyEventFields(cal, master, in, rr, start, end, tz)
	bumpChangeProps(master, s.p.now().UTC())

	o := calObject{path: objPath, cal: cal}
	o.etag, err = s.putObject(ctx, objPath, cal, etag, false)
	s.invalidate(calPath)
	if err != nil {
		return domain.Event{}, err
	}
	return eventAt(o, encodeID(calPath), master, instance)
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

// shiftRecurrenceRefs moves EXDATE, RDATE and RECURRENCE-ID values by delta
// so that exceptions and overrides stay attached to the shifted series.
func shiftRecurrenceRefs(cal *ical.Calendar, master *ical.Component, delta time.Duration) {
	for _, name := range []string{ical.PropExceptionDates, ical.PropRecurrenceDates} {
		vals := master.Props[name]
		for i := range vals {
			shiftDateProp(&vals[i], delta)
		}
	}
	for _, c := range cal.Children {
		if c == master || c.Name != master.Name {
			continue
		}
		vals := c.Props[ical.PropRecurrenceID]
		for i := range vals {
			shiftDateProp(&vals[i], delta)
		}
	}
}

func shiftDateProp(p *ical.Prop, delta time.Duration) {
	shiftDatePropBy(p, func(d dateValue) time.Time { return d.t.Add(delta) })
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
