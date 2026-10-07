package caldav

// This file holds what "this and following events" needs to know about an
// event series: where it starts as ListEvents shows it, and how it splits in
// two at an occurrence R, in memory: the series S ends before R, and a new
// series N, a resource of its own, goes on from R (FR-17).

import (
	"maps"
	"strconv"
	"strings"
	"time"

	"github.com/emersion/go-ical"

	"github.com/tbckr/lucid/internal/domain"
)

// errSplitAtStart refuses to end a series before an occurrence at or before
// its DTSTART, which only an RDATE or override before DTSTART leaves
// possible: DTSTART is always an occurrence of the series (RFC 5545 section
// 3.8.5.3), so no rule can end before it (FR-17).
var errSplitAtStart error = &domain.ValidationError{Msg: "the series cannot end before this event"}

// firstOccurrence returns the earliest RECURRENCE-ID ListEvents shows for the
// series master in cal, whose timing is tm: no window shows an occurrence of
// the series before it, so the series cannot be split there. It is the
// earliest of
//   - the first instance of the rule, DTSTART included, that is no EXDATE and
//     no cancelled override (the walk ends at that one, after at most
//     maxRRuleIterations instances),
//   - the RDATEs, and
//   - the RECURRENCE-IDs of the overrides,
//
// none of those an EXDATE or a cancelled override, as expandObject leaves
// them out. A rule that ruleInstances cannot read gives DTSTART only, as
// expandSeries does. It returns the zero time if the series shows nothing.
func firstOccurrence(cal *ical.Calendar, master *ical.Component, tm timing) time.Time {
	exdates := exceptionDates(master)
	overrides := recurrenceOverrides(cal, master)
	shown := func(t time.Time) bool {
		ov := overrides[t.Unix()]
		return !exdates[t.Unix()] && (ov == nil || !isCancelled(ov))
	}
	var first time.Time
	consider := func(t time.Time) {
		if shown(t) && (first.IsZero() || t.Before(first)) {
			first = t
		}
	}

	next, err := ruleInstances(rruleString(master), tm.start.t)
	if err != nil {
		consider(tm.start.t)
	} else {
		for range maxRRuleIterations {
			t, ok := next()
			if !ok {
				break
			}
			if shown(t) {
				consider(t)
				break
			}
		}
	}
	for _, p := range master.Props.Values(ical.PropRecurrenceDates) {
		dvs, err := parseDateList(&p)
		if err != nil {
			continue
		}
		for _, d := range dvs {
			consider(d.t)
		}
	}
	for ridUnix := range overrides {
		consider(time.Unix(ridUnix, 0))
	}
	return first
}

// placeInRule returns where rid lies among the occurrences of the rule of
// master, whose timing is tm, as ruleInstances yields them (FR-17). before
// counts those before rid as a COUNT counts them (RFC 5545 section 3.3.10):
// DTSTART is the first, and an EXDATE does not take one away. from is the
// first at or after rid, rid itself if it is one, the zero time if there is
// none. It fails for a rule ruleInstances cannot read, and for one that does
// not reach rid within maxRRuleIterations occurrences.
func placeInRule(master *ical.Component, tm timing, rid time.Time) (before int, from time.Time, err error) {
	next, err := ruleInstances(rruleString(master), tm.start.t)
	if err != nil {
		return 0, time.Time{}, err
	}
	for range maxRRuleIterations {
		t, ok := next()
		switch {
		case !ok:
			return before, time.Time{}, nil
		case t.Before(rid):
			before++
		default:
			return before, t, nil
		}
	}
	return 0, time.Time{}, errRRuleCap
}

// endBefore ends the series master in cal, whose timing is tm, just before
// its occurrence rid, in place (FR-17; spec section 4 "Teilen" step 4):
//   - A rule that has occurrences from rid on ends with an UNTIL just before
//     rid, in the form RFC 5545 section 3.3.10 wants for DTSTART's (see
//     countToUntil): for a DATE the day before rid, for a floating DATE-TIME
//     rid - 1 s floating, otherwise rid - 1 s in UTC, which keeps the
//     occurrence a week before rid across a change of summer time. It
//     replaces a COUNT or a later UNTIL. In a zone Lucid cannot resolve (see
//     todoSeries.zoneKnown), rid's instant is the wall clock read as UTC,
//     and such an UNTIL would be off by the zone's offset, so the rule ends
//     with a COUNT of its occurrences before rid instead, as for tasks. A
//     rule that already ends before rid, by its COUNT or UNTIL, stays as it
//     is.
//   - EXDATE and RDATE values from rid on go, compared as instants, and a
//     property left without values goes too (see keepDates).
//   - The overrides whose RECURRENCE-ID is rid or later go, by that instant,
//     whatever their own DTSTART: an occurrence before rid moved past it
//     stays (Review Focus 3).
//
// It fails, changing nothing, for a rule Lucid cannot walk to rid (see
// placeInRule) and for a rid at or before DTSTART (errSplitAtStart). It
// neither bumps SEQUENCE nor writes: the caller does.
func endBefore(cal *ical.Calendar, master *ical.Component, tm timing, rid time.Time) error {
	before, from, err := placeInRule(master, tm, rid)
	if err != nil {
		return err
	}
	if before == 0 {
		return errSplitAtStart
	}
	if p := master.Props.Get(ical.PropRecurrenceRule); p != nil && !from.IsZero() {
		// The rule as if its COUNT had always counted only the occurrences
		// before rid; in a zone Lucid knows, that COUNT becomes an UNTIL.
		rule := withCount(rruleString(master), before)
		if tm.start.param == "" || tm.start.tzid != "" {
			// Of a DATE, countToUntil writes the date, the day before rid.
			rule = countToUntil(rule, rid.Add(-time.Second), tm.start.form())
		}
		p.Value = rule
	}
	earlier := func(t time.Time) bool { return t.Before(rid) }
	keepDates(master, ical.PropExceptionDates, earlier)
	keepDates(master, ical.PropRecurrenceDates, earlier)
	dropOverrides(cal, master, func(r dateValue) bool { return !r.t.Before(rid) })
	return nil
}

// splitOff returns the new series N that goes on from the occurrence rid of
// the series master in cal, whose timing is tm, as the calendar of a
// resource of its own (FR-17; spec section 4 "Teilen" step 2). cal stays as
// it is: N is a deep copy, which a caller can change freely.
//   - The VTIMEZONEs and the other components that are no VEVENT, and the
//     calendar's own properties, are copied as they are.
//   - The master is copied with all its properties and components, with the
//     UID uid, SEQUENCE:0 and DTSTAMP, CREATED and LAST-MODIFIED at now. It
//     comes first, as SOGo reads the first VEVENT as the series (see
//     masterFirst).
//   - DTSTART is rid in the series' form (see seriesDateProp), except for an
//     rid off the rule, see below. A DTEND keeps the series' duration in
//     DTEND's own form, and a DURATION stays.
//   - The rule's COUNT is lowered by its occurrences before N's DTSTART,
//     DTSTART counting (RFC 5545 section 3.3.10, see placeInRule), so S and
//     N together have as many as the series had; an UNTIL stays.
//   - EXDATE and RDATE values from rid on, and the overrides whose
//     RECURRENCE-ID is rid or later, by that instant, come along. The
//     overrides take N's UID.
//
// An rid that is no occurrence of the rule, an RDATE (or an override off
// the rule), stays one of N, which starts at the rule's first occurrence
// after it. If there is none, N has no RRULE and starts at rid, keeping the
// later RDATEs; without those it is a single event at rid, so the EXDATEs
// and the overrides go too (see removeRecurrence).
//
// It fails for a rule Lucid cannot walk to rid (see placeInRule).
func splitOff(cal *ical.Calendar, master *ical.Component, tm timing, rid time.Time, uid string, now time.Time) (*ical.Calendar, error) {
	before, start, err := placeInRule(master, tm, rid)
	if err != nil {
		return nil, err
	}
	n := &ical.Calendar{Component: ical.NewComponent(cal.Name)}
	for name, props := range cal.Props {
		n.Props[name] = cloneProps(props)
	}
	var nm *ical.Component
	for _, c := range cal.Children {
		switch {
		case c == master:
			nm = copyComponent(c)
			n.Children = append(n.Children, nm)
		case c.Name != master.Name:
			n.Children = append(n.Children, copyComponent(c))
		default:
			// By the instant of the RECURRENCE-ID, never the override's own
			// date. An event without one Lucid can read stays with the series.
			r, err := parseDateProp(c.Props.Get(ical.PropRecurrenceID))
			if err == nil && !r.t.Before(rid) {
				o := copyComponent(c)
				o.Props.SetText(ical.PropUID, uid)
				n.Children = append(n.Children, o)
			}
		}
	}
	maps.Copy(nm.Props, newComponent(master.Name, uid, now).Props)
	later := func(t time.Time) bool { return !t.Before(rid) }
	keepDates(nm, ical.PropExceptionDates, later)
	keepDates(nm, ical.PropRecurrenceDates, later)

	if start.IsZero() {
		start = rid
		nm.Props.Del(ical.PropRecurrenceRule)
		// DTSTART is rid now.
		keepDates(nm, ical.PropRecurrenceDates, func(t time.Time) bool { return t.After(rid) })
		if !isRecurring(nm) {
			removeRecurrence(n, nm)
		}
	}
	if p := nm.Props.Get(ical.PropRecurrenceRule); p != nil {
		p.Value = lowerCount(rruleString(nm), before)
	}
	nm.Props.Set(seriesDateProp(n, ical.PropDateTimeStart, start, tm.start.form()))
	if p := nm.Props.Get(ical.PropDateTimeEnd); p != nil {
		end := tm.dur.addTo(start)
		shiftDatePropBy(p, func(dateValue) time.Time { return end })
	}
	masterFirst(n, nm)
	return n, nil
}

// copyComponent returns a copy of c and its components that shares nothing
// with them (see cloneProps).
func copyComponent(c *ical.Component) *ical.Component {
	out := ical.NewComponent(c.Name)
	for name, props := range c.Props {
		out.Props[name] = cloneProps(props)
	}
	for _, child := range c.Children {
		out.Children = append(out.Children, copyComponent(child))
	}
	return out
}

// withCount returns rule ending with COUNT=n in place of the COUNT and UNTIL
// parts it has, or with COUNT=n added if it has neither (FR-17).
func withCount(rule string, n int) string {
	end := "COUNT=" + strconv.Itoa(n)
	var out []string
	for part := range strings.SplitSeq(rule, ";") {
		switch rulePartKey(part) {
		case "COUNT", "UNTIL":
			if end != "" {
				out = append(out, end)
				end = ""
			}
		default:
			out = append(out, part)
		}
	}
	if end != "" {
		out = append(out, end)
	}
	return strings.Join(out, ";")
}

// keepDates keeps those values of the EXDATE or RDATE properties name of c
// whose instant keep reports, each as it is written, a PERIOD by its start,
// and removes a property left without values (FR-17). A property with a
// value Lucid cannot read, of which it reads none (see parseDateList), counts
// as the zero time, before every occurrence: it stays as it is in the series
// it is in, and does not go to a new one.
func keepDates(c *ical.Component, name string, keep func(time.Time) bool) {
	var props []ical.Prop
	for _, p := range c.Props[name] {
		if _, err := parseDateList(&p); err != nil {
			if keep(time.Time{}) {
				props = append(props, p)
			}
			continue
		}
		var vals []string
		for v := range strings.SplitSeq(p.Value, ",") {
			start, _, _ := strings.Cut(strings.TrimSpace(v), "/")
			// An empty value, the only one left that fails, goes.
			if d, err := parseDateValue(start, p.Params); err == nil && keep(d.t) {
				vals = append(vals, v)
			}
		}
		if len(vals) > 0 {
			p.Value = strings.Join(vals, ",")
			props = append(props, p)
		}
	}
	c.Props.Del(name)
	for i := range props {
		c.Props.Add(&props[i])
	}
}
