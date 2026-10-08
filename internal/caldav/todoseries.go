package caldav

import (
	"cmp"
	"errors"
	"fmt"
	"slices"
	"strconv"
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

// propDetachedFrom is the property of a todo that was detached from a series:
// the UID of that series. Lucid writes it only when it detaches a repeat, and
// drops it when the todo gets a rule of its own (FR-17).
const propDetachedFrom = "X-LUCID-DETACHED-FROM"

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
	// errMoveOntoRepeat refuses a move of a task series that puts one of its
	// repeats on one another app already changed, see keepApart (FR-17).
	errMoveOntoRepeat = fmt.Errorf("%w: the move puts a repeat on one another app already changed",
		domain.ErrSeriesMoveUnsupported)
)

// todoSeries is a recurring VTODO and what other clients recorded in it, as
// read (FR-17): roll and move rewrite the master, and decide on the series
// they were read from, never on a master they have already written.
type todoSeries struct {
	master      *ical.Component
	rrule       string         // RRULE as read (trimmed), "" if none
	anchor      dateValue      // DTSTART, or DUE without DTSTART
	onDue       bool           // anchored on DUE
	startAllDay bool           // master DTSTART value type (only meaningful when set)
	dueAllDay   bool           // master DUE (or DURATION-derived) value type
	startForm   dateForm       // how DTSTART is written; DUE's form when anchored on DUE
	dueForm     dateForm       // how DUE is written; DTSTART's form without DUE
	dueOffset   *time.Duration // DUE (or DURATION) − DTSTART when both exist
	// overrides holds one override per RECURRENCE-ID Lucid can read, in
	// RECURRENCE-ID order. atRid and onDay find the override of a rule
	// instance, exdates and exdays its EXDATE: by instant for the anchor's
	// value type, by date for the other (see seriesOverride).
	overrides []seriesOverride
	atRid     map[int64]*ical.Component     // the anchor's value type, by instant (Unix)
	onDay     map[time.Time]*ical.Component // the other value type, by date
	exdates   map[int64]bool                // the anchor's value type, by instant (Unix)
	exdays    map[time.Time]bool            // the other value type, by date
	pending   time.Time                     // X-KDE-LIBKCAL-DTRECURRENCE, zero if absent
	fixedDays bool
	err       error // non-nil: the rule cannot be evaluated
}

// seriesOverride is an override of a series, with the place of its
// RECURRENCE-ID (FR-17). RFC 5545 wants a RECURRENCE-ID and an EXDATE in the
// anchor's value type, and they match an instance at the same instant, in
// whatever form they are written. One of the other value type, a date in a
// timed series or a date-time in an all-day one, stands for the instance on
// its date in the series' zone, the date it is written with (A-11): day is
// that date, and rid that day at the anchor's time of day.
type seriesOverride struct {
	c   *ical.Component
	rid time.Time
	day time.Time // zero for the anchor's value type
}

// todoOcc is one occurrence: rid is its original start; start/due its effective
// dates, with the value type (date or date-time) they were read with (FR-16, FR-17).
type todoOcc struct {
	rid                    time.Time
	start, due             *time.Time
	startAllDay, dueAllDay bool
	done                   bool            // completed by an override
	override               *ical.Component // nil for rule-generated occurrences
	// offGrid marks an override off the rule (A-10): its RECURRENCE-ID lies
	// from the anchor on and before the rule's last instance, but on none
	// of them, as a move of an interval series to an earlier day leaves the
	// overrides of the occurrences it moves back past.
	offGrid bool
}

// newTodoSeries reads the series of master in cal. It returns nil when master
// has neither RRULE nor RDATE.
func newTodoSeries(cal *ical.Calendar, master *ical.Component) *todoSeries {
	if !isRecurring(master) {
		return nil
	}
	rr := rruleString(master)
	s := &todoSeries{
		master:    master,
		rrule:     rr,
		atRid:     map[int64]*ical.Component{},
		onDay:     map[time.Time]*ical.Component{},
		exdates:   map[int64]bool{},
		exdays:    map[time.Time]bool{},
		fixedDays: ruleHasFixedDays(rr, master.Props.Get(ical.PropRecurrenceDates) != nil),
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
	switch {
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
		rid, err := parseDateProp(c.Props.Get(ical.PropRecurrenceID))
		switch {
		case err != nil:
		case rid.allDay == s.anchor.allDay:
			s.atRid[rid.t.Unix()] = c
		default:
			s.onDay[civilDate(rid.t)] = c
		}
	}
	for u, c := range s.atRid {
		s.overrides = append(s.overrides, seriesOverride{c: c, rid: time.Unix(u, 0).UTC()})
	}
	for day, c := range s.onDay {
		// Overrides of both value types for one repeat: the anchor's wins,
		// as in occurrence.
		if rid := s.ridOn(day); s.atRid[rid.Unix()] == nil {
			s.overrides = append(s.overrides, seriesOverride{c: c, rid: rid, day: day})
		}
	}
	slices.SortFunc(s.overrides, func(a, b seriesOverride) int { return a.rid.Compare(b.rid) })
	for _, p := range master.Props.Values(ical.PropExceptionDates) {
		dvs, err := parseDateList(&p)
		if err != nil {
			continue
		}
		for _, d := range dvs {
			if d.allDay == s.anchor.allDay {
				s.exdates[d.t.Unix()] = true
			} else {
				s.exdays[civilDate(d.t)] = true
			}
		}
	}
	if d, err := parseDateProp(master.Props.Get(propKDEPending)); err == nil {
		s.pending = d.t
	}
	return s
}

// ridOf returns the RECURRENCE-ID of the override o as placeRef places it:
// by instant in the anchor's value type, else by the date it is written
// with (A-11).
func (s *todoSeries) ridOf(o seriesOverride) dateValue {
	if o.day.IsZero() {
		return dateValue{t: o.rid, allDay: s.anchor.allDay}
	}
	return dateValue{t: o.day, allDay: !s.anchor.allDay}
}

// dayOf returns the date of the instant t in the series' zone (A-11).
func (s *todoSeries) dayOf(t time.Time) time.Time {
	return civilDate(t.In(s.anchor.loc()))
}

// ridOn returns the instant an instance on day would have: day at the
// anchor's time of day in the series' zone, or day itself in an all-day
// series (A-11).
func (s *todoSeries) ridOn(day time.Time) time.Time {
	if s.anchor.allDay {
		return day
	}
	loc := s.anchor.loc()
	a := s.anchor.t.In(loc)
	y, m, d := day.Date()
	return time.Date(y, m, d, a.Hour(), a.Minute(), a.Second(), 0, loc)
}

// place compares where the override o lies with the rule instance t: by
// instant, or by date in the series' zone when o's RECURRENCE-ID has the
// other value type (A-11).
func (s *todoSeries) place(o seriesOverride, t time.Time) int {
	if o.day.IsZero() {
		return o.rid.Compare(t)
	}
	return o.day.Compare(s.dayOf(t))
}

// placeRef compares where d, a RECURRENCE-ID or EXDATE value as written,
// lies with the rule instance t, as place does (A-11): a value of the other
// value type by its date. A date is midnight UTC, so west of UTC its instant
// lies before an instance on the day before it.
func (s *todoSeries) placeRef(d dateValue, t time.Time) int {
	if d.allDay == s.anchor.allDay {
		return d.t.Compare(t)
	}
	return civilDate(d.t).Compare(s.dayOf(t))
}

// refsFrom returns whether a RECURRENCE-ID or EXDATE value lies on or after
// the rule instance t, as placeRef places it: what a new rule from t on
// replaces (FR-17).
func (s *todoSeries) refsFrom(t time.Time) func(d dateValue) bool {
	return func(d dateValue) bool { return s.placeRef(d, t) >= 0 }
}

// zoneKnown reports whether Lucid knows the zone the anchor of s is written
// in, see knownZone (FR-17).
func (s *todoSeries) zoneKnown() bool {
	return knownZone(s.anchor)
}

// knownZone reports whether Lucid knows the zone d is written in: it has no
// TZID, or one Lucid resolves (FR-17). Lucid reads the wall clock of any
// other TZID as UTC, so an instant it derives from d, such as an UNTIL,
// would be off by the zone's offset.
func knownZone(d dateValue) bool {
	return d.param == "" || d.tzid != ""
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

// rulePart returns the value of the part key (upper case) of rrule, as
// written, or "" if it has none.
func rulePart(rrule, key string) string {
	for part := range strings.SplitSeq(rrule, ";") {
		if rulePartKey(part) == key {
			_, v, _ := strings.Cut(part, "=")
			return strings.TrimSpace(v)
		}
	}
	return ""
}

// ruleIterator returns an iterator over the occurrences the rule of s
// yields, in order, see ruleInstances (FR-17): the anchor, then the rule's
// instances after it, the anchor counting against a COUNT also where the
// rule does not match it. It fails when the rule cannot be evaluated, a
// series with RDATE included.
//
// walk, instancesBefore and ruleEnd all count with it, so that a write
// (roll, move) counts the occurrences as Lucid reads them.
func (s *todoSeries) ruleIterator() (next func() (time.Time, bool), err error) {
	if s.err != nil {
		return nil, s.err
	}
	return ruleInstances(s.rrule, s.anchor.t)
}

// walk calls fn for the occurrences with rid >= from, in order, until fn
// returns false: those of ruleIterator, without EXDATEs and cancelled
// overrides, and the overrides off the rule (FR-17). An override off the
// rule (see todoOcc.offGrid) comes in RECURRENCE-ID order among the rule's
// instances, as an occurrence of its own, without counting against a COUNT
// (A-10); one past the rule's last instance lies past its end, and walk
// leaves it out. It fails when the rule cannot be evaluated (a series with
// RDATE included) or hits maxRRuleIterations before fn stops.
func (s *todoSeries) walk(from time.Time, fn func(todoOcc) bool) error {
	next, err := s.ruleIterator()
	if err != nil {
		return err
	}
	// The overrides from `from` on, until an instance reaches them: those of
	// the anchor's value type by instant, the others by date (see place).
	var byInstant, byDate []seriesOverride
	for _, o := range s.overrides {
		switch {
		case s.place(o, from) < 0:
		case o.day.IsZero():
			byInstant = append(byInstant, o)
		default:
			byDate = append(byDate, o)
		}
	}
	// The rule advances lazily, so that fn can stop before the next
	// iteration counts against the cap.
	for steps := 0; ; steps++ {
		if steps == maxRRuleIterations {
			return errRRuleCap
		}
		t, ok := next()
		if !ok {
			return nil
		}
		// An override an instance passes without matching it is off the rule.
		var offGrid []seriesOverride
		for ; len(byInstant) > 0 && s.place(byInstant[0], t) <= 0; byInstant = byInstant[1:] {
			if s.place(byInstant[0], t) < 0 {
				offGrid = append(offGrid, byInstant[0])
			}
		}
		for ; len(byDate) > 0 && s.place(byDate[0], t) <= 0; byDate = byDate[1:] {
			if s.place(byDate[0], t) < 0 {
				offGrid = append(offGrid, byDate[0])
			}
		}
		if t.Before(from) { // offGrid is empty: the overrides lie from `from` on
			continue
		}
		slices.SortFunc(offGrid, func(a, b seriesOverride) int { return a.rid.Compare(b.rid) })
		for _, o := range offGrid {
			if occ, ok := s.overrideOcc(o); ok {
				occ.offGrid = true
				if !fn(occ) {
					return nil
				}
			}
		}
		if occ, ok := s.occurrence(t); ok && !fn(occ) {
			return nil
		}
	}
}

// occurrence returns the rule's occurrence at the instance rid, or false if
// it is excluded or cancelled. Its override and EXDATE are those at rid's
// instant, or of the other value type, on rid's date (A-11).
func (s *todoSeries) occurrence(rid time.Time) (todoOcc, bool) {
	day := s.dayOf(rid)
	if s.exdates[rid.Unix()] || s.exdays[day] {
		return todoOcc{}, false
	}
	ov := s.atRid[rid.Unix()]
	if ov == nil {
		ov = s.onDay[day]
	}
	return s.occurrenceWith(rid, ov)
}

// overrideOcc returns the occurrence of the override o at the instant of its
// RECURRENCE-ID (for the other value type: on its date, see
// seriesOverride), or false if it is excluded there or cancelled (FR-17).
func (s *todoSeries) overrideOcc(o seriesOverride) (todoOcc, bool) {
	day := o.day
	if day.IsZero() {
		day = s.dayOf(o.rid)
	}
	if s.exdates[o.rid.Unix()] || s.exdays[day] {
		return todoOcc{}, false
	}
	return s.occurrenceWith(o.rid, o.c)
}

// occurrenceWith returns the occurrence at rid with the override ov (nil if
// none), or false if ov cancels it.
func (s *todoSeries) occurrenceWith(rid time.Time, ov *ical.Component) (todoOcc, bool) {
	occ := todoOcc{rid: rid, override: ov, startAllDay: s.startAllDay, dueAllDay: s.dueAllDay}
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

// reported returns the occurrence whose dates a todo read from s with the
// given status reports (see setSeries): the current occurrence of an open
// series, else one at the anchor, of which only rid is set (FR-17). last
// reports whether it is the series' last open occurrence: open itself, with
// no open one after it.
func (s *todoSeries) reported(status string) (occ todoOcc, last bool) {
	if status != domain.TodoCompleted && status != domain.TodoCancelled {
		if cur, next, err := s.current(); err == nil && !cur.rid.IsZero() {
			return cur, !cur.done && next == nil
		}
	}
	return todoOcc{rid: s.anchor.t}, false
}

// setSeries fills the series fields of t, a todo read from s.master, and
// moves an open series to its current occurrence, with that occurrence's own
// value types (FR-16, FR-17): an override can carry a value type that
// differs from the master's, and the current and next occurrence each keep
// their own rather than the master's. A completed or cancelled master, a
// rule Lucid cannot evaluate and a series without any occurrence left keep
// the master's dates. An open current occurrence also gives its
// RECURRENCE-ID, by which a client names it: the task list shows no
// occurrences.
func (s *todoSeries) setSeries(t *domain.Todo) {
	t.RRule, t.Recurring, t.FixedDays = s.rrule, true, s.fixedDays
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
	t.StartAllDay, t.DueAllDay = cur.startAllDay, cur.dueAllDay
	if !cur.done {
		// The repeat the writes to one repeat name, as the listing does.
		t.RecurrenceID = utcPtr(&cur.rid)
	}
	if next != nil {
		t.Next = &domain.TodoDates{
			Start: utcPtr(next.start), StartAllDay: next.startAllDay,
			Due: utcPtr(next.due), DueAllDay: next.dueAllDay,
		}
	}
}

// occAnchorAllDay reports whether the anchor of o (see occAnchor) is a date.
func occAnchorAllDay(o todoOcc) bool {
	if o.start != nil {
		return o.startAllDay
	}
	return o.dueAllDay
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
// KDE's pending occurrence go. In a zone Lucid cannot resolve (see
// zoneKnown) that UNTIL would be off by the zone's offset, so the COUNT
// stays instead, lowered by the occurrences before next, which the new
// DTSTART on the rule leaves behind. It fails, without changing anything,
// when the rule cannot be evaluated to its end (up to next for a COUNT that
// stays).
//
// Next's override, if any, stays and keeps moving that occurrence: the
// master takes the rule's dates (next.rid), not the override's, or the whole
// series would shift with it. Next is an instance of the rule: the master
// cannot take the place of an occurrence off it (see todoOcc.offGrid)
// without moving the rule. Cur can lie off it: everything between cur and
// next is done, and cur's override goes like any other (A-10).
func (s *todoSeries) roll(cal *ical.Calendar, cur, next todoOcc) error {
	c := s.master
	if p := c.Props.Get(ical.PropRecurrenceRule); p != nil && hasRulePart(s.rrule, "COUNT") {
		if !s.zoneKnown() {
			before, err := s.instancesBefore(next.rid)
			if err != nil {
				return err
			}
			p.Value = lowerCount(s.rrule, before)
		} else {
			last, err := s.ruleEnd()
			if err != nil {
				return err
			}
			p.Value = countToUntil(s.rrule, last, s.startForm)
		}
	}
	s.anchorAt(cal, next.rid)
	dropOccurrence(cal, c, cur)
	c.Props.Del(propKDEPending)
	return nil
}

// rollPast rolls the series s past its current occurrence cur, which leaves
// it, completed, detached or skipped, to next, the next open one (FR-17, A-10):
// the master rolls onto next (see roll), also from an occurrence off the rule
// (see todoOcc.offGrid), whose override goes with the roll. When next lies off
// the rule, the master stays where it is: cur, off the rule, only loses its
// override, and cur, an instance, gets an EXDATE (see exclude). It fails with
// errRuleUnsupported, leaving cal as it was, when the rule cannot be evaluated
// as roll needs it.
func (s *todoSeries) rollPast(cal *ical.Calendar, cur, next todoOcc) error {
	switch {
	case next.offGrid && cur.offGrid:
		dropOccurrence(cal, s.master, cur)
	case next.offGrid:
		s.exclude(cal, cur)
	default:
		if err := s.roll(cal, cur, next); err != nil {
			return errRuleUnsupported
		}
	}
	return nil
}

// exclude excludes the completed rule instance occ of s, whose next
// occurrence lies off the rule, where the master cannot roll (FR-17, A-10):
// an EXDATE in the form the anchor is written in, and occ's override goes.
// The first later completion whose next occurrence is an instance rolls the
// master past it.
func (s *todoSeries) exclude(cal *ical.Calendar, occ todoOcc) {
	s.master.Props.Add(seriesDateProp(cal, ical.PropExceptionDates, occ.rid, s.startForm))
	dropOccurrence(cal, s.master, occ)
}

// anchorAt writes the master's DTSTART and DUE for the rule date t, in the
// form they are written in (FR-17): DUE keeps its distance to DTSTART, and
// a series anchored on DUE gets DTSTART = DUE, as RFC 5545 wants DTSTART
// with RRULE.
func (s *todoSeries) anchorAt(cal *ical.Calendar, t time.Time) {
	c := s.master
	setSeriesDate(cal, c, ical.PropDateTimeStart, &t, s.startForm)
	if s.onDue {
		setSeriesDate(cal, c, ical.PropDue, &t, s.dueForm)
		c.Props.Del(ical.PropDuration) // invalid without DTSTART; DUE stands
	} else if c.Props.Get(ical.PropDue) != nil && s.dueOffset != nil {
		// A DURATION stays: it is relative to DTSTART.
		due := t.Add(*s.dueOffset)
		setSeriesDate(cal, c, ical.PropDue, &due, s.dueForm)
	}
}

// move moves the series s from the occurrence a todo with the given status
// reports (see reported) to the dates of in (FR-10, FR-17), so that the
// moved occurrence is the current one and the later ones move with it:
//   - the dates become DTSTART and DUE in the form the series is written in;
//   - the override of the moved occurrence and KDE's pending occurrence go;
//   - the rule follows as seriesShift says, from the moved occurrence's rule
//     date to the new DTSTART, both on the wall clock of the series' zone: a
//     weekly rule's days rotate with the move, any other rule on fixed days
//     moves only within its day, and only to another time of day where it
//     fixes none. A move it cannot follow is errMoveFixedDays;
//   - a COUNT no longer counts the occurrences before the moved one, which
//     the new DTSTART, on the rule, leaves behind;
//   - an UNTIL from the moved occurrence on and the references to later
//     occurrences (their overrides with their dates, EXDATEs) move by the
//     whole distance, see refShift and movedRule, as the rule's later
//     instances move; earlier ones, such as other apps' completions, stay,
//     but an EXDATE among them from the new DTSTART on goes: it excluded an
//     occurrence the series left behind, not one of the moved series;
//   - a move that adds or removes the time moves them by its change in
//     date only (see refShift), then rewrites UNTIL and the references in
//     the new value type, see retypeRefs;
//   - an UNTIL before the new DTSTART moves onto it.
//
// The series' last open occurrence moves to any date instead, on fixed days
// too: seriesShift does not decide, and the rule ends there, see endAt, so
// that it stays the only one. Its references stay where they are, but an
// EXDATE from the new DTSTART on goes, as it could only exclude the moved
// occurrence. A current occurrence another app moved, off the rule (see
// todoOcc.offGrid) or shown away from its RECURRENCE-ID by its override (see
// shownElsewhere), moves the series by the distance it moves from where it
// is shown instead, as moveShown says; its override moves along. A rule
// Lucid cannot evaluate (of a completed series) only gets its dates moved,
// and its references converted.
//
// It fails, leaving cal as it was, when in has no date, the rule cannot
// follow the move, the rule cannot be walked up to the moved occurrence, or
// the move puts an occurrence of the series on one that an override it left
// in place holds, see keepApart.
//
// Where the moved occurrence lies in the series (the instances before it)
// is decided on the series as read, s: once shifted, the rewritten rule no
// longer says where the moved occurrence lay.
func (s *todoSeries) move(cal *ical.Calendar, status string, in domain.TodoInput) error {
	saved := saveCalendar(cal)
	stayed, err := s.applyMove(cal, status, in)
	if err == nil {
		err = s.keepApart(cal, stayed)
	}
	if err != nil {
		saved.restore(cal)
	}
	return err
}

// applyMove applies the move of move to cal and returns the overrides it
// left in place, neither moved nor dropped, for keepApart (FR-17).
func (s *todoSeries) applyMove(cal *ical.Calendar, status string, in domain.TodoInput) ([]*ical.Component, error) {
	start, form := seriesStart(s.master, in, true)
	if start == nil {
		return nil, errRuleNeedsDate
	}
	c := s.master
	p := c.Props.Get(ical.PropRecurrenceRule)
	evaluable := p != nil && s.err == nil && s.rrule != ""
	occ, last := s.reported(status)
	last = last && evaluable
	if evaluable && !last && (occ.offGrid || shownElsewhere(occ)) {
		return s.moveShown(cal, occ, in)
	}
	rid := occ.rid
	to, _ := parseDateProp(seriesDateProp(nil, ical.PropDateTimeStart, *start, form)) // as writeSeriesDates writes it
	rule, before := s.rrule, 0
	if evaluable && !last {
		var ok bool
		if rule, ok = seriesShift(rule, rid.In(s.anchor.loc()), to.t.In(to.loc())); !ok {
			return nil, errMoveFixedDays
		}
		var err error
		if before, err = s.instancesBefore(rid); err != nil {
			return nil, errRuleUnsupported
		}
	}
	// What the move leaves in place: on the last occurrence everything, else
	// what refers to the moved occurrence and those before it. Of that, an
	// EXDATE from the new DTSTART on goes. A rule Lucid cannot evaluate keeps
	// its references, as it has no occurrences to tell them by.
	stays := func(d dateValue) bool { return last || s.placeRef(d, rid) <= 0 }
	var stayed []*ical.Component
	if evaluable {
		stayed = s.overridesWhere(cal, stays)
		dropExdates(c, func(d dateValue) bool { return stays(d) && notBefore(d, to) })
	}
	writeSeriesDates(cal, c, in, true)
	var shift func(dateValue) time.Time
	if evaluable && !last {
		shift = s.refShift(rid, to)
		p.Value = movedRule(rule, before, rid, shift)
	}
	dropOccurrence(cal, c, occ)
	c.Props.Del(propKDEPending)
	if shift != nil {
		s.shiftRefs(cal, func(d dateValue) bool { return s.placeRef(d, rid) > 0 }, shift)
	}
	s.retypeRefs(cal, to)
	// The last occurrence ends the rule; else UNTIL never ends before the
	// moved series starts, compared in the value type and zone the series
	// now has.
	switch loc := to.loc(); {
	case last:
		p.Value = endAt(p.Value, to)
	case evaluable && untilBefore(p.Value, to.t, loc):
		p.Value = untilAt(p.Value, to.t, loc)
	}
	return stayed, nil
}

// moveShown moves the series s, whose current occurrence occ another app
// moved, by the distance occ moves from where it is shown (its start, else
// its due) to the dates of in, as an event series moves from an exception
// (FR-17): occ lies off the rule (see todoOcc.offGrid), or its override
// shows it away from its RECURRENCE-ID (see shownElsewhere). The rule moves
// by that distance from its instance prev, as move moves it from an
// occurrence: its days as seriesShift says, from prev to prev moved, both on
// the wall clock of the series' zone, its COUNT and UNTIL, and the later
// references by the whole distance, occ's override among them, which then
// takes the dates of in.
//
// For an instance of the rule, prev is occ's RECURRENCE-ID, so that a change
// of its time alone keeps the rule's days, and occ's override moves from
// there. An occurrence off the rule is none of the rule's instances, so the
// rule cannot be anchored on it, or a rule on fixed days would start off its
// days and an interval rule would recur from another day; prev is its last
// instance before occ instead, done, excluded or cancelled, as occ is
// current: its EXDATE moves along to the new anchor, or an EXDATE there
// keeps it out, and an override of it stays where it is. The references
// before prev stay, but for an EXDATE from the new anchor on, as in move.
//
// An occurrence shown in the series' value type that in moves between a date
// and a time changes the series' value type, as a move of any current
// occurrence does: the master takes in's dates moved onto the date of prev
// moved (see datesOn), the move between a date and a time moving the rule
// and the references by its change in date only, and then the references
// convert, earlier ones too, see retypeRefs. One another app already shows in
// the other value type keeps the series' type. A move that keeps occ's start
// (else due), such as a change of its due alone, changes occ's dates only.
// It returns the overrides it left in place, for keepApart, and fails,
// without changing anything, as move does.
func (s *todoSeries) moveShown(cal *ical.Calendar, occ todoOcc, in domain.TodoInput) ([]*ical.Component, error) {
	// Without a start, DTSTART = DUE, as for the series.
	moved := todoOcc{start: in.Start, startAllDay: in.StartAllDay, due: in.Due, dueAllDay: in.DueAllDay}
	if moved.start == nil {
		moved.start, moved.startAllDay = in.Due, in.DueAllDay
	}
	loc := s.anchor.loc()
	shown := dateValue{t: occAnchor(occ).In(loc), allDay: occAnchorAllDay(occ)}
	dest := dateValue{t: occAnchor(moved).In(loc), allDay: occAnchorAllDay(moved)}
	retype := shown.allDay == s.anchor.allDay && dest.allDay != s.anchor.allDay
	shift := s.shiftBetween(shown, dest)
	if shift == nil && !retype {
		s.setEntryDates(occ.override, moved)
		return nil, nil
	}
	prev, before, err := s.movedFrom(occ)
	if err != nil {
		return nil, errRuleUnsupported
	}
	to := prev.In(loc)
	if shift != nil {
		to = shift(dateValue{t: to, allDay: s.anchor.allDay})
	}
	// The master's new DTSTART, as written: to, or, retyped, in's start
	// (else due) on to's date.
	start := dateValue{t: to.In(loc), allDay: s.anchor.allDay}
	var dates domain.TodoInput
	if retype {
		dates = datesOn(in, civilDate(to.In(loc)))
		t, form := seriesStart(s.master, dates, true)
		start, _ = parseDateProp(seriesDateProp(nil, ical.PropDateTimeStart, *t, form))
	}
	rule, ok := seriesShift(s.rrule, prev.In(loc), start.t.In(start.loc()))
	if !ok {
		return nil, errMoveFixedDays
	}
	c := s.master
	// What moves: the references after prev, and those of occ itself where
	// prev is its RECURRENCE-ID.
	moves := func(d dateValue) bool {
		at := s.placeRef(d, prev)
		return at > 0 || at == 0 && !occ.offGrid
	}
	stays := func(d dateValue) bool { return !moves(d) }
	stayed := s.overridesWhere(cal, stays)
	anchor := dateValue{t: to, allDay: s.anchor.allDay}
	dropExdates(c, func(d dateValue) bool {
		return stays(d) && (s.placeRef(d, prev) == 0 || notBefore(d, anchor))
	})
	if retype {
		writeSeriesDates(cal, c, dates, true)
	} else {
		s.anchorAt(cal, to)
	}
	c.Props.Get(ical.PropRecurrenceRule).Value = movedRule(rule, before, prev, shift)
	c.Props.Del(propKDEPending)
	if shift != nil {
		s.shiftRefs(cal, moves, shift)
	}
	if occ.offGrid {
		c.Props.Add(seriesDateProp(cal, ical.PropExceptionDates, to, s.startForm))
	}
	entry := s
	if retype {
		s.retypeRefs(cal, start)
		// occ's override takes in's dates in the forms the series has now.
		entry = newTodoSeries(cal, c)
	}
	entry.setEntryDates(occ.override, moved)
	return stayed, nil
}

// datesOn returns in with its dates moved onto day, a date, by whole days,
// for a series retyped from an occurrence shown on another day (FR-17): its
// start, else its due, falls on day at its own wall-clock time in the zone of
// in (UTC for a date, see seriesForm), and the due keeps its distance to it.
func datesOn(in domain.TodoInput, day time.Time) domain.TodoInput {
	anchor, allDay := in.Start, in.StartAllDay
	if anchor == nil {
		anchor, allDay = in.Due, in.DueAllDay
	}
	zone := time.UTC
	if l := loadLocation(in.Timezone); l != nil && !allDay {
		zone = l
	}
	days := int(day.Sub(civilDate(anchor.In(zone))) / (24 * time.Hour))
	move := func(t *time.Time) *time.Time {
		if t == nil {
			return nil
		}
		m := t.In(zone).AddDate(0, 0, days)
		return &m
	}
	in.Start, in.Due = move(in.Start), move(in.Due)
	return in
}

// movedFrom returns the instance of the rule of s that moveShown moves the
// series from for its current occurrence occ, and the number of the rule's
// occurrences before it, counted as instancesBefore counts them (FR-17):
// occ's RECURRENCE-ID for an instance of the rule; for an occurrence off
// the rule, which lies after the anchor, an instance, the rule's last
// instance before it. It fails when the rule cannot be walked that far.
func (s *todoSeries) movedFrom(occ todoOcc) (prev time.Time, before int, err error) {
	if !occ.offGrid {
		before, err = s.instancesBefore(occ.rid)
		return occ.rid, before, err
	}
	prev, n, err := s.lastBefore(occ.rid)
	if err == nil && n == 0 {
		err = errRuleUnsupported // the anchor, an instance, comes before occ
	}
	return prev, n - 1, err
}

// shownElsewhere reports whether the override of the occurrence occ shows
// it away from its RECURRENCE-ID, at another start (else due), as another
// app moves one repeat (FR-17).
func shownElsewhere(occ todoOcc) bool {
	return occ.override != nil && !occAnchor(occ).Equal(occ.rid)
}

// keepApart refuses with errMoveOntoRepeat a move of the series s, as
// applied to cal, that put one of its occurrences on the RECURRENCE-ID of
// an override in stayed, one the move left in place (FR-17): on an instance
// of the moved rule, the moved occurrence's own included, that override
// would take over a repeat it never belonged to, such as another app's
// completion marking it done; on the RECURRENCE-ID of an override the move
// moved, two overrides would hold one repeat. An override in stayed that
// lies on neither, as a done one a move to an earlier day goes back past,
// stays as history off the rule (A-10).
func (s *todoSeries) keepApart(cal *ical.Calendar, stayed []*ical.Component) error {
	if len(stayed) == 0 {
		return nil
	}
	ns := newTodoSeries(cal, s.master) // a rule it cannot walk fails below
	if ns == nil {
		return nil
	}
	left := make(map[*ical.Component]bool, len(stayed))
	for _, o := range stayed {
		left[o] = true
	}
	var stays, moved []dateValue
	for _, o := range cal.Children {
		if o == s.master || o.Name != s.master.Name {
			continue
		}
		rid, err := parseDateProp(o.Props.Get(ical.PropRecurrenceID))
		switch {
		case err != nil:
		case left[o]:
			stays = append(stays, rid)
		default:
			moved = append(moved, rid)
		}
	}
	for _, u := range stays {
		for _, m := range moved {
			if ns.sameRepeat(u, m) {
				return errMoveOntoRepeat
			}
		}
		on, err := ns.onInstance(u)
		switch {
		case err != nil:
			return errRuleUnsupported
		case on:
			return errMoveOntoRepeat
		}
	}
	return nil
}

// onInstance reports whether d, a RECURRENCE-ID, lies on an instance of the
// rule of s, placed by placeRef: one ruleIterator yields, also where an
// EXDATE excludes it (FR-17).
func (s *todoSeries) onInstance(d dateValue) (bool, error) {
	next, err := s.ruleIterator()
	if err != nil {
		return false, err
	}
	for range maxRRuleIterations {
		t, ok := next()
		if !ok {
			return false, nil
		}
		switch c := s.placeRef(d, t); {
		case c == 0:
			return true, nil
		case c < 0:
			return false, nil
		}
	}
	return false, errRRuleCap
}

// sameRepeat reports whether the RECURRENCE-IDs a and b stand for one
// occurrence of s: the same instant in the anchor's value type, else the
// same date in the series' zone (A-11).
func (s *todoSeries) sameRepeat(a, b dateValue) bool {
	if a.allDay == s.anchor.allDay && b.allDay == s.anchor.allDay {
		return a.t.Equal(b.t)
	}
	return s.refDate(a).Equal(s.refDate(b))
}

// refDate returns the date a RECURRENCE-ID or EXDATE value d stands for, as
// placeRef places it: of the anchor's value type, its date in the series'
// zone; of the other, the date it is written with (A-11).
func (s *todoSeries) refDate(d dateValue) time.Time {
	if d.allDay == s.anchor.allDay {
		return s.dayOf(d.t)
	}
	return civilDate(d.t)
}

// overridesWhere returns the overrides of the master of s in cal whose
// RECURRENCE-ID keep reports (FR-17).
func (s *todoSeries) overridesWhere(cal *ical.Calendar, keep func(rid dateValue) bool) []*ical.Component {
	var out []*ical.Component
	for _, o := range cal.Children {
		if o == s.master || o.Name != s.master.Name {
			continue
		}
		if rid, err := parseDateProp(o.Props.Get(ical.PropRecurrenceID)); err == nil && keep(rid) {
			out = append(out, o)
		}
	}
	return out
}

// notBefore reports whether the date value d does not lie before to: by
// instant for the same value type, else by date, each in its own zone
// (FR-17).
func notBefore(d, to dateValue) bool {
	if d.allDay == to.allDay {
		return !d.t.Before(to.t)
	}
	return !civilDate(d.t.In(d.loc())).Before(civilDate(to.t.In(to.loc())))
}

// dropExdates removes the EXDATE values of master that drop reports, as
// written, and an EXDATE property it leaves without values; a value Lucid
// cannot read stays, but an empty one, which is none, goes (FR-17).
func dropExdates(master *ical.Component, drop func(dateValue) bool) {
	props := master.Props[ical.PropExceptionDates]
	if len(props) == 0 {
		return
	}
	kept := props[:0]
	for _, p := range props {
		var vals []string
		for v := range strings.SplitSeq(p.Value, ",") {
			at, _, _ := strings.Cut(strings.TrimSpace(v), "/")
			if at == "" {
				continue
			}
			if d, err := parseDateValue(at, p.Params); err == nil && drop(d) {
				continue
			}
			vals = append(vals, v)
		}
		if len(vals) > 0 {
			p.Value = strings.Join(vals, ",")
			kept = append(kept, p)
		}
	}
	if len(kept) == 0 {
		master.Props.Del(ical.PropExceptionDates)
		return
	}
	master.Props[ical.PropExceptionDates] = kept
}

// calendarState is what a move of a series can change in a calendar: the
// list of its components, and the properties of each, so that a move
// refused after it was applied leaves the calendar as it was (FR-17).
type calendarState struct {
	children []*ical.Component
	props    map[*ical.Component]ical.Props
}

// saveCalendar returns the state of cal, see calendarState.
func saveCalendar(cal *ical.Calendar) calendarState {
	st := calendarState{children: slices.Clone(cal.Children), props: make(map[*ical.Component]ical.Props, len(cal.Children))}
	for _, c := range cal.Children {
		props := make(ical.Props, len(c.Props))
		for name, ps := range c.Props {
			props[name] = cloneProps(ps)
		}
		st.props[c] = props
	}
	return st
}

// restore puts cal back into the state st.
func (st calendarState) restore(cal *ical.Calendar) {
	cal.Children = st.children
	for c, props := range st.props {
		c.Props = props
	}
}

// instancesBefore returns the number of occurrences of the rule of s before
// t, counted as walk and ruleEnd count them (see ruleIterator): an anchor
// off the rule counts too, as it does against a COUNT (FR-17).
func (s *todoSeries) instancesBefore(t time.Time) (int, error) {
	_, n, err := s.lastBefore(t)
	return n, err
}

// lastBefore returns the last occurrence of the rule of s before t, zero if
// none, and the number of occurrences before t, prev included, counted as
// instancesBefore counts them (FR-17).
func (s *todoSeries) lastBefore(t time.Time) (prev time.Time, before int, err error) {
	next, err := s.ruleIterator()
	if err != nil {
		return time.Time{}, 0, err
	}
	for n := range maxRRuleIterations {
		i, ok := next()
		if !ok || !i.Before(t) {
			return prev, n, nil
		}
		prev = i
	}
	return time.Time{}, 0, errRRuleCap
}

// refShift returns how moving the occurrence rid to to, the new anchor as
// written, moves the references to later occurrences, see shiftBetween
// (FR-17).
func (s *todoSeries) refShift(rid time.Time, to dateValue) func(dateValue) time.Time {
	return s.shiftBetween(dateValue{t: rid.In(s.anchor.loc()), allDay: s.anchor.allDay}, to)
}

// shiftBetween returns how a move from `from` to `to` moves the values of
// the series s, or nil when they stay (FR-17): in the wall clock of the
// series, as the rule's instances move, by whole periods too. A monthly or
// yearly interval rule moves them by its calendar months and then days,
// whose instances keep their day of the month; any other rule by its
// calendar days, where a weekly rule on fixed days rotates its days with
// them (see seriesShift, which lets any other rule on fixed days move within
// the day only).
//
// A move between a date and a time moves them by its change in date only,
// from from's date to to's, each in its own zone: the series' for a time of
// the series. They keep their value type, which retypeRefs changes
// afterwards, setting the time of day.
func (s *todoSeries) shiftBetween(from, to dateValue) func(dateValue) time.Time {
	loc := s.anchor.loc()
	start, dest := from.t.In(from.loc()), to.t.In(to.loc())
	var months, days, secs int
	switch strings.ToUpper(rulePart(s.rrule, "FREQ")) {
	case "MONTHLY", "YEARLY":
		months = (dest.Year()-start.Year())*12 + int(dest.Month()) - int(start.Month())
		days = dest.Day() - start.Day()
	default:
		days = int(civilDate(dest).Sub(civilDate(start)) / (24 * time.Hour))
	}
	if from.allDay == to.allDay {
		secs = secondOfDay(dest) - secondOfDay(start)
	}
	if months == 0 && days == 0 && secs == 0 {
		return nil
	}
	return func(d dateValue) time.Time {
		if d.allDay {
			return d.t.AddDate(0, months, days)
		}
		w := d.t.In(loc)
		return time.Date(w.Year(), w.Month()+time.Month(months), w.Day()+days,
			w.Hour(), w.Minute(), w.Second()+secs, w.Nanosecond(), loc)
	}
}

// civilDate returns midnight UTC of t's date in its own location.
func civilDate(t time.Time) time.Time {
	y, m, d := t.Date()
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
}

// secondOfDay returns the wall-clock time of t in seconds since midnight.
func secondOfDay(t time.Time) int {
	return t.Hour()*3600 + t.Minute()*60 + t.Second()
}

// movedRule returns rrule for a series moved from its occurrence rid
// (FR-17): its COUNT without the before occurrences that preceded rid (see
// lowerCount); its UNTIL, from rid on, moved by shift (nil: kept). An UNTIL
// on rid itself makes the moved occurrence the last one, and it stays the
// last wherever it moves.
func movedRule(rrule string, before int, rid time.Time, shift func(dateValue) time.Time) string {
	rrule = lowerCount(rrule, before)
	if shift == nil {
		return rrule
	}
	return mapRulePart(rrule, "UNTIL", func(v string) string {
		p := ical.Prop{Value: v}
		shiftDatePropBy(&p, func(d dateValue) time.Time {
			if d.t.Before(rid) {
				return d.t
			}
			return shift(d)
		})
		return p.Value
	})
}

// lowerCount returns rrule with its COUNT lowered by the before occurrences
// that a new DTSTART leaves behind, to at least one (FR-17).
func lowerCount(rrule string, before int) string {
	return mapRulePart(rrule, "COUNT", func(v string) string {
		n, err := strconv.Atoi(v)
		if err != nil || before == 0 {
			return v
		}
		return strconv.Itoa(max(n-before, 1))
	})
}

// untilBefore reports whether rrule has an UNTIL before to; a DATE compares
// with to's date in loc (FR-17).
func untilBefore(rrule string, to time.Time, loc *time.Location) bool {
	for part := range strings.SplitSeq(rrule, ";") {
		if rulePartKey(part) != "UNTIL" {
			continue
		}
		_, v, _ := strings.Cut(part, "=")
		d, err := parseDateValue(v, nil)
		switch {
		case err != nil:
			return false
		case d.allDay:
			return d.t.Before(civilDate(to.In(loc)))
		default:
			return d.t.Before(to)
		}
	}
	return false
}

// untilAt returns rrule with its UNTIL at to, written in the UNTIL's own
// form: a DATE (to's date in loc), floating or UTC (FR-17).
func untilAt(rrule string, to time.Time, loc *time.Location) string {
	return mapRulePart(rrule, "UNTIL", func(v string) string {
		p := ical.Prop{Value: v}
		shiftDatePropBy(&p, func(d dateValue) time.Time {
			if d.allDay {
				return civilDate(to.In(loc))
			}
			return to
		})
		return p.Value
	})
}

// mapRulePart replaces the value of the part key (upper case) of rrule by
// f's result; a part f keeps is left as written.
func mapRulePart(rrule, key string, f func(string) string) string {
	parts := strings.Split(rrule, ";")
	for i, part := range parts {
		if rulePartKey(part) != key {
			continue
		}
		_, v, _ := strings.Cut(part, "=")
		if nv := f(strings.TrimSpace(v)); nv != strings.TrimSpace(v) {
			parts[i] = key + "=" + nv
		}
	}
	return strings.Join(parts, ";")
}

// shiftRefs moves the references of the master of s in cal that moves
// reports, placed by placeRef, by shift (FR-17): the RECURRENCE-ID, DTSTART
// and DUE of their overrides, by their RECURRENCE-ID, and EXDATE values.
func (s *todoSeries) shiftRefs(cal *ical.Calendar, moves func(dateValue) bool, shift func(dateValue) time.Time) {
	master := s.master
	for _, o := range cal.Children {
		if o == master || o.Name != master.Name {
			continue
		}
		if r, err := parseDateProp(o.Props.Get(ical.PropRecurrenceID)); err != nil || !moves(r) {
			continue
		}
		for _, name := range []string{ical.PropRecurrenceID, ical.PropDateTimeStart, ical.PropDue} {
			vals := o.Props[name]
			for i := range vals {
				shiftDatePropBy(&vals[i], shift)
			}
		}
	}
	vals := master.Props[ical.PropExceptionDates]
	for i := range vals {
		shiftDatePropBy(&vals[i], func(d dateValue) time.Time {
			if !moves(d) {
				return d.t
			}
			return shift(d)
		})
	}
}

// retypeRefs converts the references of s into the value type of to, the
// master's DTSTART as just written, when it differs from the anchor's as
// read (FR-17), see convertRefs: a time added takes to's time of day in
// to's zone, a time removed takes the date in the zone the series was read
// in. A series read without an anchor has no value type to convert from.
func (s *todoSeries) retypeRefs(cal *ical.Calendar, to dateValue) {
	switch {
	case errors.Is(s.err, errNoAnchor), to.allDay == s.anchor.allDay:
	case to.allDay:
		s.convertRefs(cal, true, 0, s.anchor.loc(), to.form())
	default:
		s.convertRefs(cal, false, time.Duration(secondOfDay(to.t))*time.Second, to.loc(), to.form())
	}
}

// convertRefs rewrites UNTIL, EXDATE, the overrides' RECURRENCE-ID and their
// own DTSTART/DUE of master into the value type of the new anchor (FR-17):
// DATE → DATE-TIME at the new anchor's time of day in the series' zone (UNTIL
// in UTC, the rest in the series' form); DATE-TIME → DATE as the date in the
// series' zone.
//
// loc is the series' zone: the new anchor's for DATE-TIME, the one the
// series was read in for DATE; f is the new anchor's form, and a floating
// one gets a floating UNTIL, as RFC 5545 3.3.10 wants. A reference already
// of the new value type stays as written, unless it shares an EXDATE with
// one that is not (see retypeDateProp).
func (s *todoSeries) convertRefs(cal *ical.Calendar, toAllDay bool, timeOfDay time.Duration, loc *time.Location, f dateForm) {
	c := s.master
	conv := func(d dateValue) time.Time {
		if toAllDay {
			return civilDate(d.t.In(loc))
		}
		// A DATE is midnight UTC of its day; the time of day is on the wall
		// clock, also on a day the zone changes its offset.
		y, m, day := d.t.Date()
		return time.Date(y, m, day, 0, 0, int(timeOfDay/time.Second), 0, loc)
	}
	if p := c.Props.Get(ical.PropRecurrenceRule); p != nil {
		p.Value = mapRulePart(p.Value, "UNTIL", func(v string) string {
			d, err := parseDateValue(v, nil)
			switch {
			case err != nil || d.allDay == toAllDay:
				return v
			case toAllDay:
				return conv(d).Format(icalDate)
			case f.floating:
				return conv(d).UTC().Format(icalDateTime)
			default:
				return conv(d).UTC().Format(icalDateTimeUTC)
			}
		})
	}
	exdates := c.Props[ical.PropExceptionDates]
	for i := range exdates {
		retypeDateProp(cal, &exdates[i], toAllDay, f, conv)
	}
	for _, o := range cal.Children {
		if o == c || o.Name != c.Name {
			continue
		}
		for _, name := range []string{ical.PropRecurrenceID, ical.PropDateTimeStart, ical.PropDue} {
			vals := o.Props[name]
			for i := range vals {
				retypeDateProp(cal, &vals[i], toAllDay, f, conv)
			}
		}
	}
}

// retypeDateProp rewrites the date property p in the form f when one of its
// values is not of the value type toAllDay (FR-17): such values by conv, the
// others at their own instant. Its parameters other than VALUE and TZID
// stay; one that cannot be read stays as written.
func retypeDateProp(cal *ical.Calendar, p *ical.Prop, toAllDay bool, f dateForm, conv func(dateValue) time.Time) {
	dvs, err := parseDateList(p)
	if err != nil || !slices.ContainsFunc(dvs, func(d dateValue) bool { return d.allDay != toAllDay }) {
		return
	}
	var np *ical.Prop
	vals := make([]string, len(dvs))
	for i, d := range dvs {
		t := d.t
		if d.allDay != toAllDay {
			t = conv(d)
		}
		np = seriesDateProp(cal, p.Name, t, f)
		vals[i] = np.Value
	}
	if p.Params == nil {
		p.Params = ical.Params{}
	}
	for _, k := range []string{ical.ParamValue, ical.ParamTimezoneID} {
		if v, ok := np.Params[k]; ok {
			p.Params[k] = v
		} else {
			p.Params.Del(k)
		}
	}
	p.Value = strings.Join(vals, ",")
}

// dropOverrides removes the overrides of master from cal whose
// RECURRENCE-ID drop reports (FR-17).
func dropOverrides(cal *ical.Calendar, master *ical.Component, drop func(rid dateValue) bool) {
	cal.Children = slices.DeleteFunc(cal.Children, func(o *ical.Component) bool {
		if o == master || o.Name != master.Name {
			return false
		}
		rid, err := parseDateProp(o.Props.Get(ical.PropRecurrenceID))
		return err == nil && drop(rid)
	})
}

// dropOccurrence removes the overrides of the occurrence occ of master from
// cal (FR-17): those at occ's instant, and the one it was read with, whose
// RECURRENCE-ID can be of the other value type (A-11).
func dropOccurrence(cal *ical.Calendar, master *ical.Component, occ todoOcc) {
	dropOverrides(cal, master, func(rid dateValue) bool { return rid.t.Equal(occ.rid) })
	if occ.override != nil {
		cal.Children = slices.DeleteFunc(cal.Children, func(o *ical.Component) bool { return o == occ.override })
	}
}

// ruleEnd returns the last occurrence of the rule of s, counted as walk
// counts them (see ruleIterator), so an anchor off the rule is one of a
// COUNT; that is the anchor when the rule yields nothing after it. It fails
// for a rule that does not end within maxRRuleIterations (FR-17).
func (s *todoSeries) ruleEnd() (time.Time, error) {
	next, err := s.ruleIterator()
	if err != nil {
		return time.Time{}, err
	}
	var last time.Time
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
// occurrence, so that the rule keeps its end when DTSTART rolls forward or
// leaves the rule (FR-17). UNTIL follows DTSTART's form f (RFC 5545
// 3.3.10): a DATE for an all-day series, floating for a floating one, UTC
// otherwise. For a TZID Lucid cannot resolve, last would be the wall clock
// read as UTC, so callers keep the COUNT then (see zoneKnown). An UNTIL next
// to the COUNT (not allowed by RFC 5545) is replaced too. A rule without
// COUNT is returned unchanged.
func countToUntil(rrule string, last time.Time, f dateForm) string {
	if !hasRulePart(rrule, "COUNT") {
		return rrule
	}
	return withEnd(rrule, "UNTIL="+untilValue(last, f))
}

// endAt returns rrule ending at to, the new DTSTART as written of a series
// moved at its last occurrence, so that the moved occurrence stays its only
// one and no instance of the rule comes back on its old day (FR-17): an
// UNTIL at to in the form DTSTART's needs (see untilValue) takes the place
// of its COUNT and UNTIL. In a zone Lucid cannot resolve (see knownZone)
// that UNTIL would be off by the zone's offset, so the rule ends with
// COUNT=1 instead, DTSTART being its first occurrence.
func endAt(rrule string, to dateValue) string {
	if !knownZone(to) {
		return withEnd(rrule, "COUNT=1")
	}
	return withEnd(rrule, "UNTIL="+untilValue(to.t, to.form()))
}

// untilValue returns the UNTIL value at t for a DTSTART written in the form
// f, as RFC 5545 3.3.10 wants it: a DATE for an all-day series, floating for
// a floating one, UTC otherwise (FR-17).
func untilValue(t time.Time, f dateForm) string {
	switch {
	case f.allDay:
		return t.UTC().Format(icalDate)
	case f.floating:
		return t.UTC().Format(icalDateTime)
	default:
		return t.UTC().Format(icalDateTimeUTC)
	}
}

// withEnd returns rrule with its COUNT and UNTIL replaced by end, a rule
// part such as "COUNT=1", written where the first of them was, else last
// (FR-17).
func withEnd(rrule, end string) string {
	var out []string
	placed := false
	for part := range strings.SplitSeq(rrule, ";") {
		switch rulePartKey(part) {
		case "COUNT", "UNTIL":
			if !placed {
				out, placed = append(out, end), true
			}
		default:
			out = append(out, part)
		}
	}
	if !placed {
		out = append(out, end)
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
// A TZID gets a VTIMEZONE in cal unless one with that TZID exists, Lucid
// cannot resolve it, or cal is nil (see entryCalendar). A nil t removes the
// property.
func setSeriesDate(cal *ical.Calendar, c *ical.Component, name string, t *time.Time, f dateForm) {
	if t == nil {
		c.Props.Del(name)
		return
	}
	c.Props.Set(seriesDateProp(cal, name, *t, f))
}

// seriesDateProp returns the date property name at t in the form f, see
// setSeriesDate, which also says when it adds a VTIMEZONE to cal (FR-17).
func seriesDateProp(cal *ical.Calendar, name string, t time.Time, f dateForm) *ical.Prop {
	tzid := cmp.Or(f.param, f.tzid)
	var loc *time.Location
	if tzid != "" {
		loc = loadLocation(tzid)
	}
	switch {
	case f.allDay:
		return newDateProp(name, t, true, nil)
	case f.param != "" || (loc != nil && loc != time.UTC):
		wall := t.UTC()
		if loc != nil {
			wall = t.In(loc)
		}
		p := ical.NewProp(name)
		p.Params.Set(ical.ParamTimezoneID, tzid)
		p.Value = wall.Truncate(time.Second).Format(icalDateTime)
		if cal != nil && loc != nil && loc != time.UTC {
			ensureVTimezoneAs(cal, tzid, loc, wall.Year())
		}
		return p
	case f.floating:
		p := ical.NewProp(name)
		p.Value = t.UTC().Truncate(time.Second).Format(icalDateTime)
		return p
	default:
		return newDateProp(name, t, false, nil)
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
	start, startForm := seriesStart(c, in, keep)
	_, dueForm, ok := storedForms(c)
	setSeriesDate(cal, c, ical.PropDateTimeStart, start, startForm)
	setSeriesDate(cal, c, ical.PropDue, in.Due, seriesForm(dueForm, in.DueAllDay, keep && ok, in.Timezone))
	c.Props.Del(ical.PropDuration)
}

// seriesStart returns the DTSTART writeSeriesDates writes for in on the
// recurring todo c, in's start, else its due, nil if neither, and the form
// it writes it in (FR-17).
func seriesStart(c *ical.Component, in domain.TodoInput, keep bool) (*time.Time, dateForm) {
	startForm, _, ok := storedForms(c)
	start, allDay := in.Start, in.StartAllDay
	if start == nil {
		start, allDay = in.Due, in.DueAllDay
	}
	return start, seriesForm(startForm, allDay, keep && ok, in.Timezone)
}
