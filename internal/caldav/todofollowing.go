package caldav

// This file splits a task series in two at one of its later repeats R, in
// memory, for a write to R and the repeats after it (FR-17; spec section 5
// "Teilen und Beenden"): the series S ends before R, and a new series N, a
// resource of its own, goes on from R. It is the task form of the events'
// split (see splitOff and endBefore), on a todoSeries.

import (
	"fmt"
	"strconv"
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
// a deep copy, see copySeries, which a caller can change freely.
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
//     STATUS:NEEDS-ACTION without COMPLETED and PERCENT-COMPLETE (see
//     markOpen).
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
	markOpen(nm)
	// N's series, as copied, has the forms and the distance of DUE of s.
	newTodoSeries(n, nm).anchorAt(n, rid)
	nm.Props.Get(ical.PropRecurrenceRule).Value = lowerCount(series.rrule, before)
	masterFirst(n, nm)
	return n, nil
}
