package caldav

import (
	"cmp"
	"slices"
	"testing"
	"time"

	"github.com/emersion/go-ical"

	"github.com/tbckr/lucid/internal/caldav/caldavtest"
	"github.com/tbckr/lucid/internal/domain"
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

// A move refused after it was applied, because it put a repeat on one
// another app changed, leaves the calendar as it was, a VTIMEZONE it added
// included (FR-17).
func TestRefusedMoveLeavesCalendar(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name  string
		comps [][]string
		start time.Time
	}{
		{
			// Monday to the Thursday before, which another app completed.
			name: "the moved repeat",
			comps: [][]string{
				{"DTSTART;TZID=Europe/Berlin:20250306T090000", "RRULE:FREQ=WEEKLY;BYDAY=MO,TH", "EXDATE;TZID=Europe/Berlin:20250313T090000"},
				{"RECURRENCE-ID;TZID=Europe/Berlin:20250306T090000", "STATUS:COMPLETED"},
			},
			start: date(2025, 3, 6, 8, 0),
		},
		{
			// Two apps wrote an override of the moved repeat, one of each
			// value type, and the anchor's hid the date's (A-11). The move
			// drops the anchor's; within the day, the date's would take
			// over the moved repeat.
			name: "the moved repeat's override of the other value type",
			comps: [][]string{
				{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY"},
				{"RECURRENCE-ID:20250310T090000Z", "DESCRIPTION:Timed"},
				{"RECURRENCE-ID;VALUE=DATE:20250310", "DESCRIPTION:Dated"},
			},
			start: date(2025, 3, 10, 10, 0),
		},
		{
			// The repeat off the rule onto the completed 9th.
			name: "a repeat off the rule",
			comps: [][]string{
				{"DTSTART:20250309T090000Z", "RRULE:FREQ=WEEKLY"},
				{"RECURRENCE-ID:20250309T090000Z", "STATUS:COMPLETED"},
				{"RECURRENCE-ID:20250310T090000Z", "DTSTART:20250312T090000Z"},
			},
			start: date(2025, 3, 11, 9, 0),
		},
		{
			// The last repeat onto the completed 17th.
			name: "the last repeat",
			comps: [][]string{
				{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY;COUNT=3", "EXDATE:20250317T090000Z,20250331T090000Z"},
				{"RECURRENCE-ID:20250324T090000Z", "STATUS:COMPLETED"},
			},
			start: date(2025, 3, 24, 9, 0),
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			s, cal := testSeries(t, tc.comps...)
			before := encodeCal(t, cal)
			err := s.move(cal, "NEEDS-ACTION", domain.TodoInput{Start: &tc.start, Timezone: "Europe/Berlin"})
			mustErr(t, err, errMoveOntoRepeat)
			if after := encodeCal(t, cal); after != before {
				t.Errorf("calendar after the refused move:\n%s\nwant it as it was:\n%s", after, before)
			}
		})
	}
}

// moveShownCase is a series whose current repeat another app shows away from
// its RECURRENCE-ID, saved with the dates start and due (none where zero)
// with "all" from the zone tz (Berlin where empty), and what the series
// stores and lists from 1 March to 1 April 2025 afterwards (FR-17).
type moveShownCase struct {
	name       string
	master     []string
	overrides  [][]string
	start, due time.Time
	allDay     bool
	tz         string
	stored     []string
	lacks      []string
	next       time.Time
	nextAllDay bool
	dates      []time.Time
	states     []string
}

// checkMoveShown saves the current repeat of the series of tc with tc's
// dates, as a client in tc's zone saves it, and checks the outcome.
func checkMoveShown(t *testing.T, tc moveShownCase) {
	t.Helper()
	e := newEnv(t, caldavtest.Options{})
	id := seedSeries(t, e, tc.master, tc.overrides...)
	f := listedTodo(t, e, id)
	in := editInput(&f)
	in.Start, in.Due, in.StartAllDay, in.DueAllDay = &tc.start, nil, tc.allDay, tc.allDay
	if !tc.due.IsZero() {
		in.Due = &tc.due
	}
	in.Timezone = cmp.Or(tc.tz, "Europe/Berlin")
	got, _, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, in)
	mustNoErr(t, err)
	if !sameTime(got.Start, &tc.start) || got.StartAllDay != tc.allDay || got.Next == nil ||
		!sameTime(got.Next.Start, &tc.next) || got.Next.StartAllDay != tc.nextAllDay {
		t.Errorf("saved series = %+v, next %+v; want the repeat at %v, then %v", got, got.Next, tc.start, tc.next)
	}
	checkStored(t, "series", storedObject(t, e, id), tc.stored, tc.lacks)
	occs, err := e.svc.ListTodoOccurrences(t.Context(), e.cals["tasks"], date(2025, 3, 1, 0, 0), date(2025, 4, 1, 0, 0))
	mustNoErr(t, err)
	checkTodoOccurrences(t, occs, tc.dates, tc.states)
}

// A current repeat another app shows away from its RECURRENCE-ID, saved
// between all-day and timed with "all", changes the value type of the whole
// series, as a move of any current repeat does: the series takes the dates
// saved, moved from where the repeat is shown onto the rule's date, and
// every reference converts, earlier ones too, the overrides (RECURRENCE-ID,
// DTSTART, DUE), the EXDATEs and the UNTIL; a date gets the new time of day
// in the zone saved, and a time becomes its date (FR-17). A repeat whose
// override already has the other value type is no change of the series'
// type.
func TestMoveShownRetypes(t *testing.T) {
	t.Parallel()
	done, upcoming, current := domain.OccurrenceDone, domain.OccurrenceUpcoming, domain.OccurrenceCurrent
	timed := []string{
		"DTSTART:20250303T090000Z", "DUE:20250303T100000Z", "RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20250331T090000Z",
		"EXDATE:20250317T090000Z",
	}
	// Monday the 10th, shown on Wednesday the 12th; the 3rd is done.
	timedOverrides := [][]string{
		{"RECURRENCE-ID:20250303T090000Z", "STATUS:COMPLETED"},
		{"RECURRENCE-ID:20250310T090000Z", "DTSTART:20250312T090000Z", "DUE:20250312T100000Z", "SUMMARY:Moved"},
		{"RECURRENCE-ID:20250324T090000Z", "SUMMARY:Later"},
	}
	saved := moveShownCase{
		name:      "a timed series saved all-day on the day shown",
		master:    timed,
		overrides: timedOverrides,
		start:     date(2025, 3, 12, 0, 0), due: date(2025, 3, 12, 0, 0), allDay: true,
		stored: []string{
			"DTSTART;VALUE=DATE:20250310", "DUE;VALUE=DATE:20250310", "RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20250331\r\n",
			"EXDATE;VALUE=DATE:20250317", "RECURRENCE-ID;VALUE=DATE:20250303", "RECURRENCE-ID;VALUE=DATE:20250310",
			"DTSTART;VALUE=DATE:20250312", "DUE;VALUE=DATE:20250312", "RECURRENCE-ID;VALUE=DATE:20250324", "SUMMARY:Moved",
		},
		lacks:      []string{"T090000", "T100000"},
		next:       date(2025, 3, 24, 0, 0),
		nextAllDay: true,
		dates:      []time.Time{date(2025, 3, 3, 0, 0), date(2025, 3, 12, 0, 0), date(2025, 3, 24, 0, 0), date(2025, 3, 31, 0, 0)},
		states:     []string{done, current, upcoming, upcoming},
	}
	// West of UTC, a date saved is the evening before in the zone saved
	// from: it counts as written.
	west := saved
	west.name, west.tz = "a timed series saved all-day on the day shown, west of UTC", "America/New_York"
	for _, tc := range []moveShownCase{
		saved,
		west,
		{
			// The days rotate by the day it moved, and the references move
			// by it, before they convert.
			name:      "a timed series saved all-day a day after the day shown",
			master:    timed,
			overrides: timedOverrides,
			start:     date(2025, 3, 13, 0, 0), due: date(2025, 3, 13, 0, 0), allDay: true,
			stored: []string{
				"DTSTART;VALUE=DATE:20250311", "DUE;VALUE=DATE:20250311", "BYDAY=TU", "UNTIL=20250401\r\n",
				"EXDATE;VALUE=DATE:20250318", "RECURRENCE-ID;VALUE=DATE:20250303", "RECURRENCE-ID;VALUE=DATE:20250311",
				"DTSTART;VALUE=DATE:20250313", "DUE;VALUE=DATE:20250313", "RECURRENCE-ID;VALUE=DATE:20250325",
			},
			lacks:      []string{"T090000", "T100000", "BYDAY=MO"},
			next:       date(2025, 3, 25, 0, 0),
			nextAllDay: true,
			dates:      []time.Time{date(2025, 3, 3, 0, 0), date(2025, 3, 13, 0, 0), date(2025, 3, 25, 0, 0)},
			states:     []string{done, current, upcoming},
		},
		{
			// 14:00 to 15:00 in Berlin, an hour ahead of UTC in March before
			// the 30th.
			name: "an all-day series saved timed on the day shown",
			master: []string{
				"DTSTART;VALUE=DATE:20250303", "DUE;VALUE=DATE:20250303", "RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20250324",
				"EXDATE;VALUE=DATE:20250317",
			},
			overrides: [][]string{
				{"RECURRENCE-ID;VALUE=DATE:20250303", "STATUS:COMPLETED"},
				{"RECURRENCE-ID;VALUE=DATE:20250310", "DTSTART;VALUE=DATE:20250312", "DUE;VALUE=DATE:20250312", "SUMMARY:Moved"},
				{"RECURRENCE-ID;VALUE=DATE:20250324", "SUMMARY:Later"},
			},
			start: date(2025, 3, 12, 13, 0), due: date(2025, 3, 12, 14, 0),
			stored: []string{
				"DTSTART;TZID=Europe/Berlin:20250310T140000", "DUE;TZID=Europe/Berlin:20250310T150000",
				"RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20250324T130000Z\r\n", "EXDATE;TZID=Europe/Berlin:20250317T140000",
				"RECURRENCE-ID;TZID=Europe/Berlin:20250303T140000", "RECURRENCE-ID;TZID=Europe/Berlin:20250310T140000",
				"DTSTART;TZID=Europe/Berlin:20250312T140000", "DUE;TZID=Europe/Berlin:20250312T150000",
				"RECURRENCE-ID;TZID=Europe/Berlin:20250324T140000", "BEGIN:VTIMEZONE",
			},
			lacks:  []string{"VALUE=DATE"},
			next:   date(2025, 3, 24, 13, 0),
			dates:  []time.Time{date(2025, 3, 3, 13, 0), date(2025, 3, 12, 13, 0), date(2025, 3, 24, 13, 0)},
			states: []string{done, current, upcoming},
		},
		{
			// Monday the 24th, shown on Monday the 31st, after Berlin went
			// to summer time on the 30th: the series starts at 14:00 on the
			// wall clock there too.
			name:      "an all-day series saved timed across a change of summer time",
			master:    []string{"DTSTART;VALUE=DATE:20250324", "RRULE:FREQ=WEEKLY;BYDAY=MO"},
			overrides: [][]string{{"RECURRENCE-ID;VALUE=DATE:20250324", "DTSTART;VALUE=DATE:20250331"}},
			start:     date(2025, 3, 31, 12, 0),
			stored: []string{
				"DTSTART;TZID=Europe/Berlin:20250324T140000", "RECURRENCE-ID;TZID=Europe/Berlin:20250324T140000",
				"DTSTART;TZID=Europe/Berlin:20250331T140000",
			},
			lacks:  []string{"VALUE=DATE", "DUE"},
			next:   date(2025, 3, 31, 12, 0),
			dates:  []time.Time{date(2025, 3, 31, 12, 0), date(2025, 3, 31, 12, 0)},
			states: []string{current, upcoming},
		},
		{
			// Monday the 10th lies off a rule from Sunday the 9th, which is
			// excluded: the rule's date the series moves from, and its
			// EXDATE stays there, converted.
			name:      "a repeat off the rule saved all-day on the day shown",
			master:    []string{"DTSTART:20250309T090000Z", "RRULE:FREQ=WEEKLY", "EXDATE:20250309T090000Z"},
			overrides: [][]string{{"RECURRENCE-ID:20250310T090000Z", "DTSTART:20250312T090000Z"}},
			start:     date(2025, 3, 12, 0, 0), allDay: true,
			stored: []string{
				"DTSTART;VALUE=DATE:20250309", "RRULE:FREQ=WEEKLY\r\n", "EXDATE;VALUE=DATE:20250309",
				"RECURRENCE-ID;VALUE=DATE:20250310", "DTSTART;VALUE=DATE:20250312",
			},
			lacks:      []string{"T090000", "DUE"},
			next:       date(2025, 3, 16, 0, 0),
			nextAllDay: true,
			dates:      []time.Time{date(2025, 3, 12, 0, 0), date(2025, 3, 16, 0, 0), date(2025, 3, 23, 0, 0), date(2025, 3, 30, 0, 0)},
			states:     []string{current, upcoming, upcoming, upcoming},
		},
		{
			// Another app made the repeat all-day: saved timed on its day,
			// it takes the series' value type, which stays as it is.
			name:   "a repeat of the other value type saved in the series' own",
			master: []string{"DTSTART:20250310T090000Z", "DUE:20250310T100000Z", "RRULE:FREQ=WEEKLY;BYDAY=MO"},
			overrides: [][]string{
				{"RECURRENCE-ID:20250310T090000Z", "DTSTART;VALUE=DATE:20250312", "DUE;VALUE=DATE:20250312"},
			},
			start: date(2025, 3, 12, 13, 0), due: date(2025, 3, 12, 14, 0),
			stored: []string{
				"DTSTART:20250310T090000Z", "DUE:20250310T100000Z", "RRULE:FREQ=WEEKLY;BYDAY=MO\r\n",
				"RECURRENCE-ID:20250310T090000Z", "DTSTART:20250312T130000Z", "DUE:20250312T140000Z",
			},
			lacks: []string{"VALUE=DATE"},
			next:  date(2025, 3, 17, 9, 0),
			dates: []time.Time{
				date(2025, 3, 12, 13, 0), date(2025, 3, 17, 9, 0), date(2025, 3, 24, 9, 0), date(2025, 3, 31, 9, 0),
			},
			states: []string{current, upcoming, upcoming, upcoming},
		},
		{
			// Dragged a day later, all-day as another app made it: the
			// series moves by that day and stays timed.
			name:   "a repeat of the other value type moved a day keeps the series' type",
			master: []string{"DTSTART:20250310T090000Z", "DUE:20250310T100000Z", "RRULE:FREQ=WEEKLY;BYDAY=MO"},
			overrides: [][]string{
				{"RECURRENCE-ID:20250310T090000Z", "DTSTART;VALUE=DATE:20250312", "DUE;VALUE=DATE:20250312"},
			},
			start: date(2025, 3, 13, 0, 0), due: date(2025, 3, 13, 0, 0), allDay: true,
			stored: []string{
				"DTSTART:20250311T090000Z", "DUE:20250311T100000Z", "RRULE:FREQ=WEEKLY;BYDAY=TU\r\n",
				"RECURRENCE-ID:20250311T090000Z", "DTSTART;VALUE=DATE:20250313", "DUE;VALUE=DATE:20250313",
			},
			lacks:  []string{"BYDAY=MO", "RECURRENCE-ID;VALUE=DATE"},
			next:   date(2025, 3, 18, 9, 0),
			dates:  []time.Time{date(2025, 3, 13, 0, 0), date(2025, 3, 18, 9, 0), date(2025, 3, 25, 9, 0)},
			states: []string{current, upcoming, upcoming},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			checkMoveShown(t, tc)
		})
	}
}

// A repeat whose override another app wrote with a DATE RECURRENCE-ID in a
// timed series, as for the repeat on that date (A-11), shown on another
// day, moves the series by the distance it moves from where it is shown, as
// one with a RECURRENCE-ID of the series' own value type does: from the
// rule's repeat on that date, the RECURRENCE-ID moving along by the change
// in date, in its own value type (FR-17).
func TestMoveShownDateRid(t *testing.T) {
	t.Parallel()
	upcoming, current := domain.OccurrenceUpcoming, domain.OccurrenceCurrent
	master := []string{"DTSTART:20250310T090000Z", "DUE:20250310T100000Z", "RRULE:FREQ=WEEKLY;BYDAY=MO"}
	// Monday the 10th, shown on Wednesday the 12th.
	shown := [][]string{{"RECURRENCE-ID;VALUE=DATE:20250310", "DTSTART:20250312T090000Z", "DUE:20250312T100000Z", "SUMMARY:Dated"}}
	for _, tc := range []moveShownCase{
		{
			name:  "an hour later",
			start: date(2025, 3, 12, 10, 0), due: date(2025, 3, 12, 11, 0),
			stored: []string{
				"DTSTART:20250310T100000Z", "DUE:20250310T110000Z", "RRULE:FREQ=WEEKLY;BYDAY=MO\r\n",
				"RECURRENCE-ID;VALUE=DATE:20250310", "DTSTART:20250312T100000Z", "DUE:20250312T110000Z", "SUMMARY:Dated",
			},
			lacks: []string{"T090000Z"},
			next:  date(2025, 3, 17, 10, 0),
			dates: []time.Time{
				date(2025, 3, 12, 10, 0), date(2025, 3, 17, 10, 0), date(2025, 3, 24, 10, 0), date(2025, 3, 31, 10, 0),
			},
			states: []string{current, upcoming, upcoming, upcoming},
		},
		{
			name:  "a day later",
			start: date(2025, 3, 13, 9, 0), due: date(2025, 3, 13, 10, 0),
			stored: []string{
				"DTSTART:20250311T090000Z", "DUE:20250311T100000Z", "RRULE:FREQ=WEEKLY;BYDAY=TU\r\n",
				"RECURRENCE-ID;VALUE=DATE:20250311", "DTSTART:20250313T090000Z", "DUE:20250313T100000Z", "SUMMARY:Dated",
			},
			lacks:  []string{"BYDAY=MO", "20250310", "20250312"},
			next:   date(2025, 3, 18, 9, 0),
			dates:  []time.Time{date(2025, 3, 13, 9, 0), date(2025, 3, 18, 9, 0), date(2025, 3, 25, 9, 0)},
			states: []string{current, upcoming, upcoming},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			tc.master, tc.overrides = master, shown
			checkMoveShown(t, tc)
		})
	}
}
