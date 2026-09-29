package caldav

import (
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
	errRRuleCap = fmt.Errorf("RRULE exceeds %d iterations", maxRRuleIterations)
	// errRuleUnsupported rejects completing or moving an occurrence of a
	// series whose rule Lucid cannot evaluate (FR-17).
	errRuleUnsupported error = &domain.ValidationError{Msg: "the repeat rule cannot be evaluated"}
)

// todoSeries is a recurring VTODO and what other clients recorded in it (FR-17).
type todoSeries struct {
	master      *ical.Component
	anchor      dateValue                 // DTSTART, or DUE without DTSTART
	onDue       bool                      // anchored on DUE
	startAllDay bool                      // master DTSTART value type (only meaningful when set)
	dueAllDay   bool                      // master DUE (or DURATION-derived) value type
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
	if rr := rruleString(master); rr != "" && s.err == nil {
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
// returns false: the anchor, the RRULE instances and the RDATEs, without
// EXDATEs and cancelled overrides (FR-17). It fails when the rule cannot be
// evaluated or hits maxRRuleIterations before fn stops.
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
	rdates := s.rdates()

	// Merge the rule stream (the anchor, then the RRULE instances) with the
	// sorted RDATEs. The rule stream advances lazily, so that fn can stop
	// before the next iteration counts against the cap.
	head, more, consumed := s.anchor.t, true, false
	steps := 0
	var prev time.Time
	for {
		if consumed {
			consumed = false
			if ruleNext == nil {
				more = false
			} else {
				if steps == maxRRuleIterations {
					return errRRuleCap
				}
				steps++
				head, more = ruleNext()
			}
		}
		var t time.Time
		switch {
		case more && (len(rdates) == 0 || !rdates[0].Before(head)):
			t, consumed = head, true
		case len(rdates) > 0:
			t, rdates = rdates[0], rdates[1:]
		default:
			return nil
		}
		if t.Equal(prev) || t.Before(from) {
			continue
		}
		prev = t
		occ, ok := s.occurrence(t)
		if ok && !fn(occ) {
			return nil
		}
	}
}

// rdates returns the RDATEs of the series in its location, sorted.
func (s *todoSeries) rdates() []time.Time {
	var out []time.Time
	for _, p := range s.master.Props.Values(ical.PropRecurrenceDates) {
		dvs, err := parseDateList(&p)
		if err != nil {
			continue
		}
		for _, d := range dvs {
			out = append(out, d.t.In(s.anchor.loc()))
		}
	}
	slices.SortFunc(out, time.Time.Compare)
	return out
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
// next, in the series' own form (FR-15, FR-17): DTSTART and DUE (DTSTART =
// DUE for a series anchored on DUE, as RFC 5545 wants DTSTART with RRULE)
// move to next's place in the rule, a COUNT becomes the UNTIL of the last
// occurrence, and the override of cur and KDE's pending occurrence go. It
// fails, without changing anything, when the rule cannot be evaluated to
// its end.
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
		p.Value = countToUntil(strings.TrimSpace(p.Value), last, s.anchor.allDay)
	}

	tzid := s.anchor.tzid
	if s.onDue {
		setSeriesDate(cal, c, ical.PropDateTimeStart, &next.rid, s.dueAllDay, tzid)
		setSeriesDate(cal, c, ical.PropDue, &next.rid, s.dueAllDay, tzid)
		c.Props.Del(ical.PropDuration) // invalid without DTSTART; DUE stands
	} else {
		setSeriesDate(cal, c, ical.PropDateTimeStart, &next.rid, s.startAllDay, tzid)
		// A DURATION stays: it is relative to DTSTART.
		if c.Props.Get(ical.PropDue) != nil && s.dueOffset != nil {
			due := next.rid.Add(*s.dueOffset)
			setSeriesDate(cal, c, ical.PropDue, &due, s.dueAllDay, tzid)
		}
	}

	cal.Children = slices.DeleteFunc(cal.Children, func(o *ical.Component) bool {
		if o == c || o.Name != c.Name {
			return false
		}
		rid, err := parseDateProp(o.Props.Get(ical.PropRecurrenceID))
		return err == nil && rid.t.Equal(cur.rid)
	})
	c.Props.Del(propKDEPending)
	return nil
}

// ruleEnd returns the last instance of the RRULE of s, iterated from the
// anchor as walk does (so an anchor off the rule still counts extra for
// COUNT), or the anchor when the rule yields none. RDATEs are left out: they
// do not extend the rule. It fails for a rule that does not end within
// maxRRuleIterations (FR-17).
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
// (FR-17). UNTIL is a DATE for an all-day series and UTC otherwise (RFC
// 5545); an UNTIL next to the COUNT (not allowed by RFC 5545) is replaced
// too. A rule without COUNT is returned unchanged.
func countToUntil(rrule string, last time.Time, allDay bool) string {
	if !hasRulePart(rrule, "COUNT") {
		return rrule
	}
	until := "UNTIL=" + last.UTC().Format(icalDateTimeUTC)
	if allDay {
		until = "UNTIL=" + last.UTC().Format(icalDate)
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

// setSeriesDate writes the date property name of c in the form of its
// series (FR-17): a DATE when allDay, local time with TZID when tzid names a
// zone (adding its VTIMEZONE to cal if missing), else UTC. A nil t removes
// the property.
func setSeriesDate(cal *ical.Calendar, c *ical.Component, name string, t *time.Time, allDay bool, tzid string) {
	if t == nil {
		c.Props.Del(name)
		return
	}
	var loc *time.Location
	if !allDay && tzid != "" {
		loc = loadLocation(tzid)
	}
	c.Props.Set(newDateProp(name, *t, allDay, loc))
	if loc != nil && loc != time.UTC {
		ensureVTimezone(cal, loc, t.In(loc).Year())
	}
}
