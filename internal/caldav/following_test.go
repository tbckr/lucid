package caldav

import (
	"maps"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/emersion/go-ical"
)

// TestFirstOccurrence checks which RECURRENCE-ID firstOccurrence names as the
// first one ListEvents shows: the rule's, an RDATE's or an override's,
// whichever comes first, none of them an EXDATE or a cancelled override
// (FR-17).
func TestFirstOccurrence(t *testing.T) {
	t.Parallel()
	weekly := []string{
		"UID:1", "DTSTAMP:20250101T000000Z", "SUMMARY:Series", "DTSTART:20250303T080000Z",
		"DTEND:20250303T090000Z", "RRULE:FREQ=WEEKLY",
	}
	with := func(base []string, extra ...string) []string {
		return append(append([]string{}, base...), extra...)
	}
	override := func(rid string, extra ...string) []string {
		return append([]string{
			"BEGIN:VEVENT", "UID:1", "DTSTAMP:20250101T000000Z", "SUMMARY:Series",
			"RECURRENCE-ID:" + rid,
		}, append(extra, "END:VEVENT")...)
	}
	vevent := func(master []string, overrides ...[]string) []string {
		out := append([]string{"BEGIN:VEVENT"}, master...)
		out = append(out, "END:VEVENT")
		for _, o := range overrides {
			out = append(out, o...)
		}
		return out
	}

	tests := []struct {
		name  string
		lines []string
		want  time.Time // the zero time: no occurrence is shown
	}{
		{"weekly series", vevent(weekly), date(2025, 3, 3, 8, 0)},
		{"EXDATE on DTSTART", vevent(with(weekly, "EXDATE:20250303T080000Z")), date(2025, 3, 10, 8, 0)},
		{
			"EXDATEs on the first two instances",
			vevent(with(weekly, "EXDATE:20250303T080000Z,20250310T080000Z")), date(2025, 3, 17, 8, 0),
		},
		{
			"override at DTSTART moved to March 5",
			vevent(weekly, override("20250303T080000Z", "DTSTART:20250305T080000Z", "DTEND:20250305T090000Z")),
			date(2025, 3, 3, 8, 0),
		},
		{
			"cancelled override at DTSTART",
			vevent(weekly, override("20250303T080000Z", "STATUS:CANCELLED", "DTSTART:20250303T080000Z")),
			date(2025, 3, 10, 8, 0),
		},
		{
			"cancelled override, status in lower case",
			vevent(weekly, override("20250303T080000Z", "STATUS:cancelled", "DTSTART:20250303T080000Z")),
			date(2025, 3, 10, 8, 0),
		},
		{
			"confirmed override at DTSTART",
			vevent(weekly, override("20250303T080000Z", "STATUS:CONFIRMED", "DTSTART:20250303T080000Z")),
			date(2025, 3, 3, 8, 0),
		},
		{"RDATE before DTSTART", vevent(with(weekly, "RDATE:20250301T080000Z")), date(2025, 3, 1, 8, 0)},
		{"RDATE after DTSTART", vevent(with(weekly, "RDATE:20250305T080000Z")), date(2025, 3, 3, 8, 0)},
		{
			"RDATE before DTSTART, excluded by EXDATE",
			vevent(with(weekly, "RDATE:20250301T080000Z", "EXDATE:20250301T080000Z")), date(2025, 3, 3, 8, 0),
		},
		{
			"RDATE before DTSTART, cancelled by an override",
			vevent(with(weekly, "RDATE:20250301T080000Z"),
				override("20250301T080000Z", "STATUS:CANCELLED", "DTSTART:20250301T080000Z")),
			date(2025, 3, 3, 8, 0),
		},
		{
			"RDATE among several, the earliest wins",
			vevent(with(weekly, "RDATE:20250306T080000Z,20250302T080000Z")), date(2025, 3, 2, 8, 0),
		},
		{"RDATE that cannot be read", vevent(with(weekly, "RDATE:tomorrow")), date(2025, 3, 3, 8, 0)},
		{"EXDATE that cannot be read", vevent(with(weekly, "EXDATE:tomorrow")), date(2025, 3, 3, 8, 0)},
		{
			"override before DTSTART",
			vevent(weekly, override("20250228T080000Z", "DTSTART:20250228T100000Z", "DTEND:20250228T110000Z")),
			date(2025, 2, 28, 8, 0),
		},
		{
			"override before DTSTART, cancelled",
			vevent(weekly, override("20250228T080000Z", "STATUS:CANCELLED", "DTSTART:20250228T080000Z")),
			date(2025, 3, 3, 8, 0),
		},
		{
			"override before DTSTART, in EXDATE",
			vevent(with(weekly, "EXDATE:20250228T080000Z"),
				override("20250228T080000Z", "DTSTART:20250228T080000Z")),
			date(2025, 3, 3, 8, 0),
		},
		{
			"EXDATE on DTSTART, override of the second instance",
			vevent(with(weekly, "EXDATE:20250303T080000Z"),
				override("20250310T080000Z", "DTSTART:20250310T120000Z", "DTEND:20250310T130000Z")),
			date(2025, 3, 10, 8, 0),
		},
		{
			"override moved before the first instance keeps its RECURRENCE-ID",
			vevent(with(weekly, "EXDATE:20250303T080000Z"),
				override("20250310T080000Z", "DTSTART:20250301T080000Z", "DTEND:20250301T090000Z")),
			date(2025, 3, 10, 8, 0),
		},
		{
			"DTSTART off the rule",
			vevent([]string{
				"UID:1", "DTSTAMP:20250101T000000Z", "DTSTART:20250303T080000Z", "DTEND:20250303T090000Z",
				"RRULE:FREQ=WEEKLY;BYDAY=WE",
			}),
			date(2025, 3, 3, 8, 0),
		},
		{
			"DTSTART off the rule, in EXDATE",
			vevent([]string{
				"UID:1", "DTSTAMP:20250101T000000Z", "DTSTART:20250303T080000Z", "DTEND:20250303T090000Z",
				"RRULE:FREQ=WEEKLY;BYDAY=WE", "EXDATE:20250303T080000Z",
			}),
			date(2025, 3, 5, 8, 0),
		},
		{
			"rule with a COUNT, all instances excluded",
			vevent([]string{
				"UID:1", "DTSTAMP:20250101T000000Z", "DTSTART:20250303T080000Z", "DTEND:20250303T090000Z",
				"RRULE:FREQ=WEEKLY;COUNT=2", "EXDATE:20250303T080000Z,20250310T080000Z",
			}),
			time.Time{},
		},
		{
			"RDATEs only",
			vevent([]string{
				"UID:1", "DTSTAMP:20250101T000000Z", "DTSTART:20250303T080000Z", "DTEND:20250303T090000Z",
				"RDATE:20250305T080000Z", "EXDATE:20250303T080000Z",
			}),
			date(2025, 3, 5, 8, 0),
		},
		{
			"unreadable rule",
			vevent([]string{
				"UID:1", "DTSTAMP:20250101T000000Z", "DTSTART:20250303T080000Z", "DTEND:20250303T090000Z",
				"RRULE:FREQ=WEEKLY;RSCALE=GREGORIAN",
			}),
			date(2025, 3, 3, 8, 0),
		},
		{
			"unreadable rule, DTSTART in EXDATE, RDATE",
			vevent([]string{
				"UID:1", "DTSTAMP:20250101T000000Z", "DTSTART:20250303T080000Z", "DTEND:20250303T090000Z",
				"RRULE:FREQ=WEEKLY;RSCALE=GREGORIAN", "EXDATE:20250303T080000Z", "RDATE:20250306T080000Z",
			}),
			date(2025, 3, 6, 8, 0),
		},
		{
			"zone of its own, DST change after DTSTART",
			[]string{
				"BEGIN:VEVENT", "UID:1", "DTSTAMP:20250101T000000Z", "DTSTART;TZID=Europe/Berlin:20250324T090000",
				"DTEND;TZID=Europe/Berlin:20250324T100000", "RRULE:FREQ=WEEKLY",
				"EXDATE;TZID=Europe/Berlin:20250324T090000", "END:VEVENT",
			},
			date(2025, 3, 31, 7, 0), // the first week of summer time
		},
		{
			"all-day series",
			[]string{
				"BEGIN:VEVENT", "UID:1", "DTSTAMP:20250101T000000Z", "DTSTART;VALUE=DATE:20250303",
				"RRULE:FREQ=DAILY", "EXDATE;VALUE=DATE:20250303", "END:VEVENT",
			},
			date(2025, 3, 4, 0, 0),
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			cal := mustParse(t, ics(tt.lines...))
			master := mainComponent(cal, ical.CompEvent)
			tm, err := parseTiming(master)
			mustNoErr(t, err)
			got := firstOccurrence(cal, master, tm)
			if !got.Equal(tt.want) {
				t.Errorf("firstOccurrence = %v; want %v", got, tt.want)
			}
		})
	}
}

// splitUID and splitNow are the UID and the time splitOff gives the new
// series in the tests below.
const splitUID = "new-uid"

var splitNow = date(2025, 6, 1, 12, 0)

// berlinVTimezone is a VTIMEZONE for Europe/Berlin as clients write it.
var berlinVTimezone = []string{
	"BEGIN:VTIMEZONE", "TZID:Europe/Berlin",
	"BEGIN:DAYLIGHT", "DTSTART:19700329T020000", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0200",
	"RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU", "END:DAYLIGHT",
	"BEGIN:STANDARD", "DTSTART:19701025T030000", "TZOFFSETFROM:+0200", "TZOFFSETTO:+0100",
	"RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU", "END:STANDARD",
	"END:VTIMEZONE",
}

// seriesICS returns a calendar with berlinVTimezone, a series master "Series"
// of the given lines, and its overrides, given as their lines each.
func seriesICS(master []string, overrides ...[]string) string {
	lines := append([]string{}, berlinVTimezone...)
	lines = append(lines, "BEGIN:VEVENT", "UID:1", "DTSTAMP:20250101T000000Z", "SEQUENCE:2", "SUMMARY:Series")
	lines = append(append(lines, master...), "END:VEVENT")
	for _, o := range overrides {
		lines = append(lines, "BEGIN:VEVENT", "UID:1", "DTSTAMP:20250101T000000Z")
		lines = append(append(lines, o...), "END:VEVENT")
	}
	return ics(lines...)
}

// splitAt splits the series in cal at rid as UpdateFollowing does: it builds
// N with splitOff, failing the test if that changes cal, and then ends cal,
// S, with endBefore. It returns S and N.
func splitAt(t *testing.T, cal *ical.Calendar, rid time.Time) (s, n *ical.Calendar) {
	t.Helper()
	master := mainComponent(cal, ical.CompEvent)
	tm, err := parseTiming(master)
	mustNoErr(t, err)
	before := encodeCal(t, cal)
	n, err = splitOff(cal, master, tm, rid, splitUID, splitNow)
	mustNoErr(t, err)
	if got := encodeCal(t, cal); got != before {
		t.Fatalf("splitOff changed the series:\n%s\nwant\n%s", got, before)
	}
	mustNoErr(t, endBefore(cal, master, tm, rid))
	return cal, n
}

// encodeCal returns cal as it is written.
func encodeCal(t *testing.T, cal *ical.Calendar) string {
	t.Helper()
	var b strings.Builder
	mustNoErr(t, ical.NewEncoder(&b).Encode(cal))
	return b.String()
}

// propLines returns the properties name of c as they are written, their
// parameters sorted.
func propLines(c *ical.Component, name string) []string {
	var out []string
	for _, p := range c.Props.Values(name) {
		var line strings.Builder
		line.WriteString(p.Name)
		for _, k := range slices.Sorted(maps.Keys(p.Params)) {
			line.WriteString(";" + k + "=" + strings.Join(p.Params[k], ","))
		}
		out = append(out, line.String()+":"+p.Value)
	}
	return out
}

// propLine returns the first property name of c as propLines writes it, ""
// if c has none.
func propLine(c *ical.Component, name string) string {
	if lines := propLines(c, name); len(lines) > 0 {
		return lines[0]
	}
	return ""
}

// overridesIn returns the overrides in cal, each as its UID, RECURRENCE-ID
// and title.
func overridesIn(cal *ical.Calendar) []string {
	var out []string
	for _, c := range cal.Children {
		if c.Name == ical.CompEvent && c.Props.Get(ical.PropRecurrenceID) != nil {
			out = append(out, text(c.Props, ical.PropUID)+" "+propLine(c, ical.PropRecurrenceID)+" "+
				text(c.Props, ical.PropSummary))
		}
	}
	return out
}

// shownIn returns the events ListEvents shows in 2025 for the series in
// cals, each as its start, end and title, sorted.
func shownIn(t *testing.T, cals ...*ical.Calendar) []string {
	t.Helper()
	var out []string
	for _, cal := range cals {
		evs, err := expandObject(calObject{path: "/cal/x.ics", cal: cal}, "c",
			date(2025, 1, 1, 0, 0), date(2026, 1, 1, 0, 0))
		mustNoErr(t, err)
		for i := range evs {
			ev := &evs[i]
			out = append(out, ev.Start.Format(time.RFC3339)+"/"+ev.End.Format(time.RFC3339)+" "+ev.Title)
		}
	}
	slices.Sort(out)
	return out
}

// checkShownAsBefore fails the test unless S and N together show the events
// the series of raw showed, none twice (FR-17).
func checkShownAsBefore(t *testing.T, raw string, s, n *ical.Calendar) {
	t.Helper()
	got, want := shownIn(t, s, n), shownIn(t, mustParse(t, raw))
	if !slices.Equal(got, want) {
		t.Errorf("S and N show\n%s\nwant the series' events\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}

// TestSplitOffAndEndBefore splits a weekly series from Monday, March 3,
// 2025, at its fourth event, March 24, for each form DTSTART can take and
// each way the rule can end (FR-17). S ends just before R: by an UNTIL in
// the form RFC 5545 section 3.3.10 wants for DTSTART's, or, in a zone Lucid
// cannot resolve, by a COUNT of S's three events. N starts at R in the
// series' form and keeps the duration, with the COUNT lowered by S's three
// events and an UNTIL as it was. Together they show the series' events.
func TestSplitOffAndEndBefore(t *testing.T) {
	t.Parallel()
	forms := []struct {
		name         string
		start, end   string    // the series' DTSTART and DTEND
		rid          time.Time // R, the fourth event
		until        string    // an UNTIL at the tenth event, May 5
		sEnd         string    // how S's rule ends
		nStart, nEnd string    // N's DTSTART and DTEND
	}{
		{
			"DATE", "DTSTART;VALUE=DATE:20250303", "DTEND;VALUE=DATE:20250304", date(2025, 3, 24, 0, 0),
			"20250505", "UNTIL=20250323", "DTSTART;VALUE=DATE:20250324", "DTEND;VALUE=DATE:20250325",
		},
		{
			// 09:00 CET is 08:00 UTC.
			"TZID", "DTSTART;TZID=Europe/Berlin:20250303T090000", "DTEND;TZID=Europe/Berlin:20250303T100000",
			date(2025, 3, 24, 8, 0), "20250505T070000Z", "UNTIL=20250324T075959Z",
			"DTSTART;TZID=Europe/Berlin:20250324T090000", "DTEND;TZID=Europe/Berlin:20250324T100000",
		},
		{
			"UTC", "DTSTART:20250303T090000Z", "DTEND:20250303T100000Z", date(2025, 3, 24, 9, 0),
			"20250505T090000Z", "UNTIL=20250324T085959Z", "DTSTART:20250324T090000Z", "DTEND:20250324T100000Z",
		},
		{
			"floating", "DTSTART:20250303T090000", "DTEND:20250303T100000", date(2025, 3, 24, 9, 0),
			"20250505T090000", "UNTIL=20250324T085959", "DTSTART:20250324T090000", "DTEND:20250324T100000",
		},
		{
			// Lucid reads the wall clock as UTC, so an UNTIL it derived would
			// be off by the zone's offset.
			"unknown TZID", "DTSTART;TZID=Unknown/Zone:20250303T090000", "DTEND;TZID=Unknown/Zone:20250303T100000",
			date(2025, 3, 24, 9, 0), "20250505T090000Z", "COUNT=3",
			"DTSTART;TZID=Unknown/Zone:20250324T090000", "DTEND;TZID=Unknown/Zone:20250324T100000",
		},
	}
	for _, f := range forms {
		endings := []struct {
			name, rule, wantS, wantN string
		}{
			{"COUNT", "FREQ=WEEKLY;COUNT=10", "FREQ=WEEKLY;" + f.sEnd, "FREQ=WEEKLY;COUNT=7"},
			{"UNTIL", "FREQ=WEEKLY;UNTIL=" + f.until, "FREQ=WEEKLY;" + f.sEnd, "FREQ=WEEKLY;UNTIL=" + f.until},
			{"no end", "FREQ=WEEKLY", "FREQ=WEEKLY;" + f.sEnd, "FREQ=WEEKLY"},
		}
		for _, e := range endings {
			t.Run(f.name+", "+e.name, func(t *testing.T) {
				t.Parallel()
				raw := seriesICS([]string{f.start, f.end, "RRULE:" + e.rule})
				s, n := splitAt(t, mustParse(t, raw), f.rid)
				sm, nm := mainComponent(s, ical.CompEvent), mainComponent(n, ical.CompEvent)
				if got := rruleString(sm); got != e.wantS {
					t.Errorf("S: RRULE:%s; want RRULE:%s", got, e.wantS)
				}
				if got := rruleString(nm); got != e.wantN {
					t.Errorf("N: RRULE:%s; want RRULE:%s", got, e.wantN)
				}
				for _, c := range []struct{ what, got, want string }{
					{"S's DTSTART", propLine(sm, ical.PropDateTimeStart), f.start},
					{"S's DTEND", propLine(sm, ical.PropDateTimeEnd), f.end},
					{"N's DTSTART", propLine(nm, ical.PropDateTimeStart), f.nStart},
					{"N's DTEND", propLine(nm, ical.PropDateTimeEnd), f.nEnd},
				} {
					if c.got != c.want {
						t.Errorf("%s = %s; want %s", c.what, c.got, c.want)
					}
				}
				checkShownAsBefore(t, raw, s, n)
			})
		}
	}
}

// TestSplitCountsExcludedInstances splits a series of ten weekly events
// whose second is excluded, at the fourth (FR-17): the excluded event still
// counts against the COUNT (RFC 5545 section 3.8.5.3: EXDATE applies to the
// set the rule makes), so N keeps the last seven, and S and N together show
// the nine events the series showed.
func TestSplitCountsExcludedInstances(t *testing.T) {
	t.Parallel()
	raw := seriesICS([]string{
		"DTSTART:20250303T090000Z", "DTEND:20250303T100000Z", "RRULE:FREQ=WEEKLY;COUNT=10", "EXDATE:20250310T090000Z",
	})
	if got := len(shownIn(t, mustParse(t, raw))); got != 9 {
		t.Fatalf("the series shows %d events; want 9", got)
	}
	s, n := splitAt(t, mustParse(t, raw), date(2025, 3, 24, 9, 0))
	if got, want := rruleString(mainComponent(n, ical.CompEvent)), "FREQ=WEEKLY;COUNT=7"; got != want {
		t.Errorf("N: RRULE:%s; want RRULE:%s", got, want)
	}
	if got, want := rruleString(mainComponent(s, ical.CompEvent)), "FREQ=WEEKLY;UNTIL=20250324T085959Z"; got != want {
		t.Errorf("S: RRULE:%s; want RRULE:%s", got, want)
	}
	if got := len(shownIn(t, n)); got != 7 {
		t.Errorf("N shows %d events; want 7", got)
	}
	checkShownAsBefore(t, raw, s, n)
}

// TestSplitAcrossDST splits a Berlin series that started in winter at an
// event in summer (FR-17): S's UNTIL is R - 1 s in UTC, so S keeps the event
// a week before R and not R itself, and N starts at R's summer wall clock.
func TestSplitAcrossDST(t *testing.T) {
	t.Parallel()
	berlin, err := time.LoadLocation("Europe/Berlin")
	mustNoErr(t, err)
	raw := seriesICS([]string{
		"DTSTART;TZID=Europe/Berlin:20250106T090000", "DTEND;TZID=Europe/Berlin:20250106T100000", "RRULE:FREQ=WEEKLY",
	})
	rid := time.Date(2025, 4, 7, 9, 0, 0, 0, berlin) // CEST, 07:00 UTC
	s, n := splitAt(t, mustParse(t, raw), rid)
	if got, want := rruleString(mainComponent(s, ical.CompEvent)), "FREQ=WEEKLY;UNTIL=20250407T065959Z"; got != want {
		t.Errorf("S: RRULE:%s; want RRULE:%s", got, want)
	}
	evs, err := expandObject(calObject{path: "/cal/x.ics", cal: s}, "c", date(2025, 1, 1, 0, 0), date(2026, 1, 1, 0, 0))
	mustNoErr(t, err)
	sortEvents(evs)
	var last time.Time
	if len(evs) > 0 {
		last = evs[len(evs)-1].Start.In(berlin)
	}
	if want := time.Date(2025, 3, 31, 9, 0, 0, 0, berlin); !last.Equal(want) {
		t.Errorf("S's last event starts at %v; want %v", last, want)
	}
	nm := mainComponent(n, ical.CompEvent)
	if got, want := propLine(nm, ical.PropDateTimeStart), "DTSTART;TZID=Europe/Berlin:20250407T090000"; got != want {
		t.Errorf("N's DTSTART = %s; want %s", got, want)
	}
	if got, want := propLine(nm, ical.PropDateTimeEnd), "DTEND;TZID=Europe/Berlin:20250407T100000"; got != want {
		t.Errorf("N's DTEND = %s; want %s", got, want)
	}
	checkShownAsBefore(t, raw, s, n)
}

// TestSplitPartitionsByRecurrenceID splits a weekly series at March 24
// (FR-17). Overrides, EXDATEs and RDATEs go by the instant of their
// RECURRENCE-ID or value, in whatever form it is written, never by an
// override's own date: the override of March 17, moved past R, stays in S
// and is shown once; the one at R goes to N with N's UID. A PERIOD goes by
// its start, and a property Lucid cannot read stays in S as it is.
func TestSplitPartitionsByRecurrenceID(t *testing.T) {
	t.Parallel()
	raw := seriesICS(
		[]string{
			"DTSTART:20250303T090000Z", "DTEND:20250303T100000Z", "RRULE:FREQ=WEEKLY",
			"EXDATE:20250310T090000Z,20250331T090000Z",
			"EXDATE;TZID=Europe/Berlin:20250407T110000,", // April 7, 09:00 UTC
			"RDATE;VALUE=PERIOD:20250312T090000Z/PT2H,20250326T090000Z/20250326T100000Z",
			"RDATE:20250402T090000Z,someday", // Lucid reads neither value
		},
		[]string{
			"RECURRENCE-ID:20250317T090000Z", "DTSTART:20250325T090000Z", "DTEND:20250325T100000Z",
			"SUMMARY:Moved past R",
		},
		[]string{
			"RECURRENCE-ID;TZID=Europe/Berlin:20250324T100000", // R, 09:00 UTC
			"DTSTART:20250324T120000Z", "DTEND:20250324T130000Z", "SUMMARY:At R",
		},
		[]string{
			"RECURRENCE-ID:20250414T090000Z", "DTSTART:20250414T090000Z", "DTEND:20250414T100000Z", "SUMMARY:Later",
		},
	)
	s, n := splitAt(t, mustParse(t, raw), date(2025, 3, 24, 9, 0))
	sm, nm := mainComponent(s, ical.CompEvent), mainComponent(n, ical.CompEvent)
	for _, c := range []struct {
		what      string
		got, want []string
	}{
		{"S's EXDATEs", propLines(sm, ical.PropExceptionDates), []string{"EXDATE:20250310T090000Z"}},
		{
			"N's EXDATEs", propLines(nm, ical.PropExceptionDates),
			[]string{"EXDATE:20250331T090000Z", "EXDATE;TZID=Europe/Berlin:20250407T110000"},
		},
		{
			"S's RDATEs", propLines(sm, ical.PropRecurrenceDates),
			[]string{"RDATE;VALUE=PERIOD:20250312T090000Z/PT2H", "RDATE:20250402T090000Z,someday"},
		},
		{
			"N's RDATEs", propLines(nm, ical.PropRecurrenceDates),
			[]string{"RDATE;VALUE=PERIOD:20250326T090000Z/20250326T100000Z"},
		},
		{"S's overrides", overridesIn(s), []string{"1 RECURRENCE-ID:20250317T090000Z Moved past R"}},
		{
			"N's overrides", overridesIn(n),
			[]string{
				splitUID + " RECURRENCE-ID;TZID=Europe/Berlin:20250324T100000 At R",
				splitUID + " RECURRENCE-ID:20250414T090000Z Later",
			},
		},
	} {
		if !slices.Equal(c.got, c.want) {
			t.Errorf("%s = %q; want %q", c.what, c.got, c.want)
		}
	}
	moved := slices.DeleteFunc(shownIn(t, s), func(ev string) bool { return !strings.HasSuffix(ev, " Moved past R") })
	if want := []string{"2025-03-25T09:00:00Z/2025-03-25T10:00:00Z Moved past R"}; !slices.Equal(moved, want) {
		t.Errorf("S shows the moved event as %q; want %q", moved, want)
	}
	checkShownAsBefore(t, raw, s, n)
}

// TestSplitAtRDate splits a series at an RDATE R, which is no event of its
// rule (FR-17). N starts at the rule's first event after R, and R stays an
// RDATE of N. Without such an event, N has no RRULE and starts at R, and the
// RDATEs after R stay; without one either, N is a single event at R.
func TestSplitAtRDate(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name                 string
		master               []string
		overrides            [][]string
		sRule, nRule         string
		sRDates, nRDates     []string
		nStart, nEnd         string
		nExdates, nOverrides []string
		shownAsBefore        bool
	}{
		{
			name: "a rule event after R",
			master: []string{
				"RRULE:FREQ=WEEKLY;COUNT=10", "RDATE:20250312T090000Z,20250326T090000Z",
			},
			// Of the ten, March 3, 10, 17 and 24 lie before N's start.
			sRule: "FREQ=WEEKLY;UNTIL=20250326T085959Z", nRule: "FREQ=WEEKLY;COUNT=6",
			sRDates: []string{"RDATE:20250312T090000Z"}, nRDates: []string{"RDATE:20250326T090000Z"},
			nStart: "DTSTART:20250331T090000Z", nEnd: "DTEND:20250331T100000Z", shownAsBefore: true,
		},
		{
			name: "no rule event after R, a later RDATE",
			master: []string{
				"RRULE:FREQ=WEEKLY;COUNT=3", "RDATE:20250312T090000Z,20250326T090000Z,20250402T090000Z",
				"EXDATE:20250310T090000Z,20250409T090000Z", "RDATE:20250409T090000Z",
			},
			overrides: [][]string{{
				"RECURRENCE-ID:20250402T090000Z", "DTSTART:20250402T100000Z", "DTEND:20250402T110000Z",
				"SUMMARY:Later",
			}},
			// The rule's three events lie before R: its COUNT ends S as it is.
			sRule: "FREQ=WEEKLY;COUNT=3", nRule: "",
			sRDates: []string{"RDATE:20250312T090000Z"},
			nRDates: []string{"RDATE:20250402T090000Z", "RDATE:20250409T090000Z"},
			nStart:  "DTSTART:20250326T090000Z", nEnd: "DTEND:20250326T100000Z",
			nExdates:      []string{"EXDATE:20250409T090000Z"},
			nOverrides:    []string{splitUID + " RECURRENCE-ID:20250402T090000Z Later"},
			shownAsBefore: true,
		},
		{
			name: "the last RDATE",
			master: []string{
				"RRULE:FREQ=WEEKLY;COUNT=3", "RDATE:20250326T090000Z", "EXDATE:20250310T090000Z,20250402T090000Z",
			},
			sRule: "FREQ=WEEKLY;COUNT=3", nRule: "",
			nStart: "DTSTART:20250326T090000Z", nEnd: "DTEND:20250326T100000Z", shownAsBefore: true,
		},
		{
			name:    "RDATEs only",
			master:  []string{"RDATE:20250312T090000Z,20250326T090000Z,20250402T090000Z"},
			sRDates: []string{"RDATE:20250312T090000Z"}, nRDates: []string{"RDATE:20250402T090000Z"},
			nStart: "DTSTART:20250326T090000Z", nEnd: "DTEND:20250326T100000Z", shownAsBefore: true,
		},
		{
			// A single event has no events to override: N is R as shown, the
			// override laid over the master (see TestSplitOffSingleEvent).
			name:   "the last RDATE, overridden",
			master: []string{"RRULE:FREQ=WEEKLY;COUNT=3", "RDATE:20250326T090000Z"},
			overrides: [][]string{{
				"RECURRENCE-ID:20250326T090000Z", "DTSTART:20250326T140000Z", "DTEND:20250326T150000Z",
				"SUMMARY:At R",
			}},
			sRule: "FREQ=WEEKLY;COUNT=3", nRule: "",
			nStart: "DTSTART:20250326T140000Z", nEnd: "DTEND:20250326T150000Z", shownAsBefore: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			raw := seriesICS(append([]string{"DTSTART:20250303T090000Z", "DTEND:20250303T100000Z"}, tt.master...),
				tt.overrides...)
			s, n := splitAt(t, mustParse(t, raw), date(2025, 3, 26, 9, 0))
			sm, nm := mainComponent(s, ical.CompEvent), mainComponent(n, ical.CompEvent)
			if got := rruleString(sm); got != tt.sRule {
				t.Errorf("S: RRULE:%s; want RRULE:%s", got, tt.sRule)
			}
			if got := rruleString(nm); got != tt.nRule {
				t.Errorf("N: RRULE:%s; want RRULE:%s", got, tt.nRule)
			}
			for _, c := range []struct {
				what      string
				got, want []string
			}{
				{"S's RDATEs", propLines(sm, ical.PropRecurrenceDates), tt.sRDates},
				{"N's RDATEs", propLines(nm, ical.PropRecurrenceDates), tt.nRDates},
				{"N's DTSTART", propLines(nm, ical.PropDateTimeStart), []string{tt.nStart}},
				{"N's DTEND", propLines(nm, ical.PropDateTimeEnd), []string{tt.nEnd}},
				{"N's EXDATEs", propLines(nm, ical.PropExceptionDates), tt.nExdates},
				{"N's overrides", overridesIn(n), tt.nOverrides},
				{"S's overrides", overridesIn(s), nil},
			} {
				if !slices.Equal(c.got, c.want) {
					t.Errorf("%s = %q; want %q", c.what, c.got, c.want)
				}
			}
			if tt.shownAsBefore {
				checkShownAsBefore(t, raw, s, n)
			}
		})
	}
}

// TestSplitOffCopiesTheSeries checks that N is a copy that shares nothing
// with the series (FR-17): changing N leaves the series as it was. N has a
// UID, SEQUENCE and timestamps of its own, its master comes first, a
// DURATION stays, and the VTIMEZONEs, other components and the calendar's
// properties are copied as they are.
func TestSplitOffCopiesTheSeries(t *testing.T) {
	t.Parallel()
	lines := append([]string{"X-WR-CALNAME:Home"}, berlinVTimezone...)
	lines = append(lines,
		"BEGIN:X-EXTRA", "X-NOTE:kept", "END:X-EXTRA",
		"BEGIN:VEVENT", "UID:1", "DTSTAMP:20250101T000000Z", "SUMMARY:Later",
		"RECURRENCE-ID;TZID=Europe/Berlin:20250331T090000", "DTSTART;TZID=Europe/Berlin:20250331T110000",
		"DURATION:PT1H", "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Later", "TRIGGER:-PT5M", "END:VALARM",
		"END:VEVENT",
		"BEGIN:VEVENT", "UID:1", "DTSTAMP:20250101T000000Z", "SUMMARY:Earlier",
		"RECURRENCE-ID;TZID=Europe/Berlin:20250310T090000", "DTSTART;TZID=Europe/Berlin:20250310T110000",
		"END:VEVENT",
		"BEGIN:VEVENT", "UID:1", "DTSTAMP:20250101T000000Z", "CREATED:20241201T000000Z",
		"LAST-MODIFIED:20250101T000000Z", "SEQUENCE:4", "SUMMARY:Series", "CATEGORIES:Work",
		"DTSTART;TZID=Europe/Berlin:20250303T090000", "DURATION:PT1H30M", "RRULE:FREQ=WEEKLY",
		"BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Soon", "TRIGGER:-PT15M", "END:VALARM",
		"END:VEVENT",
	)
	cal := mustParse(t, ics(lines...))
	master := mainComponent(cal, ical.CompEvent)
	tm, err := parseTiming(master)
	mustNoErr(t, err)
	before := encodeCal(t, cal)
	n, err := splitOff(cal, master, tm, date(2025, 3, 24, 8, 0), splitUID, splitNow)
	mustNoErr(t, err)

	var names []string
	for _, c := range n.Children {
		names = append(names, c.Name+" "+text(c.Props, ical.PropSummary))
	}
	if want := []string{"VTIMEZONE ", "X-EXTRA ", "VEVENT Series", "VEVENT Later"}; !slices.Equal(names, want) {
		t.Fatalf("N's components = %q; want %q", names, want)
	}
	if got, want := propLine(n.Component, "X-WR-CALNAME"), "X-WR-CALNAME:Home"; got != want {
		t.Errorf("N's calendar has %s; want %s", got, want)
	}
	tz, extra, nm, ov := n.Children[0], n.Children[1], n.Children[2], n.Children[3]
	if got, want := encodeCal(t, &ical.Calendar{Component: tz}), encodeCal(t, &ical.Calendar{Component: cal.Children[0]}); got != want {
		t.Errorf("N's VTIMEZONE =\n%s\nwant\n%s", got, want)
	}
	if got, want := propLine(extra, "X-NOTE"), "X-NOTE:kept"; got != want {
		t.Errorf("N's X-EXTRA has %s; want %s", got, want)
	}
	for _, c := range []struct{ got, want string }{
		{propLine(nm, ical.PropUID), "UID:" + splitUID},
		{propLine(nm, ical.PropSequence), "SEQUENCE:0"},
		{propLine(nm, ical.PropDateTimeStamp), "DTSTAMP:20250601T120000Z"},
		{propLine(nm, ical.PropCreated), "CREATED:20250601T120000Z"},
		{propLine(nm, ical.PropLastModified), "LAST-MODIFIED:20250601T120000Z"},
		{propLine(nm, ical.PropCategories), "CATEGORIES:Work"},
		{propLine(nm, ical.PropDateTimeStart), "DTSTART;TZID=Europe/Berlin:20250324T090000"},
		{propLine(nm, ical.PropDuration), "DURATION:PT1H30M"},
		{propLine(nm, ical.PropDateTimeEnd), ""},
		{propLine(nm, ical.PropRecurrenceRule), "RRULE:FREQ=WEEKLY"},
		{propLine(ov, ical.PropUID), "UID:" + splitUID},
		{propLine(ov, ical.PropDateTimeStamp), "DTSTAMP:20250101T000000Z"},
	} {
		if c.got != c.want {
			t.Errorf("N has %s; want %s", c.got, c.want)
		}
	}
	if len(nm.Children) != 1 || text(nm.Children[0].Props, ical.PropDescription) != "Soon" {
		t.Errorf("N's master has %d children; want its VALARM", len(nm.Children))
	}

	// Change everything in N that a copy could share with the series.
	n.Props.Get("X-WR-CALNAME").Value = "Changed"
	tz.Props.Get(ical.PropTimezoneID).Value = "Changed"
	tz.Children[0].Props.Get(ical.PropTimezoneOffsetTo).Value = "+0300"
	extra.Props.Get("X-NOTE").Value = "changed"
	for _, c := range []*ical.Component{nm, ov} {
		c.Props.Get(ical.PropDateTimeStart).Params.Set(ical.ParamTimezoneID, "Changed")
		c.Props.Get(ical.PropDateTimeStamp).Value = "20300101T000000Z"
		c.Children[0].Props.SetText(ical.PropDescription, "Changed")
		c.Children = append(c.Children, ical.NewComponent(ical.CompAlarm))
	}
	ov.Props.Get(ical.PropRecurrenceID).Params.Set(ical.ParamTimezoneID, "Changed")
	nm.Props.Get(ical.PropRecurrenceRule).Value = "FREQ=DAILY"
	n.Children = n.Children[:1]
	if got := encodeCal(t, cal); got != before {
		t.Errorf("changing N changed the series:\n%s\nwant\n%s", got, before)
	}
}

// TestSplitOffKeepsDuration checks that N's DTEND keeps the series'
// duration, written in DTEND's own form, and that a DURATION stays (FR-17).
func TestSplitOffKeepsDuration(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name             string
		start, end       string
		rid              time.Time
		wantEnd, wantDur string
	}{
		{
			// 08:00 to 09:30 UTC in winter; the split at the fifth event, in
			// summer, keeps the hour and a half: 07:00 to 08:30 UTC.
			"DTEND in UTC", "DTSTART;TZID=Europe/Berlin:20250303T090000", "DTEND:20250303T093000Z",
			date(2025, 3, 31, 7, 0), "DTEND:20250331T083000Z", "",
		},
		{
			// 08:00 to 09:00 UTC; New York keeps summer time from March 9.
			"DTEND in another zone", "DTSTART;TZID=Europe/Berlin:20250303T090000",
			"DTEND;TZID=America/New_York:20250303T040000", date(2025, 3, 24, 8, 0),
			"DTEND;TZID=America/New_York:20250324T050000", "",
		},
		{
			"all-day over two days", "DTSTART;VALUE=DATE:20250303", "DTEND;VALUE=DATE:20250305",
			date(2025, 3, 24, 0, 0), "DTEND;VALUE=DATE:20250326", "",
		},
		{
			"DURATION", "DTSTART:20250303T090000Z", "DURATION:PT45M",
			date(2025, 3, 24, 9, 0), "", "DURATION:PT45M",
		},
		{"all-day without an end", "DTSTART;VALUE=DATE:20250303", "", date(2025, 3, 24, 0, 0), "", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			master := []string{tt.start, "RRULE:FREQ=WEEKLY"}
			if tt.end != "" {
				master = append(master, tt.end)
			}
			raw := seriesICS(master)
			s, n := splitAt(t, mustParse(t, raw), tt.rid)
			nm := mainComponent(n, ical.CompEvent)
			if got := propLine(nm, ical.PropDateTimeEnd); got != tt.wantEnd {
				t.Errorf("N's DTEND = %q; want %q", got, tt.wantEnd)
			}
			if got := propLine(nm, ical.PropDuration); got != tt.wantDur {
				t.Errorf("N's DURATION = %q; want %q", got, tt.wantDur)
			}
			checkShownAsBefore(t, raw, s, n)
		})
	}
}

// TestEndBeforeRefusesUnreadableRule checks that a rule Lucid cannot walk to
// R, one ruleInstances cannot read or one that does not reach R within
// maxRRuleIterations events, is refused by both endBefore and splitOff,
// which change nothing (FR-17).
func TestEndBeforeRefusesUnreadableRule(t *testing.T) {
	t.Parallel()
	for _, tt := range []struct{ name, rule string }{
		{"RSCALE", "RRULE:FREQ=WEEKLY;RSCALE=GREGORIAN"},
		{"beyond the iteration cap", "RRULE:FREQ=SECONDLY"}, // 172,800 events before R
	} {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			cal := mustParse(t, seriesICS([]string{"DTSTART:20250303T090000Z", "DTEND:20250303T100000Z", tt.rule}))
			master := mainComponent(cal, ical.CompEvent)
			tm, err := parseTiming(master)
			mustNoErr(t, err)
			rid := date(2025, 3, 5, 9, 0)
			before := encodeCal(t, cal)
			if n, err := splitOff(cal, master, tm, rid, splitUID, splitNow); err == nil || n != nil {
				t.Errorf("splitOff = %v, %v; want an error", n, err)
			}
			if err := endBefore(cal, master, tm, rid); err == nil {
				t.Error("endBefore = nil; want an error")
			}
			if got := encodeCal(t, cal); got != before {
				t.Errorf("the series changed:\n%s\nwant\n%s", got, before)
			}
		})
	}
}

// TestEndBeforeRefusesStart checks that endBefore refuses an R at or before
// DTSTART, which only an RDATE or override before DTSTART leaves
// possible, and changes nothing: DTSTART is always an event of the series
// (RFC 5545 section 3.8.5.3), so it cannot end before R (FR-17).
func TestEndBeforeRefusesStart(t *testing.T) {
	t.Parallel()
	for _, tt := range []struct {
		name string
		rid  time.Time
	}{
		{"at DTSTART", date(2025, 3, 3, 9, 0)},
		{"at an RDATE before DTSTART", date(2025, 3, 1, 9, 0)},
	} {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			cal := mustParse(t, seriesICS([]string{
				"DTSTART:20250303T090000Z", "DTEND:20250303T100000Z", "RRULE:FREQ=WEEKLY",
				"RDATE:20250224T090000Z,20250301T090000Z",
			}))
			master := mainComponent(cal, ical.CompEvent)
			tm, err := parseTiming(master)
			mustNoErr(t, err)
			before := encodeCal(t, cal)
			mustErr(t, endBefore(cal, master, tm, tt.rid), errSplitAtStart)
			if got := encodeCal(t, cal); got != before {
				t.Errorf("the series changed:\n%s\nwant\n%s", got, before)
			}
		})
	}
}

// TestSplitOffAddsMissingVTimezone checks that N gets a VTIMEZONE for its
// TZID where the series had none, as RFC 5545 section 3.6.5 wants one for
// each TZID, and that the series stays without (FR-17).
func TestSplitOffAddsMissingVTimezone(t *testing.T) {
	t.Parallel()
	cal := mustParse(t, ics(
		"BEGIN:VEVENT", "UID:1", "DTSTAMP:20250101T000000Z", "DTSTART;TZID=Europe/Paris:20250303T090000",
		"DTEND;TZID=Europe/Paris:20250303T100000", "RRULE:FREQ=WEEKLY", "END:VEVENT",
	))
	s, n := splitAt(t, cal, date(2025, 3, 24, 8, 0))
	if tz := findVTimezone(n, "Europe/Paris"); tz == nil {
		t.Error("N has no VTIMEZONE for Europe/Paris")
	}
	if tz := findVTimezone(s, "Europe/Paris"); tz != nil {
		t.Error("S got a VTIMEZONE")
	}
}

// TestWithCount checks that withCount ends a rule with one COUNT, in the
// place of its COUNT or UNTIL, or added at the end (FR-17).
func TestWithCount(t *testing.T) {
	t.Parallel()
	for _, tt := range []struct{ rule, want string }{
		{"FREQ=WEEKLY;COUNT=10;BYDAY=MO", "FREQ=WEEKLY;COUNT=3;BYDAY=MO"},
		{"UNTIL=20250505T090000Z;FREQ=WEEKLY", "COUNT=3;FREQ=WEEKLY"},
		{"FREQ=WEEKLY;COUNT=10;UNTIL=20250505T090000Z", "FREQ=WEEKLY;COUNT=3"},
		{"freq=weekly;until=20250505T090000Z", "freq=weekly;COUNT=3"},
		{"FREQ=WEEKLY", "FREQ=WEEKLY;COUNT=3"},
	} {
		if got := withCount(tt.rule, 3); got != tt.want {
			t.Errorf("withCount(%q, 3) = %q; want %q", tt.rule, got, tt.want)
		}
	}
}

// TestSplitOffSingleEvent splits a series at its last RDATE, R, with no
// event of its rule after it, where N is a single event (FR-17). An override
// at R is the event as shown, so it is laid over N's master: its properties
// and components replace the master's of the same name, its DTSTART, DTEND
// and DURATION together where ListEvents shows the override at its own
// times, while N keeps its own UID, SEQUENCE and timestamps. A single event
// shows no overrides, so an override off the rule after R goes.
func TestSplitOffSingleEvent(t *testing.T) {
	t.Parallel()
	master := []string{
		"DTSTART:20250303T090000Z", "DTEND:20250303T100000Z", "RRULE:FREQ=WEEKLY;COUNT=3",
		"RDATE:20250326T090000Z", "CATEGORIES:Work",
		"BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Series alarm", "TRIGGER:-PT15M", "END:VALARM",
	}
	atR := []string{
		"RECURRENCE-ID:20250326T090000Z", "SEQUENCE:5", "CREATED:20240101T000000Z",
		"LAST-MODIFIED:20250201T000000Z", "DTSTART:20250326T140000Z", "DURATION:PT30M", "SUMMARY:At R",
		"CATEGORIES:Home",
		"BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:R alarm", "TRIGGER:-PT5M", "END:VALARM",
	}
	orphan := []string{
		"RECURRENCE-ID:20250402T090000Z", "DTSTART:20250402T090000Z", "DTEND:20250402T100000Z",
		"SUMMARY:Orphan",
	}
	own := map[string]string{
		ical.PropUID:           "UID:" + splitUID,
		ical.PropSequence:      "SEQUENCE:0",
		ical.PropDateTimeStamp: "DTSTAMP:20250601T120000Z",
		ical.PropCreated:       "CREATED:20250601T120000Z",
		ical.PropLastModified:  "LAST-MODIFIED:20250601T120000Z",
	}
	with := func(extra map[string]string) map[string]string {
		out := maps.Clone(own)
		maps.Copy(out, extra)
		return out
	}
	tests := []struct {
		name      string
		overrides [][]string
		want      map[string]string // N's master; a property not named is absent
		alarms    []string          // the descriptions of N's master's VALARMs
		shown     []string          // nil: as the series showed them
	}{
		{
			name:      "full override",
			overrides: [][]string{atR},
			want: with(map[string]string{
				ical.PropDateTimeStart: "DTSTART:20250326T140000Z", ical.PropDuration: "DURATION:PT30M",
				ical.PropSummary: "SUMMARY:At R", ical.PropCategories: "CATEGORIES:Home",
			}),
			alarms: []string{"R alarm"},
		},
		{
			// Without a DTSTART, ListEvents shows the override at the
			// series' times, which N keeps.
			name:      "override without times",
			overrides: [][]string{{"RECURRENCE-ID:20250326T090000Z", "SUMMARY:At R", "DTEND:20250326T110000Z"}},
			want: with(map[string]string{
				ical.PropDateTimeStart: "DTSTART:20250326T090000Z", ical.PropDateTimeEnd: "DTEND:20250326T100000Z",
				ical.PropSummary: "SUMMARY:At R", ical.PropCategories: "CATEGORIES:Work",
			}),
			alarms: []string{"Series alarm"},
		},
		{
			name:      "an override off the rule after R",
			overrides: [][]string{atR, orphan},
			want: with(map[string]string{
				ical.PropDateTimeStart: "DTSTART:20250326T140000Z", ical.PropDuration: "DURATION:PT30M",
				ical.PropSummary: "SUMMARY:At R", ical.PropCategories: "CATEGORIES:Home",
			}),
			alarms: []string{"R alarm"},
			shown: []string{
				"2025-03-03T09:00:00Z/2025-03-03T10:00:00Z Series", "2025-03-10T09:00:00Z/2025-03-10T10:00:00Z Series",
				"2025-03-17T09:00:00Z/2025-03-17T10:00:00Z Series", "2025-03-26T14:00:00Z/2025-03-26T14:30:00Z At R",
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			raw := seriesICS(master, tt.overrides...)
			s, n := splitAt(t, mustParse(t, raw), date(2025, 3, 26, 9, 0))
			nm := mainComponent(n, ical.CompEvent)
			for _, name := range []string{
				ical.PropUID, ical.PropSequence, ical.PropDateTimeStamp, ical.PropCreated, ical.PropLastModified,
				ical.PropRecurrenceID, ical.PropDateTimeStart, ical.PropDateTimeEnd, ical.PropDuration,
				ical.PropSummary, ical.PropCategories, ical.PropRecurrenceRule, ical.PropRecurrenceDates,
			} {
				if got := propLine(nm, name); got != tt.want[name] {
					t.Errorf("N's %s = %q; want %q", name, got, tt.want[name])
				}
			}
			var alarms []string
			for _, c := range nm.Children {
				alarms = append(alarms, c.Name+" "+text(c.Props, ical.PropDescription))
			}
			var want []string
			for _, a := range tt.alarms {
				want = append(want, ical.CompAlarm+" "+a)
			}
			if !slices.Equal(alarms, want) {
				t.Errorf("N's master has %q; want %q", alarms, want)
			}
			if got := overridesIn(n); got != nil {
				t.Errorf("N's overrides = %q; want none", got)
			}
			if tt.shown == nil {
				checkShownAsBefore(t, raw, s, n)
			} else if got := shownIn(t, s, n); !slices.Equal(got, tt.shown) {
				t.Errorf("S and N show %q; want %q", got, tt.shown)
			}
		})
	}
}
