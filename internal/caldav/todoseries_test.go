package caldav

import (
	"slices"
	"testing"
	"time"

	"github.com/emersion/go-ical"
)

func TestRuleHasFixedDays(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name     string
		rrule    string
		hasRDate bool
		want     bool
	}{
		{name: "rolling parts only", rrule: "FREQ=WEEKLY;INTERVAL=2;COUNT=3;UNTIL=20250101T000000Z;WKST=MO"},
		{name: "byday", rrule: "FREQ=WEEKLY;BYDAY=MO", want: true},
		{name: "bymonthday", rrule: "FREQ=MONTHLY;BYMONTHDAY=15", want: true},
		{name: "rdate", rrule: "FREQ=DAILY", hasRDate: true, want: true},
		{name: "lower-case rolling", rrule: "freq=weekly;interval=2;wkst=mo"},
		{name: "lower-case byday", rrule: "freq=weekly;byday=mo", want: true},
		{name: "rdate only", hasRDate: true, want: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := ruleHasFixedDays(tc.rrule, tc.hasRDate); got != tc.want {
				t.Errorf("ruleHasFixedDays(%q, %v) = %v; want %v", tc.rrule, tc.hasRDate, got, tc.want)
			}
		})
	}
}

// testSeries parses one VTODO per component and returns the series of the
// master (the first without RECURRENCE-ID) and the master itself.
func testSeries(t *testing.T, comps ...[]string) (*todoSeries, *ical.Calendar) {
	t.Helper()
	var lines []string
	for _, c := range comps {
		lines = append(lines, "BEGIN:VTODO", "UID:s", "DTSTAMP:20240101T000000Z", "SUMMARY:Series")
		lines = append(append(lines, c...), "END:VTODO")
	}
	cal := mustParse(t, ics(lines...))
	return newTodoSeries(cal, mainComponent(cal, ical.CompToDo)), cal
}

func checkOcc(t *testing.T, what string, got, want todoOcc) {
	t.Helper()
	if !got.rid.Equal(want.rid) || !sameTime(got.start, want.start) || !sameTime(got.due, want.due) || got.done != want.done {
		t.Errorf("%s = rid %v, start %v, due %v, done %v; want %v, %v, %v, %v",
			what, got.rid, got.start, got.due, got.done, want.rid, want.start, want.due, want.done)
	}
}

func TestNewTodoSeriesNeedsRecurrence(t *testing.T) {
	t.Parallel()
	if s, _ := testSeries(t, []string{"DTSTART:20250310T090000Z"}); s != nil {
		t.Fatalf("newTodoSeries = %+v; want nil for a single todo", s)
	}
}

func TestTodoSeriesWalk(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name      string
		lines     []string
		overrides [][]string
		from      time.Time
		want      []time.Time
		offGrid   []time.Time // the RECURRENCE-IDs of want off the rule
	}{
		{
			// RFC 5545: DTSTART is an occurrence even if the rule does not match it.
			name:  "anchor off the rule comes first",
			lines: []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20250318T090000Z"},
			want:  []time.Time{date(2025, 3, 10, 9, 0), date(2025, 3, 11, 9, 0), date(2025, 3, 18, 9, 0)},
		},
		{
			// RFC 5545 3.3.10: DTSTART is the first of COUNT occurrences, also off the rule.
			name:  "anchor off the rule counts for COUNT",
			lines: []string{"DTSTART:20250311T090000Z", "RRULE:FREQ=WEEKLY;BYDAY=MO,TH;COUNT=3"},
			want:  []time.Time{date(2025, 3, 11, 9, 0), date(2025, 3, 13, 9, 0), date(2025, 3, 17, 9, 0)},
		},
		{
			name:  "from skips earlier occurrences",
			lines: []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=DAILY;COUNT=5"},
			from:  date(2025, 3, 12, 9, 0),
			want:  []time.Time{date(2025, 3, 12, 9, 0), date(2025, 3, 13, 9, 0), date(2025, 3, 14, 9, 0)},
		},
		{
			// A-10: overrides on no instance take their place by RECURRENCE-ID,
			// a cancelled one excepted; one past the last instance is past the
			// rule's end, and does not count against COUNT.
			name:  "overrides off the rule come in order",
			lines: []string{"DTSTART:20250309T090000Z", "RRULE:FREQ=WEEKLY;COUNT=3"},
			overrides: [][]string{
				{"RECURRENCE-ID:20250310T090000Z", "STATUS:COMPLETED"},
				{"RECURRENCE-ID:20250311T090000Z", "STATUS:CANCELLED"},
				{"RECURRENCE-ID:20250316T090000Z", "DTSTART:20250316T150000Z"},
				{"RECURRENCE-ID:20250317T080000Z"},
				{"RECURRENCE-ID:20250330T090000Z"},
			},
			want: []time.Time{
				date(2025, 3, 9, 9, 0), date(2025, 3, 10, 9, 0), date(2025, 3, 16, 9, 0),
				date(2025, 3, 17, 8, 0), date(2025, 3, 23, 9, 0),
			},
			offGrid: []time.Time{date(2025, 3, 10, 9, 0), date(2025, 3, 17, 8, 0)},
		},
		{
			name:      "from skips earlier overrides off the rule",
			lines:     []string{"DTSTART:20250309T090000Z", "RRULE:FREQ=WEEKLY;COUNT=3"},
			overrides: [][]string{{"RECURRENCE-ID:20250310T090000Z"}, {"RECURRENCE-ID:20250317T090000Z"}},
			from:      date(2025, 3, 16, 9, 0),
			want:      []time.Time{date(2025, 3, 16, 9, 0), date(2025, 3, 17, 9, 0), date(2025, 3, 23, 9, 0)},
			offGrid:   []time.Time{date(2025, 3, 17, 9, 0)},
		},
		{
			// A-11: a date in a timed series is off the rule only on a day
			// without an instance in the series' zone, and stands for the
			// series' time of day there: 20:00 in New York is midnight UTC
			// of the next day.
			name:  "a date override off the rule",
			lines: []string{"DTSTART;TZID=America/New_York:20250310T200000", "RRULE:FREQ=WEEKLY;COUNT=2"},
			overrides: [][]string{
				{"RECURRENCE-ID;VALUE=DATE:20250310", "STATUS:COMPLETED"},
				{"RECURRENCE-ID;VALUE=DATE:20250311"},
			},
			want:    []time.Time{date(2025, 3, 11, 0, 0), date(2025, 3, 12, 0, 0), date(2025, 3, 18, 0, 0)},
			offGrid: []time.Time{date(2025, 3, 12, 0, 0)},
		},
		{
			// The override of the anchor's value type wins, as on the rule.
			name:  "overrides of both value types for one repeat off the rule",
			lines: []string{"DTSTART:20250309T090000Z", "RRULE:FREQ=WEEKLY;COUNT=2"},
			overrides: [][]string{
				{"RECURRENCE-ID;VALUE=DATE:20250310", "STATUS:COMPLETED"},
				{"RECURRENCE-ID:20250310T090000Z"},
			},
			want:    []time.Time{date(2025, 3, 9, 9, 0), date(2025, 3, 10, 9, 0), date(2025, 3, 16, 9, 0)},
			offGrid: []time.Time{date(2025, 3, 10, 9, 0)},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			s, _ := testSeries(t, append([][]string{tc.lines}, tc.overrides...)...)
			var got, offGrid []time.Time
			err := s.walk(tc.from, func(o todoOcc) bool {
				got = append(got, o.rid)
				if o.offGrid {
					offGrid = append(offGrid, o.rid)
				}
				return true
			})
			mustNoErr(t, err)
			if !slices.EqualFunc(got, tc.want, time.Time.Equal) || !slices.EqualFunc(offGrid, tc.offGrid, time.Time.Equal) {
				t.Errorf("walk visited %v, off the rule %v; want %v, %v", got, offGrid, tc.want, tc.offGrid)
			}
		})
	}
}

// instancesBefore and ruleEnd count as walk does: the anchor first, on the
// rule or off it, and COUNT occurrences in all (FR-17).
func TestTodoSeriesCounting(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name   string
		lines  []string
		before time.Time // instancesBefore(before) = n
		n      int
		end    time.Time
	}{
		{
			name:   "anchor on the rule",
			lines:  []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY;BYDAY=MO,TH;COUNT=3"},
			before: date(2025, 3, 17, 9, 0), n: 2,
			end: date(2025, 3, 17, 9, 0),
		},
		{
			name:   "anchor off the rule",
			lines:  []string{"DTSTART:20250311T090000Z", "RRULE:FREQ=WEEKLY;BYDAY=MO,TH;COUNT=3"},
			before: date(2025, 3, 13, 9, 0), n: 1,
			end: date(2025, 3, 17, 9, 0),
		},
		{
			name:   "anchor off the rule is the only one of COUNT=1",
			lines:  []string{"DTSTART:20250311T090000Z", "RRULE:FREQ=WEEKLY;BYDAY=MO,TH;COUNT=1"},
			before: date(2025, 3, 13, 9, 0), n: 1,
			end: date(2025, 3, 11, 9, 0),
		},
		{
			name:   "anchor off the rule with UNTIL",
			lines:  []string{"DTSTART:20250311T090000Z", "RRULE:FREQ=WEEKLY;BYDAY=MO,TH;UNTIL=20250317T090000Z"},
			before: date(2025, 3, 17, 9, 0), n: 2,
			end: date(2025, 3, 17, 9, 0),
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			s, _ := testSeries(t, tc.lines)
			n, err := s.instancesBefore(tc.before)
			mustNoErr(t, err)
			if n != tc.n {
				t.Errorf("instancesBefore(%v) = %d; want %d", tc.before, n, tc.n)
			}
			end, err := s.ruleEnd()
			mustNoErr(t, err)
			if !end.Equal(tc.end) {
				t.Errorf("ruleEnd() = %v; want %v", end, tc.end)
			}
		})
	}
}

func TestTodoSeriesZoneKnown(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name  string
		start string
		want  bool
	}{
		{name: "utc", start: "DTSTART:20250310T090000Z", want: true},
		{name: "floating", start: "DTSTART:20250310T090000", want: true},
		{name: "all-day", start: "DTSTART;VALUE=DATE:20250310", want: true},
		{name: "iana", start: "DTSTART;TZID=Europe/Berlin:20250310T090000", want: true},
		{name: "prefixed", start: "DTSTART;TZID=/mozilla.org/20050126_1/Europe/Berlin:20250310T090000", want: true},
		{name: "unknown", start: "DTSTART;TZID=W. Europe Standard Time:20250310T090000"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			s, _ := testSeries(t, []string{tc.start, "RRULE:FREQ=WEEKLY"})
			if got := s.zoneKnown(); got != tc.want {
				t.Errorf("zoneKnown() = %v; want %v", got, tc.want)
			}
		})
	}
}

func TestTodoSeriesCurrent(t *testing.T) {
	t.Parallel()
	mar := func(d, h int) *time.Time { return ptr(date(2025, 3, d, h, 0)) }
	for _, tc := range []struct {
		name  string
		comps [][]string
		cur   todoOcc
		next  *todoOcc
	}{
		{
			name: "every occurrence done",
			comps: [][]string{
				{"DTSTART:20250310T090000Z", "RRULE:FREQ=DAILY;COUNT=2"},
				{"RECURRENCE-ID:20250310T090000Z", "STATUS:COMPLETED"},
				{"RECURRENCE-ID:20250311T090000Z", "STATUS:COMPLETED"},
			},
			cur: todoOcc{rid: *mar(11, 9), start: mar(11, 9), done: true},
		},
		{
			name: "override due",
			comps: [][]string{
				{"DTSTART:20250310T090000Z", "DUE:20250310T110000Z", "RRULE:FREQ=DAILY"},
				{"RECURRENCE-ID:20250310T090000Z", "DUE:20250310T180000Z"},
			},
			cur:  todoOcc{rid: *mar(10, 9), start: mar(10, 9), due: mar(10, 18)},
			next: &todoOcc{rid: *mar(11, 9), start: mar(11, 9), due: mar(11, 11)},
		},
		{
			name: "moved override keeps its length",
			comps: [][]string{
				{"DTSTART:20250310T090000Z", "DUE:20250310T110000Z", "RRULE:FREQ=DAILY"},
				{"RECURRENCE-ID:20250310T090000Z", "DTSTART:20250310T150000Z"},
			},
			cur:  todoOcc{rid: *mar(10, 9), start: mar(10, 15), due: mar(10, 17)},
			next: &todoOcc{rid: *mar(11, 9), start: mar(11, 9), due: mar(11, 11)},
		},
		{
			name:  "duration",
			comps: [][]string{{"DTSTART:20250310T090000Z", "DURATION:PT2H", "RRULE:FREQ=DAILY"}},
			cur:   todoOcc{rid: *mar(10, 9), start: mar(10, 9), due: mar(10, 11)},
			next:  &todoOcc{rid: *mar(11, 9), start: mar(11, 9), due: mar(11, 11)},
		},
		{
			name:  "anchored on due",
			comps: [][]string{{"DUE:20250310T090000Z", "RRULE:FREQ=DAILY"}},
			cur:   todoOcc{rid: *mar(10, 9), due: mar(10, 9)},
			next:  &todoOcc{rid: *mar(11, 9), due: mar(11, 9)},
		},
		{
			// Summer time starts on 30 Mar 2025: 09:00 in Berlin moves from 08:00 to 07:00 UTC.
			name: "wall clock across dst",
			comps: [][]string{{
				"DTSTART;TZID=Europe/Berlin:20250329T090000", "DUE;TZID=Europe/Berlin:20250329T100000",
				"RRULE:FREQ=DAILY",
			}},
			cur:  todoOcc{rid: *mar(29, 8), start: mar(29, 8), due: mar(29, 9)},
			next: &todoOcc{rid: *mar(30, 7), start: mar(30, 7), due: mar(30, 8)},
		},
		{
			name:  "no occurrence left",
			comps: [][]string{{"DTSTART:20250310T090000Z", "RRULE:FREQ=DAILY;COUNT=1", "EXDATE:20250310T090000Z"}},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			s, _ := testSeries(t, tc.comps...)
			cur, next, err := s.current()
			mustNoErr(t, err)
			checkOcc(t, "cur", cur, tc.cur)
			switch {
			case next == nil || tc.next == nil:
				if next != tc.next {
					t.Errorf("next = %+v; want %+v", next, tc.next)
				}
			default:
				checkOcc(t, "next", *next, *tc.next)
			}
		})
	}
}

func TestTodoSeriesErrors(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name  string
		lines []string
		start *time.Time
	}{
		{name: "invalid rule", lines: []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=DAILY;BYDAY=XX"}, start: ptr(date(2025, 3, 10, 9, 0))},
		{name: "no date", lines: []string{"RRULE:FREQ=DAILY"}},
		{
			// Rolling cannot keep an RDATE off the rule without shifting it (FR-17).
			name:  "rdate",
			lines: []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY", "RDATE:20250312T090000Z"},
			start: ptr(date(2025, 3, 10, 9, 0)),
		},
		{
			// The pending occurrence lies beyond maxRRuleIterations minutes.
			name:  "iteration cap",
			lines: []string{"DTSTART:20250101T000000Z", "RRULE:FREQ=MINUTELY", "X-KDE-LIBKCAL-DTRECURRENCE:20260101T000000Z"},
			start: ptr(date(2025, 1, 1, 0, 0)),
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			s, cal := testSeries(t, tc.lines)
			if _, _, err := s.current(); err == nil {
				t.Error("current() succeeded; want an error")
			}
			if err := s.walk(time.Time{}, func(todoOcc) bool { return true }); err == nil {
				t.Error("walk() succeeded; want an error")
			}
			got := todoFromObject(calObject{path: "/c/s.ics", cal: cal}, "c", s.master)
			if !got.Recurring || !got.RuleUnsupported || got.Next != nil || !sameTime(got.Start, tc.start) {
				t.Errorf("todo = %+v; want a recurring todo with an unsupported rule at its raw start %v", got, tc.start)
			}
		})
	}
}
