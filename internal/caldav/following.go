package caldav

// This file holds what "this and following events" needs to know about an
// event series: where it starts as ListEvents shows it, and how it splits in
// two at an occurrence R, in memory: the series S ends before R, and a new
// series N, a resource of its own, goes on from R (FR-17).

import (
	"context"
	"fmt"
	"maps"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/emersion/go-ical"

	"github.com/tbckr/lucid/internal/domain"
)

// errSplitAtStart refuses to end a series before an occurrence at or before
// its DTSTART, which only an RDATE or override before DTSTART leaves
// possible: DTSTART is always an occurrence of the series (RFC 5545 section
// 3.8.5.3), so no rule can end before it. Like every split Lucid cannot
// compute, it is domain.ErrSeriesSplitUnsupported (FR-17).
var errSplitAtStart = fmt.Errorf("%w: the series cannot end before this event", domain.ErrSeriesSplitUnsupported)

// unsplittable returns err, why Lucid cannot walk a series' rule to an
// occurrence, as domain.ErrSeriesSplitUnsupported: a split it cannot compute
// is one it does not support, never a server failure (FR-17).
func unsplittable(err error) error {
	return fmt.Errorf("%w: %w", domain.ErrSeriesSplitUnsupported, err)
}

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
// none. It fails, as domain.ErrSeriesSplitUnsupported (see unsplittable),
// for a rule ruleInstances cannot read, and for one that does not reach rid
// within maxRRuleIterations occurrences.
func placeInRule(master *ical.Component, tm timing, rid time.Time) (before int, from time.Time, err error) {
	next, err := ruleInstances(rruleString(master), tm.start.t)
	if err != nil {
		return 0, time.Time{}, unsplittable(err)
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
	return 0, time.Time{}, unsplittable(errRRuleCap)
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
//     property left without values goes too; one Lucid cannot read stays
//     (see keepDates).
//   - The overrides whose RECURRENCE-ID is rid or later go, by that instant,
//     whatever their own DTSTART: an occurrence before rid moved past it
//     stays.
//
// It fails, changing nothing, for a rule Lucid cannot walk to rid (see
// placeInRule) and for a rid at or before DTSTART (errSplitAtStart), both as
// domain.ErrSeriesSplitUnsupported. It neither bumps SEQUENCE nor writes: the
// caller does.
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
	keepDates(master, ical.PropExceptionDates, earlier, true)
	keepDates(master, ical.PropRecurrenceDates, earlier, true)
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
//     overrides take N's UID. An EXDATE property Lucid cannot read comes
//     along too, while it stays in S as well; an RDATE one stays in S only
//     (see keepDates).
//
// An rid that is no occurrence of the rule, an RDATE (or an override off
// the rule), stays one of N, which starts at the rule's first occurrence
// after it. If there is none, N has no RRULE and starts at rid, keeping the
// later RDATEs. Without those it is a single event, the event rid as shown:
// an override at rid is laid over the master (see layOver), and the EXDATEs
// and the other overrides go, as a single event shows none (see
// removeRecurrence). An override off the rule after rid that the series
// shows would be lost that way, so the split is refused then
// (errSplitLosesEvent).
//
// It fails for a rule Lucid cannot walk to rid (see placeInRule). It does
// not check that the series can end before rid: callers call splitOff
// first, on the series as read, and then endBefore, which changes cal in
// place and refuses an rid at or before DTSTART (errSplitAtStart).
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
	keepDates(nm, ical.PropExceptionDates, later, true)
	keepDates(nm, ical.PropRecurrenceDates, later, false)

	offRule := start.IsZero()
	if offRule {
		start = rid
		nm.Props.Del(ical.PropRecurrenceRule)
		// DTSTART is rid now.
		keepDates(nm, ical.PropRecurrenceDates, func(t time.Time) bool { return t.After(rid) }, false)
	}
	if p := nm.Props.Get(ical.PropRecurrenceRule); p != nil {
		p.Value = lowerCount(rruleString(nm), before)
	}
	nm.Props.Set(seriesDateProp(n, ical.PropDateTimeStart, start, tm.start.form()))
	if p := nm.Props.Get(ical.PropDateTimeEnd); p != nil {
		end := tm.dur.addTo(start)
		shiftDatePropBy(p, func(dateValue) time.Time { return end })
	}
	if offRule && !isRecurring(nm) {
		if showsOverrideAfter(n, nm, rid) {
			return nil, errSplitLosesEvent
		}
		if ov := findOverride(n, nm, rid); ov != nil {
			layOver(nm, ov)
		}
		removeRecurrence(n, nm)
	}
	masterFirst(n, nm)
	return n, nil
}

// errSplitLosesEvent refuses a split whose new series would be a single
// event while the series shows an override off the rule after the event
// the split starts at, which a single event cannot show (FR-17). Like every
// split Lucid cannot do without losing an event, it is
// domain.ErrSeriesSplitUnsupported.
var errSplitLosesEvent = fmt.Errorf("%w: an event after this one would be lost", domain.ErrSeriesSplitUnsupported)

// showsOverrideAfter reports whether the series master in cal shows an
// override whose RECURRENCE-ID is after rid: one neither cancelled nor at an
// EXDATE, as expandObject shows them (FR-17).
func showsOverrideAfter(cal *ical.Calendar, master *ical.Component, rid time.Time) bool {
	exdates := exceptionDates(master)
	for ridUnix, ov := range recurrenceOverrides(cal, master) {
		if ridUnix > rid.Unix() && !exdates[ridUnix] && !isCancelled(ov) {
			return true
		}
	}
	return false
}

// layOver writes the override ov over master, which becomes the single
// event ov shows (FR-17): ov's properties and components replace master's
// of the same name, as ListEvents shows ov's own title and the series'
// where it has none. DTSTART, DTEND and DURATION go together: ov's where
// ListEvents shows ov at its own times, which takes a DTSTART, else
// master's. master keeps its UID, SEQUENCE, DTSTAMP, CREATED and
// LAST-MODIFIED, and gets no RECURRENCE-ID.
func layOver(master, ov *ical.Component) {
	_, err := parseTiming(ov)
	ownTimes := err == nil
	if ownTimes {
		for _, name := range []string{ical.PropDateTimeStart, ical.PropDateTimeEnd, ical.PropDuration} {
			master.Props.Del(name)
		}
	}
	for name, props := range ov.Props {
		switch name {
		case ical.PropUID, ical.PropRecurrenceID, ical.PropSequence, ical.PropDateTimeStamp, ical.PropCreated,
			ical.PropLastModified:
			continue
		case ical.PropDateTimeStart, ical.PropDateTimeEnd, ical.PropDuration:
			if !ownTimes {
				continue
			}
		}
		master.Props[name] = props
	}
	replaced := map[string]bool{}
	for _, c := range ov.Children {
		replaced[c.Name] = true
	}
	master.Children = slices.DeleteFunc(master.Children, func(c *ical.Component) bool { return replaced[c.Name] })
	master.Children = append(master.Children, ov.Children...)
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
// value Lucid cannot read, of which it reads none (see parseDateList), stays
// as it is where unreadable is set, and goes otherwise. A split keeps such an
// EXDATE in both series: another client may read it, and in a series whose
// range does not reach its dates it excludes nothing. Such an RDATE stays in
// the series it is in only, as in both it would add its events twice.
func keepDates(c *ical.Component, name string, keep func(time.Time) bool, unreadable bool) {
	var props []ical.Prop
	for _, p := range c.Props[name] {
		if _, err := parseDateList(&p); err != nil {
			if unreadable {
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

// followingSeries is a series loaded for a write to the occurrence rid and
// the ones after it (see loadFollowing): the series, as loadSeries reads it,
// and whether rid is the first event ListEvents shows for it (FR-17).
type followingSeries struct {
	loadedSeries
	first bool
}

// loadFollowing reads the resource at eventID for ending its series before
// recurrenceID, or for splitting it there, and checks that it can (FR-17; spec
// section 4 "Teilen"). DeleteFollowing and UpdateFollowing share it. Besides
// what loadSeries checks:
//   - recurrenceID is an event ListEvents shows, neither an EXDATE nor a
//     cancelled override, else ErrNotFound: a user cannot have picked it.
//   - The series has no ORGANIZER or ATTENDEE in any event, since a server
//     that schedules implicitly would tell them of a series that ends and
//     another with a UID of its own; no EXRULE, which a new series would
//     count from its own start and so exclude other events; at most one
//     RRULE, as Lucid reads and ends only the first, and a second would go
//     on past recurrenceID, in the series and in a copy of it; and a rule
//     ruleInstances can read, though only the walk to recurrenceID needs it.
//     Else ErrSeriesSplitUnsupported, with nothing written, even where
//     recurrenceID is the first event and the series would simply go.
//
// It tells whether recurrenceID is the first event ListEvents shows (see
// firstOccurrence), where "this and following" is "all".
func (s *service) loadFollowing(ctx context.Context, eventID, etag string, recurrenceID time.Time) (followingSeries, error) {
	ls, err := s.loadSeries(ctx, eventID, etag, recurrenceID)
	if err != nil {
		return followingSeries{}, err
	}
	rid := ls.rid.Unix()
	if ov := recurrenceOverrides(ls.cal, ls.master)[rid]; exceptionDates(ls.master)[rid] || (ov != nil && isCancelled(ov)) {
		return followingSeries{}, fmt.Errorf("%w: not an event of the series", domain.ErrNotFound)
	}
	if hasAttendees(ls.cal) {
		return followingSeries{}, fmt.Errorf("%w: the series has attendees", domain.ErrSeriesSplitUnsupported)
	}
	if ls.master.Props.Get(propExRule) != nil {
		return followingSeries{}, fmt.Errorf("%w: the series has an EXRULE", domain.ErrSeriesSplitUnsupported)
	}
	if len(ls.master.Props[ical.PropRecurrenceRule]) > 1 {
		return followingSeries{}, fmt.Errorf("%w: the series has more than one RRULE", domain.ErrSeriesSplitUnsupported)
	}
	if _, err := ruleInstances(rruleString(ls.master), ls.tm.start.t); err != nil {
		return followingSeries{}, unsplittable(err)
	}
	return followingSeries{loadedSeries: ls, first: ls.rid.Equal(firstOccurrence(ls.cal, ls.master, ls.tm))}, nil
}

// DeleteFollowing implements domain.CalendarService: it ends the recurring
// series before its occurrence at recurrenceID, with endBefore, in one write
// (FR-17; spec section 4 "Löschen"). At the series' first event, which is all
// of them, it deletes the resource instead, as DeleteEvent does. At a later
// event the series keeps the events before it, so it is never left without
// one; should endBefore and hasEventsLeft ever disagree on that, a guard
// deletes the resource rather than write a series without events. It
// returns what DeleteOccurrence does: the new ETag of a resource it keeps,
// so the client's next write of the series does not conflict with this one
// (NFR-26), and the snapshot RestoreEvent undoes the change with, the
// resource as it was; "" and nil for one it deletes.
func (s *service) DeleteFollowing(ctx context.Context, eventID, etag string, recurrenceID time.Time) (string, *domain.Snapshot, error) {
	if s.err != nil {
		return "", nil, s.err
	}
	fs, err := s.loadFollowing(ctx, eventID, etag, recurrenceID)
	if err != nil {
		return "", nil, err
	}
	if !fs.first {
		if err := endBefore(fs.cal, fs.master, fs.tm, fs.rid); err != nil {
			return "", nil, err
		}
		// The series has an event before rid, as rid is not its first, and
		// hasEventsLeft counts every such event, so this holds. The check
		// keeps a series without events from ever being written, which
		// Baïkal answers with 500 (see DeleteOccurrence), should the two
		// ever differ.
		if hasEventsLeft(fs.cal, fs.master, fs.tm) {
			bumpChangeProps(fs.master, s.p.now().UTC())
			masterFirst(fs.cal, fs.master)
			next, err := s.putObject(ctx, fs.objPath, fs.cal, etag, false)
			s.invalidate(fs.calPath)
			if err != nil {
				return "", nil, err
			}
			// The series has no attendees, or loadFollowing had refused it.
			return next, s.eventSnapshot(eventID, fs.raw, next, false), nil
		}
	}
	err = s.deleteObject(ctx, fs.objPath, etag)
	s.invalidate(fs.calPath)
	return "", nil, err
}

// UpdateFollowing implements domain.CalendarService: it changes the event of
// the recurring series at recurrenceID and the following ones as a series of
// their own (FR-17; spec section 4 "Teilen"). The series S ends before it, as
// DeleteFollowing ends it, and the new series N, a resource with a UID of its
// own, goes on from it (see splitOff), changed by in as UpdateEvent changes
// all events of a series from that event (see applySeriesEdit). in's rule is
// N's rule, except that S's rule as read, sent unchanged, keeps the one N
// inherits, with its COUNT lowered: an edit that keeps the rule does not take
// N's lower COUNT for a new one. A rule removed makes N the single event
// entered. At the series' first event, which is all of them, it is
// UpdateEvent with the event as instanceStart.
//
// Nothing is written for a change it refuses: a series loadFollowing
// refuses, a split it cannot compute (ErrSeriesSplitUnsupported) and a move
// N cannot follow (ErrSeriesMoveUnsupported). Then it writes N, with
// If-None-Match, and S, with If-Match etag; if either write fails, N goes
// again as far as Lucid can tell, see writeCreatedThenMaster (A-01). It
// returns the edited event in N, as ListEvents shows it, S's new ETag, so the
// client's next write of S does not conflict with this one (NFR-26), and the
// snapshot RestoreEvent undoes the split with: S as read, and N as the
// resource the change created, which the undo deletes. There is none when
// the ETag of S or N is unknown.
func (s *service) UpdateFollowing(ctx context.Context, eventID, etag string, recurrenceID time.Time, in domain.EventInput) (domain.FollowingResult, *domain.Snapshot, error) {
	if s.err != nil {
		return domain.FollowingResult{}, nil, s.err
	}
	rr, err := normalizeEventInput(in)
	if err != nil {
		return domain.FollowingResult{}, nil, err
	}
	fs, err := s.loadFollowing(ctx, eventID, etag, recurrenceID)
	if err != nil {
		return domain.FollowingResult{}, nil, err
	}
	rid := fs.rid
	in.InstanceStart = &rid
	if fs.first {
		ev, snap, err := s.UpdateEvent(ctx, eventID, etag, in)
		if err != nil {
			return domain.FollowingResult{}, nil, err
		}
		return domain.FollowingResult{Event: ev, ETag: ev.ETag}, snap, nil
	}

	cal, master, tm := fs.cal, fs.master, fs.tm
	// Judged on S as read, before endBefore ends its rule.
	// Rule parts are case-insensitive (RFC 5545 section 3.1).
	ruleKept := strings.EqualFold(rr, rruleString(master))
	now := s.p.now().UTC()
	uid := newUID()
	// splitOff reads the series as it is; endBefore changes it in place.
	n, err := splitOff(cal, master, tm, rid, uid, now)
	if err != nil {
		return domain.FollowingResult{}, nil, err
	}
	if err := endBefore(cal, master, tm, rid); err != nil {
		return domain.FollowingResult{}, nil, err
	}
	nm := mainComponent(n, master.Name)
	switch {
	case ruleKept:
		// "" once N has no RRULE left: then N moves by its RDATEs, or, a
		// single event, takes the dates entered.
		rr = rruleString(nm)
	case rr == "":
		// Also N's RDATEs go, which applySeriesEdit would move along.
		removeRecurrence(n, nm)
	}
	instance, moved, err := applySeriesEdit(n, nm, in, rr, now)
	if err != nil {
		return domain.FollowingResult{}, nil, err
	}
	// N is new: its SEQUENCE stays 0, while S's goes up.
	bumpChangeProps(master, now)
	masterFirst(cal, master)

	calendarID := encodeID(fs.calPath)
	created := calObject{path: objectPath(fs.calPath, uid+".ics"), cal: n}
	// Located before anything is written, from N as it is written; the ETag
	// follows from the write.
	ev, err := editedEvent(created, calendarID, nm, instance, moved, in)
	if err != nil {
		return domain.FollowingResult{}, nil, err
	}

	defer s.invalidate(fs.calPath)
	next, err := s.writeCreatedThenMaster(ctx, fs.calPath, &created, fs.objPath, cal, etag)
	if err != nil {
		return domain.FollowingResult{}, nil, err
	}
	ev.ETag = created.etag
	// An undo needs both ETags: without S's it could not tell its own change
	// from another client's (see eventSnapshot), and without N's it could not
	// delete N, which would then stand next to S restored, every event from
	// R on twice. The series has no attendees, or loadFollowing had refused
	// it.
	var snap *domain.Snapshot
	if created.etag != "" {
		snap = s.eventSnapshot(eventID, fs.raw, next, false)
	}
	if snap != nil {
		snap.Created = []domain.CreatedRef{{ID: encodeID(created.path), ETag: created.etag}}
	}
	return domain.FollowingResult{Event: ev, ETag: next}, snap, nil
}
