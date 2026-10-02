package caldav

// This file implements "only this event" writes for a recurring series: an
// RFC 5545 override, a second VEVENT sharing the series' UID and carrying a
// RECURRENCE-ID, in the same resource as the series (FR-17).

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/emersion/go-ical"

	"github.com/tbckr/lucid/internal/domain"
)

// findOverride returns the override of master in cal whose RECURRENCE-ID is
// the instant rid, comparing instants rather than raw values (FR-17).
func findOverride(cal *ical.Calendar, master *ical.Component, rid time.Time) *ical.Component {
	for _, c := range cal.Children {
		if c == master || c.Name != master.Name {
			continue
		}
		r, err := parseDateProp(c.Props.Get(ical.PropRecurrenceID))
		if err == nil && r.t.Equal(rid) {
			return c
		}
	}
	return nil
}

// isInstance reports whether rid is an occurrence the rule of master
// produces: a time expandSeries yields for [rid, rid+1s), not excluded by an
// EXDATE at the same instant (FR-17).
func isInstance(master *ical.Component, tm timing, rid time.Time) bool {
	occs, err := expandSeries(master, tm.start, rid, rid.Add(time.Second))
	if err != nil || len(occs) == 0 {
		return false
	}
	for _, p := range master.Props.Values(ical.PropExceptionDates) {
		dvs, perr := parseDateList(&p)
		if perr != nil {
			continue
		}
		for _, d := range dvs {
			if d.t.Equal(rid) {
				return false
			}
		}
	}
	return true
}

// newOverride returns a new override component for master at rid: a full
// copy of its properties (via cloneProps) and of its children (VALARM,
// ATTENDEE, ...), except the recurrence-defining properties, with
// RECURRENCE-ID written in the form f. A partial copy leaves the override
// untitled in Thunderbird and DAVx⁵, and a copy that keeps
// RRULE/RDATE/EXDATE is rejected by Radicale or duplicated by older DAVx⁵
// versions (spec section 2, FR-17).
func newOverride(cal *ical.Calendar, master *ical.Component, rid time.Time, f dateForm) *ical.Component {
	c := ical.NewComponent(master.Name)
	for name, props := range master.Props {
		c.Props[name] = cloneProps(props)
	}
	c.Children = append(c.Children, master.Children...)
	for _, name := range []string{ical.PropRecurrenceRule, ical.PropRecurrenceDates, ical.PropExceptionDates, propExRule} {
		c.Props.Del(name)
	}
	c.Props.Set(seriesDateProp(cal, ical.PropRecurrenceID, rid, f))
	return c
}

// masterFirst moves master to be the first component of its type (VEVENT or
// VTODO) among cal's children, leaving any VTIMEZONEs where they are: SOGo
// reads the first one as the series (spec section 2 step 7, FR-17).
func masterFirst(cal *ical.Calendar, master *ical.Component) {
	cal.Children = slices.DeleteFunc(cal.Children, func(c *ical.Component) bool { return c == master })
	i := slices.IndexFunc(cal.Children, func(c *ical.Component) bool { return c.Name == master.Name })
	if i < 0 {
		i = len(cal.Children)
	}
	cal.Children = slices.Insert(cal.Children, i, master)
}

// setTextKept sets a text property even when value is empty, unlike setText,
// so a deliberately cleared field is written as an existing, empty property:
// the reader (textOr) only falls back to the series' value when the override
// has none at all (spec section 2 step 8, FR-17).
func setTextKept(props ical.Props, name, value string) {
	value = strings.ReplaceAll(strings.ReplaceAll(value, "\r\n", "\n"), "\r", "\n")
	props.SetText(name, value)
}

// UpdateOccurrence implements domain.CalendarService: it changes only the
// occurrence at recurrenceID of a recurring event, writing or editing an
// RFC 5545 override in the series' resource (FR-17; spec section 2).
func (s *service) UpdateOccurrence(ctx context.Context, eventID, etag string, recurrenceID time.Time, in domain.OccurrenceInput) (domain.Event, error) {
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
	if err := in.Validate(); err != nil {
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

	// Step 1: the series is the VEVENT without RECURRENCE-ID; missing, or
	// neither RRULE nor RDATE, is 404 (spec section 2 step 1).
	master := mainComponent(cal, ical.CompEvent)
	if master == nil || !isRecurring(master) {
		return domain.Event{}, fmt.Errorf("%w: not a recurring event", domain.ErrNotFound)
	}
	tm, err := parseTiming(master)
	if err != nil {
		return domain.Event{}, fmt.Errorf("%w: %w", domain.ErrUpstream, err)
	}

	// Step 2: the recurrenceID must be an instance of the rule, or already
	// have an override, orphaned or not (spec section 2 step 2).
	rid := recurrenceID.UTC()
	override := findOverride(cal, master, rid)
	if override == nil && !isInstance(master, tm, rid) {
		return domain.Event{}, fmt.Errorf("%w: not an occurrence of the series", domain.ErrNotFound)
	}
	// Step 3: allDay must match the series; switching it changes the whole
	// series instead (spec section 2 step 3).
	if in.AllDay != tm.start.allDay {
		return domain.Event{}, &domain.ValidationError{Msg: "allDay must match the series"}
	}

	// Steps 4-5: edit the existing override, or build a full copy of the
	// series for a new one, with RECURRENCE-ID/DTSTART/DTEND in the series'
	// form (spec section 2 steps 4-5).
	f := tm.start.form()
	if override == nil {
		override = newOverride(cal, master, rid, f)
		cal.Children = append(cal.Children, override)
	}
	setTextKept(override.Props, ical.PropSummary, in.Title)
	setTextKept(override.Props, ical.PropDescription, in.Description)
	setTextKept(override.Props, ical.PropLocation, in.Location)
	override.Props.Set(seriesDateProp(cal, ical.PropDateTimeStart, in.Start, f))
	override.Props.Set(seriesDateProp(cal, ical.PropDateTimeEnd, in.End, f))
	override.Props.Del(ical.PropDuration)

	// Step 6: DTSTAMP, LAST-MODIFIED and SEQUENCE of the override.
	bumpChangeProps(override, s.p.now().UTC())
	// Step 7: the series stays the first VEVENT of the resource.
	masterFirst(cal, master)

	// Step 9: write and invalidate the cache.
	o := calObject{path: objPath, cal: cal}
	o.etag, err = s.putObject(ctx, objPath, cal, etag, false)
	s.invalidate(calPath)
	if err != nil {
		return domain.Event{}, err
	}

	calendarID := encodeID(calPath)
	from, to := in.Start, in.End
	if rid.Before(from) {
		from = rid
	}
	if rid.After(to) {
		to = rid
	}
	to = to.Add(time.Second)
	evs, err := expandObject(o, calendarID, from, to)
	if err != nil {
		return domain.Event{}, fmt.Errorf("%w: %w", domain.ErrUpstream, err)
	}
	for i := range evs {
		if evs[i].RecurrenceID != nil && evs[i].RecurrenceID.Equal(rid) {
			return evs[i], nil
		}
	}
	return domain.Event{}, fmt.Errorf("%w: occurrence not found after update", domain.ErrUpstream)
}
