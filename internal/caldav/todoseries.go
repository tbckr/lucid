package caldav

import (
	"cmp"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/emersion/go-ical"

	"github.com/tbckr/lucid/internal/domain"
)

// This file reads recurring VTODOs as Tasks.org, Apple, Thunderbird and KDE
// write them (FR-17; docs/RECURRING-TASKS.md).

// propKDEPending is where KDE records the pending occurrence of a rolling
// series whose DTSTART stays at the first occurrence.
const propKDEPending = "X-KDE-LIBKCAL-DTRECURRENCE"

var (
	errNoAnchor = errors.New("recurring todo without DTSTART or DUE")
	// errRDate makes a series with RDATE unsupported: rolling it forward
	// cannot keep an RDATE off its rule without shifting the rule, and such
	// task series are rare (FR-17).
	errRDate    = errors.New("recurring todo with RDATE")
	errRRuleCap = fmt.Errorf("RRULE exceeds %d iterations", maxRRuleIterations)
	// errRuleUnsupported rejects completing or moving an occurrence of a
	// series whose rule Lucid cannot evaluate (FR-17).
	errRuleUnsupported error = &domain.ValidationError{Msg: "the repeat rule cannot be evaluated"}
	// errRuleNeedsDate rejects a series without a date to recur from (FR-17).
	errRuleNeedsDate error = &domain.ValidationError{Msg: "a repeating task needs a start or due date"}
)

// todoSeries is a recurring VTODO and what other clients recorded in it (FR-17).
type todoSeries struct {
	master      *ical.Component
	anchor      dateValue                 // DTSTART, or DUE without DTSTART
	onDue       bool                      // anchored on DUE
	startAllDay bool                      // master DTSTART value type (only meaningful when set)
	dueAllDay   bool                      // master DUE (or DURATION-derived) value type
	startForm   dateForm                  // how DTSTART is written; DUE's form when anchored on DUE
	dueForm     dateForm                  // how DUE is written; DTSTART's form without DUE
	dueOffset   *time.Duration            // DUE (or DURATION) − DTSTART when both exist
	overrides   map[int64]*ical.Component // by RECURRENCE-ID instant (Unix)
	exdates     map[int64]bool
	pending     time.Time // X-KDE-LIBKCAL-DTRECURRENCE, zero if absent
	fixedDays   bool
	err         error // non-nil: the rule cannot be evaluated
}

// todoOcc is one occurrence: rid is its original start; start/due its effective
// dates, with the value type (date or date-time) they were read with (FR-16, FR-17).
type todoOcc struct {
	rid                    time.Time
	start, due             *time.Time
	startAllDay, dueAllDay bool
	done                   bool            // completed by an override
	override               *ical.Component // nil for rule-generated occurrences
}

// newTodoSeries reads the series of master in cal. It returns nil when master
// has neither RRULE nor RDATE.
func newTodoSeries(cal *ical.Calendar, master *ical.Component) *todoSeries {
	if !isRecurring(master) {
		return nil
	}
	s := &todoSeries{
		master:    master,
		overrides: map[int64]*ical.Component{},
		exdates:   map[int64]bool{},
		fixedDays: ruleHasFixedDays(rruleString(master), master.Props.Get(ical.PropRecurrenceDates) != nil),
	}
	start, startErr := parseDateProp(master.Props.Get(ical.PropDateTimeStart))
	due, dueErr := parseDateProp(master.Props.Get(ical.PropDue))
	s.startForm, s.dueForm, _ = storedForms(master)
	switch {
	case startErr == nil:
		s.anchor, s.startAllDay = start, start.allDay
		if dueErr == nil {
			s.dueAllDay = due.allDay
			off := due.t.Sub(start.t)
			s.dueOffset = &off
		} else if p := master.Props.Get(ical.PropDuration); p != nil {
			// DURATION stands for DUE, as for single todos (FR-16).
			if dur, err := parseDuration(p.Value); err == nil {
				s.dueAllDay = start.allDay
				off := dur.addTo(start.t).Sub(start.t)
				s.dueOffset = &off
			}
		}
	case dueErr == nil:
		// Tasks.org writes series without DTSTART; they recur on DUE.
		s.anchor, s.onDue, s.dueAllDay = due, true, due.allDay
	default:
		s.err = errNoAnchor
	}
	switch rr := rruleString(master); {
	case s.err != nil:
	case master.Props.Get(ical.PropRecurrenceDates) != nil:
		s.err = errRDate
	case rr != "":
		_, s.err = newRRule(rr, s.anchor.t)
	}

	for _, c := range cal.Children {
		if c == master || c.Name != master.Name {
			continue
		}
		// Instants, not strings: other clients write RECURRENCE-ID in UTC,
		// with TZID or floating, whatever DTSTART uses.
		if rid, err := parseDateProp(c.Props.Get(ical.PropRecurrenceID)); err == nil {
			s.overrides[rid.t.Unix()] = c
		}
	}
	for _, p := range master.Props.Values(ical.PropExceptionDates) {
		dvs, err := parseDateList(&p)
		if err != nil {
			continue
		}
		for _, d := range dvs {
			s.exdates[d.t.Unix()] = true
		}
	}
	if d, err := parseDateProp(master.Props.Get(propKDEPending)); err == nil {
		s.pending = d.t
	}
	return s
}

// ruleHasFixedDays reports whether a series recurs on fixed days rather than
// at a fixed interval from its anchor: an RRULE with a part other than FREQ,
// INTERVAL, COUNT, UNTIL or WKST, or any RDATE (FR-17).
func ruleHasFixedDays(rrule string, hasRDate bool) bool {
	if hasRDate {
		return true
	}
	for part := range strings.SplitSeq(rrule, ";") {
		switch rulePartKey(part) {
		case "", "FREQ", "INTERVAL", "COUNT", "UNTIL", "WKST":
		default:
			return true
		}
	}
	return false
}

// rulePartKey returns the upper-case name of an RRULE part such as "COUNT=3".
func rulePartKey(part string) string {
	key, _, _ := strings.Cut(part, "=")
	return strings.ToUpper(strings.TrimSpace(key))
}

// walk calls fn for the occurrences with rid >= from, in order, until fn
// returns false: the anchor and the RRULE instances, without EXDATEs and
// cancelled overrides (FR-17). It fails when the rule cannot be evaluated
// (a series with RDATE included) or hits maxRRuleIterations before fn stops.
func (s *todoSeries) walk(from time.Time, fn func(todoOcc) bool) error {
	if s.err != nil {
		return s.err
	}
	var ruleNext func() (time.Time, bool)
	if rr := rruleString(s.master); rr != "" {
		r, err := newRRule(rr, s.anchor.t)
		if err != nil {
			return err
		}
		ruleNext = r.Iterator()
	}
	// The anchor, then the rule's instances (the first may be the anchor
	// again). The rule advances lazily, so that fn can stop before the next
	// iteration counts against the cap.
	var prev time.Time
	for t, more, steps := s.anchor.t, true, 0; more; steps++ {
		if !t.Equal(prev) && !t.Before(from) {
			prev = t
			if occ, ok := s.occurrence(t); ok && !fn(occ) {
				return nil
			}
		}
		switch {
		case ruleNext == nil:
			return nil
		case steps == maxRRuleIterations:
			return errRRuleCap
		}
		t, more = ruleNext()
	}
	return nil
}

// occurrence returns the occurrence at rid, or false if it is excluded or
// cancelled.
func (s *todoSeries) occurrence(rid time.Time) (todoOcc, bool) {
	if s.exdates[rid.Unix()] {
		return todoOcc{}, false
	}
	occ := todoOcc{rid: rid, override: s.overrides[rid.Unix()], startAllDay: s.startAllDay, dueAllDay: s.dueAllDay}
	if s.onDue {
		occ.due = &rid
	} else {
		occ.start = &rid
	}
	if ov := occ.override; ov != nil {
		status := strings.ToUpper(strings.TrimSpace(text(ov.Props, ical.PropStatus)))
		if status == domain.TodoCancelled {
			return todoOcc{}, false
		}
		occ.done = status == domain.TodoCompleted
		// An override's own DTSTART/DUE value type wins over the master's (FR-17).
		if d, err := parseDateProp(ov.Props.Get(ical.PropDateTimeStart)); err == nil {
			occ.start, occ.startAllDay = &d.t, d.allDay
		}
		if d, err := parseDateProp(ov.Props.Get(ical.PropDue)); err == nil {
			occ.due, occ.dueAllDay = &d.t, d.allDay
		}
	}
	if !s.onDue && occ.due == nil && s.dueOffset != nil {
		due := occ.start.Add(*s.dueOffset)
		occ.due = &due
	}
	return occ, true
}

// current returns the earliest occurrence that is not done, from the anchor
// or KDE's pending occurrence on, and the next one that is not done (nil if
// none). When every occurrence is done, cur is the last one; when there is
// none at all, cur is the zero todoOcc.
func (s *todoSeries) current() (cur todoOcc, next *todoOcc, err error) {
	from := s.anchor.t
	if s.pending.After(from) {
		from = s.pending
	}
	found := false
	err = s.walk(from, func(o todoOcc) bool {
		switch {
		case o.done && !found:
			cur = o
		case o.done:
		case !found:
			cur, found = o, true
		default:
			next = &o
			return false
		}
		return true
	})
	if err != nil {
		return todoOcc{}, nil, err
	}
	return cur, next, nil
}

// reportedRid returns the RECURRENCE-ID of the occurrence whose dates a todo
// read from s with the given status reports (see setSeries): the current
// occurrence of an open series, else the anchor (FR-17).
func (s *todoSeries) reportedRid(status string) time.Time {
	if status != domain.TodoCompleted && status != domain.TodoCancelled {
		if cur, _, err := s.current(); err == nil && !cur.rid.IsZero() {
			return cur.rid
		}
	}
	return s.anchor.t
}

// setSeries fills the series fields of t, a todo read from s.master, and
// moves an open series to its current occurrence (FR-16, FR-17). A completed
// or cancelled master, a rule Lucid cannot evaluate and a series without any
// occurrence left keep the master's dates.
func (s *todoSeries) setSeries(t *domain.Todo) {
	t.RRule, t.Recurring, t.FixedDays = rruleString(s.master), true, s.fixedDays
	if t.Status == domain.TodoCompleted || t.Status == domain.TodoCancelled {
		return
	}
	cur, next, err := s.current()
	if err != nil {
		t.RuleUnsupported = true
		return
	}
	if cur.rid.IsZero() {
		return
	}
	t.Start, t.Due = utcPtr(cur.start), utcPtr(cur.due)
	if next != nil {
		t.Next = &domain.TodoDates{Start: utcPtr(next.start), Due: utcPtr(next.due)}
	}
}

func utcPtr(t *time.Time) *time.Time {
	if t == nil {
		return nil
	}
	u := t.UTC()
	return &u
}

// roll moves the master of s from its completed current occurrence cur to
// next, keeping the form other clients wrote its dates in (FR-15, FR-17):
// DTSTART and DUE (DTSTART = DUE for a series anchored on DUE, as RFC 5545
// wants DTSTART with RRULE) move to next's place in the rule, a COUNT
// becomes the UNTIL of the last occurrence, and the override of cur and
// KDE's pending occurrence go. It fails, without changing anything, when
// the rule cannot be evaluated to its end.
//
// Next's override, if any, stays and keeps moving that occurrence: the
// master takes the rule's dates (next.rid), not the override's, or the whole
// series would shift with it.
func (s *todoSeries) roll(cal *ical.Calendar, cur, next todoOcc) error {
	c := s.master
	if p := c.Props.Get(ical.PropRecurrenceRule); p != nil && hasRulePart(p.Value, "COUNT") {
		last, err := s.ruleEnd()
		if err != nil {
			return err
		}
		p.Value = countToUntil(strings.TrimSpace(p.Value), last, s.startForm)
	}

	setSeriesDate(cal, c, ical.PropDateTimeStart, &next.rid, s.startForm)
	if s.onDue {
		setSeriesDate(cal, c, ical.PropDue, &next.rid, s.dueForm)
		c.Props.Del(ical.PropDuration) // invalid without DTSTART; DUE stands
	} else if c.Props.Get(ical.PropDue) != nil && s.dueOffset != nil {
		// A DURATION stays: it is relative to DTSTART.
		due := next.rid.Add(*s.dueOffset)
		setSeriesDate(cal, c, ical.PropDue, &due, s.dueForm)
	}

	dropOverrides(cal, c, cur.rid.Equal)
	c.Props.Del(propKDEPending)
	return nil
}

// dropOverrides removes the overrides of master from cal whose
// RECURRENCE-ID instant drop reports (FR-17).
func dropOverrides(cal *ical.Calendar, master *ical.Component, drop func(rid time.Time) bool) {
	cal.Children = slices.DeleteFunc(cal.Children, func(o *ical.Component) bool {
		if o == master || o.Name != master.Name {
			return false
		}
		rid, err := parseDateProp(o.Props.Get(ical.PropRecurrenceID))
		return err == nil && drop(rid.t)
	})
}

// ruleEnd returns the last instance of the RRULE of s, iterated from the
// anchor as walk does (so an anchor off the rule still counts extra for
// COUNT), or the anchor when the rule yields none. It fails for a rule that
// does not end within maxRRuleIterations (FR-17).
func (s *todoSeries) ruleEnd() (time.Time, error) {
	if s.err != nil {
		return time.Time{}, s.err
	}
	r, err := newRRule(rruleString(s.master), s.anchor.t)
	if err != nil {
		return time.Time{}, err
	}
	last, next := s.anchor.t, r.Iterator()
	for range maxRRuleIterations {
		t, ok := next()
		if !ok {
			return last, nil
		}
		last = t
	}
	return time.Time{}, errRRuleCap
}

// hasRulePart reports whether rrule has a part named key (upper case).
func hasRulePart(rrule, key string) bool {
	for part := range strings.SplitSeq(rrule, ";") {
		if rulePartKey(part) == key {
			return true
		}
	}
	return false
}

// countToUntil replaces the COUNT of rrule by an UNTIL at last, the final
// occurrence, so that the rule keeps its end when DTSTART rolls forward
// (FR-17). UNTIL follows DTSTART's form f (RFC 5545 3.3.10): a DATE for an
// all-day series, floating for a floating one, UTC otherwise (for a TZID
// Lucid cannot resolve, its wall clock was read as UTC). An UNTIL next to
// the COUNT (not allowed by RFC 5545) is replaced too. A rule without COUNT
// is returned unchanged.
func countToUntil(rrule string, last time.Time, f dateForm) string {
	if !hasRulePart(rrule, "COUNT") {
		return rrule
	}
	var until string
	switch {
	case f.allDay:
		until = "UNTIL=" + last.UTC().Format(icalDate)
	case f.floating:
		until = "UNTIL=" + last.UTC().Format(icalDateTime)
	default:
		until = "UNTIL=" + last.UTC().Format(icalDateTimeUTC)
	}
	var out []string
	for part := range strings.SplitSeq(rrule, ";") {
		switch rulePartKey(part) {
		case "COUNT":
			out = append(out, until)
		case "UNTIL":
		default:
			out = append(out, part)
		}
	}
	return strings.Join(out, ";")
}

// setSeriesDate writes the date property name of c in the form f (FR-17):
//   - a DATE when f.allDay;
//   - with f.param as TZID, verbatim, when set: the wall clock in the zone
//     it resolves to, else the wall clock it was read with (as UTC);
//   - with f.tzid as TZID, for a zone of Lucid's choosing (a new rule);
//   - floating (a wall clock without "Z") when f.floating;
//   - else in UTC.
//
// A TZID gets a VTIMEZONE in cal unless one with that TZID exists, or Lucid
// cannot resolve it. A nil t removes the property.
func setSeriesDate(cal *ical.Calendar, c *ical.Component, name string, t *time.Time, f dateForm) {
	if t == nil {
		c.Props.Del(name)
		return
	}
	tzid := cmp.Or(f.param, f.tzid)
	var loc *time.Location
	if tzid != "" {
		loc = loadLocation(tzid)
	}
	switch {
	case f.allDay:
		c.Props.Set(newDateProp(name, *t, true, nil))
	case f.param != "" || (loc != nil && loc != time.UTC):
		wall := t.UTC()
		if loc != nil {
			wall = t.In(loc)
		}
		p := ical.NewProp(name)
		p.Params.Set(ical.ParamTimezoneID, tzid)
		p.Value = wall.Truncate(time.Second).Format(icalDateTime)
		c.Props.Set(p)
		if loc != nil && loc != time.UTC {
			ensureVTimezoneAs(cal, tzid, loc, wall.Year())
		}
	case f.floating:
		p := ical.NewProp(name)
		p.Value = t.UTC().Truncate(time.Second).Format(icalDateTime)
		c.Props.Set(p)
	default:
		c.Props.Set(newDateProp(name, *t, false, nil))
	}
}

// storedForms returns the forms DTSTART and DUE of c are written in, each
// standing in for the other when missing; ok is false when c has neither
// (FR-17).
func storedForms(c *ical.Component) (start, due dateForm, ok bool) {
	s, startErr := parseDateProp(c.Props.Get(ical.PropDateTimeStart))
	d, dueErr := parseDateProp(c.Props.Get(ical.PropDue))
	switch {
	case startErr == nil && dueErr == nil:
		return s.form(), d.form(), true
	case startErr == nil:
		return s.form(), s.form(), true
	case dueErr == nil:
		return d.form(), d.form(), true
	}
	return dateForm{}, dateForm{}, false
}

// seriesForm returns the form a series date of the given value type is
// written in (FR-17): a DATE when all-day; else the stored DATE-TIME form f
// when keep is set or f has a TZID another client chose; else the zone tz,
// UTC without one.
func seriesForm(f dateForm, allDay, keep bool, tz string) dateForm {
	switch {
	case allDay:
		return dateForm{allDay: true}
	case !f.allDay && (keep || f.param != ""):
		return f
	default:
		return dateForm{tzid: tz}
	}
}

// writeSeriesDates writes the start and due of in as DTSTART and DUE of the
// recurring todo c (FR-10, FR-17). Without a start, DTSTART = DUE, as RFC
// 5545 wants DTSTART with RRULE; DUE replaces a DURATION. keep keeps the
// form of the dates c has, else only a TZID stays and timed dates take the
// zone of in (see seriesForm).
func writeSeriesDates(cal *ical.Calendar, c *ical.Component, in domain.TodoInput, keep bool) {
	startForm, dueForm, ok := storedForms(c)
	keep = keep && ok
	start, startAllDay := in.Start, in.StartAllDay
	if start == nil {
		start, startAllDay = in.Due, in.DueAllDay
	}
	setSeriesDate(cal, c, ical.PropDateTimeStart, start, seriesForm(startForm, startAllDay, keep, in.Timezone))
	setSeriesDate(cal, c, ical.PropDue, in.Due, seriesForm(dueForm, in.DueAllDay, keep, in.Timezone))
	c.Props.Del(ical.PropDuration)
}
