package caldav

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"path"
	"reflect"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/emersion/go-ical"

	"github.com/tbckr/lucid/internal/caldav/caldavtest"
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
// without KDE's pending occurrence, the origin of a detached task, the
// master's progress, its checklist's included, and the links to the
// series' subtasks, with a new UID, SEQUENCE:0 and its change dates at the
// time of the split, and keeps the series' alarm, its other relations and
// its VTIMEZONE. S keeps all of that as it was, its pending occurrence
// included, for the caller to write.
func TestSplitTodoDropsMarkers(t *testing.T) {
	t.Parallel()
	raw := todoSeriesICS([]string{
		"DTSTART;TZID=Europe/Berlin:20250303T090000", "RRULE:FREQ=WEEKLY;COUNT=10",
		"X-KDE-LIBKCAL-DTRECURRENCE;TZID=Europe/Berlin:20250310T090000", "X-LUCID-DETACHED-FROM:origin",
		"STATUS:IN-PROCESS", "PERCENT-COMPLETE:40", "COMPLETED:20250305T120000Z",
		"CREATED:20240101T000000Z", "LAST-MODIFIED:20250101T000000Z",
		`DESCRIPTION:Notes\n\n- [x] a\n- [ ] b`, "RELATED-TO;RELTYPE=CHILD:kid", "RELATED-TO:mom",
		"BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-PT15M", "DESCRIPTION:Series", "END:VALARM",
	})
	s, n := splitTodoAt(t, mustParse(t, raw), date(2025, 3, 24, 8, 0))
	sm, nm := mainComponent(s, ical.CompToDo), mainComponent(n, ical.CompToDo)
	now := "20250601T120000Z"
	checkStored(t, "N", encodeCal(t, n),
		[]string{
			"UID:" + splitUID, "SEQUENCE:0", "DTSTAMP:" + now, "CREATED:" + now, "LAST-MODIFIED:" + now,
			"STATUS:NEEDS-ACTION", "SUMMARY:Series", "BEGIN:VALARM", "TRIGGER:-PT15M", "TZID:Europe/Berlin",
			`DESCRIPTION:Notes\n\n- [ ] a\n- [ ] b`, "RELATED-TO:mom",
		},
		[]string{"UID:s", "X-KDE-LIBKCAL-DTRECURRENCE", "X-LUCID-DETACHED-FROM", "PERCENT-COMPLETE", "COMPLETED:", "- [x]", "kid"})
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
		{"S's notes", propLine(sm, ical.PropDescription), `DESCRIPTION:Notes\n\n- [x] a\n- [ ] b`},
		{"S's relations", strings.Join(propLines(sm, ical.PropRelatedTo), " "), "RELATED-TO;RELTYPE=CHILD:kid RELATED-TO:mom"},
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

// listedRepeat returns the repeat at rid of the series id, as
// ListTodoOccurrences reports it from February to June 2025.
func listedRepeat(t *testing.T, e *env, id string, rid time.Time) domain.TodoOccurrence {
	t.Helper()
	occs, err := e.svc.ListTodoOccurrences(t.Context(), e.cals["tasks"], date(2025, 2, 1, 0, 0), date(2025, 6, 1, 0, 0))
	mustNoErr(t, err)
	for i := range occs {
		if o := occs[i]; o.TodoID == id && o.RecurrenceID.Equal(rid) {
			return o
		}
	}
	t.Fatalf("no repeat %v of %s in %+v", rid, id, occs)
	return domain.TodoOccurrence{}
}

// followingInput is what a client sends to save the repeat at rid of the
// series f, as listed, and the repeats after it: f's fields, with the dates
// the occurrence listing reports for the repeat, and without rrule.
func followingInput(t *testing.T, e *env, f *domain.Todo, rid time.Time) domain.TodoInput {
	t.Helper()
	o := listedRepeat(t, e, f.ID, rid)
	in := editInput(f)
	in.Start, in.StartAllDay, in.Due, in.DueAllDay = o.Start, o.StartAllDay, o.Due, o.DueAllDay
	return in
}

// shiftedBy returns an edit that moves the dates of the input by d.
func shiftedBy(d time.Duration) func(in *domain.TodoInput) {
	return func(in *domain.TodoInput) {
		if in.Start != nil {
			in.Start = ptr(in.Start.Add(d))
		}
		if in.Due != nil {
			in.Due = ptr(in.Due.Add(d))
		}
	}
}

// updateTodoFollowing saves the repeat at rid of the series id and the
// repeats after it with the input a client sends, changed by edit, and
// returns the answer and its snapshot.
func updateTodoFollowing(t *testing.T, e *env, id string, rid time.Time, edit func(in *domain.TodoInput)) (domain.TodoFollowing, *domain.Snapshot) {
	t.Helper()
	f := listedTodo(t, e, id)
	in := followingInput(t, e, &f, rid)
	if edit != nil {
		edit(&in)
	}
	res, snap, err := e.svc.UpdateTodoFollowing(t.Context(), id, f.ETag, rid, in)
	mustNoErr(t, err)
	return res, snap
}

// repeatLines returns the repeats ListTodoOccurrences reports from February
// to June 2025 of the series s, as "S", and n, as "N", each as its
// recurrence ID, its start (else its due) and its state, in that order.
func repeatLines(t *testing.T, e *env, s, n string) []string {
	t.Helper()
	occs, err := e.svc.ListTodoOccurrences(t.Context(), e.cals["tasks"], date(2025, 2, 1, 0, 0), date(2025, 6, 1, 0, 0))
	mustNoErr(t, err)
	var out []string
	for i := range occs {
		o := &occs[i]
		name := map[string]string{s: "S", n: "N"}[o.TodoID]
		if name == "" {
			t.Errorf("repeat of another series %s: %+v", o.TodoID, o)
			continue
		}
		out = append(out, name+" "+o.RecurrenceID.Format("01-02 15:04")+" "+occAnchorTime(*o).Format("01-02 15:04")+" "+o.State)
	}
	slices.Sort(out)
	return out
}

// checkRepeats fails the test unless repeatLines lists want.
func checkRepeats(t *testing.T, e *env, s, n string, want ...string) {
	t.Helper()
	slices.Sort(want)
	if got := repeatLines(t, e, s, n); !slices.Equal(got, want) {
		t.Errorf("repeats:\n%s\nwant:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}

// weeklyFromMarch3 is a weekly task series at 09:00 UTC from Monday, March
// 3, 2025, due an hour later, with ten repeats; its fourth is on March 24.
var weeklyFromMarch3 = []string{"DTSTART:20250303T090000Z", "DUE:20250303T100000Z", "RRULE:FREQ=WEEKLY;COUNT=10"}

// fourthRepeat is the fourth repeat of weeklyFromMarch3.
var fourthRepeat = date(2025, 3, 24, 9, 0)

// TestUpdateTodoFollowing changes a later repeat R of a task series and the
// repeats after it as a series of their own (FR-17; spec section 5 "Teilen
// und Beenden"): the series S ends before R, and a new series N goes on from
// R, changed as PUT /todos/{id} changes a series from its current repeat.
func TestUpdateTodoFollowing(t *testing.T) {
	t.Parallel()

	t.Run("an interval series moved from its fourth repeat by a day", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, weeklyFromMarch3,
			[]string{"RECURRENCE-ID:20250310T090000Z", "SUMMARY:Before"},
			[]string{"RECURRENCE-ID:20250414T090000Z", "SUMMARY:Later"})
		seeded := storedObject(t, e, id)
		res, snap := updateTodoFollowing(t, e, id, fourthRepeat, func(in *domain.TodoInput) {
			shiftedBy(24 * time.Hour)(in)
			in.Title = "Renamed"
		})

		n, s := res.Todo, res.Series
		if n.ID == id || n.UID == "r" || n.ETag == "" || n.CalendarID != e.cals["tasks"] || n.Title != "Renamed" ||
			!n.Recurring || n.RRule != "FREQ=WEEKLY;COUNT=7" ||
			!sameTime(n.Start, ptr(date(2025, 3, 25, 9, 0))) || !sameTime(n.Due, ptr(date(2025, 3, 25, 10, 0))) ||
			!sameTime(n.RecurrenceID, ptr(date(2025, 3, 25, 9, 0))) {
			t.Errorf("new series = %+v; want it renamed, from Tuesday, March 25, with the 7 repeats left", n)
		}
		if s.ID != id || s.ETag != listedTodo(t, e, id).ETag || s.Title != "Series" ||
			s.RRule != "FREQ=WEEKLY;UNTIL=20250324T085959Z" || !sameTime(s.Start, ptr(date(2025, 3, 3, 9, 0))) ||
			!sameNext(s.Next, &domain.TodoDates{Start: ptr(date(2025, 3, 10, 9, 0)), Due: ptr(date(2025, 3, 10, 10, 0))}) {
			t.Errorf("series = %+v; want it as stored, ending before March 24", s)
		}
		checkStored(t, "S", storedObject(t, e, id),
			[]string{
				"DTSTART:20250303T090000Z", "RRULE:FREQ=WEEKLY;UNTIL=20250324T085959Z\r\n", "SUMMARY:Series",
				"SEQUENCE:1", "RECURRENCE-ID:20250310T090000Z", "SUMMARY:Before",
			},
			[]string{"Renamed", "RECURRENCE-ID:20250414", "Later"})
		checkStored(t, "N", storedObject(t, e, n.ID),
			[]string{
				"UID:" + n.UID, "DTSTART:20250325T090000Z", "DUE:20250325T100000Z", "RRULE:FREQ=WEEKLY;COUNT=7\r\n",
				"SUMMARY:Renamed", "SEQUENCE:0", "RECURRENCE-ID:20250415T090000Z", "SUMMARY:Later",
			},
			[]string{"\r\nUID:r\r\n", "Before", "SUMMARY:Series"})
		checkRepeats(t, e, id, n.ID,
			"S 03-03 09:00 03-03 09:00 current", "S 03-10 09:00 03-10 09:00 upcoming", "S 03-17 09:00 03-17 09:00 upcoming",
			"N 03-25 09:00 03-25 09:00 current", "N 04-01 09:00 04-01 09:00 upcoming", "N 04-08 09:00 04-08 09:00 upcoming",
			"N 04-15 09:00 04-15 09:00 upcoming", "N 04-22 09:00 04-22 09:00 upcoming", "N 04-29 09:00 04-29 09:00 upcoming",
			"N 05-06 09:00 05-06 09:00 upcoming")
		if snap == nil || snap.Kind != domain.SnapshotTodo || snap.ID != id || snap.ETag != s.ETag || string(snap.Data) != seeded ||
			!reflect.DeepEqual(snap.Created, []domain.CreatedRef{{ID: n.ID, ETag: n.ETag}}) {
			t.Errorf("snapshot = %+v; want S as seeded, and N as a resource that may not stay", snap)
		}
	})

	// N belongs to R, not to S's current repeat: it starts open, its
	// checklist unchecked, however the client echoes S's progress, and the
	// series' subtasks stay with S, as for a completed copy (FR-17).
	t.Run("N starts open, without S's progress and subtasks", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, append([]string{
			`DESCRIPTION:Notes\n\n- [x] a\n- [ ] b`, "STATUS:IN-PROCESS", "PERCENT-COMPLETE:40",
			"RELATED-TO;RELTYPE=CHILD:kid", "RELATED-TO;RELTYPE=PARENT:mom",
		}, weeklyFromMarch3...))
		res, _ := updateTodoFollowing(t, e, id, fourthRepeat, nil)
		if n := res.Todo; n.Status != domain.TodoNeedsAction || n.Description != "Notes" ||
			!reflect.DeepEqual(n.Checklist, []domain.ChecklistItem{{Text: "a"}, {Text: "b"}}) {
			t.Errorf("new series = %+v; want it open, its checklist unchecked", n)
		}
		checkStored(t, "N", storedObject(t, e, res.Todo.ID),
			[]string{`DESCRIPTION:Notes\n\n- [ ] a\n- [ ] b`, "STATUS:NEEDS-ACTION", "RELATED-TO;RELTYPE=PARENT:mom"},
			[]string{"PERCENT-COMPLETE", "IN-PROCESS", "- [x]", "kid"})
		checkStored(t, "S", storedObject(t, e, id),
			[]string{`DESCRIPTION:Notes\n\n- [x] a\n- [ ] b`, "STATUS:IN-PROCESS", "PERCENT-COMPLETE:40", "RELATED-TO;RELTYPE=CHILD:kid"},
			nil)
	})

	// A rule on fixed days follows the move on N only, as seriesShift says;
	// one it cannot follow is refused, with nothing written (FR-17).
	for _, tc := range []struct {
		name  string
		d     time.Duration
		nRule string // "" refused
	}{
		{"a fixed-day series rotates its days on N only", 24 * time.Hour, "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,FR\r\n"},
		{"a fixed-day series refuses a move its rule cannot follow", 4 * 24 * time.Hour, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			// Mondays and Thursdays every other week: March 3, 6, 17, 20, ...
			id := seedSeries(t, e, []string{"DTSTART:20250303T090000Z", "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH"})
			seeded := storedObject(t, e, id)
			rid := date(2025, 3, 17, 9, 0)
			f := listedTodo(t, e, id)
			in := followingInput(t, e, &f, rid)
			shiftedBy(tc.d)(&in)
			e.mock.ResetCounts()
			res, snap, err := e.svc.UpdateTodoFollowing(t.Context(), id, f.ETag, rid, in)
			if tc.nRule == "" {
				mustErr(t, err, domain.ErrSeriesMoveUnsupported)
				if snap != nil {
					t.Errorf("snapshot %+v; want none", snap)
				}
				mustWriteNothing(t, e, id, seeded)
				return
			}
			mustNoErr(t, err)
			checkStored(t, "N", storedObject(t, e, res.Todo.ID), []string{"DTSTART:20250318T090000Z", tc.nRule}, nil)
			checkStored(t, "S", storedObject(t, e, id),
				[]string{"DTSTART:20250303T090000Z", "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;UNTIL=20250317T085959Z\r\n"}, nil)
		})
	}

	// R, Monday the 24th, shown on Wednesday by another app's override,
	// moved to 10:00 there: N moves by that hour from R's RECURRENCE-ID, as
	// a series moves from its current repeat shown elsewhere, and keeps its
	// day; R's override moves along and takes the new dates (FR-17).
	t.Run("N moves by the distance R moved from where it is shown", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250303T090000Z", "RRULE:FREQ=WEEKLY;BYDAY=MO"},
			[]string{"RECURRENCE-ID:20250324T090000Z", "DTSTART:20250326T090000Z"})
		res, _ := updateTodoFollowing(t, e, id, fourthRepeat, shiftedBy(time.Hour))
		if n := res.Todo; n.RRule != "FREQ=WEEKLY;BYDAY=MO" || !sameTime(n.Start, ptr(date(2025, 3, 26, 10, 0))) ||
			n.Next == nil || !sameTime(n.Next.Start, ptr(date(2025, 3, 31, 10, 0))) {
			t.Errorf("new series = %+v; want R on Wednesday at 10:00, then Mondays at 10:00", n)
		}
		checkStored(t, "N", storedObject(t, e, res.Todo.ID), []string{
			"DTSTART:20250324T100000Z", "RRULE:FREQ=WEEKLY;BYDAY=MO\r\n", "RECURRENCE-ID:20250324T100000Z", "DTSTART:20250326T100000Z",
		}, []string{"BYDAY=WE", "RECURRENCE-ID:20250324T090000Z"})
		checkStored(t, "S", storedObject(t, e, id),
			[]string{"DTSTART:20250303T090000Z", "RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20250324T085959Z\r\n"}, []string{"RECURRENCE-ID"})
	})

	// The rule of the body is N's: S's own, in any case, keeps the rule N
	// inherits, with its lowered COUNT; any other is N's new rule, from R
	// on, and "" makes N the single task at R (FR-17).
	for _, tc := range []struct {
		name    string
		rule    *string // nil: no rrule in the body
		d       time.Duration
		has     []string
		lacks   []string
		rrule   string
		repeats []string
	}{
		{
			name: "S's rule kept, its COUNT lowered", rule: ptr("freq=weekly;count=10"),
			has:   []string{"RRULE:FREQ=WEEKLY;COUNT=7\r\n", "DTSTART:20250324T090000Z", "RECURRENCE-ID:20250331T090000Z"},
			rrule: "FREQ=WEEKLY;COUNT=7",
		},
		{
			name: "another COUNT is a new rule", rule: ptr("FREQ=WEEKLY;COUNT=2"),
			has:   []string{"RRULE:FREQ=WEEKLY;COUNT=2\r\n", "DTSTART:20250324T090000Z"},
			lacks: []string{"RECURRENCE-ID"},
			rrule: "FREQ=WEEKLY;COUNT=2",
			repeats: []string{
				"N 03-24 09:00 03-24 09:00 current", "N 03-31 09:00 03-31 09:00 upcoming",
			},
		},
		{
			name: "a new rule on N only", rule: ptr("FREQ=DAILY;COUNT=2"),
			has:   []string{"RRULE:FREQ=DAILY;COUNT=2\r\n", "DTSTART:20250324T090000Z"},
			lacks: []string{"RECURRENCE-ID"},
			rrule: "FREQ=DAILY;COUNT=2",
			repeats: []string{
				"N 03-24 09:00 03-24 09:00 current", "N 03-25 09:00 03-25 09:00 upcoming",
			},
		},
		{
			name: "no rule makes N the single task at R", rule: ptr(""), d: time.Hour,
			has:   []string{"DTSTART:20250324T100000Z", "DUE:20250324T110000Z"},
			lacks: []string{"RRULE", "RECURRENCE-ID", "EXDATE"},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			id := seedSeries(t, e, weeklyFromMarch3, []string{"RECURRENCE-ID:20250331T090000Z", "SUMMARY:Ahead"})
			res, snap := updateTodoFollowing(t, e, id, fourthRepeat, func(in *domain.TodoInput) {
				shiftedBy(tc.d)(in)
				if tc.rule != nil {
					*in = withRule(*in, *tc.rule)
				}
			})
			checkStored(t, "N", storedObject(t, e, res.Todo.ID), tc.has, tc.lacks)
			checkStored(t, "S", storedObject(t, e, id), []string{"RRULE:FREQ=WEEKLY;UNTIL=20250324T085959Z\r\n"},
				[]string{"RECURRENCE-ID"})
			if res.Todo.RRule != tc.rrule || res.Todo.Recurring != (tc.rrule != "") || snap == nil {
				t.Errorf("new series = %+v, snapshot %v; want rule %q", res.Todo, snap != nil, tc.rrule)
			}
			if tc.repeats != nil {
				checkRepeats(t, e, id, res.Todo.ID, append([]string{
					"S 03-03 09:00 03-03 09:00 current", "S 03-10 09:00 03-10 09:00 upcoming", "S 03-17 09:00 03-17 09:00 upcoming",
				}, tc.repeats...)...)
			}
		})
	}

	// At the current repeat nothing comes before it: "this and following"
	// is "all", PUT /todos/{id}, and both todos of the answer are the series
	// as written (FR-17).
	for _, tc := range []struct {
		name   string
		master []string
		has    []string
	}{
		{
			"the current repeat changes the whole series", weeklyFromMarch3,
			[]string{"DTSTART:20250304T090000Z", "RRULE:FREQ=WEEKLY;COUNT=10\r\n", "SUMMARY:Renamed"},
		},
		{
			"the last repeat changes the whole series",
			[]string{"DTSTART:20250303T090000Z", "RRULE:FREQ=WEEKLY;COUNT=1"},
			[]string{"DTSTART:20250304T090000Z", "RRULE:FREQ=WEEKLY;UNTIL=20250304T090000Z\r\n", "SUMMARY:Renamed"},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			id := seedSeries(t, e, tc.master)
			seeded := storedObject(t, e, id)
			res, snap := updateTodoFollowing(t, e, id, date(2025, 3, 3, 9, 0), func(in *domain.TodoInput) {
				shiftedBy(24 * time.Hour)(in)
				in.Title = "Renamed"
			})
			if res.Todo.ID != id || res.Todo.Title != "Renamed" || res.Todo.ETag == "" || !reflect.DeepEqual(res.Series, res.Todo) {
				t.Errorf("answer = %+v; want the series itself, renamed, twice", res)
			}
			checkStored(t, "series", storedObject(t, e, id), tc.has, nil)
			if paths := e.mock.ObjectPaths(e.paths["tasks"]); len(paths) != 1 {
				t.Errorf("objects = %v; want the series only", paths)
			}
			if snap == nil || string(snap.Data) != seeded || snap.ETag != res.Todo.ETag || len(snap.Created) != 0 {
				t.Errorf("snapshot = %+v; want the seeded series alone", snap)
			}
		})
	}

	// A view not reloaded since the series changed elsewhere is stale
	// (FR-17, NFR-26).
	for _, tc := range staleRepeats {
		t.Run("stale: "+tc.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			id := seedSeries(t, e, tc.master, tc.overrides...)
			seeded := storedObject(t, e, id)
			f := listedTodo(t, e, id)
			in := editInput(&f)
			in.Status = domain.TodoNeedsAction // the view showed the series open
			e.mock.ResetCounts()
			_, _, err := e.svc.UpdateTodoFollowing(t.Context(), id, f.ETag, tc.rid, in)
			mustErr(t, err, domain.ErrConflict)
			mustWriteNothing(t, e, id, seeded)
		})
	}

	// Completing goes through PUT /todos/{id}: the body is refused before
	// anything is read (FR-17).
	for _, status := range []string{domain.TodoCompleted, domain.TodoCancelled} {
		t.Run("a body "+status+" is refused", func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			id := seedSeries(t, e, weeklyFromMarch3)
			seeded := storedObject(t, e, id)
			f := listedTodo(t, e, id)
			in := followingInput(t, e, &f, fourthRepeat)
			in.Status = status
			e.mock.ResetCounts()
			_, _, err := e.svc.UpdateTodoFollowing(t.Context(), id, f.ETag, fourthRepeat, in)
			mustErr(t, err, domain.ErrInvalidInput)
			for _, m := range []string{http.MethodGet, "PROPFIND", "REPORT"} {
				if n := e.mock.Count(m); n != 0 {
					t.Errorf("%s count = %d; want nothing read", m, n)
				}
			}
			mustWriteNothing(t, e, id, seeded)
		})
	}

	t.Run("a stale etag is a conflict", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, weeklyFromMarch3)
		seeded := storedObject(t, e, id)
		f := listedTodo(t, e, id)
		in := followingInput(t, e, &f, fourthRepeat)
		e.mock.ResetCounts()
		_, _, err := e.svc.UpdateTodoFollowing(t.Context(), id, `"bogus"`, fourthRepeat, in)
		mustErr(t, err, domain.ErrConflict)
		mustWriteNothing(t, e, id, seeded)
	})

	// A change N or the series refuses is refused as by PUT /todos/{id},
	// before anything is written: an invalid body before anything is read,
	// dates or a rule that are not valid for N, and a move of the whole
	// series at its current repeat that its rule cannot follow (FR-17).
	for _, tc := range []struct {
		name   string
		master []string
		rid    time.Time
		edit   func(in *domain.TodoInput)
		want   error
	}{
		{"a body without a title", weeklyFromMarch3, fourthRepeat, func(in *domain.TodoInput) { in.Title = "" }, domain.ErrInvalidInput},
		{"a start after the due", weeklyFromMarch3, fourthRepeat, func(in *domain.TodoInput) {
			in.Start = ptr(in.Due.Add(time.Hour))
		}, domain.ErrInvalidInput},
		{"a rule that is not valid", weeklyFromMarch3, fourthRepeat, func(in *domain.TodoInput) {
			*in = withRule(*in, "FREQ=SOMETIMES")
		}, domain.ErrInvalidInput},
		{
			"a move at the current repeat the rule cannot follow",
			[]string{"DTSTART:20250315T090000Z", "RRULE:FREQ=MONTHLY;BYMONTHDAY=15"},
			date(2025, 3, 15, 9, 0), shiftedBy(24 * time.Hour), domain.ErrSeriesMoveUnsupported,
		},
	} {
		t.Run(tc.name+" is refused", func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			id := seedSeries(t, e, tc.master)
			seeded := storedObject(t, e, id)
			f := listedTodo(t, e, id)
			in := followingInput(t, e, &f, tc.rid)
			tc.edit(&in)
			e.mock.ResetCounts()
			_, snap, err := e.svc.UpdateTodoFollowing(t.Context(), id, f.ETag, tc.rid, in)
			mustErr(t, err, tc.want)
			if snap != nil {
				t.Errorf("snapshot %+v; want none", snap)
			}
			mustWriteNothing(t, e, id, seeded)
		})
	}
}

// The body of a write to a later repeat R and the repeats after it carries
// the series' fields with the user's edits: only those that differ from the
// series go into the new series N, into its master and into R's override,
// so that a field left as the series has it keeps the value another app
// gave R alone, and R's own title does not become the title of every repeat
// of N. The checklist counts by its items' text, as N's are unchecked
// anyway. Without a rule, N is R alone, and takes the body as it is (FR-17).
func TestTodoFollowingComparesWithSeries(t *testing.T) {
	t.Parallel()
	series := todoFields{"Series", "Series notes\n\n- [ ] s", "5"}
	own := todoFields{"Own", "Own notes\n\n- [x] o", "1"}
	// R, shown at 15:00 by its override, moved a day later: its override
	// moves along with N.
	const moved = "20250325T090000Z"
	day := shiftedBy(24 * time.Hour)
	for _, tc := range []struct {
		name      string
		edit      func(in *domain.TodoInput)
		rule      *string
		master    todoFields
		overrides map[string]todoFields // R's in N, by its RECURRENCE-ID
	}{
		{name: "the series' fields leave R's own", edit: day, master: series, overrides: map[string]todoFields{moved: own}},
		{
			name: "a changed title goes into N and R",
			edit: func(in *domain.TodoInput) {
				day(in)
				in.Title = "New"
			},
			master:    todoFields{"New", series.notes, "5"},
			overrides: map[string]todoFields{moved: {"New", own.notes, "1"}},
		},
		{
			name: "changed notes go into N and R, each with its own checklist",
			edit: func(in *domain.TodoInput) {
				day(in)
				in.Description = "New notes"
			},
			master:    todoFields{"Series", "New notes\n\n- [ ] s", "5"},
			overrides: map[string]todoFields{moved: {"Own", "New notes\n\n- [x] o", "1"}},
		},
		{
			name: "a changed priority goes into N and R",
			edit: func(in *domain.TodoInput) {
				day(in)
				in.Priority = 2
			},
			master:    todoFields{"Series", series.notes, "2"},
			overrides: map[string]todoFields{moved: {"Own", own.notes, "2"}},
		},
		{
			name: "a changed checklist goes into N and R, each with its own notes",
			edit: func(in *domain.TodoInput) {
				in.Checklist = []domain.ChecklistItem{{Text: "s"}, {Text: "p"}}
			},
			master:    todoFields{"Series", "Series notes\n\n- [ ] s\n- [ ] p", "5"},
			overrides: map[string]todoFields{"20250324T090000Z": {"Own", "Own notes\n\n- [ ] s\n- [ ] p", "1"}},
		},
		{
			name:      "a checklist item's state alone is no change",
			edit:      func(in *domain.TodoInput) { in.Checklist = []domain.ChecklistItem{{Text: "s", Done: true}} },
			master:    series,
			overrides: map[string]todoFields{"20250324T090000Z": own},
		},
		{
			name:      "without a rule, N is R as sent",
			edit:      func(in *domain.TodoInput) { in.Title = "New" },
			rule:      ptr(""),
			master:    todoFields{"New", series.notes, "5"},
			overrides: map[string]todoFields{},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			id := seedSeries(t, e, append([]string{`DESCRIPTION:Series notes\n\n- [ ] s`, "PRIORITY:5"}, weeklyFromMarch3...),
				[]string{
					"RECURRENCE-ID:20250324T090000Z", "DTSTART:20250324T150000Z", "SUMMARY:Own",
					`DESCRIPTION:Own notes\n\n- [x] o`, "PRIORITY:1",
				})
			if r := listedRepeat(t, e, id, fourthRepeat); r.Title != "Own" {
				t.Fatalf("R = %+v; want it listed with its own title", r)
			}
			res, _ := updateTodoFollowing(t, e, id, fourthRepeat, func(in *domain.TodoInput) {
				// The series' fields, as a client sends them, and the edit.
				tc.edit(in)
				if tc.rule != nil {
					*in = withRule(*in, *tc.rule)
				}
			})
			checkFields(t, e, res.Todo.ID, tc.master, tc.overrides)
		})
	}

	// A field left as the series has it is not written into N at all: it
	// keeps the form another app wrote it in, here a checklist with "*"
	// (FR-17).
	t.Run("the fields left as they are keep their form in N", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, append([]string{`DESCRIPTION:Notes\n\n* [ ] a`, "PRIORITY:05"}, weeklyFromMarch3...))
		res, _ := updateTodoFollowing(t, e, id, fourthRepeat, func(in *domain.TodoInput) { in.Title = "New" })
		checkFields(t, e, res.Todo.ID, todoFields{"New", "Notes\n\n* [ ] a", "05"}, map[string]todoFields{})
	})
}

// unsplittableSeries are task series a write to a repeat and the ones after
// it refuses with ErrSeriesSplitUnsupported before anything is written, at
// the repeat rid (FR-17): what a server that schedules implicitly would tell
// attendees of, what a new series could not keep, and a repeat no new series
// can start at.
var unsplittableSeries = []struct {
	name      string
	master    []string
	overrides [][]string
	rid       time.Time
}{
	{
		name:   "an attendee of the series",
		master: append([]string{"ATTENDEE:mailto:you@example.com"}, weeklyFromMarch3...),
		rid:    fourthRepeat,
	},
	{
		name:      "an organizer of an override",
		master:    weeklyFromMarch3,
		overrides: [][]string{{"RECURRENCE-ID:20250310T090000Z", "ORGANIZER:mailto:me@example.com"}},
		rid:       fourthRepeat,
	},
	{
		// Also where the change is all of the series.
		name:   "an attendee, at the current repeat",
		master: append([]string{"ATTENDEE:mailto:you@example.com"}, weeklyFromMarch3...),
		rid:    date(2025, 3, 3, 9, 0),
	},
	{
		name:   "an EXRULE",
		master: append([]string{"EXRULE:FREQ=MONTHLY"}, weeklyFromMarch3...),
		rid:    fourthRepeat,
	},
	{
		// Lucid reads the first, the weekly one.
		name:   "two RRULEs",
		master: slices.Concat(weeklyFromMarch3, []string{"RRULE:FREQ=DAILY;COUNT=2"}),
		rid:    fourthRepeat,
	},
	{
		name:   "a rule Lucid cannot read",
		master: []string{"DTSTART:20250303T090000Z", "RRULE:FREQ=WEEKLY;BYDAY=XX"},
		rid:    fourthRepeat,
	},
	{
		name:   "an RDATE",
		master: append([]string{"RDATE:20250305T090000Z"}, weeklyFromMarch3...),
		rid:    fourthRepeat,
	},
	{
		// A Tuesday override of a Monday series, as a move of an interval
		// series leaves it (A-10).
		name:      "a repeat off the rule",
		master:    weeklyFromMarch3,
		overrides: [][]string{{"RECURRENCE-ID:20250325T090000Z", "SUMMARY:Off the rule"}},
		rid:       date(2025, 3, 25, 9, 0),
	},
	{
		// R lies past maxRRuleIterations minutes.
		name:   "a repeat the rule cannot be walked to",
		master: []string{"DTSTART:20250101T000000Z", "RRULE:FREQ=MINUTELY"},
		rid:    date(2026, 1, 1, 0, 0),
	},
}

// Both writes to a repeat and the ones after it refuse a series they cannot
// split, with nothing written (FR-17).
func TestTodoFollowingRefuses(t *testing.T) {
	t.Parallel()
	for _, tc := range unsplittableSeries {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			id := seedSeries(t, e, tc.master, tc.overrides...)
			seeded := storedObject(t, e, id)
			f := listedTodo(t, e, id)
			in := editInput(&f)
			e.mock.ResetCounts()
			_, snap, err := e.svc.UpdateTodoFollowing(t.Context(), id, f.ETag, tc.rid, in)
			mustErr(t, err, domain.ErrSeriesSplitUnsupported)
			if errors.Is(err, domain.ErrInvalidInput) {
				t.Errorf("error %v is invalid input as well; want series_split_unsupported alone", err)
			}
			got, dsnap, derr := e.svc.DeleteTodoFollowing(t.Context(), id, f.ETag, tc.rid)
			mustErr(t, derr, domain.ErrSeriesSplitUnsupported)
			if snap != nil || dsnap != nil || got.ID != "" {
				t.Errorf("answered %+v and snapshots %v, %v; want neither", got, snap != nil, dsnap != nil)
			}
			mustWriteNothing(t, e, id, seeded)
		})
	}
}

// TestTodoFollowingOverOtherAppsCompletion is Review Focus 4: a series is
// split at its fourth repeat while another app completed its fifth. The
// completion becomes a task of its own, as when a rule change drops it, and
// leaves both series: N excludes that repeat, which shows once, done, as its
// entry, and starts at the fourth with the repeats left. There is no undo:
// restoring S would bring the completion back next to its entry (FR-17,
// A-18).
func TestTodoFollowingOverOtherAppsCompletion(t *testing.T) {
	t.Parallel()
	done := []string{"RECURRENCE-ID:20250331T090000Z", "STATUS:COMPLETED", "COMPLETED:20250320T080000Z", "SUMMARY:Done early"}
	before := []string{"RECURRENCE-ID:20250310T090000Z", "STATUS:COMPLETED"}
	// checkEntry checks the one resource besides the todos ids: the entry
	// of the fifth repeat's completion.
	checkEntry := func(t *testing.T, e *env, ids ...string) {
		t.Helper()
		skip := map[string]bool{}
		for _, id := range ids {
			skip[mustDecode(t, e, id)] = true
		}
		var entries []string
		for _, p := range e.mock.ObjectPaths(e.paths["tasks"]) {
			if data, ok := e.mock.Object(p); ok && !skip[p] {
				entries = append(entries, data)
			}
		}
		if len(entries) != 1 {
			t.Fatalf("entries = %q; want the fifth repeat's", entries)
		}
		checkStored(t, "entry", entries[0],
			[]string{"DTSTART:20250331T090000Z", "STATUS:COMPLETED", "COMPLETED:20250320T080000Z", "SUMMARY:Done early"},
			[]string{"RECURRENCE-ID", "RRULE", "EXDATE", "\r\nUID:r\r\n"})
	}

	t.Run("the change", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, weeklyFromMarch3, before, done)
		res, snap := updateTodoFollowing(t, e, id, fourthRepeat, func(in *domain.TodoInput) { in.Title = "Renamed" })
		if snap != nil {
			t.Errorf("snapshot for %s; want none", snap.ID)
		}
		n := res.Todo
		checkEntry(t, e, id, n.ID)
		checkStored(t, "N", storedObject(t, e, n.ID),
			[]string{"DTSTART:20250324T090000Z", "RRULE:FREQ=WEEKLY;COUNT=7\r\n", "EXDATE:20250331T090000Z", "SUMMARY:Renamed"},
			[]string{"RECURRENCE-ID", "Done early"})
		checkStored(t, "S", storedObject(t, e, id),
			[]string{"RRULE:FREQ=WEEKLY;UNTIL=20250324T085959Z\r\n", "RECURRENCE-ID:20250310T090000Z"},
			[]string{"20250331", "Done early", "EXDATE"})
		checkRepeats(t, e, id, n.ID,
			"S 03-03 09:00 03-03 09:00 current", "S 03-10 09:00 03-10 09:00 done", "S 03-17 09:00 03-17 09:00 upcoming",
			"N 03-24 09:00 03-24 09:00 current", "N 04-07 09:00 04-07 09:00 upcoming", "N 04-14 09:00 04-14 09:00 upcoming",
			"N 04-21 09:00 04-21 09:00 upcoming", "N 04-28 09:00 04-28 09:00 upcoming", "N 05-05 09:00 05-05 09:00 upcoming")
	})

	// The excluded repeat moves along with N, as an EXDATE does.
	t.Run("the change with a move", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, weeklyFromMarch3, done)
		res, _ := updateTodoFollowing(t, e, id, fourthRepeat, shiftedBy(24*time.Hour))
		checkStored(t, "N", storedObject(t, e, res.Todo.ID),
			[]string{"DTSTART:20250325T090000Z", "RRULE:FREQ=WEEKLY;COUNT=7\r\n", "EXDATE:20250401T090000Z"},
			[]string{"RECURRENCE-ID"})
	})

	// A completion off the rule, where a move of the series to an earlier
	// day left it, is no repeat of N: it only leaves the series, as on a
	// roll (A-10).
	t.Run("a completion off the rule", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, weeklyFromMarch3,
			[]string{"RECURRENCE-ID:20250401T090000Z", "STATUS:COMPLETED", "SUMMARY:Off the rule"})
		res, snap := updateTodoFollowing(t, e, id, fourthRepeat, nil)
		if snap != nil {
			t.Errorf("snapshot for %s; want none", snap.ID)
		}
		checkStored(t, "N", storedObject(t, e, res.Todo.ID), []string{"RRULE:FREQ=WEEKLY;COUNT=7\r\n"},
			[]string{"RECURRENCE-ID", "EXDATE", "Off the rule"})
		if entries := len(e.mock.ObjectPaths(e.paths["tasks"])) - 2; entries != 1 {
			t.Errorf("%d entries; want the completion's", entries)
		}
	})

	// A completion the rule cannot be walked to within maxRRuleIterations
	// may or may not be a repeat of N: the change is refused, with nothing
	// written. Ending the series, which keeps no repeat after it, is not.
	t.Run("a completion the rule cannot be walked to", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250101T000000Z", "RRULE:FREQ=MINUTELY"},
			[]string{"RECURRENCE-ID:20250601T000000Z", "STATUS:COMPLETED"})
		seeded := storedObject(t, e, id)
		f := listedTodo(t, e, id)
		rid := date(2025, 1, 1, 0, 10)
		in := editInput(&f)
		in.Start = &rid
		e.mock.ResetCounts()
		_, _, err := e.svc.UpdateTodoFollowing(t.Context(), id, f.ETag, rid, in)
		mustErr(t, err, domain.ErrSeriesSplitUnsupported)
		mustWriteNothing(t, e, id, seeded)
		_, _, err = e.svc.DeleteTodoFollowing(t.Context(), id, f.ETag, rid)
		mustNoErr(t, err)
	})

	// An entry that cannot be created stops the change before anything else
	// is written (FR-17, A-18).
	t.Run("an entry that cannot be created", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, weeklyFromMarch3, done)
		seeded := storedObject(t, e, id)
		f := listedTodo(t, e, id)
		in := followingInput(t, e, &f, fourthRepeat)
		var toS atomic.Int32
		answerCreate(e.mock, mustDecode(t, e, id), createAnswer{status: http.StatusPreconditionFailed}, &toS)
		e.mock.ResetCounts()
		_, _, err := e.svc.UpdateTodoFollowing(t.Context(), id, f.ETag, fourthRepeat, in)
		mustErr(t, err, domain.ErrConflict)
		_, _, err = e.svc.DeleteTodoFollowing(t.Context(), id, f.ETag, fourthRepeat)
		mustErr(t, err, domain.ErrConflict)
		if e.mock.Count(http.MethodPut) != 2 || toS.Load() != 0 {
			t.Errorf("%d PUTs, %d of the series; want the two refused entries only", e.mock.Count(http.MethodPut), toS.Load())
		}
		if stored := storedObject(t, e, id); stored != seeded {
			t.Errorf("S = %q; want it unchanged: %q", stored, seeded)
		}
		if paths := e.mock.ObjectPaths(e.paths["tasks"]); len(paths) != 1 {
			t.Errorf("objects = %v; want the series only", paths)
		}
	})

	t.Run("the end", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, weeklyFromMarch3, before, done)
		got, snap, err := e.svc.DeleteTodoFollowing(t.Context(), id, listedTodo(t, e, id).ETag, fourthRepeat)
		mustNoErr(t, err)
		if snap != nil || got.ID != id {
			t.Errorf("answered %+v and a snapshot: %v; want S and no snapshot", got, snap != nil)
		}
		checkEntry(t, e, id)
		checkStored(t, "S", storedObject(t, e, id),
			[]string{"RRULE:FREQ=WEEKLY;UNTIL=20250324T085959Z\r\n", "RECURRENCE-ID:20250310T090000Z"},
			[]string{"20250331", "Done early"})
	})
}

// refuseNewSeries makes mock refuse with 412 the PUT that creates a new
// series, a resource with an RRULE created with If-None-Match: *, and pass
// the other requests on, the creates of entries among them.
func refuseNewSeries(mock *caldavtest.Server) {
	mock.SetHook(func(w http.ResponseWriter, r *http.Request) bool {
		if r.Method != http.MethodPut || r.Header.Get("If-None-Match") != "*" {
			return false
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return true
		}
		if bytes.Contains(body, []byte("RRULE:")) {
			w.WriteHeader(http.StatusPreconditionFailed)
			return true
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
		return false
	})
}

// TestTodoFollowingWriteFailures checks the writes of a split when one fails
// (FR-17, A-01), as for events (see TestUpdateFollowingWriteFailures): N,
// and the entries other apps' completions became, go again where S's write
// is known not to have landed, by the server's refusal or by S's unchanged
// ETag; the split counts as saved, with S's ETag unknown and no snapshot,
// where S's ETag changed; and N stays, logged, with the error where S's ETag
// cannot be read. When N cannot be created, S is not written at all. A split
// whose N's ETag is unknown is saved without a snapshot.
func TestTodoFollowingWriteFailures(t *testing.T) {
	t.Parallel()
	moved := shiftedBy(time.Hour)
	done := []string{"RECURRENCE-ID:20250331T090000Z", "STATUS:COMPLETED"}
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
		t.Run("S "+tc.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			id := seedSeries(t, e, weeklyFromMarch3)
			seeded := storedObject(t, e, id)
			f := listedTodo(t, e, id)
			in := followingInput(t, e, &f, fourthRepeat)
			moved(&in)
			answerPutWith(e.mock, mustDecode(t, e, id), tc.apply, tc.status, tc.propfindStatus)
			e.mock.ResetCounts()
			res, snap, err := e.svc.UpdateTodoFollowing(t.Context(), id, f.ETag, fourthRepeat, in)
			if tc.wantErr != nil {
				mustErr(t, err, tc.wantErr)
				if now := storedObject(t, e, id); now != seeded {
					t.Errorf("S = %q; want it unchanged: %q", now, seeded)
				}
				if res.Todo.ID != "" || res.Series.ID != "" || snap != nil {
					t.Errorf("answered %+v and a snapshot: %v; want neither with an error", res, snap != nil)
				}
			} else {
				mustNoErr(t, err)
				if res.Series.ETag != "" || snap != nil || res.Todo.ID == "" || res.Todo.ETag == "" {
					t.Errorf("answered %+v and a snapshot: %v; want N, S's ETag unknown and no snapshot", res, snap != nil)
				}
				checkStored(t, "S", storedObject(t, e, id), []string{"UNTIL=20250324T085959Z"}, nil)
			}
			if n := len(e.mock.ObjectPaths(e.paths["tasks"])); n != tc.wantObjects {
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
		id := seedSeries(t, e, weeklyFromMarch3)
		answerWithoutETag(e.mock, mustDecode(t, e, id))
		res, snap := updateTodoFollowing(t, e, id, fourthRepeat, moved)
		if res.Series.ETag != "" || snap != nil || res.Todo.ETag == "" || res.Series.ID != id {
			t.Errorf("answered %+v and a snapshot: %v; want N with its ETag, S's unknown, no snapshot", res, snap != nil)
		}
	})

	// N's ETag unknown: an undo could not delete N, which would stand next
	// to S restored, so there is none; the split is saved all the same.
	t.Run("N's ETag unknown", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, weeklyFromMarch3)
		var toS atomic.Int32
		answerCreate(e.mock, mustDecode(t, e, id), createAnswer{noETag: true, propfind: http.StatusInternalServerError}, &toS)
		res, snap := updateTodoFollowing(t, e, id, fourthRepeat, moved)
		if snap != nil || res.Todo.ID == "" || res.Todo.ETag != "" {
			t.Errorf("answered %+v and a snapshot: %v; want N, its ETag unknown, no snapshot", res, snap != nil)
		}
		if want := storedETag(t, e, mustDecode(t, e, id)); res.Series.ETag != want {
			t.Errorf("S's ETag = %q; want the stored %q", res.Series.ETag, want)
		}
	})

	for _, tc := range []struct {
		name        string
		answer      createAnswer
		want        error
		wantObjects int
		wantDeletes int
	}{
		{"creating N refused", createAnswer{status: http.StatusPreconditionFailed}, domain.ErrConflict, 1, 0},
		{"creating N fails, N not stored", createAnswer{status: http.StatusBadGateway}, domain.ErrUpstream, 1, 0},
		{"creating N fails, N stored", createAnswer{status: http.StatusBadGateway, stored: true}, domain.ErrUpstream, 1, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			id := seedSeries(t, e, weeklyFromMarch3)
			seeded := storedObject(t, e, id)
			f := listedTodo(t, e, id)
			in := followingInput(t, e, &f, fourthRepeat)
			moved(&in)
			var toS atomic.Int32
			answerCreate(e.mock, mustDecode(t, e, id), tc.answer, &toS)
			e.mock.ResetCounts()
			_, snap, err := e.svc.UpdateTodoFollowing(t.Context(), id, f.ETag, fourthRepeat, in)
			mustErr(t, err, tc.want)
			if n := toS.Load(); n != 0 || snap != nil {
				t.Errorf("%d PUTs of S and a snapshot: %v; want neither", n, snap != nil)
			}
			if paths := e.mock.ObjectPaths(e.paths["tasks"]); len(paths) != tc.wantObjects {
				t.Errorf("objects = %v; want %d", paths, tc.wantObjects)
			}
			if n := e.mock.Count(http.MethodDelete); n != tc.wantDeletes {
				t.Errorf("%d DELETEs; want %d", n, tc.wantDeletes)
			}
			if now := storedObject(t, e, id); now != seeded {
				t.Errorf("S = %q; want it unchanged: %q", now, seeded)
			}
		})
	}

	// The entries other apps' completions became go again with N, as N
	// does, where the split is known not to have landed, and stay where it
	// may have (FR-17, A-18).
	for _, tc := range []struct {
		name        string
		hook        func(e *env, sPath string)
		want        error
		wantObjects int
		wantDeletes int
	}{
		{"creating N refused", func(e *env, _ string) { refuseNewSeries(e.mock) }, domain.ErrConflict, 1, 1},
		{"S refused", func(e *env, sPath string) {
			answerPutWith(e.mock, sPath, false, http.StatusPreconditionFailed, 0)
		}, domain.ErrConflict, 1, 2},
		{"S's write unverified", func(e *env, sPath string) {
			answerPutWith(e.mock, sPath, false, http.StatusBadGateway, http.StatusInternalServerError)
		}, domain.ErrUpstream, 3, 0},
	} {
		t.Run("with an entry, "+tc.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			id := seedSeries(t, e, weeklyFromMarch3, done)
			seeded := storedObject(t, e, id)
			f := listedTodo(t, e, id)
			in := followingInput(t, e, &f, fourthRepeat)
			tc.hook(e, mustDecode(t, e, id))
			e.mock.ResetCounts()
			_, snap, err := e.svc.UpdateTodoFollowing(t.Context(), id, f.ETag, fourthRepeat, in)
			mustErr(t, err, tc.want)
			if snap != nil {
				t.Errorf("snapshot %+v; want none", snap)
			}
			if paths := e.mock.ObjectPaths(e.paths["tasks"]); len(paths) != tc.wantObjects {
				t.Errorf("objects = %v; want %d", paths, tc.wantObjects)
			}
			if n := e.mock.Count(http.MethodDelete); n != tc.wantDeletes {
				t.Errorf("%d DELETEs; want %d", n, tc.wantDeletes)
			}
			if now := storedObject(t, e, id); now != seeded {
				t.Errorf("S = %q; want it unchanged: %q", now, seeded)
			}
		})
	}
}

// TestDeleteTodoFollowing ends a task series before a later repeat R
// (FR-17; spec section 5 "Teilen und Beenden"): the rule ends just before R,
// and the references from R on go, in one write that an undo restores. At
// the current repeat nothing comes before it: the task goes.
func TestDeleteTodoFollowing(t *testing.T) {
	t.Parallel()

	t.Run("ends the series before a later repeat", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, append([]string{"EXDATE:20250407T090000Z,20250317T090000Z"}, weeklyFromMarch3...),
			[]string{"RECURRENCE-ID:20250310T090000Z", "SUMMARY:Kept"},
			[]string{"RECURRENCE-ID:20250331T090000Z", "SUMMARY:Ahead"})
		seeded := storedObject(t, e, id)
		before := listedTodo(t, e, id)
		got, snap, err := e.svc.DeleteTodoFollowing(t.Context(), id, before.ETag, fourthRepeat)
		mustNoErr(t, err)
		if got.ID != id || got.ETag != listedTodo(t, e, id).ETag || got.RRule != "FREQ=WEEKLY;UNTIL=20250324T085959Z" ||
			!sameTime(got.Start, ptr(date(2025, 3, 3, 9, 0))) {
			t.Errorf("series = %+v; want it as stored, ending before March 24", got)
		}
		checkStored(t, "S", storedObject(t, e, id),
			[]string{
				"RRULE:FREQ=WEEKLY;UNTIL=20250324T085959Z\r\n", "EXDATE:20250317T090000Z\r\n",
				"RECURRENCE-ID:20250310T090000Z", "SEQUENCE:1",
			},
			[]string{"20250407", "20250331", "Ahead"})
		checkRepeats(t, e, id, "",
			"S 03-03 09:00 03-03 09:00 current", "S 03-10 09:00 03-10 09:00 upcoming")
		if paths := e.mock.ObjectPaths(e.paths["tasks"]); len(paths) != 1 {
			t.Errorf("objects = %v; want the series only", paths)
		}
		if snap == nil || snap.ID != id || snap.ETag != got.ETag || string(snap.Data) != seeded || len(snap.Created) != 0 {
			t.Fatalf("snapshot = %+v; want the seeded series alone", snap)
		}
		restored, err := e.svc.RestoreTodo(t.Context(), *snap)
		mustNoErr(t, err)
		if stored := storedObject(t, e, id); stored != seeded {
			t.Errorf("restored:\n%s\nwant the seeded series:\n%s", stored, seeded)
		}
		if restored.ETag == "" || !reflect.DeepEqual(restored, before) {
			t.Errorf("restored todo = %+v; want it as listed before, %+v", restored, before)
		}
	})

	for _, tc := range []struct {
		name   string
		master []string
	}{
		{"the current repeat deletes the task", weeklyFromMarch3},
		{"the last repeat deletes the task", []string{"DTSTART:20250303T090000Z", "RRULE:FREQ=WEEKLY;COUNT=1"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			id := seedSeries(t, e, tc.master)
			got, snap, err := e.svc.DeleteTodoFollowing(t.Context(), id, listedTodo(t, e, id).ETag, date(2025, 3, 3, 9, 0))
			mustNoErr(t, err)
			if got.ID != "" || snap != nil {
				t.Errorf("answered %+v and a snapshot: %v; want neither once the task is deleted", got, snap != nil)
			}
			if paths := e.mock.ObjectPaths(e.paths["tasks"]); len(paths) != 0 {
				t.Errorf("objects = %v; want none", paths)
			}
		})
	}

	for _, tc := range staleRepeats {
		t.Run("stale: "+tc.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			id := seedSeries(t, e, tc.master, tc.overrides...)
			seeded := storedObject(t, e, id)
			f := listedTodo(t, e, id)
			e.mock.ResetCounts()
			_, _, err := e.svc.DeleteTodoFollowing(t.Context(), id, f.ETag, tc.rid)
			mustErr(t, err, domain.ErrConflict)
			mustWriteNothing(t, e, id, seeded)
		})
	}

	// The entry of another app's completion goes again with S's write
	// refused, as for a rule change (FR-17, A-18).
	t.Run("a refused write removes the entries", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, weeklyFromMarch3, []string{"RECURRENCE-ID:20250331T090000Z", "STATUS:COMPLETED"})
		seeded := storedObject(t, e, id)
		f := listedTodo(t, e, id)
		answerPutWith(e.mock, mustDecode(t, e, id), false, http.StatusPreconditionFailed, 0)
		e.mock.ResetCounts()
		_, snap, err := e.svc.DeleteTodoFollowing(t.Context(), id, f.ETag, fourthRepeat)
		mustErr(t, err, domain.ErrConflict)
		if snap != nil {
			t.Errorf("snapshot %+v; want none", snap)
		}
		if n := e.mock.Count(http.MethodDelete); n != 1 {
			t.Errorf("%d DELETEs; want the entry's", n)
		}
		if now := storedObject(t, e, id); now != seeded {
			t.Errorf("S = %q; want it unchanged: %q", now, seeded)
		}
		if paths := e.mock.ObjectPaths(e.paths["tasks"]); len(paths) != 1 {
			t.Errorf("objects = %v; want the series only", paths)
		}
	})

	t.Run("a stale etag is a conflict", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, weeklyFromMarch3)
		seeded := storedObject(t, e, id)
		e.mock.ResetCounts()
		_, _, err := e.svc.DeleteTodoFollowing(t.Context(), id, `"bogus"`, fourthRepeat)
		mustErr(t, err, domain.ErrConflict)
		mustWriteNothing(t, e, id, seeded)
	})
}

// TestRestoreTodoSplit undoes a split of a task series: S is written back
// as read and N deleted. Review Focus 5: once N changed since, in Lucid or
// another app, S restored next to it would show every repeat from R on
// twice, so the undo is refused and writes nothing (FR-17).
func TestRestoreTodoSplit(t *testing.T) {
	t.Parallel()

	t.Run("the undo restores S and deletes N", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, weeklyFromMarch3, []string{"RECURRENCE-ID:20250331T090000Z", "SUMMARY:Ahead"})
		seeded := storedObject(t, e, id)
		before := listedTodo(t, e, id)
		_, snap := updateTodoFollowing(t, e, id, fourthRepeat, shiftedBy(24*time.Hour))
		if snap == nil {
			t.Fatal("no snapshot")
		}
		got, err := e.svc.RestoreTodo(t.Context(), *snap)
		mustNoErr(t, err)
		if stored := storedObject(t, e, id); stored != seeded {
			t.Errorf("restored:\n%s\nwant the seeded series:\n%s", stored, seeded)
		}
		if paths := e.mock.ObjectPaths(e.paths["tasks"]); len(paths) != 1 {
			t.Errorf("objects = %v; want the series only", paths)
		}
		if got.ETag == "" || got.CopyKept || !reflect.DeepEqual(got, before) {
			t.Errorf("restored todo = %+v; want it as listed before, %+v", got, before)
		}
	})

	t.Run("the undo is refused once N changed", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, weeklyFromMarch3)
		res, snap := updateTodoFollowing(t, e, id, fourthRepeat, shiftedBy(24*time.Hour))
		if snap == nil {
			t.Fatal("no snapshot")
		}
		split := storedObject(t, e, id)
		nPath := mustDecode(t, e, res.Todo.ID)
		other := strings.Replace(storedObject(t, e, res.Todo.ID), "SUMMARY:Series", "SUMMARY:Other", 1)
		if _, err := e.mock.PutObject(e.paths["tasks"], path.Base(nPath), other); err != nil {
			t.Fatalf("PutObject: %v", err)
		}
		e.mock.ResetCounts()
		_, err := e.svc.RestoreTodo(t.Context(), *snap)
		mustErr(t, err, domain.ErrConflict)
		if n := e.mock.Count(http.MethodPut) + e.mock.Count(http.MethodDelete); n != 0 {
			t.Errorf("%d writes; want none", n)
		}
		if stored := storedObject(t, e, id); stored != split {
			t.Errorf("S:\n%s\nwant it as the split left it:\n%s", stored, split)
		}
		if stored := storedObject(t, e, res.Todo.ID); stored != other {
			t.Errorf("N:\n%s\nwant the other app's change:\n%s", stored, other)
		}
	})

	// N deleted since leaves nothing to delete: S is restored.
	t.Run("the undo restores S once N is gone", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, weeklyFromMarch3)
		seeded := storedObject(t, e, id)
		res, snap := updateTodoFollowing(t, e, id, fourthRepeat, shiftedBy(24*time.Hour))
		if snap == nil {
			t.Fatal("no snapshot")
		}
		mustNoErr(t, e.svc.DeleteTodo(t.Context(), res.Todo.ID, res.Todo.ETag))
		_, err := e.svc.RestoreTodo(t.Context(), *snap)
		mustNoErr(t, err)
		if stored := storedObject(t, e, id); stored != seeded {
			t.Errorf("restored:\n%s\nwant the seeded series:\n%s", stored, seeded)
		}
	})
}
