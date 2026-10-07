package caldav

import (
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/emersion/go-ical"

	"github.com/tbckr/lucid/internal/domain"
)

// todoSeriesICS returns a calendar with berlinVTimezone, a task series
// master "Series" of the given lines, with the UID s and SEQUENCE:2, and its
// overrides, given as their lines each.
func todoSeriesICS(master []string, overrides ...[]string) string {
	lines := append([]string{}, berlinVTimezone...)
	lines = append(lines, "BEGIN:VTODO", "UID:s", "DTSTAMP:20250101T000000Z", "SEQUENCE:2", "SUMMARY:Series")
	lines = append(append(lines, master...), "END:VTODO")
	for _, o := range overrides {
		lines = append(lines, "BEGIN:VTODO", "UID:s", "DTSTAMP:20250101T000000Z")
		lines = append(append(lines, o...), "END:VTODO")
	}
	return ics(lines...)
}

// splitTodoAt splits the task series in cal at rid as a write to rid and the
// repeats after it does: it builds N with splitTodoOff, failing the test if
// that changes cal, and then ends cal, S, with endTodoBefore. It returns S
// and N.
func splitTodoAt(t *testing.T, cal *ical.Calendar, rid time.Time) (s, n *ical.Calendar) {
	t.Helper()
	series := newTodoSeries(cal, mainComponent(cal, ical.CompToDo))
	before := encodeCal(t, cal)
	n, err := splitTodoOff(cal, series, rid, splitUID, splitNow)
	mustNoErr(t, err)
	if got := encodeCal(t, cal); got != before {
		t.Fatalf("splitTodoOff changed the series:\n%s\nwant\n%s", got, before)
	}
	mustNoErr(t, endTodoBefore(cal, series, rid))
	return cal, n
}

// openRepeats returns the open repeats the occurrence listing shows in 2025
// for the task series in cals, each as its recurrence ID, its start (else
// its due), its due and its title, sorted.
func openRepeats(t *testing.T, cals ...*ical.Calendar) []string {
	t.Helper()
	var out []string
	for _, cal := range cals {
		c := mainComponent(cal, ical.CompToDo)
		occs, err := seriesOccurrences(newTodoSeries(cal, c), "id", "c", text(c.Props, ical.PropSummary),
			date(2025, 1, 1, 0, 0), date(2026, 1, 1, 0, 0))
		mustNoErr(t, err)
		for i := range occs {
			o := &occs[i]
			if o.State == domain.OccurrenceDone {
				continue
			}
			due := "-"
			if o.Due != nil {
				due = o.Due.Format(time.RFC3339)
			}
			out = append(out, o.RecurrenceID.Format(time.RFC3339)+" "+occAnchorTime(*o).Format(time.RFC3339)+"/"+
				due+" "+o.Title)
		}
	}
	slices.Sort(out)
	return out
}

// checkOpenAsBefore fails the test unless S and N together list the open
// repeats the series of raw listed, from its current one on, none lost and
// none twice (FR-17).
func checkOpenAsBefore(t *testing.T, raw string, s, n *ical.Calendar) {
	t.Helper()
	got, want := openRepeats(t, s, n), openRepeats(t, mustParse(t, raw))
	if len(want) == 0 {
		t.Fatal("the series lists no open repeat")
	}
	if !slices.Equal(got, want) {
		t.Errorf("S and N list\n%s\nwant the series' open repeats\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}

// TestSplitTodoSeries splits a weekly task series from Monday, March 3,
// 2025, at its fourth repeat, March 24, for each form its anchor can take
// and each way the rule can end (FR-17). S ends just before R: by an UNTIL in
// the form RFC 5545 section 3.3.10 wants for the anchor's, or, in a zone
// Lucid cannot resolve, by a COUNT of S's three repeats. N starts at R in
// the series' form, DUE keeping its distance, with the COUNT lowered by S's
// three repeats and an UNTIL as it was. A series anchored on DUE gets
// DTSTART = DUE in N, as on a roll. Together they list the series' open
// repeats.
func TestSplitTodoSeries(t *testing.T) {
	t.Parallel()
	forms := []struct {
		name         string
		start, due   string    // the series' DTSTART ("" for none) and DUE
		rid          time.Time // R, the fourth repeat
		until        string    // an UNTIL at the tenth repeat, May 5
		sEnd         string    // how S's rule ends
		nStart, nDue string    // N's DTSTART and DUE
	}{
		{
			"DATE", "DTSTART;VALUE=DATE:20250303", "DUE;VALUE=DATE:20250304", date(2025, 3, 24, 0, 0),
			"20250505", "UNTIL=20250323", "DTSTART;VALUE=DATE:20250324", "DUE;VALUE=DATE:20250325",
		},
		{
			// 09:00 CET is 08:00 UTC.
			"TZID", "DTSTART;TZID=Europe/Berlin:20250303T090000", "DUE;TZID=Europe/Berlin:20250303T100000",
			date(2025, 3, 24, 8, 0), "20250505T070000Z", "UNTIL=20250324T075959Z",
			"DTSTART;TZID=Europe/Berlin:20250324T090000", "DUE;TZID=Europe/Berlin:20250324T100000",
		},
		{
			"UTC", "DTSTART:20250303T090000Z", "DUE:20250303T100000Z", date(2025, 3, 24, 9, 0),
			"20250505T090000Z", "UNTIL=20250324T085959Z", "DTSTART:20250324T090000Z", "DUE:20250324T100000Z",
		},
		{
			"floating", "DTSTART:20250303T090000", "DUE:20250303T100000", date(2025, 3, 24, 9, 0),
			"20250505T090000", "UNTIL=20250324T085959", "DTSTART:20250324T090000", "DUE:20250324T100000",
		},
		{
			// Lucid reads the wall clock as UTC, so an UNTIL it derived would
			// be off by the zone's offset.
			"unknown TZID", "DTSTART;TZID=Unknown/Zone:20250303T090000", "DUE;TZID=Unknown/Zone:20250303T100000",
			date(2025, 3, 24, 9, 0), "20250505T090000Z", "COUNT=3",
			"DTSTART;TZID=Unknown/Zone:20250324T090000", "DUE;TZID=Unknown/Zone:20250324T100000",
		},
		{
			// As Tasks.org writes an all-day series: no DTSTART.
			"anchored on DUE", "", "DUE;VALUE=DATE:20250303", date(2025, 3, 24, 0, 0),
			"20250505", "UNTIL=20250323", "DTSTART;VALUE=DATE:20250324", "DUE;VALUE=DATE:20250324",
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
				lines := []string{f.due, "RRULE:" + e.rule}
				if f.start != "" {
					lines = append(lines, f.start)
				}
				raw := todoSeriesICS(lines)
				s, n := splitTodoAt(t, mustParse(t, raw), f.rid)
				sm, nm := mainComponent(s, ical.CompToDo), mainComponent(n, ical.CompToDo)
				for _, c := range []struct{ what, got, want string }{
					{"S's RRULE", propLine(sm, ical.PropRecurrenceRule), "RRULE:" + e.wantS},
					{"N's RRULE", propLine(nm, ical.PropRecurrenceRule), "RRULE:" + e.wantN},
					{"S's DTSTART", propLine(sm, ical.PropDateTimeStart), f.start},
					{"S's DUE", propLine(sm, ical.PropDue), f.due},
					{"N's DTSTART", propLine(nm, ical.PropDateTimeStart), f.nStart},
					{"N's DUE", propLine(nm, ical.PropDue), f.nDue},
				} {
					if c.got != c.want {
						t.Errorf("%s = %s; want %s", c.what, c.got, c.want)
					}
				}
				checkOpenAsBefore(t, raw, s, n)
			})
		}
	}
}

// TestSplitTodoPartitionsRefs splits task series at R (FR-17). EXDATE
// values and overrides go by where refsFrom places their value or
// RECURRENCE-ID, never by an override's own dates: those of R and after it
// go to N, the overrides with N's UID, done ones included; those before R
// stay in S, as does the override before R moved past it. A value of the
// other value type goes by its date in the series' zone (A-11), also where
// its instant lies on the other side of R. An EXDATE property left without
// values goes, and so does an empty value.
func TestSplitTodoPartitionsRefs(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name                   string
		master                 []string
		overrides              [][]string
		rid                    time.Time
		sRule, nRule           string
		sExdates, nExdates     []string
		sOverrides, nOverrides []string
	}{
		{
			// R is Monday, March 24, 20:00 in New York, midnight UTC on the
			// 25th: the date 2025-03-24 is R's day, though its instant lies
			// before R.
			name: "a timed series",
			master: []string{
				"DTSTART;TZID=America/New_York:20250303T200000", "RRULE:FREQ=WEEKLY",
				"EXDATE;TZID=America/New_York:20250310T200000,20250331T200000",
				"EXDATE:20250415T000000Z,", // April 14, 20:00 in New York
				"EXDATE;VALUE=DATE:20250428",
			},
			overrides: [][]string{
				{"RECURRENCE-ID;TZID=America/New_York:20250303T200000", "STATUS:COMPLETED", "SUMMARY:Done before R"},
				{
					"RECURRENCE-ID;TZID=America/New_York:20250317T200000",
					"DTSTART;TZID=America/New_York:20250325T090000", "SUMMARY:Moved past R",
				},
				{"RECURRENCE-ID;VALUE=DATE:20250324", "SUMMARY:At R"},
				{"RECURRENCE-ID:20250408T000000Z", "SUMMARY:Later"}, // April 7, 20:00 in New York
				{"RECURRENCE-ID;TZID=America/New_York:20250421T200000", "STATUS:COMPLETED", "SUMMARY:Done later"},
			},
			rid:      date(2025, 3, 25, 0, 0),
			sRule:    "FREQ=WEEKLY;UNTIL=20250324T235959Z",
			nRule:    "FREQ=WEEKLY",
			sExdates: []string{"EXDATE;TZID=America/New_York:20250310T200000"},
			nExdates: []string{
				"EXDATE;TZID=America/New_York:20250331T200000", "EXDATE:20250415T000000Z",
				"EXDATE;VALUE=DATE:20250428",
			},
			sOverrides: []string{
				"s RECURRENCE-ID;TZID=America/New_York:20250303T200000 Done before R",
				"s RECURRENCE-ID;TZID=America/New_York:20250317T200000 Moved past R",
			},
			nOverrides: []string{
				splitUID + " RECURRENCE-ID;VALUE=DATE:20250324 At R",
				splitUID + " RECURRENCE-ID:20250408T000000Z Later",
				splitUID + " RECURRENCE-ID;TZID=America/New_York:20250421T200000 Done later",
			},
		},
		{
			// R is March 24. 22:00 on the 23rd in New York lies after R's
			// instant, midnight UTC, and 08:00 on the 24th in Tokyo before
			// it: each goes by its date.
			name: "an all-day series",
			master: []string{
				"DTSTART;VALUE=DATE:20250303", "RRULE:FREQ=WEEKLY;COUNT=10",
				"EXDATE;VALUE=DATE:20250310,20250407", "EXDATE;TZID=America/New_York:20250323T220000",
			},
			overrides: [][]string{
				{"RECURRENCE-ID;VALUE=DATE:20250317", "SUMMARY:Before R"},
				{"RECURRENCE-ID;TZID=Asia/Tokyo:20250324T080000", "SUMMARY:At R"},
			},
			rid:   date(2025, 3, 24, 0, 0),
			sRule: "FREQ=WEEKLY;UNTIL=20250323",
			nRule: "FREQ=WEEKLY;COUNT=7",
			sExdates: []string{
				"EXDATE;VALUE=DATE:20250310", "EXDATE;TZID=America/New_York:20250323T220000",
			},
			nExdates:   []string{"EXDATE;VALUE=DATE:20250407"},
			sOverrides: []string{"s RECURRENCE-ID;VALUE=DATE:20250317 Before R"},
			nOverrides: []string{splitUID + " RECURRENCE-ID;TZID=Asia/Tokyo:20250324T080000 At R"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			raw := todoSeriesICS(tt.master, tt.overrides...)
			s, n := splitTodoAt(t, mustParse(t, raw), tt.rid)
			sm, nm := mainComponent(s, ical.CompToDo), mainComponent(n, ical.CompToDo)
			for _, c := range []struct {
				what      string
				got, want []string
			}{
				{"S's RRULE", propLines(sm, ical.PropRecurrenceRule), []string{"RRULE:" + tt.sRule}},
				{"N's RRULE", propLines(nm, ical.PropRecurrenceRule), []string{"RRULE:" + tt.nRule}},
				{"S's EXDATEs", propLines(sm, ical.PropExceptionDates), tt.sExdates},
				{"N's EXDATEs", propLines(nm, ical.PropExceptionDates), tt.nExdates},
				{"S's overrides", overridesIn(s), tt.sOverrides},
				{"N's overrides", overridesIn(n), tt.nOverrides},
			} {
				if !slices.Equal(c.got, c.want) {
					t.Errorf("%s = %q; want %q", c.what, c.got, c.want)
				}
			}
			checkOpenAsBefore(t, raw, s, n)
		})
	}
}

// TestSplitTodoDropsMarkers splits a series KDE rolls, which another one
// was detached from, at a later repeat (FR-17): N is a new, open series,
// without KDE's pending occurrence, the origin of a detached task, and the
// master's progress, with a new UID, SEQUENCE:0 and its change dates at the
// time of the split, and keeps the series' alarm and VTIMEZONE. S keeps all
// of that as it was, its pending occurrence included, for the caller to
// write.
func TestSplitTodoDropsMarkers(t *testing.T) {
	t.Parallel()
	raw := todoSeriesICS([]string{
		"DTSTART;TZID=Europe/Berlin:20250303T090000", "RRULE:FREQ=WEEKLY;COUNT=10",
		"X-KDE-LIBKCAL-DTRECURRENCE;TZID=Europe/Berlin:20250310T090000", "X-LUCID-DETACHED-FROM:origin",
		"STATUS:IN-PROCESS", "PERCENT-COMPLETE:40", "COMPLETED:20250305T120000Z",
		"CREATED:20240101T000000Z", "LAST-MODIFIED:20250101T000000Z",
		"BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-PT15M", "DESCRIPTION:Series", "END:VALARM",
	})
	s, n := splitTodoAt(t, mustParse(t, raw), date(2025, 3, 24, 8, 0))
	sm, nm := mainComponent(s, ical.CompToDo), mainComponent(n, ical.CompToDo)
	now := "20250601T120000Z"
	checkStored(t, "N", encodeCal(t, n),
		[]string{
			"UID:" + splitUID, "SEQUENCE:0", "DTSTAMP:" + now, "CREATED:" + now, "LAST-MODIFIED:" + now,
			"STATUS:NEEDS-ACTION", "SUMMARY:Series", "BEGIN:VALARM", "TRIGGER:-PT15M", "TZID:Europe/Berlin",
		},
		[]string{"UID:s", "X-KDE-LIBKCAL-DTRECURRENCE", "X-LUCID-DETACHED-FROM", "PERCENT-COMPLETE", "COMPLETED:"})
	if got := len(slices.DeleteFunc(slices.Clone(n.Children), func(c *ical.Component) bool {
		return c.Name != ical.CompTimezone
	})); got != 1 {
		t.Errorf("N has %d VTIMEZONEs; want the series' one", got)
	}
	for _, c := range []struct{ what, got, want string }{
		{"N's DTSTART", propLine(nm, ical.PropDateTimeStart), "DTSTART;TZID=Europe/Berlin:20250324T090000"},
		{"N's RRULE", propLine(nm, ical.PropRecurrenceRule), "RRULE:FREQ=WEEKLY;COUNT=7"},
		{"S's RRULE", propLine(sm, ical.PropRecurrenceRule), "RRULE:FREQ=WEEKLY;UNTIL=20250324T075959Z"},
		{"S's UID", propLine(sm, ical.PropUID), "UID:s"},
		{"S's SEQUENCE", propLine(sm, ical.PropSequence), "SEQUENCE:2"},
		{"S's STATUS", propLine(sm, ical.PropStatus), "STATUS:IN-PROCESS"},
		{"S's PERCENT-COMPLETE", propLine(sm, ical.PropPercentComplete), "PERCENT-COMPLETE:40"},
		{"S's pending occurrence", propLine(sm, propKDEPending), propKDEPending + ";TZID=Europe/Berlin:20250310T090000"},
		{"S's origin", propLine(sm, propDetachedFrom), propDetachedFrom + ":origin"},
	} {
		if c.got != c.want {
			t.Errorf("%s = %s; want %s", c.what, c.got, c.want)
		}
	}
	checkOpenAsBefore(t, raw, s, n)
}

// TestSplitTodoRefusesOffRule refuses to split a task series at a repeat
// that is no instance of its rule after its anchor, or that its rule cannot
// be walked to, with ErrSeriesSplitUnsupported, from splitTodoOff and
// endTodoBefore alike, and leaves the series as it was (FR-17).
func TestSplitTodoRefusesOffRule(t *testing.T) {
	t.Parallel()
	weekly := []string{"DTSTART:20250309T090000Z", "RRULE:FREQ=WEEKLY"}
	tests := []struct {
		name      string
		master    []string
		overrides [][]string
		rid       time.Time
	}{
		{
			// A Monday override of a Sunday series, as a move of an interval
			// series leaves it (A-10).
			name:      "an override off the rule",
			master:    weekly,
			overrides: [][]string{{"RECURRENCE-ID:20250317T090000Z", "SUMMARY:Off the rule"}},
			rid:       date(2025, 3, 17, 9, 0),
		},
		{name: "between two instances", master: weekly, rid: date(2025, 3, 12, 9, 0)},
		{name: "another time of an instance's day", master: weekly, rid: date(2025, 3, 16, 10, 0)},
		{name: "the anchor", master: weekly, rid: date(2025, 3, 9, 9, 0)},
		{name: "before the anchor", master: weekly, rid: date(2025, 3, 2, 9, 0)},
		{
			name:   "past the rule's end",
			master: []string{"DTSTART:20250309T090000Z", "RRULE:FREQ=WEEKLY;COUNT=3"},
			rid:    date(2025, 3, 30, 9, 0),
		},
		{
			// R lies past maxRRuleIterations minutes.
			name:   "past the iteration cap",
			master: []string{"DTSTART:20250101T000000Z", "RRULE:FREQ=MINUTELY"},
			rid:    date(2026, 1, 1, 0, 0),
		},
		{
			name:   "a rule Lucid cannot read",
			master: []string{"DTSTART:20250309T090000Z", "RRULE:FREQ=WEEKLY;BYDAY=XX"},
			rid:    date(2025, 3, 16, 9, 0),
		},
		{
			name:   "a series with RDATE",
			master: append([]string{"RDATE:20250312T090000Z"}, weekly...),
			rid:    date(2025, 3, 16, 9, 0),
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			cal := mustParse(t, todoSeriesICS(tt.master, tt.overrides...))
			series := newTodoSeries(cal, mainComponent(cal, ical.CompToDo))
			before := encodeCal(t, cal)
			n, err := splitTodoOff(cal, series, tt.rid, splitUID, splitNow)
			mustErr(t, err, domain.ErrSeriesSplitUnsupported)
			if n != nil {
				t.Errorf("splitTodoOff returned N:\n%s", encodeCal(t, n))
			}
			mustErr(t, endTodoBefore(cal, series, tt.rid), domain.ErrSeriesSplitUnsupported)
			if got := encodeCal(t, cal); got != before {
				t.Errorf("the refused split changed the series:\n%s\nwant\n%s", got, before)
			}
		})
	}
}
