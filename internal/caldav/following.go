package caldav

// This file holds what "this and following events" needs to know about an
// event series: where it starts as ListEvents shows it (FR-17).

import (
	"time"

	"github.com/emersion/go-ical"
)

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
