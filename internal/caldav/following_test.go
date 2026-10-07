package caldav

import (
	"bytes"
	"errors"
	"io"
	"log/slog"
	"maps"
	"net/http"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/emersion/go-ical"

	"github.com/tbckr/lucid/internal/caldav/caldavtest"
	"github.com/tbckr/lucid/internal/domain"
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
	n, err = splitOff(cal, master, tm, rid, splitUID, splitNow, false)
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

// overridesIn returns the overrides in cal, of an event or a task series,
// each as its UID, RECURRENCE-ID and title.
func overridesIn(cal *ical.Calendar) []string {
	var out []string
	for _, c := range cal.Children {
		if (c.Name == ical.CompEvent || c.Name == ical.CompToDo) && c.Props.Get(ical.PropRecurrenceID) != nil {
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
// its start. An RDATE property Lucid cannot read stays in S as it is, as in
// both it would add its events twice; an EXDATE one goes to both, as another
// client may read it, and it excludes nothing outside a series' range.
func TestSplitPartitionsByRecurrenceID(t *testing.T) {
	t.Parallel()
	raw := seriesICS(
		[]string{
			"DTSTART:20250303T090000Z", "DTEND:20250303T100000Z", "RRULE:FREQ=WEEKLY",
			"EXDATE:20250310T090000Z,20250331T090000Z",
			"EXDATE;TZID=Europe/Berlin:20250407T110000,", // April 7, 09:00 UTC
			"EXDATE:20250421T090000Z,never",              // Lucid reads neither value
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
		{
			"S's EXDATEs", propLines(sm, ical.PropExceptionDates),
			[]string{"EXDATE:20250310T090000Z", "EXDATE:20250421T090000Z,never"},
		},
		{
			"N's EXDATEs", propLines(nm, ical.PropExceptionDates),
			[]string{
				"EXDATE:20250331T090000Z", "EXDATE;TZID=Europe/Berlin:20250407T110000",
				"EXDATE:20250421T090000Z,never",
			},
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
	n, err := splitOff(cal, master, tm, date(2025, 3, 24, 8, 0), splitUID, splitNow, false)
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
			// Whatever the reason, a split Lucid cannot compute is one it does
			// not support.
			if n, err := splitOff(cal, master, tm, rid, splitUID, splitNow, false); !errors.Is(err, domain.ErrSeriesSplitUnsupported) || n != nil {
				t.Errorf("splitOff = %v, %v; want ErrSeriesSplitUnsupported", n, err)
			}
			if err := endBefore(cal, master, tm, rid); !errors.Is(err, domain.ErrSeriesSplitUnsupported) {
				t.Errorf("endBefore = %v; want ErrSeriesSplitUnsupported", err)
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
			err = endBefore(cal, master, tm, tt.rid)
			mustErr(t, err, errSplitAtStart)
			mustErr(t, err, domain.ErrSeriesSplitUnsupported)
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
// shows no overrides: an override off the rule after R that the series does
// not show goes, and one it shows refuses the split.
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
	excluded := []string{
		"RECURRENCE-ID:20250409T090000Z", "DTSTART:20250409T090000Z", "DTEND:20250409T100000Z",
		"SUMMARY:Excluded",
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
		exdate    string            // an EXDATE of the series, if any
		want      map[string]string // N's master; a property not named is absent
		alarms    []string          // the descriptions of N's master's VALARMs
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
			// The series shows neither, so neither is lost.
			name:      "overrides off the rule after R, cancelled or excluded",
			overrides: [][]string{atR, append(slices.Clone(orphan), "STATUS:CANCELLED"), excluded},
			exdate:    "EXDATE:20250409T090000Z",
			want: with(map[string]string{
				ical.PropDateTimeStart: "DTSTART:20250326T140000Z", ical.PropDuration: "DURATION:PT30M",
				ical.PropSummary: "SUMMARY:At R", ical.PropCategories: "CATEGORIES:Home",
			}),
			alarms: []string{"R alarm"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			lines := master
			if tt.exdate != "" {
				lines = append(slices.Clone(master), tt.exdate)
			}
			raw := seriesICS(lines, tt.overrides...)
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
			checkShownAsBefore(t, raw, s, n)
		})
	}

	// P4 caveat, final review: a single event shows no overrides, so N would
	// lose an override off the rule after R that the series shows. The split
	// is refused instead, and the series stays as it is.
	t.Run("an override off the rule after R", func(t *testing.T) {
		t.Parallel()
		cal := mustParse(t, seriesICS(master, atR, orphan))
		m := mainComponent(cal, ical.CompEvent)
		tm, err := parseTiming(m)
		mustNoErr(t, err)
		before := encodeCal(t, cal)
		_, err = splitOff(cal, m, tm, date(2025, 3, 26, 9, 0), splitUID, splitNow, false)
		mustErr(t, err, domain.ErrSeriesSplitUnsupported)
		if got := encodeCal(t, cal); got != before {
			t.Errorf("splitOff changed the series:\n%s\nwant\n%s", got, before)
		}
	})
}

// weeklyStandup returns the components of a weekly series "Standup" from
// Monday, March 3, 2025, 09:00 to 10:00 in Berlin, with the VTIMEZONE and
// the extra lines in the master: the series of the DeleteFollowing tests.
// Its fourth event, March 24, is at 08:00Z, still in winter time.
func weeklyStandup(extra ...string) []string {
	return slices.Concat(berlinVTimezone, []string{
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Standup",
		"DTSTART;TZID=Europe/Berlin:20250303T090000", "DTEND;TZID=Europe/Berlin:20250303T100000",
		"RRULE:FREQ=WEEKLY",
	}, extra, []string{"END:VEVENT"})
}

// followingEnd is what DeleteFollowing answered for a series seeded with
// deleteFollowing, and what the server saw of it.
type followingEnd struct {
	id, seeded string
	next       string
	snap       *domain.Snapshot
	err        error
	puts       int
	deletes    int
}

// deleteFollowing seeds lines as a resource in the calendar "work", shows its
// events once, as a client does, and then ends the series before rid with
// DeleteFollowing.
func deleteFollowing(t *testing.T, e *env, lines []string, rid time.Time) followingEnd {
	t.Helper()
	id := e.put(t, "work", "series.ics", lines...)
	objPath, _, err := decodeObjectID(e.mock.HomePath(), id)
	mustNoErr(t, err)
	etag := storedETag(t, e, objPath)
	_, err = e.svc.ListEvents(t.Context(), e.cals["work"], date(2025, 3, 1, 0, 0), date(2025, 5, 1, 0, 0))
	mustNoErr(t, err)
	seeded := storedObject(t, e, id)
	e.mock.ResetCounts()
	next, snap, err := e.svc.DeleteFollowing(t.Context(), id, etag, rid)
	return followingEnd{
		id: id, seeded: seeded, next: next, snap: snap, err: err,
		puts: e.mock.Count(http.MethodPut), deletes: e.mock.Count(http.MethodDelete),
	}
}

// listedEvents returns the events of the calendar "work" in March and April
// 2025 as ListEvents shows them, each as its start, end and title.
func listedEvents(t *testing.T, e *env) []string {
	t.Helper()
	evs, err := e.svc.ListEvents(t.Context(), e.cals["work"], date(2025, 3, 1, 0, 0), date(2025, 5, 1, 0, 0))
	mustNoErr(t, err)
	var out []string
	for i := range evs {
		out = append(out, evs[i].Start.Format(time.RFC3339)+"/"+evs[i].End.Format(time.RFC3339)+" "+evs[i].Title)
	}
	slices.Sort(out)
	return out
}

// TestDeleteFollowing checks that DeleteFollowing ends the series before the
// occurrence in one write: S ends just before it, in the form of its DTSTART,
// the EXDATEs, RDATEs and overrides from there on go, the series' SEQUENCE
// goes up, and the answer is the new ETag and the snapshot that undoes it,
// the resource as it was (FR-17). ListEvents shows the change at once.
func TestDeleteFollowing(t *testing.T) {
	t.Parallel()
	override := func(title, rid, start, end string) []string {
		return []string{
			"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:" + title,
			"RECURRENCE-ID:" + rid, "DTSTART:" + start, "DTEND:" + end, "END:VEVENT",
		}
	}
	tests := []struct {
		name      string
		lines     []string
		rid       time.Time
		rule      string   // the stored RRULE
		overrides []string // the stored overrides, as overridesIn lists them
		shown     []string
	}{
		{
			// Mondays 09:00 CET, so R is 08:00Z, and UNTIL is one second
			// before it, in UTC (RFC 5545 section 3.3.10).
			name:  "in a zone, without an end",
			lines: weeklyStandup(),
			rid:   date(2025, 3, 24, 8, 0),
			rule:  "RRULE:FREQ=WEEKLY;UNTIL=20250324T075959Z",
			shown: []string{
				"2025-03-03T08:00:00Z/2025-03-03T09:00:00Z Standup", "2025-03-10T08:00:00Z/2025-03-10T09:00:00Z Standup",
				"2025-03-17T08:00:00Z/2025-03-17T09:00:00Z Standup",
			},
		},
		{
			// A date wants a date: the day before R.
			name: "all-day, with a COUNT",
			lines: []string{
				"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Garbage",
				"DTSTART;VALUE=DATE:20250303", "DTEND;VALUE=DATE:20250304", "RRULE:FREQ=WEEKLY;COUNT=10", "END:VEVENT",
			},
			rid:  date(2025, 3, 24, 0, 0),
			rule: "RRULE:FREQ=WEEKLY;UNTIL=20250323",
			shown: []string{
				"2025-03-03T00:00:00Z/2025-03-04T00:00:00Z Garbage", "2025-03-10T00:00:00Z/2025-03-11T00:00:00Z Garbage",
				"2025-03-17T00:00:00Z/2025-03-18T00:00:00Z Garbage",
			},
		},
		{
			// The exception and the RDATE from R on, and the override at
			// April 7, go; the override of March 10, listed before the
			// series, stays, and the series stays the first event.
			name: "exceptions from R on",
			lines: slices.Concat(
				override("Moved", "20250310T090000Z", "20250310T120000Z", "20250310T130000Z"),
				[]string{
					"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Standup",
					"DTSTART:20250303T090000Z", "DTEND:20250303T100000Z", "RRULE:FREQ=WEEKLY;COUNT=10",
					"EXDATE:20250331T090000Z", "RDATE:20250402T090000Z", "END:VEVENT",
				},
				override("Later", "20250407T090000Z", "20250407T120000Z", "20250407T130000Z"),
			),
			rid:       date(2025, 3, 24, 9, 0),
			rule:      "RRULE:FREQ=WEEKLY;UNTIL=20250324T085959Z",
			overrides: []string{"series RECURRENCE-ID:20250310T090000Z Moved"},
			shown: []string{
				"2025-03-03T09:00:00Z/2025-03-03T10:00:00Z Standup", "2025-03-10T12:00:00Z/2025-03-10T13:00:00Z Moved",
				"2025-03-17T09:00:00Z/2025-03-17T10:00:00Z Standup",
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			got := deleteFollowing(t, e, tt.lines, tt.rid)
			mustNoErr(t, got.err)
			if got.puts != 1 || got.deletes != 0 {
				t.Errorf("%d PUTs and %d DELETEs; want one PUT", got.puts, got.deletes)
			}

			stored := mustParse(t, storedObject(t, e, got.id))
			master := mainComponent(stored, ical.CompEvent)
			if first := vevents(stored)[0]; first != master {
				t.Error("the series is not the first event of the resource")
			}
			if line := propLine(master, ical.PropRecurrenceRule); line != tt.rule {
				t.Errorf("RRULE = %q; want %q", line, tt.rule)
			}
			for _, name := range []string{ical.PropExceptionDates, ical.PropRecurrenceDates} {
				if lines := propLines(master, name); lines != nil {
					t.Errorf("%s = %q; want none from R on", name, lines)
				}
			}
			if got := overridesIn(stored); !slices.Equal(got, tt.overrides) {
				t.Errorf("overrides = %q; want %q", got, tt.overrides)
			}
			if line := propLine(master, ical.PropSequence); line != "SEQUENCE:1" {
				t.Errorf("%s; want SEQUENCE:1", line)
			}
			if want := "LAST-MODIFIED:20250301T120000Z"; propLine(master, ical.PropLastModified) != want {
				t.Errorf("%s; want %s", propLine(master, ical.PropLastModified), want)
			}
			if want := storedETag(t, e, mustDecode(t, e, got.id)); got.next != want {
				t.Errorf("ETag = %q; want the stored resource's %q", got.next, want)
			}
			if shown := listedEvents(t, e); !slices.Equal(shown, tt.shown) {
				t.Errorf("shown:\n%s\nwant:\n%s", strings.Join(shown, "\n"), strings.Join(tt.shown, "\n"))
			}

			if got.snap == nil {
				t.Fatal("no snapshot")
			}
			if got.snap.Kind != domain.SnapshotEvent || got.snap.ID != got.id || got.snap.ETag != got.next ||
				string(got.snap.Data) != got.seeded {
				t.Errorf("snapshot = %+v; want the resource as seeded, with the ETag after the change", got.snap)
			}
		})
	}
}

// mustDecode returns the path of the resource id.
func mustDecode(t *testing.T, e *env, id string) string {
	t.Helper()
	objPath, _, err := decodeObjectID(e.mock.HomePath(), id)
	mustNoErr(t, err)
	return objPath
}

// TestDeleteFollowingFirst checks that ending a series before its first event
// deletes the resource, as deleting all events does: no PUT, no ETag, no
// snapshot, since nothing is left to restore (FR-17). It is the first event
// ListEvents shows, whatever DTSTART is.
func TestDeleteFollowingFirst(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name  string
		lines []string
		rid   time.Time
	}{
		{"DTSTART", weeklyStandup(), date(2025, 3, 3, 8, 0)},
		{"DTSTART excluded", weeklyStandup("EXDATE;TZID=Europe/Berlin:20250303T090000"), date(2025, 3, 10, 8, 0)},
		{"DTSTART cancelled by an override", slices.Concat(weeklyStandup(), []string{
			"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "STATUS:CANCELLED",
			"RECURRENCE-ID;TZID=Europe/Berlin:20250303T090000", "DTSTART;TZID=Europe/Berlin:20250303T090000", "END:VEVENT",
		}), date(2025, 3, 10, 8, 0)},
		{"an RDATE before DTSTART", weeklyStandup("RDATE;TZID=Europe/Berlin:20250301T090000"), date(2025, 3, 1, 8, 0)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			got := deleteFollowing(t, e, tt.lines, tt.rid)
			mustNoErr(t, got.err)
			if got.next != "" || got.snap != nil {
				t.Errorf("answered %q and a snapshot: %v; want neither", got.next, got.snap != nil)
			}
			if got.puts != 0 || got.deletes != 1 {
				t.Errorf("%d PUTs and %d DELETEs; want one DELETE", got.puts, got.deletes)
			}
			if paths := e.mock.ObjectPaths(e.paths["work"]); len(paths) != 0 {
				t.Errorf("objects = %v; want none", paths)
			}
			if shown := listedEvents(t, e); shown != nil {
				t.Errorf("shown = %q; want none", shown)
			}
		})
	}
}

// TestDeleteFollowingRefuses checks that DeleteFollowing refuses, with
// ErrSeriesSplitUnsupported and nothing written or deleted, a series it
// cannot end before an occurrence, also one that its first event would have
// deleted (FR-17): a series with an ORGANIZER or an ATTENDEE, in any of its
// events, whom a change tells; one with an EXRULE, which a new series would
// count from its own start; a rule Lucid cannot read, or cannot walk to the
// occurrence within maxRRuleIterations events; and an occurrence at or before
// DTSTART that is not the first one. TestFollowingRefusesTwoRules has the
// series with more than one RRULE.
func TestDeleteFollowingRefuses(t *testing.T) {
	t.Parallel()
	organizer := "ORGANIZER:mailto:boss@example.com"
	utc := func(extra ...string) []string {
		return slices.Concat([]string{
			"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Standup",
			"DTSTART:20250303T090000Z", "DTEND:20250303T100000Z",
		}, extra, []string{"END:VEVENT"})
	}
	tests := []struct {
		name  string
		lines []string
		rid   time.Time
	}{
		{"attendees", weeklyStandup(organizer), date(2025, 3, 17, 8, 0)},
		{"attendees, at the first", weeklyStandup("ATTENDEE:mailto:me@example.com"), date(2025, 3, 3, 8, 0)},
		{"attendees in an override only", slices.Concat(weeklyStandup(), []string{
			"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", organizer,
			"RECURRENCE-ID;TZID=Europe/Berlin:20250310T090000", "DTSTART;TZID=Europe/Berlin:20250310T100000", "END:VEVENT",
		}), date(2025, 3, 17, 8, 0)},
		{"an EXRULE", weeklyStandup("EXRULE:FREQ=WEEKLY;INTERVAL=2"), date(2025, 3, 17, 8, 0)},
		// ListEvents shows DTSTART and the RDATEs of such a series only.
		{"a rule that cannot be read", utc("RRULE:FREQ=WEEKLY;RSCALE=GREGORIAN", "RDATE:20250310T090000Z"), date(2025, 3, 10, 9, 0)},
		{"a rule that cannot be read, at the first", utc("RRULE:FREQ=WEEKLY;RSCALE=GREGORIAN"), date(2025, 3, 3, 9, 0)},
		// R is an RDATE a week after DTSTART, beyond the first 100,000 events.
		{"a rule beyond the iteration cap", utc("RRULE:FREQ=SECONDLY", "RDATE:20250310T090000Z"), date(2025, 3, 10, 9, 0)},
		{"DTSTART, with an RDATE before it", utc("RRULE:FREQ=WEEKLY", "RDATE:20250224T090000Z"), date(2025, 3, 3, 9, 0)},
		{"an RDATE before DTSTART, with one before it", utc("RRULE:FREQ=WEEKLY", "RDATE:20250224T090000Z,20250301T090000Z"), date(2025, 3, 1, 9, 0)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			got := deleteFollowing(t, e, tt.lines, tt.rid)
			mustErr(t, got.err, domain.ErrSeriesSplitUnsupported)
			if got.next != "" || got.snap != nil {
				t.Errorf("answered %q and a snapshot: %v; want neither with an error", got.next, got.snap != nil)
			}
			if got.puts != 0 || got.deletes != 0 {
				t.Errorf("%d PUTs and %d DELETEs; want none", got.puts, got.deletes)
			}
			if now := storedObject(t, e, got.id); now != got.seeded {
				t.Errorf("the resource changed:\n%s\nwant\n%s", now, got.seeded)
			}
		})
	}
}

// TestFollowingRefusesTwoRules checks that both following writes refuse a
// series with more than one RRULE, which RFC 5545 section 3.8.5.3 advises
// against, with ErrSeriesSplitUnsupported and nothing written, also at its
// first event (FR-17): Lucid reads and ends only the first rule, so the
// second would keep the series going past R, and, copied into the new
// series, show the events from R on twice. The mock stores no such series,
// as go-ical writes none, so the GET of the resource answers it.
func TestFollowingRefusesTwoRules(t *testing.T) {
	t.Parallel()
	for _, tt := range []struct {
		name  string
		rid   time.Time
		write func(t *testing.T, e *env, id, etag string, rid time.Time) error
	}{
		{"ending", date(2025, 3, 17, 8, 0), func(t *testing.T, e *env, id, etag string, rid time.Time) error {
			t.Helper()
			_, _, err := e.svc.DeleteFollowing(t.Context(), id, etag, rid)
			return err
		}},
		{"ending at the first", date(2025, 3, 3, 8, 0), func(t *testing.T, e *env, id, etag string, rid time.Time) error {
			t.Helper()
			_, _, err := e.svc.DeleteFollowing(t.Context(), id, etag, rid)
			return err
		}},
		{"splitting", date(2025, 3, 17, 8, 0), func(t *testing.T, e *env, id, etag string, rid time.Time) error {
			t.Helper()
			in := eventInputOf(shownEvent(t, e, "work", rid))
			laterBy(time.Hour)(&in)
			_, _, err := e.svc.UpdateFollowing(t.Context(), id, etag, rid, in)
			return err
		}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			id := e.put(t, "work", "series.ics", weeklyStandup()...)
			objPath := mustDecode(t, e, id)
			etag := storedETag(t, e, objPath)
			seeded := storedObject(t, e, id)
			twoRules := ics(slices.Insert(weeklyStandup(), len(weeklyStandup())-1, "RRULE:FREQ=DAILY;COUNT=40")...)
			e.mock.SetHook(func(w http.ResponseWriter, r *http.Request) bool {
				if r.Method != http.MethodGet || r.URL.Path != objPath {
					return false
				}
				w.Header().Set("ETag", etag)
				_, _ = io.WriteString(w, twoRules)
				return true
			})
			e.mock.ResetCounts()
			mustErr(t, tt.write(t, e, id, etag, tt.rid), domain.ErrSeriesSplitUnsupported)
			if n := e.mock.Count(http.MethodPut) + e.mock.Count(http.MethodDelete); n != 0 {
				t.Errorf("%d writes; want none", n)
			}
			if paths := e.mock.ObjectPaths(e.paths["work"]); len(paths) != 1 {
				t.Errorf("objects = %v; want the series only", paths)
			}
			if now := storedObject(t, e, id); now != seeded {
				t.Errorf("the resource changed:\n%s\nwant\n%s", now, seeded)
			}
		})
	}
}

// TestDeleteFollowingNotFound checks that DeleteFollowing answers ErrNotFound
// for an occurrence ListEvents shows nowhere, and ErrConflict for a stale
// ETag, writing nothing (FR-17): a series ends before something a user saw.
func TestDeleteFollowingNotFound(t *testing.T) {
	t.Parallel()
	moved := func(extra ...string) []string {
		return slices.Concat(weeklyStandup("EXDATE;TZID=Europe/Berlin:20250310T090000"), []string{
			"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Moved",
			"RECURRENCE-ID;TZID=Europe/Berlin:20250310T090000", "DTSTART;TZID=Europe/Berlin:20250310T110000",
		}, extra, []string{"END:VEVENT"})
	}
	tests := []struct {
		name  string
		lines []string
		rid   time.Time
		want  error
	}{
		{"not an occurrence", weeklyStandup(), date(2025, 3, 11, 8, 0), domain.ErrNotFound},
		{"a single event", []string{
			"BEGIN:VEVENT", "UID:once", "DTSTAMP:20250101T000000Z", "DTSTART:20250310T090000Z", "END:VEVENT",
		}, date(2025, 3, 10, 9, 0), domain.ErrNotFound},
		{"excluded, with an override", moved(), date(2025, 3, 10, 8, 0), domain.ErrNotFound},
		{"cancelled by an override", slices.Concat(weeklyStandup(), []string{
			"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "STATUS:CANCELLED",
			"RECURRENCE-ID;TZID=Europe/Berlin:20250317T090000", "DTSTART;TZID=Europe/Berlin:20250317T090000", "END:VEVENT",
		}), date(2025, 3, 17, 8, 0), domain.ErrNotFound},
		{"cancelled by an override, at the first", slices.Concat(weeklyStandup(), []string{
			"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "STATUS:cancelled",
			"RECURRENCE-ID;TZID=Europe/Berlin:20250303T090000", "DTSTART;TZID=Europe/Berlin:20250303T090000", "END:VEVENT",
		}), date(2025, 3, 3, 8, 0), domain.ErrNotFound},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			got := deleteFollowing(t, e, tt.lines, tt.rid)
			mustErr(t, got.err, tt.want)
			if got.puts != 0 || got.deletes != 0 {
				t.Errorf("%d PUTs and %d DELETEs; want none", got.puts, got.deletes)
			}
			if now := storedObject(t, e, got.id); now != got.seeded {
				t.Errorf("the resource changed:\n%s\nwant\n%s", now, got.seeded)
			}
		})
	}

	t.Run("stale ETag", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := e.put(t, "work", "series.ics", weeklyStandup()...)
		seeded := storedObject(t, e, id)
		e.mock.ResetCounts()
		_, _, err := e.svc.DeleteFollowing(t.Context(), id, `"stale"`, date(2025, 3, 17, 8, 0))
		mustErr(t, err, domain.ErrConflict)
		if n := e.mock.Count(http.MethodPut) + e.mock.Count(http.MethodDelete); n != 0 {
			t.Errorf("%d writes; want none", n)
		}
		if now := storedObject(t, e, id); now != seeded {
			t.Errorf("the resource changed:\n%s\nwant\n%s", now, seeded)
		}
	})
}

// TestDeleteFollowingWriteFails checks that a PUT the server refuses fails
// DeleteFollowing without an ETag or a snapshot, and that the whole series is
// still shown (FR-17): a write can fail after the series was read, as another
// client's write can land in between.
func TestDeleteFollowingWriteFails(t *testing.T) {
	t.Parallel()
	for _, tt := range []struct {
		name   string
		status int
		want   error
	}{
		{"precondition failed", http.StatusPreconditionFailed, domain.ErrConflict},
		{"server error", http.StatusInternalServerError, domain.ErrUpstream},
	} {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			id := e.put(t, "work", "series.ics", weeklyStandup()...)
			ev := shownEvent(t, e, "work", date(2025, 3, 17, 8, 0))
			e.mock.SetHook(func(w http.ResponseWriter, r *http.Request) bool {
				if r.Method != http.MethodPut {
					return false
				}
				w.WriteHeader(tt.status)
				return true
			})
			next, snap, err := e.svc.DeleteFollowing(t.Context(), id, ev.ETag, *ev.RecurrenceID)
			mustErr(t, err, tt.want)
			if next != "" || snap != nil {
				t.Errorf("answered %q and a snapshot: %v; want neither with an error", next, snap != nil)
			}
			if shown := listedEvents(t, e); len(shown) < 5 {
				t.Errorf("shown = %q; want the whole series", shown)
			}
		})
	}
}

// followingChange is what UpdateFollowing answered for a series seeded with
// updateFollowing, and what the server saw of it.
type followingChange struct {
	id, seeded string
	res        domain.FollowingResult
	snap       *domain.Snapshot
	err        error
	puts       int
	deletes    int
}

// updateFollowing seeds lines as a resource in the calendar "work", shows its
// events once, as a client does, and then changes the event at rid and the
// following ones with UpdateFollowing: with what the client sends to save
// that event as it is shown, changed by edit.
func updateFollowing(t *testing.T, e *env, lines []string, rid time.Time, edit func(in *domain.EventInput)) followingChange {
	t.Helper()
	id := e.put(t, "work", "series.ics", lines...)
	ev := shownEvent(t, e, "work", rid)
	seeded := storedObject(t, e, id)
	in := eventInputOf(ev)
	edit(&in)
	e.mock.ResetCounts()
	res, snap, err := e.svc.UpdateFollowing(t.Context(), id, ev.ETag, rid, in)
	return followingChange{
		id: id, seeded: seeded, res: res, snap: snap, err: err,
		puts: e.mock.Count(http.MethodPut), deletes: e.mock.Count(http.MethodDelete),
	}
}

// laterBy returns an edit that moves the event by d.
func laterBy(d time.Duration) func(in *domain.EventInput) {
	return func(in *domain.EventInput) { in.Start, in.End = in.Start.Add(d), in.End.Add(d) }
}

// newSeriesIn returns the ID and the stored data of the one resource in the
// calendar "work" besides the series id: the new series of a split.
func newSeriesIn(t *testing.T, e *env, id string) (nid, data string) {
	t.Helper()
	sPath := mustDecode(t, e, id)
	var others []string
	for _, p := range e.mock.ObjectPaths(e.paths["work"]) {
		if p != sPath {
			others = append(others, p)
		}
	}
	if len(others) != 1 {
		t.Fatalf("resources besides the series = %q; want the new series", others)
	}
	data, _ = e.mock.Object(others[0])
	return encodeID(others[0]), data
}

// shownAs writes ev as listedEvents does: its start, end and title.
func shownAs(ev domain.Event) string {
	return ev.Start.Format(time.RFC3339) + "/" + ev.End.Format(time.RFC3339) + " " + ev.Title
}

// TestUpdateFollowing checks that UpdateFollowing changes an event and the
// following ones as a series of their own, N, a resource with a UID of its
// own, while the series S ends before it: two PUTs, N's first, the change
// applied to N as "all events" applies it to a series, and S's RRULE ending
// just before R, its SEQUENCE up (FR-17; spec section 4 "Teilen"). The
// answer is the edited event in N, as ListEvents shows it, with S's new
// ETag, and the snapshot that undoes the split: S as read, and N as the
// resource the change created.
func TestUpdateFollowing(t *testing.T) {
	t.Parallel()
	// S as stored after each split: the three events before March 24.
	const sRule = "RRULE:FREQ=WEEKLY;UNTIL=20250324T075959Z"
	before := []string{
		"2025-03-03T08:00:00Z/2025-03-03T09:00:00Z Standup", "2025-03-10T08:00:00Z/2025-03-10T09:00:00Z Standup",
		"2025-03-17T08:00:00Z/2025-03-17T09:00:00Z Standup",
	}
	// weekly returns N's events in March and April at start to end, in UTC
	// before the change to summer time on March 30, and an hour earlier
	// after it, as a series on Berlin's wall clock shows them.
	weekly := func(start, end string) []string {
		var out []string
		for _, day := range []string{"03-24", "03-31", "04-07", "04-14", "04-21", "04-28"} {
			s, e := start, end
			if day != "03-24" {
				s, e = earlier(t, s), earlier(t, e)
			}
			out = append(out, "2025-"+day+"T"+s+"Z/2025-"+day+"T"+e+"Z Standup")
		}
		return out
	}
	tests := []struct {
		name      string
		edit      func(in *domain.EventInput)
		nHas      []string // in N as stored
		nLacks    []string
		shownN    []string // N's events in March and April
		answer    string   // the edited event, as shownAs writes it
		recurring bool     // whether the answer is an event of a series, N's first
	}{
		{
			// instanceStart is ignored, also one that names another event.
			name: "moved an hour later",
			edit: func(in *domain.EventInput) {
				laterBy(time.Hour)(in)
				in.InstanceStart = ptr(date(2025, 3, 10, 8, 0))
			},
			nHas: []string{
				"DTSTART;TZID=Europe/Berlin:20250324T100000", "DTEND;TZID=Europe/Berlin:20250324T110000",
				"RRULE:FREQ=WEEKLY\r\n",
			},
			shownN:    weekly("09:00:00", "10:00:00"),
			answer:    "2025-03-24T09:00:00Z/2025-03-24T10:00:00Z Standup",
			recurring: true,
		},
		{
			name: "resized",
			edit: func(in *domain.EventInput) {
				in.End = in.End.Add(30 * time.Minute)
				in.InstanceStart = nil
			},
			nHas: []string{
				"DTSTART;TZID=Europe/Berlin:20250324T090000", "DTEND;TZID=Europe/Berlin:20250324T103000",
				"RRULE:FREQ=WEEKLY\r\n",
			},
			shownN:    weekly("08:00:00", "09:30:00"),
			answer:    "2025-03-24T08:00:00Z/2025-03-24T09:30:00Z Standup",
			recurring: true,
		},
		{
			// The rule entered is N's; S keeps its own.
			name:   "a new rule",
			edit:   func(in *domain.EventInput) { in.RRule = "FREQ=DAILY;COUNT=3" },
			nHas:   []string{"DTSTART;TZID=Europe/Berlin:20250324T090000", "RRULE:FREQ=DAILY;COUNT=3"},
			nLacks: []string{"FREQ=WEEKLY"},
			shownN: []string{
				"2025-03-24T08:00:00Z/2025-03-24T09:00:00Z Standup", "2025-03-25T08:00:00Z/2025-03-25T09:00:00Z Standup",
				"2025-03-26T08:00:00Z/2025-03-26T09:00:00Z Standup",
			},
			answer:    "2025-03-24T08:00:00Z/2025-03-24T09:00:00Z Standup",
			recurring: true,
		},
		{
			// N is the single event R, stored in UTC like every single
			// event (FR-18).
			name:   "no rule",
			edit:   func(in *domain.EventInput) { in.RRule = "" },
			nHas:   []string{"DTSTART:20250324T080000Z", "DTEND:20250324T090000Z"},
			nLacks: []string{"RRULE:FREQ=WEEKLY", "RDATE", "EXDATE"},
			shownN: []string{"2025-03-24T08:00:00Z/2025-03-24T09:00:00Z Standup"},
			answer: "2025-03-24T08:00:00Z/2025-03-24T09:00:00Z Standup",
		},
		{
			name: "made all-day",
			edit: func(in *domain.EventInput) {
				in.AllDay, in.Start, in.End = true, date(2025, 3, 24, 0, 0), date(2025, 3, 25, 0, 0)
			},
			nHas: []string{"DTSTART;VALUE=DATE:20250324", "DTEND;VALUE=DATE:20250325", "RRULE:FREQ=WEEKLY\r\n"},
			shownN: []string{
				"2025-03-24T00:00:00Z/2025-03-25T00:00:00Z Standup", "2025-03-31T00:00:00Z/2025-04-01T00:00:00Z Standup",
				"2025-04-07T00:00:00Z/2025-04-08T00:00:00Z Standup", "2025-04-14T00:00:00Z/2025-04-15T00:00:00Z Standup",
				"2025-04-21T00:00:00Z/2025-04-22T00:00:00Z Standup", "2025-04-28T00:00:00Z/2025-04-29T00:00:00Z Standup",
			},
			answer:    "2025-03-24T00:00:00Z/2025-03-25T00:00:00Z Standup",
			recurring: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			got := updateFollowing(t, e, weeklyStandup(), date(2025, 3, 24, 8, 0), tt.edit)
			mustNoErr(t, got.err)
			if got.puts != 2 || got.deletes != 0 {
				t.Errorf("%d PUTs and %d DELETEs; want two PUTs", got.puts, got.deletes)
			}

			stored := mustParse(t, storedObject(t, e, got.id))
			master := mainComponent(stored, ical.CompEvent)
			if line := propLine(master, ical.PropRecurrenceRule); line != sRule {
				t.Errorf("S's RRULE = %q; want %q", line, sRule)
			}
			if line := propLine(master, ical.PropSequence); line != "SEQUENCE:1" {
				t.Errorf("S's %s; want SEQUENCE:1", line)
			}
			nid, nData := newSeriesIn(t, e, got.id)
			checkStored(t, "N", nData, append([]string{"SUMMARY:Standup", "SEQUENCE:0"}, tt.nHas...),
				append([]string{"UID:series"}, tt.nLacks...))
			if shown, want := listedEvents(t, e), slices.Concat(before, tt.shownN); !slices.Equal(shown, want) {
				t.Errorf("shown:\n%s\nwant:\n%s", strings.Join(shown, "\n"), strings.Join(want, "\n"))
			}

			ev := got.res.Event
			if shownAs(ev) != tt.answer || ev.ID != nid || ev.CalendarID != e.cals["work"] {
				t.Errorf("answer = %s in %s; want %s in the new series %s", shownAs(ev), ev.ID, tt.answer, nid)
			}
			if want := storedETag(t, e, mustDecode(t, e, nid)); ev.ETag != want {
				t.Errorf("answer's ETag = %q; want N's %q", ev.ETag, want)
			}
			if ev.Recurring != tt.recurring || ev.First != tt.recurring || (ev.RecurrenceID != nil) != tt.recurring {
				t.Errorf("answer recurring %v, first %v, recurrence ID %v; want all %v",
					ev.Recurring, ev.First, ev.RecurrenceID, tt.recurring)
			}
			if tt.recurring && !ev.RecurrenceID.Equal(ev.Start) {
				t.Errorf("answer's recurrence ID = %v; want its start, N's first event", ev.RecurrenceID)
			}
			if want := storedETag(t, e, mustDecode(t, e, got.id)); got.res.ETag != want {
				t.Errorf("ETag = %q; want S's stored %q", got.res.ETag, want)
			}

			if got.snap == nil {
				t.Fatal("no snapshot")
			}
			wantCreated := []domain.CreatedRef{{ID: nid, ETag: ev.ETag}}
			if got.snap.Kind != domain.SnapshotEvent || got.snap.ID != got.id || got.snap.ETag != got.res.ETag ||
				string(got.snap.Data) != got.seeded || !slices.Equal(got.snap.Created, wantCreated) {
				t.Errorf("snapshot = %+v; want S as seeded, with its ETag after the change, and N created", got.snap)
			}
		})
	}
}

// earlier returns the clock time hh:mm:ss an hour earlier.
func earlier(t *testing.T, clock string) string {
	t.Helper()
	c, err := time.Parse(time.TimeOnly, clock)
	mustNoErr(t, err)
	return c.Add(-time.Hour).Format(time.TimeOnly)
}

// TestUpdateFollowingFirst checks that "this and following events" at the
// first event the series shows is "all events": UpdateEvent with the event
// as instanceStart, one PUT and no new resource, also where the client's view
// is stale and an earlier event is gone (FR-17). The answer is the event in
// the series, ListEvents' first, with the series' new ETag, and the
// snapshot UpdateEvent hands out, which creates nothing.
func TestUpdateFollowingFirst(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		lines  []string
		rid    time.Time
		edit   func(in *domain.EventInput)
		has    []string // in the series as stored
		answer string
	}{
		{
			name: "DTSTART", lines: weeklyStandup(), rid: date(2025, 3, 3, 8, 0), edit: laterBy(time.Hour),
			has:    []string{"DTSTART;TZID=Europe/Berlin:20250303T100000", "RRULE:FREQ=WEEKLY\r\n"},
			answer: "2025-03-03T09:00:00Z/2025-03-03T10:00:00Z Standup",
		},
		{
			name:  "DTSTART excluded",
			lines: weeklyStandup("EXDATE;TZID=Europe/Berlin:20250303T090000"), rid: date(2025, 3, 10, 8, 0),
			edit:   laterBy(time.Hour),
			has:    []string{"DTSTART;TZID=Europe/Berlin:20250303T100000", "EXDATE;TZID=Europe/Berlin:20250303T100000"},
			answer: "2025-03-10T09:00:00Z/2025-03-10T10:00:00Z Standup",
		},
		{
			name: "a new rule", lines: weeklyStandup(), rid: date(2025, 3, 3, 8, 0),
			edit:   func(in *domain.EventInput) { in.RRule = "FREQ=DAILY;COUNT=3" },
			has:    []string{"DTSTART;TZID=Europe/Berlin:20250303T090000", "RRULE:FREQ=DAILY;COUNT=3"},
			answer: "2025-03-03T08:00:00Z/2025-03-03T09:00:00Z Standup",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			got := updateFollowing(t, e, tt.lines, tt.rid, tt.edit)
			mustNoErr(t, got.err)
			if got.puts != 1 || got.deletes != 0 {
				t.Errorf("%d PUTs and %d DELETEs; want one PUT", got.puts, got.deletes)
			}
			if paths := e.mock.ObjectPaths(e.paths["work"]); len(paths) != 1 {
				t.Errorf("objects = %v; want the series only", paths)
			}
			checkStored(t, "series", storedObject(t, e, got.id), tt.has, []string{"UNTIL"})

			ev := got.res.Event
			if shownAs(ev) != tt.answer || ev.ID != got.id || !ev.First {
				t.Errorf("answer = %s in %s, first %v; want %s in the series %s, its first", shownAs(ev), ev.ID, ev.First,
					tt.answer, got.id)
			}
			if want := storedETag(t, e, mustDecode(t, e, got.id)); got.res.ETag != want || ev.ETag != want {
				t.Errorf("ETag = %q, answer's %q; want the series' stored %q for both", got.res.ETag, ev.ETag, want)
			}
			if got.snap == nil || got.snap.ID != got.id || string(got.snap.Data) != got.seeded || got.snap.Created != nil {
				t.Errorf("snapshot = %+v; want the series as seeded, nothing created", got.snap)
			}
		})
	}
}

// TestUpdateFollowingRefuses checks that UpdateFollowing writes nothing for a
// change it refuses (FR-17): a move N cannot follow as a series, which "all
// events" refuses the same way (ErrSeriesMoveUnsupported), a series it cannot
// split (ErrSeriesSplitUnsupported, see loadFollowing), an event the series
// does not show (ErrNotFound) and input it cannot save (ErrInvalidInput).
func TestUpdateFollowingRefuses(t *testing.T) {
	t.Parallel()
	monthly := func(rule string) []string {
		return []string{
			"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Rent",
			"DTSTART:20250115T090000Z", "DTEND:20250115T100000Z", rule, "END:VEVENT",
		}
	}
	tests := []struct {
		name  string
		lines []string
		rid   time.Time
		edit  func(in *domain.EventInput)
		want  error
	}{
		// N repeats on the 15th: a rule on fixed days cannot move to another.
		// Both are domain.ErrSeriesMoveUnsupported.
		{
			"fixed days, to another day", monthly("RRULE:FREQ=MONTHLY;BYMONTHDAY=15"), date(2025, 3, 15, 9, 0),
			laterBy(24 * time.Hour), errMoveFixedDays,
		},
		// "All events" refuses it alike.
		{
			"fixed days, at the first event", []string{
				"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Rent",
				"DTSTART:20250315T090000Z", "DTEND:20250315T100000Z", "RRULE:FREQ=MONTHLY;BYMONTHDAY=15", "END:VEVENT",
			}, date(2025, 3, 15, 9, 0), laterBy(24 * time.Hour), errMoveFixedDays,
		},
		// From March 15 to 31, N's April event would land on April 31.
		{
			"onto a day its months lack", monthly("RRULE:FREQ=MONTHLY"), date(2025, 3, 15, 9, 0),
			laterBy(16 * 24 * time.Hour), errMoveOffMonth,
		},
		{
			"attendees", weeklyStandup("ATTENDEE:mailto:me@example.com"), date(2025, 3, 24, 8, 0),
			laterBy(time.Hour), domain.ErrSeriesSplitUnsupported,
		},
		{
			"an EXRULE", weeklyStandup("EXRULE:FREQ=WEEKLY;INTERVAL=2"), date(2025, 3, 24, 8, 0),
			laterBy(time.Hour), domain.ErrSeriesSplitUnsupported,
		},
		{
			"end before start", weeklyStandup(), date(2025, 3, 24, 8, 0),
			func(in *domain.EventInput) { in.End = in.Start.Add(-time.Hour) }, domain.ErrInvalidInput,
		},
		{
			"an invalid rule", weeklyStandup(), date(2025, 3, 24, 8, 0),
			func(in *domain.EventInput) { in.RRule = "FREQ=SOMETIMES" }, domain.ErrInvalidInput,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			got := updateFollowing(t, e, tt.lines, tt.rid, tt.edit)
			mustErr(t, got.err, tt.want)
			if got.puts != 0 || got.deletes != 0 {
				t.Errorf("%d PUTs and %d DELETEs; want none", got.puts, got.deletes)
			}
			if got.snap != nil || got.res.ETag != "" || got.res.Event.ID != "" {
				t.Errorf("answered %+v and a snapshot: %v; want neither with an error", got.res, got.snap != nil)
			}
			if paths := e.mock.ObjectPaths(e.paths["work"]); len(paths) != 1 {
				t.Errorf("objects = %v; want the series only", paths)
			}
			if now := storedObject(t, e, got.id); now != got.seeded {
				t.Errorf("the resource changed:\n%s\nwant\n%s", now, got.seeded)
			}
		})
	}
}

// TestUpdateFollowingCannotSplit checks that a split UpdateFollowing cannot
// compute is ErrSeriesSplitUnsupported, with nothing written (FR-17): a rule
// it cannot walk to R within maxRRuleIterations events, and a single N that
// would lose an override the series shows, where splitOff fails, and an R
// before DTSTART that is not the first event, where endBefore does.
// ListEvents does not show the first, so the request is made as a client
// with a stale view would.
func TestUpdateFollowingCannotSplit(t *testing.T) {
	t.Parallel()
	utc := func(extra ...string) []string {
		return slices.Concat([]string{
			"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Standup",
			"DTSTART:20250303T090000Z", "DTEND:20250303T100000Z",
		}, extra, []string{"END:VEVENT"})
	}
	for _, tt := range []struct {
		name  string
		lines []string
		rid   time.Time
	}{
		{"a rule beyond the iteration cap", utc("RRULE:FREQ=SECONDLY", "RDATE:20250310T090000Z"), date(2025, 3, 10, 9, 0)},
		{
			"an RDATE before DTSTART, with one before it", utc("RRULE:FREQ=WEEKLY", "RDATE:20250224T090000Z,20250301T090000Z"),
			date(2025, 3, 1, 9, 0),
		},
		// R is the last RDATE, after the rule's last event: N would be a
		// single event, which shows none of the overrides, and the one off
		// the rule after R, which the series shows, would be lost.
		{
			"an override off the rule after the last RDATE", slices.Concat(
				utc("RRULE:FREQ=WEEKLY;COUNT=3", "RDATE:20250326T090000Z"),
				[]string{
					"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Orphan",
					"RECURRENCE-ID:20250402T090000Z", "DTSTART:20250402T090000Z", "DTEND:20250402T100000Z", "END:VEVENT",
				},
			), date(2025, 3, 26, 9, 0),
		},
		// rrule-go reads rule parts in upper case only, so Lucid cannot read
		// such a rule (loadFollowing refuses it) and shows its DTSTART only:
		// the case-insensitive comparison of the rules never meets one.
		{"a rule in lower case, at DTSTART", utc("RRULE:FREQ=WEEKLY;count=10"), date(2025, 3, 3, 9, 0)},
	} {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			id := e.put(t, "work", "series.ics", tt.lines...)
			seeded := storedObject(t, e, id)
			in := domain.EventInput{Title: "Standup", Start: tt.rid.Add(time.Hour), End: tt.rid.Add(2 * time.Hour), RRule: "FREQ=WEEKLY"}
			e.mock.ResetCounts()
			_, snap, err := e.svc.UpdateFollowing(t.Context(), id, storedETag(t, e, mustDecode(t, e, id)), tt.rid, in)
			mustErr(t, err, domain.ErrSeriesSplitUnsupported)
			if n := e.mock.Count(http.MethodPut) + e.mock.Count(http.MethodDelete); n != 0 || snap != nil {
				t.Errorf("%d writes and a snapshot: %v; want neither", n, snap != nil)
			}
			if now := storedObject(t, e, id); now != seeded {
				t.Errorf("the resource changed:\n%s\nwant\n%s", now, seeded)
			}
		})
	}
}

// TestUpdateFollowingRemovesRulePastOrphan splits a series at its last RDATE,
// with no event of its rule after it, while the series shows an override off
// the rule after it (FR-17). A change that removes the rule makes N the
// single event entered, and its question says that the later events go: the
// override goes, as announced, instead of the split being refused. Any other
// change, a move that keeps the rule among them, is still refused, as N, a
// single event, would drop the override without a word.
func TestUpdateFollowingRemovesRulePastOrphan(t *testing.T) {
	t.Parallel()
	lines := []string{
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Standup",
		"DTSTART:20250303T090000Z", "DTEND:20250303T100000Z", "RRULE:FREQ=WEEKLY;COUNT=3",
		"RDATE:20250326T090000Z", "END:VEVENT",
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Orphan",
		"RECURRENCE-ID:20250402T090000Z", "DTSTART:20250402T090000Z", "DTEND:20250402T100000Z", "END:VEVENT",
	}
	rid := date(2025, 3, 26, 9, 0)

	t.Run("the rule removed", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		got := updateFollowing(t, e, lines, rid, func(in *domain.EventInput) {
			laterBy(time.Hour)(in)
			in.RRule = ""
		})
		mustNoErr(t, got.err)
		if got.puts != 2 || got.snap == nil {
			t.Errorf("%d PUTs and a snapshot: %v; want N's and S's, and a snapshot", got.puts, got.snap != nil)
		}
		_, nData := newSeriesIn(t, e, got.id)
		checkStored(t, "N", nData, []string{"DTSTART:20250326T100000Z"},
			[]string{"RRULE", "RDATE", "RECURRENCE-ID", "Orphan"})
		checkStored(t, "S", storedObject(t, e, got.id), []string{"RRULE:FREQ=WEEKLY;COUNT=3"},
			[]string{"RDATE", "RECURRENCE-ID", "Orphan"})
		want := []string{
			"2025-03-03T09:00:00Z/2025-03-03T10:00:00Z Standup", "2025-03-10T09:00:00Z/2025-03-10T10:00:00Z Standup",
			"2025-03-17T09:00:00Z/2025-03-17T10:00:00Z Standup", "2025-03-26T10:00:00Z/2025-03-26T11:00:00Z Standup",
		}
		if shown := listedEvents(t, e); !slices.Equal(shown, want) {
			t.Errorf("shown:\n%s\nwant:\n%s", strings.Join(shown, "\n"), strings.Join(want, "\n"))
		}
	})

	for _, tt := range []struct {
		name string
		edit func(in *domain.EventInput)
	}{
		{"the rule kept", laterBy(time.Hour)},
		{"a new rule", func(in *domain.EventInput) { in.RRule = "FREQ=DAILY;COUNT=2" }},
	} {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			got := updateFollowing(t, e, lines, rid, tt.edit)
			mustErr(t, got.err, domain.ErrSeriesSplitUnsupported)
			if got.puts != 0 || got.deletes != 0 || got.snap != nil {
				t.Errorf("%d PUTs, %d DELETEs and a snapshot: %v; want none", got.puts, got.deletes, got.snap != nil)
			}
			if now := storedObject(t, e, got.id); now != got.seeded {
				t.Errorf("the resource changed:\n%s\nwant\n%s", now, got.seeded)
			}
		})
	}
}

// TestUpdateFollowingNotFound checks that UpdateFollowing answers ErrNotFound
// for an event the series does not show, and ErrConflict for a stale ETag,
// writing nothing (FR-17).
func TestUpdateFollowingNotFound(t *testing.T) {
	t.Parallel()
	for _, tt := range []struct {
		name  string
		lines []string
		etag  func(shown string) string
		rid   time.Time
		want  error
	}{
		{
			"excluded", weeklyStandup("EXDATE;TZID=Europe/Berlin:20250324T090000"), func(s string) string { return s },
			date(2025, 3, 24, 8, 0), domain.ErrNotFound,
		},
		{"not an event", weeklyStandup(), func(s string) string { return s }, date(2025, 3, 25, 8, 0), domain.ErrNotFound},
		{"stale ETag", weeklyStandup(), func(string) string { return `"stale"` }, date(2025, 3, 24, 8, 0), domain.ErrConflict},
	} {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			id := e.put(t, "work", "series.ics", tt.lines...)
			seeded := storedObject(t, e, id)
			ev := shownEvent(t, e, "work", date(2025, 3, 17, 8, 0))
			in := eventInputOf(ev)
			in.Start, in.End = tt.rid, tt.rid.Add(time.Hour)
			e.mock.ResetCounts()
			_, snap, err := e.svc.UpdateFollowing(t.Context(), id, tt.etag(ev.ETag), tt.rid, in)
			mustErr(t, err, tt.want)
			if snap != nil {
				t.Error("returned a snapshot with an error")
			}
			if n := e.mock.Count(http.MethodPut) + e.mock.Count(http.MethodDelete); n != 0 {
				t.Errorf("%d writes; want none", n)
			}
			if now := storedObject(t, e, id); now != seeded {
				t.Errorf("the resource changed:\n%s\nwant\n%s", now, seeded)
			}
		})
	}
}

// TestUpdateEventFromEventSeriesLeft checks that "all events" from an event
// the series no longer shows, neither an event of its rule nor an override,
// is ErrConflict, with nothing written (FR-17, NFR-26): sent from a view not
// reloaded since the series ended or split before that event, with the ETag
// the end or split gave, as a write queued behind the client's own change
// sends it, it would write the series' old rule back, bringing deleted events
// back or showing those of the new series twice. The series changed since
// the view was loaded, as a conflict says, and the client reloads it.
func TestUpdateEventFromEventSeriesLeft(t *testing.T) {
	t.Parallel()
	rid := date(2025, 3, 24, 8, 0)
	// March 31, 09:00 in Berlin summer time, the event after R.
	after := date(2025, 3, 31, 7, 0)
	for _, tt := range []struct {
		name string
		// change changes the series, whose ETag is etag, and returns its new one.
		change func(t *testing.T, e *env, id, etag string) string
		at     time.Time // the event the stale view shows
		from   time.Time // its recurrence ID as sent
	}{
		{
			name: "ended before it",
			change: func(t *testing.T, e *env, id, etag string) string {
				t.Helper()
				next, _, err := e.svc.DeleteFollowing(t.Context(), id, etag, rid)
				mustNoErr(t, err)
				return next
			},
			at: after, from: after,
		},
		{
			name: "split before it",
			change: func(t *testing.T, e *env, id, etag string) string {
				t.Helper()
				in := eventInputOf(shownEvent(t, e, "work", rid))
				laterBy(time.Hour)(&in)
				res, _, err := e.svc.UpdateFollowing(t.Context(), id, etag, rid, in)
				mustNoErr(t, err)
				return res.ETag
			},
			at: after, from: after,
		},
		{
			name:   "no event of it",
			change: func(_ *testing.T, _ *env, _, etag string) string { return etag },
			at:     rid, from: date(2025, 3, 25, 8, 0),
		},
	} {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			id := e.put(t, "work", "series.ics", weeklyStandup()...)
			stale := shownEvent(t, e, "work", tt.at)
			next := tt.change(t, e, id, stale.ETag)
			if next == "" {
				t.Fatal("the change told no ETag")
			}
			changed := storedObject(t, e, id)
			shown := listedEvents(t, e)
			e.mock.ResetCounts()

			in := eventInputOf(stale)
			in.InstanceStart = &tt.from
			laterBy(time.Hour)(&in)
			_, snap, err := e.svc.UpdateEvent(t.Context(), id, next, in)
			mustErr(t, err, domain.ErrConflict)
			if snap != nil {
				t.Error("returned a snapshot with an error")
			}
			if n := e.mock.Count(http.MethodPut) + e.mock.Count(http.MethodDelete); n != 0 {
				t.Errorf("%d writes; want none", n)
			}
			if now := storedObject(t, e, id); now != changed {
				t.Errorf("the series changed:\n%s\nwant\n%s", now, changed)
			}
			if now := listedEvents(t, e); !slices.Equal(now, shown) {
				t.Errorf("shown:\n%s\nwant:\n%s", strings.Join(now, "\n"), strings.Join(shown, "\n"))
			}
		})
	}

	// An override off the rule is an event the series shows: "all events"
	// moves the series from it, as from any other.
	t.Run("an override off the rule", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := e.put(t, "work", "series.ics", slices.Concat(weeklyStandup(), []string{
			"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Moved",
			"RECURRENCE-ID;TZID=Europe/Berlin:20250312T090000", "DTSTART;TZID=Europe/Berlin:20250312T090000",
			"DTEND;TZID=Europe/Berlin:20250312T100000", "END:VEVENT",
		})...)
		orphan := shownEvent(t, e, "work", date(2025, 3, 12, 8, 0))
		in := eventInputOf(orphan)
		laterBy(time.Hour)(&in)
		_, _, err := e.svc.UpdateEvent(t.Context(), id, orphan.ETag, in)
		mustNoErr(t, err)
		checkStored(t, "series", storedObject(t, e, id), []string{"DTSTART;TZID=Europe/Berlin:20250303T100000"}, nil)
	})
}

// TestUpdateFollowingKeepsCountBoundary is Review Focus 1 through the whole
// write: a series of ten weekly events moved an hour later from its fourth
// keeps ten events, three in S and seven in N, none lost or doubled, also
// where an EXDATE excludes the second, which still counts against the COUNT
// (FR-17; RFC 5545 section 3.3.10).
func TestUpdateFollowingKeepsCountBoundary(t *testing.T) {
	t.Parallel()
	for _, tt := range []struct {
		name  string
		extra []string
		want  []string
	}{
		{"all ten", nil, []string{
			"03-03 09", "03-10 09", "03-17 09", "03-24 10", "03-31 10", "04-07 10", "04-14 10",
			"04-21 10", "04-28 10", "05-05 10",
		}},
		{"the second excluded", []string{"EXDATE:20250310T090000Z"}, []string{
			"03-03 09", "03-17 09", "03-24 10",
			"03-31 10", "04-07 10", "04-14 10", "04-21 10", "04-28 10", "05-05 10",
		}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			lines := slices.Concat([]string{
				"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Standup",
				"DTSTART:20250303T090000Z", "DTEND:20250303T100000Z", "RRULE:FREQ=WEEKLY;COUNT=10",
			}, tt.extra, []string{"END:VEVENT"})
			got := updateFollowing(t, e, lines, date(2025, 3, 24, 9, 0), laterBy(time.Hour))
			mustNoErr(t, got.err)
			_, nData := newSeriesIn(t, e, got.id)
			checkStored(t, "N", nData, []string{"RRULE:FREQ=WEEKLY;COUNT=7\r\n"}, nil)
			checkStored(t, "S", storedObject(t, e, got.id), []string{"RRULE:FREQ=WEEKLY;UNTIL=20250324T085959Z\r\n"}, nil)

			evs, err := e.svc.ListEvents(t.Context(), e.cals["work"], date(2025, 3, 1, 0, 0), date(2025, 7, 1, 0, 0))
			mustNoErr(t, err)
			var shown []string
			for i := range evs {
				shown = append(shown, evs[i].Start.Format("01-02 15"))
			}
			slices.Sort(shown)
			if !slices.Equal(shown, tt.want) {
				t.Errorf("events at %q; want %q", shown, tt.want)
			}
		})
	}
}

// TestUpdateFollowingWriteFailures checks the two writes of a split when the
// second one, S's, fails (FR-17, A-01; spec section 4 "Teilen" step 5): N is
// deleted again where S's write is known not to have landed, by the server's
// refusal or by S's unchanged ETag; the split counts as saved, with S's ETag
// unknown and no snapshot, where S's ETag changed; and N stays, logged, with
// the error where S's ETag cannot be read. When N cannot be created, S is not
// written at all, and an N the server stored all the same goes again (see
// writeCreatedThenMaster). A split whose N's ETag is unknown is saved without
// a snapshot.
func TestUpdateFollowingWriteFailures(t *testing.T) {
	t.Parallel()
	rid := date(2025, 3, 24, 8, 0)
	for _, tc := range []struct {
		name           string
		apply          bool
		status         int
		propfindStatus int
		wantErr        error // nil: the split is saved
		wantObjects    int
		wantDeletes    int
	}{
		{name: "refused with 412", status: http.StatusPreconditionFailed, wantErr: domain.ErrConflict, wantObjects: 1, wantDeletes: 1},
		{name: "502, its ETag unchanged", status: http.StatusBadGateway, wantErr: domain.ErrUpstream, wantObjects: 1, wantDeletes: 1},
		{name: "applied, then 502", apply: true, status: http.StatusBadGateway, wantObjects: 2},
		{
			name: "502, its ETag unreadable", status: http.StatusBadGateway, propfindStatus: http.StatusInternalServerError,
			wantErr: domain.ErrUpstream, wantObjects: 2,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			id := e.put(t, "work", "series.ics", weeklyStandup()...)
			seeded := storedObject(t, e, id)
			sPath := mustDecode(t, e, id)
			ev := shownEvent(t, e, "work", rid)
			answerPutWith(e.mock, sPath, tc.apply, tc.status, tc.propfindStatus)
			e.mock.ResetCounts()
			in := eventInputOf(ev)
			laterBy(time.Hour)(&in)
			res, snap, err := e.svc.UpdateFollowing(t.Context(), id, ev.ETag, rid, in)
			if tc.wantErr != nil {
				mustErr(t, err, tc.wantErr)
				if now := storedObject(t, e, id); now != seeded {
					t.Errorf("S = %q; want it unchanged: %q", now, seeded)
				}
				if res.Event.ID != "" || res.ETag != "" || snap != nil {
					t.Errorf("answered %+v and a snapshot: %v; want neither with an error", res, snap != nil)
				}
			} else {
				mustNoErr(t, err)
				nid, _ := newSeriesIn(t, e, id)
				if res.ETag != "" || snap != nil || res.Event.ID != nid {
					t.Errorf("answered %+v and a snapshot: %v; want the event in N, S's ETag unknown and no snapshot",
						res, snap != nil)
				}
				checkStored(t, "S", storedObject(t, e, id), []string{"UNTIL=20250324T075959Z"}, nil)
			}
			if n := len(e.mock.ObjectPaths(e.paths["work"])); n != tc.wantObjects {
				t.Errorf("%d objects; want %d", n, tc.wantObjects)
			}
			if n := e.mock.Count(http.MethodDelete); n != tc.wantDeletes {
				t.Errorf("%d DELETEs; want %d", n, tc.wantDeletes)
			}
		})
	}

	// A write that lands but whose new ETag the server tells neither in its
	// answer nor when asked is saved, with S's ETag unknown and no snapshot:
	// an undo could not tell its own change from another client's.
	t.Run("S's new ETag unknown", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := e.put(t, "work", "series.ics", weeklyStandup()...)
		ev := shownEvent(t, e, "work", rid)
		answerWithoutETag(e.mock, mustDecode(t, e, id))
		in := eventInputOf(ev)
		laterBy(time.Hour)(&in)
		res, snap, err := e.svc.UpdateFollowing(t.Context(), id, ev.ETag, rid, in)
		mustNoErr(t, err)
		nid, _ := newSeriesIn(t, e, id)
		if res.ETag != "" || snap != nil || res.Event.ID != nid || res.Event.ETag == "" {
			t.Errorf("answered %+v and a snapshot: %v; want the event in N with N's ETag, S's unknown, no snapshot",
				res, snap != nil)
		}
	})

	// N's ETag unknown: an undo could not delete N, which would stand next to
	// S restored, so there is none; the split is saved all the same.
	t.Run("N's ETag unknown", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := e.put(t, "work", "series.ics", weeklyStandup()...)
		ev := shownEvent(t, e, "work", rid)
		var toS atomic.Int32
		answerCreate(e.mock, mustDecode(t, e, id), createAnswer{noETag: true, propfind: http.StatusInternalServerError}, &toS)
		in := eventInputOf(ev)
		laterBy(time.Hour)(&in)
		res, snap, err := e.svc.UpdateFollowing(t.Context(), id, ev.ETag, rid, in)
		mustNoErr(t, err)
		nid, _ := newSeriesIn(t, e, id)
		if snap != nil || res.Event.ID != nid || res.Event.ETag != "" {
			t.Errorf("answered %+v and a snapshot: %v; want the event in N, N's ETag unknown, no snapshot", res, snap != nil)
		}
		if want := storedETag(t, e, mustDecode(t, e, id)); res.ETag != want {
			t.Errorf("ETag = %q; want S's stored %q", res.ETag, want)
		}
	})

	for _, tc := range []struct {
		name        string
		answer      createAnswer
		want        error
		wantObjects int
		wantDeletes int
		wantLog     string
	}{
		{"creating N refused", createAnswer{status: http.StatusPreconditionFailed}, domain.ErrConflict, 1, 0, ""},
		// The server's refusal: what is at N's path is not the split's, and
		// stays.
		{
			"creating N refused, a resource there",
			createAnswer{status: http.StatusPreconditionFailed, stored: true},
			domain.ErrConflict, 2, 0, "",
		},
		{"creating N fails, N not stored", createAnswer{status: http.StatusBadGateway}, domain.ErrUpstream, 1, 0, ""},
		{"creating N fails, N stored", createAnswer{status: http.StatusBadGateway, stored: true}, domain.ErrUpstream, 1, 1, ""},
		// Kept, logged: a delete needs N's ETag (see removeEntries).
		{
			"creating N fails, N stored, its ETag unreadable",
			createAnswer{status: http.StatusBadGateway, stored: true, propfind: http.StatusInternalServerError},
			domain.ErrUpstream, 2, 0, "keeping a resource a change created whose etag cannot be read",
		},
		{
			"creating N fails, N stored, its ETag weak",
			createAnswer{status: http.StatusBadGateway, stored: true, weakETag: true},
			domain.ErrUpstream, 2, 0, "keeping an entry a change created whose etag is unknown",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			var logs bytes.Buffer
			e.p.log = slog.New(slog.NewTextHandler(&logs, nil))
			id := e.put(t, "work", "series.ics", weeklyStandup()...)
			seeded := storedObject(t, e, id)
			ev := shownEvent(t, e, "work", rid)
			var toS atomic.Int32
			answerCreate(e.mock, mustDecode(t, e, id), tc.answer, &toS)
			in := eventInputOf(ev)
			laterBy(time.Hour)(&in)
			e.mock.ResetCounts()
			_, snap, err := e.svc.UpdateFollowing(t.Context(), id, ev.ETag, rid, in)
			mustErr(t, err, tc.want)
			if n := toS.Load(); n != 0 || snap != nil {
				t.Errorf("%d PUTs of S and a snapshot: %v; want neither", n, snap != nil)
			}
			if paths := e.mock.ObjectPaths(e.paths["work"]); len(paths) != tc.wantObjects {
				t.Errorf("objects = %v; want %d", paths, tc.wantObjects)
			}
			if n := e.mock.Count(http.MethodDelete); n != tc.wantDeletes {
				t.Errorf("%d DELETEs; want %d", n, tc.wantDeletes)
			}
			if now := storedObject(t, e, id); now != seeded {
				t.Errorf("S = %q; want it unchanged: %q", now, seeded)
			}
			if tc.wantLog != "" {
				checkStored(t, "log", logs.String(), []string{tc.wantLog, "path=" + e.paths["work"]}, []string{"Standup"})
			}
		})
	}

	// S's write refused, and N created without an ETag the server told on
	// its create or when read back: N's UID is fresh, so its ETag is read
	// again and N deleted with it, a strong one; else N stays, logged (see
	// removeIfStored).
	for _, tc := range []struct {
		name        string
		answer      createAnswer
		wantObjects int
		wantDeletes int
		wantLog     string
	}{
		{"N's ETag readable again", createAnswer{
			noETag: true, propfind: http.StatusInternalServerError, propfindOnce: true, master: http.StatusPreconditionFailed,
		}, 1, 1, ""},
		{"N's ETag unreadable", createAnswer{
			noETag: true, propfind: http.StatusInternalServerError, master: http.StatusPreconditionFailed,
		}, 2, 0, "keeping a resource a change created whose etag cannot be read"},
		{"N's ETag weak", createAnswer{
			noETag: true, weakETag: true, master: http.StatusPreconditionFailed,
		}, 2, 0, "keeping an entry a change created whose etag is unknown"},
	} {
		t.Run("S refused, "+tc.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			var logs bytes.Buffer
			e.p.log = slog.New(slog.NewTextHandler(&logs, nil))
			id := e.put(t, "work", "series.ics", weeklyStandup()...)
			seeded := storedObject(t, e, id)
			ev := shownEvent(t, e, "work", rid)
			var toS atomic.Int32
			answerCreate(e.mock, mustDecode(t, e, id), tc.answer, &toS)
			in := eventInputOf(ev)
			laterBy(time.Hour)(&in)
			e.mock.ResetCounts()
			_, snap, err := e.svc.UpdateFollowing(t.Context(), id, ev.ETag, rid, in)
			mustErr(t, err, domain.ErrConflict)
			if n := toS.Load(); n != 1 || snap != nil {
				t.Errorf("%d PUTs of S and a snapshot: %v; want one PUT and no snapshot", n, snap != nil)
			}
			if paths := e.mock.ObjectPaths(e.paths["work"]); len(paths) != tc.wantObjects {
				t.Errorf("objects = %v; want %d", paths, tc.wantObjects)
			}
			if n := e.mock.Count(http.MethodDelete); n != tc.wantDeletes {
				t.Errorf("%d DELETEs; want %d", n, tc.wantDeletes)
			}
			if now := storedObject(t, e, id); now != seeded {
				t.Errorf("S = %q; want it unchanged: %q", now, seeded)
			}
			if tc.wantLog != "" {
				checkStored(t, "log", logs.String(), []string{tc.wantLog, "path=" + e.paths["work"]}, []string{"Standup"})
			}
		})
	}
}

// TestUpdateFollowingAtRDate splits a series at an RDATE after the last event
// of its rule, where N has no RRULE left but the later RDATE (FR-17; spec
// section 4 "Teilen" steps 2 and 3): sent with the series' rule, unchanged,
// N moves as a series of RDATEs, both of its events; sent without a rule, N
// is the single event entered, and the later RDATE goes with the rule.
func TestUpdateFollowingAtRDate(t *testing.T) {
	t.Parallel()
	lines := []string{
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Lecture",
		"DTSTART:20250303T090000Z", "DTEND:20250303T100000Z", "RRULE:FREQ=WEEKLY;COUNT=2",
		"RDATE:20250320T090000Z,20250327T090000Z", "END:VEVENT",
	}
	s := []string{"2025-03-03T09:00:00Z/2025-03-03T10:00:00Z Lecture", "2025-03-10T09:00:00Z/2025-03-10T10:00:00Z Lecture"}
	for _, tt := range []struct {
		name   string
		edit   func(in *domain.EventInput)
		shownN []string
	}{
		{"the rule kept", laterBy(time.Hour), []string{
			"2025-03-20T10:00:00Z/2025-03-20T11:00:00Z Lecture", "2025-03-27T10:00:00Z/2025-03-27T11:00:00Z Lecture",
		}},
		{"the rule removed", func(in *domain.EventInput) {
			laterBy(time.Hour)(in)
			in.RRule = ""
		}, []string{"2025-03-20T10:00:00Z/2025-03-20T11:00:00Z Lecture"}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			got := updateFollowing(t, e, lines, date(2025, 3, 20, 9, 0), tt.edit)
			mustNoErr(t, got.err)
			_, nData := newSeriesIn(t, e, got.id)
			checkStored(t, "N", nData, nil, []string{"RRULE"})
			if shown, want := listedEvents(t, e), slices.Concat(s, tt.shownN); !slices.Equal(shown, want) {
				t.Errorf("shown:\n%s\nwant:\n%s", strings.Join(shown, "\n"), strings.Join(want, "\n"))
			}
			if want := tt.shownN[0]; shownAs(got.res.Event) != want {
				t.Errorf("answer = %s; want %s", shownAs(got.res.Event), want)
			}
		})
	}
}
