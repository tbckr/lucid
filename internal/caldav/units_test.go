package caldav

import (
	"errors"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/emersion/go-ical"

	"github.com/tbckr/lucid/internal/domain"
)

func TestDecodeIDs(t *testing.T) {
	t.Parallel()
	const home = "/dav/calendars/user/"
	tests := []struct {
		name    string
		path    string
		raw     string // used instead of encodeID(path) if set
		wantCal string // "" means ErrNotFound for calendar IDs
		wantObj bool
	}{
		{name: "calendar", path: home + "work/", wantCal: home + "work/"},
		{name: "calendar without slash", path: home + "work", wantCal: home + "work/"},
		{name: "object", path: home + "work/a.ics", wantObj: true},
		{name: "home itself", path: home},
		{name: "outside home", path: "/dav/calendars/other/work/"},
		{name: "prefix trick", path: "/dav/calendars/user2/work/"},
		{name: "dot dot", path: home + "../other/work/"},
		{name: "dot segment", path: home + "./work/"},
		{name: "double slash", path: home + "/work/"},
		{name: "nested", path: home + "a/b/c/"},
		{name: "absolute URL", path: "https://evil.example" + home + "work/"},
		{name: "query", path: home + "work/?x"},
		{name: "backslash", path: home + "work\\..\\x/"},
		{name: "NUL", path: home + "work\x00/"},
		{name: "invalid UTF-8", path: home + "\xff/"},
		{name: "not base64", raw: "*/*"},
		{name: "empty", raw: ""},
		{name: "too long", raw: strings.Repeat("A", 5000)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			id := tt.raw
			if tt.raw == "" && tt.path != "" {
				id = encodeID(tt.path)
			}
			cal, err := decodeCalendarID(home, id)
			if tt.wantCal != "" {
				mustNoErr(t, err)
				if cal != tt.wantCal {
					t.Fatalf("calendar = %q; want %q", cal, tt.wantCal)
				}
			} else if !errors.Is(err, domain.ErrNotFound) {
				t.Fatalf("decodeCalendarID err = %v; want ErrNotFound", err)
			}
			obj, parent, err := decodeObjectID(home, id)
			if tt.wantObj {
				mustNoErr(t, err)
				if obj != tt.path || parent != home+"work/" {
					t.Fatalf("object = %q in %q", obj, parent)
				}
			} else if !errors.Is(err, domain.ErrNotFound) {
				t.Fatalf("decodeObjectID err = %v; want ErrNotFound", err)
			}
		})
	}
}

func TestVTimezone(t *testing.T) {
	t.Parallel()
	tests := []struct {
		tz   string
		want []string
	}{
		{"Europe/Berlin", []string{
			"BEGIN:DAYLIGHT", "DTSTART:20240331T020000", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0200", "TZNAME:CEST",
			"RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
			"BEGIN:STANDARD", "DTSTART:20241027T030000", "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
		}},
		{"America/New_York", []string{
			"RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU", "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU", "TZOFFSETTO:-0400",
		}},
		{"Asia/Tokyo", []string{"BEGIN:STANDARD", "DTSTART:20250101T000000", "TZOFFSETFROM:+0900", "TZOFFSETTO:+0900"}},
		{"Asia/Kolkata", []string{"TZOFFSETTO:+0530"}},
		{"UTC", []string{"TZOFFSETTO:+0000"}},
	}
	for _, tt := range tests {
		t.Run(tt.tz, func(t *testing.T) {
			t.Parallel()
			loc, err := time.LoadLocation(tt.tz)
			mustNoErr(t, err)
			cal := newCalendar()
			cal.Children = append(cal.Children, vtimezone(loc, 2025))
			var b strings.Builder
			mustNoErr(t, ical.NewEncoder(&b).Encode(cal))
			for _, w := range tt.want {
				if !strings.Contains(b.String(), w) {
					t.Errorf("VTIMEZONE lacks %q:\n%s", w, b.String())
				}
			}
		})
	}
}

func TestEnsureVTimezoneOnce(t *testing.T) {
	t.Parallel()
	loc, _ := time.LoadLocation("Europe/Berlin")
	cal := newCalendar()
	ensureVTimezone(cal, loc, 2025)
	ensureVTimezone(cal, loc, 2026)
	if len(cal.Children) != 1 {
		t.Fatalf("got %d components; want 1", len(cal.Children))
	}
}

func TestFormatOffset(t *testing.T) {
	t.Parallel()
	tests := map[int]string{0: "+0000", 3600: "+0100", -18000: "-0500", 19800: "+0530", 3661: "+010101"}
	for in, want := range tests {
		if got := formatOffset(in); got != want {
			t.Errorf("formatOffset(%d) = %q; want %q", in, got, want)
		}
	}
}

func TestParseDuration(t *testing.T) {
	t.Parallel()
	tests := []struct {
		in      string
		want    span
		wantErr bool
	}{
		{in: "PT1H30M", want: span{exact: 90 * time.Minute}},
		{in: "P1D", want: span{days: 1}},
		{in: "P1W", want: span{days: 7}},
		{in: "+P1DT2H3M4S", want: span{days: 1, exact: 2*time.Hour + 3*time.Minute + 4*time.Second}},
		{in: "-PT15M", want: span{exact: -15 * time.Minute}},
		{in: "PT", wantErr: true},
		{in: "1H", wantErr: true},
		{in: "P1H", wantErr: true},
		{in: "PTH", wantErr: true},
		{in: "PT99999999H", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.in, func(t *testing.T) {
			t.Parallel()
			got, err := parseDuration(tt.in)
			if (err != nil) != tt.wantErr || got != tt.want {
				t.Fatalf("parseDuration(%q) = %+v, %v; want %+v, err=%v", tt.in, got, err, tt.want, tt.wantErr)
			}
		})
	}
}

func TestParseDateValue(t *testing.T) {
	t.Parallel()
	berlin, _ := time.LoadLocation("Europe/Berlin")
	tests := []struct {
		name     string
		value    string
		tzid     string
		want     time.Time
		allDay   bool
		wantTZ   string
		floating bool
		wantErr  bool
	}{
		{name: "date", value: "20250305", want: date(2025, 3, 5, 0, 0), allDay: true},
		{name: "utc", value: "20250305T101500Z", want: date(2025, 3, 5, 10, 15)},
		{name: "floating", value: "20250305T101500", want: date(2025, 3, 5, 10, 15), floating: true},
		{name: "tzid", value: "20250305T101500", tzid: "Europe/Berlin", want: time.Date(2025, 3, 5, 10, 15, 0, 0, berlin), wantTZ: "Europe/Berlin"},
		{name: "prefixed tzid", value: "20250305T101500", tzid: "/mozilla.org/20050126_1/Europe/Berlin", want: time.Date(2025, 3, 5, 10, 15, 0, 0, berlin), wantTZ: "Europe/Berlin"},
		{name: "unknown tzid is UTC", value: "20250305T101500", tzid: "W. Europe Standard Time", want: date(2025, 3, 5, 10, 15)},
		{name: "utc tzid", value: "20250305T101500", tzid: "UTC", want: date(2025, 3, 5, 10, 15), wantTZ: "UTC"},
		{name: "bad date", value: "2025030X", wantErr: true},
		{name: "bad utc", value: "2025-03-05Z", wantErr: true},
		{name: "bad local", value: "garbage-value", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			params := ical.Params{}
			if tt.tzid != "" {
				params.Set(ical.ParamTimezoneID, tt.tzid)
			}
			got, err := parseDateValue(tt.value, params)
			if tt.wantErr {
				if err == nil {
					t.Fatal("expected error")
				}
				return
			}
			mustNoErr(t, err)
			if !got.t.Equal(tt.want) || got.allDay != tt.allDay || got.tzid != tt.wantTZ {
				t.Fatalf("got %+v; want %s allDay=%v tz=%q", got, tt.want, tt.allDay, tt.wantTZ)
			}
			// The form keeps the TZID parameter verbatim, resolvable or not (FR-17).
			if got.param != tt.tzid || got.floating != tt.floating {
				t.Fatalf("got param %q, floating %v; want %q, %v", got.param, got.floating, tt.tzid, tt.floating)
			}
		})
	}
	if _, err := parseDateProp(nil); err == nil {
		t.Fatal("expected error for missing property")
	}
	p := ical.NewProp(ical.PropExceptionDates)
	p.Value = "20250101T000000Z/PT1H,bad"
	if _, err := parseDateList(p); err == nil {
		t.Fatal("expected error for invalid list")
	}
}

func TestLoadLocation(t *testing.T) {
	t.Parallel()
	for in, want := range map[string]string{
		"Europe/Berlin":          "Europe/Berlin",
		`"America/New_York"`:     "America/New_York",
		"GMT":                    "UTC",
		"Local":                  "",
		"":                       "",
		"../../etc/passwd":       "",
		strings.Repeat("x", 200): "",
		"/freeassociation.sourceforge.net/Tzfile/Europe/Vienna": "Europe/Vienna",
	} {
		got := loadLocation(in)
		name := ""
		if got != nil {
			name = got.String()
		}
		if name != want {
			t.Errorf("loadLocation(%q) = %q; want %q", in, name, want)
		}
	}
}

// TestShiftDateProp checks that shiftDatePropBy keeps each value's form:
// lists, PERIOD values and garbage, here for a UTC series moved one hour or
// two days later (FR-17).
func TestShiftDateProp(t *testing.T) {
	t.Parallel()
	st := dateValue{t: date(2025, 3, 3, 10, 0)}
	by := func(d time.Duration) func(dateValue) time.Time {
		mv, err := wallShift("FREQ=WEEKLY", st, date(2025, 3, 3, 10, 0), date(2025, 3, 3, 10, 0), date(2025, 3, 3, 10, 0).Add(d))
		mustNoErr(t, err)
		return mv.shift
	}
	tests := []struct {
		value, tzid, want string
		allDay            bool
	}{
		{value: "20250310T100000Z,20250317T100000Z", want: "20250310T110000Z,20250317T110000Z"},
		{value: "20250310T100000", tzid: "Europe/Berlin", want: "20250310T110000"},
		{value: "20250310", allDay: true, want: "20250310"},
		{value: "20250310T100000Z/PT1H", want: "20250310T100000Z/PT1H"},
		{value: "garbage", want: "garbage"},
	}
	for _, tt := range tests {
		p := ical.NewProp(ical.PropExceptionDates)
		p.Value = tt.value
		if tt.tzid != "" {
			p.Params.Set(ical.ParamTimezoneID, tt.tzid)
		}
		shiftDatePropBy(p, by(time.Hour))
		if p.Value != tt.want {
			t.Errorf("shift(%q) = %q; want %q", tt.value, p.Value, tt.want)
		}
	}
	p := ical.NewProp(ical.PropExceptionDates)
	p.Value = "20250310"
	shiftDatePropBy(p, by(48*time.Hour))
	if p.Value != "20250312" {
		t.Errorf("date shift = %q", p.Value)
	}
}

// TestWallShift checks how wallShift moves each form of a value of a
// series in Europe/Berlin by one calendar day, across the change to
// summer time on 2026-03-29 (spec section 3 item 2, FR-17).
func TestWallShift(t *testing.T) {
	t.Parallel()
	berlin := loadLocation("Europe/Berlin")
	st := dateValue{t: time.Date(2026, 1, 2, 9, 0, 0, 0, berlin), tzid: "Europe/Berlin", param: "Europe/Berlin"}

	tests := []struct {
		name  string
		value string
		param string
		want  string
	}{
		{"DTSTART", "20260102T090000", "Europe/Berlin", "20260103T090000"},
		{"TZID across the change", "20260328T090000", "Europe/Berlin", "20260329T090000"},
		{"UTC on the series' wall clock", "20260328T080000Z", "", "20260329T070000Z"},
		{"TZID of another zone on the series' wall clock", "20260328T040000", "America/New_York", "20260329T030000"},
		{"floating on its own wall clock", "20260328T090000", "", "20260329T090000"},
		{"unknown TZID on its own wall clock", "20260328T090000", "Mars/Olympus", "20260329T090000"},
		{"DATE by the days only", "20260328", "", "20260329"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			// Shown on Friday 03-27, moved to Saturday 03-28, both 09:00 CET: one
			// day later, which takes values on 03-28 into summer time.
			mv, err := wallShift("FREQ=WEEKLY;BYDAY=FR", st, date(2026, 3, 27, 8, 0), date(2026, 3, 27, 8, 0), date(2026, 3, 28, 8, 0))
			mustNoErr(t, err)
			p := ical.Prop{Value: tt.value, Params: ical.Params{}}
			if tt.param != "" {
				p.Params.Set(ical.ParamTimezoneID, tt.param)
			}
			shiftDatePropBy(&p, mv.shift)
			if p.Value != tt.want || mv.lost {
				t.Errorf("shifted %s = %s, lost %v; want %s", tt.value, p.Value, mv.lost, tt.want)
			}
		})
	}
}

// TestDateShift checks how dateShift counts the change of date of a moved
// event: from its RECURRENCE-ID, by the calendar days it moved, in calendar
// months and days for a monthly or yearly rule without BY parts, in
// calendar days otherwise; and that a monthly rule refuses a change of date
// from an event on another day of the month than DTSTART's (spec section 3
// items 1 and 2, FR-17).
func TestDateShift(t *testing.T) {
	t.Parallel()
	mar30, apr2 := date(2026, 3, 30, 7, 0), date(2026, 4, 2, 7, 0)
	feb15, feb28, mar1 := date(2026, 2, 15, 8, 0), date(2026, 2, 28, 8, 0), date(2026, 3, 1, 8, 0)
	jan15, jan31, feb1 := date(2026, 1, 15, 8, 0), date(2026, 1, 31, 8, 0), date(2026, 2, 1, 8, 0)
	byMonth := func(months, days int) dateMove { return dateMove{months: months, days: days, byMonth: true} }
	tests := []struct {
		name                 string
		rule                 string
		start, rid, from, to time.Time // a zero rid: the event is shown at it; a zero start: on rid
		want                 dateMove
		err                  error
	}{
		{"monthly", "FREQ=MONTHLY", time.Time{}, time.Time{}, mar30, apr2, byMonth(1, -28), nil},
		{"monthly back", "FREQ=MONTHLY", time.Time{}, time.Time{}, apr2, mar30, byMonth(-1, 28), nil},
		{"monthly with interval and count", "FREQ=MONTHLY;INTERVAL=2;COUNT=5", time.Time{}, time.Time{}, mar30, apr2, byMonth(1, -28), nil},
		{"yearly into the next year", "FREQ=YEARLY", time.Time{}, time.Time{}, date(2026, 12, 30, 8, 0), date(2027, 1, 2, 8, 0), byMonth(1, -28), nil},
		{"monthly, an exception shown on another day", "FREQ=MONTHLY", time.Time{}, feb15, feb28, mar1, byMonth(0, 1), nil},
		{"monthly, an exception moved across a month end", "FREQ=MONTHLY", time.Time{}, jan31, date(2026, 2, 2, 8, 0), date(2026, 2, 5, 8, 0), byMonth(1, -28), nil},
		{"monthly, from an event off DTSTART's day of the month", "FREQ=MONTHLY", jan15, time.Time{}, jan31, feb1, dateMove{}, errMoveOffDay},
		{"yearly, from an event off DTSTART's day of the month", "FREQ=YEARLY", jan15, time.Time{}, jan31, feb1, dateMove{}, errMoveOffDay},
		{"monthly, the clock time only of an event off DTSTART's day", "FREQ=MONTHLY", jan15, time.Time{}, jan31, jan31.Add(time.Hour), byMonth(0, 0), nil},
		{"monthly on fixed days", "FREQ=MONTHLY;BYMONTHDAY=30", time.Time{}, time.Time{}, mar30, apr2, dateMove{days: 3}, nil},
		{"monthly on fixed days, off DTSTART's day", "FREQ=MONTHLY;BYMONTHDAY=15,31", jan15, time.Time{}, jan31, feb1, dateMove{days: 1}, nil},
		{"weekly", "FREQ=WEEKLY", time.Time{}, time.Time{}, mar30, apr2, dateMove{days: 3}, nil},
		{"weekly, an exception shown on another day", "FREQ=WEEKLY", time.Time{}, feb15, feb28, mar1, dateMove{days: 1}, nil},
		{"weekly, off DTSTART's day of the month", "FREQ=WEEKLY", jan15, time.Time{}, jan31, feb1, dateMove{days: 1}, nil},
		{"no rule", "", time.Time{}, time.Time{}, mar30, apr2, dateMove{days: 3}, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			rid := tt.rid
			if rid.IsZero() {
				rid = tt.from
			}
			start := tt.start
			if start.IsZero() {
				start = rid
			}
			got, err := dateShift(tt.rule, start, rid, tt.from, tt.to)
			if got != tt.want || !errors.Is(err, tt.err) || (err == nil) != (tt.err == nil) {
				t.Errorf("dateShift(%q) = %+v, %v; want %+v, %v", tt.rule, got, err, tt.want, tt.err)
			}
		})
	}
	if !errors.Is(errMoveOffDay, domain.ErrSeriesMoveUnsupported) {
		t.Errorf("%v is no %v", errMoveOffDay, domain.ErrSeriesMoveUnsupported)
	}
}

// TestDateMoveDate checks where dateMove.date moves a date, and that a
// change counted in months and days fails where it names a day that month
// lacks (spec section 3 item 2, FR-17).
func TestDateMoveDate(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		mv   dateMove
		from time.Time
		want time.Time
		ok   bool
	}{
		{"a month less a day, onto the 30th", dateMove{months: 1, days: -1, byMonth: true}, date(2026, 3, 31, 9, 0), date(2026, 4, 30, 0, 0), true},
		{"a month less a day, onto February 30", dateMove{months: 1, days: -1, byMonth: true}, date(2026, 1, 31, 9, 0), date(2026, 3, 2, 0, 0), false},
		{"onto February 29 in a leap year", dateMove{months: -1, days: 28, byMonth: true}, date(2028, 3, 1, 9, 0), date(2028, 2, 29, 0, 0), true},
		{"onto February 29 in a common year", dateMove{months: -1, days: 28, byMonth: true}, date(2026, 3, 1, 9, 0), date(2026, 3, 1, 0, 0), false},
		{"past the month's last day", dateMove{days: 1, byMonth: true}, date(2026, 1, 31, 9, 0), date(2026, 2, 1, 0, 0), false},
		{"before the month's first day", dateMove{days: -15, byMonth: true}, date(2026, 1, 15, 9, 0), date(2025, 12, 31, 0, 0), false},
		{"from the 30th to the 2nd", dateMove{months: 1, days: -28, byMonth: true}, date(2026, 1, 30, 9, 0), date(2026, 2, 2, 0, 0), true},
		{"into the next year", dateMove{months: 1, byMonth: true}, date(2026, 12, 31, 9, 0), date(2027, 1, 31, 0, 0), true},
		{"calendar days past the month's last day", dateMove{days: 3}, date(2026, 1, 31, 9, 0), date(2026, 2, 3, 0, 0), true},
		{"calendar days before the month's first day", dateMove{days: -15}, date(2026, 1, 15, 9, 0), date(2025, 12, 31, 0, 0), true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			y, m, d, ok := tt.mv.date(tt.from)
			if got := time.Date(y, m, d, 0, 0, 0, 0, time.UTC); !got.Equal(tt.want) || ok != tt.ok {
				t.Errorf("date(%s) = %s, %v; want %s, %v", tt.from, got, ok, tt.want, tt.ok)
			}
		})
	}
}

// TestSeriesMoveLost checks when seriesMove.shift tells that a value left
// its month: on DTSTART's day of the month, or with a change of month, but
// not for a value on another day that days alone carry into the next month
// (spec section 3 item 2, FR-17).
func TestSeriesMoveLost(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name  string
		mv    dateMove
		value time.Time
		want  time.Time
		lost  bool
	}{
		{"days alone, on DTSTART's day", dateMove{days: 16, byMonth: true}, date(2026, 2, 15, 9, 0), date(2026, 3, 3, 9, 0), true},
		{"days alone, on another day", dateMove{days: 1, byMonth: true}, date(2026, 12, 31, 9, 0), date(2027, 1, 1, 9, 0), false},
		{"days alone, staying in the month", dateMove{days: 1, byMonth: true}, date(2026, 2, 15, 9, 0), date(2026, 2, 16, 9, 0), false},
		{"a month back, on another day", dateMove{months: -1, days: 27, byMonth: true}, date(2026, 12, 31, 9, 0), date(2026, 12, 28, 9, 0), true},
		{"a month on, on DTSTART's day", dateMove{months: 1, days: -1, byMonth: true}, date(2026, 1, 15, 9, 0), date(2026, 2, 14, 9, 0), false},
		{"calendar days, on DTSTART's day", dateMove{days: 16}, date(2026, 2, 15, 9, 0), date(2026, 3, 3, 9, 0), false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			mv := &seriesMove{loc: time.UTC, date: tt.mv, day: 15}
			if got := mv.shift(dateValue{t: tt.value}); !got.Equal(tt.want) || mv.lost != tt.lost {
				t.Errorf("shift(%s) = %s, lost %v; want %s, %v", tt.value, got, mv.lost, tt.want, tt.lost)
			}
		})
	}
}

// TestShiftEvents checks that seriesMove.shiftEvents tells of a move that
// puts an event of the rule on a day its month lacks, also beyond the
// first year, and only of an event the rule has (spec section 3 item 2,
// FR-17).
func TestShiftEvents(t *testing.T) {
	t.Parallel()
	on := func(y int, m time.Month, d int) dateValue { return dateValue{t: date(y, m, d, 9, 0)} }
	tests := []struct {
		name string
		rule string
		st   dateValue
		mv   dateMove
		lost bool
	}{
		{"monthly from the 15th to the 31st", "FREQ=MONTHLY", on(2026, 1, 15), dateMove{days: 16, byMonth: true}, true},
		{"monthly from the 15th to the 31st, ending in January", "FREQ=MONTHLY;COUNT=1", on(2026, 1, 15), dateMove{days: 16, byMonth: true}, false},
		{"monthly from the 31st to the 30th", "FREQ=MONTHLY", on(2026, 1, 31), dateMove{days: -1, byMonth: true}, false},
		{"every 12 months on the 31st, by a month less a day", "FREQ=MONTHLY;INTERVAL=12", on(2026, 3, 31), dateMove{months: 1, days: -1, byMonth: true}, false},
		{"yearly onto February 29 from a leap year", "FREQ=YEARLY", on(2028, 3, 1), dateMove{months: -1, days: 28, byMonth: true}, true},
		{"every 4 years onto February 29 in leap years", "FREQ=YEARLY;INTERVAL=4;UNTIL=20961231T000000Z", on(2028, 3, 1), dateMove{months: -1, days: 28, byMonth: true}, false},
		{"monthly in calendar days", "FREQ=MONTHLY;BYMONTHDAY=15", on(2026, 1, 15), dateMove{days: 16}, false},
		{"a rule Lucid can't read", "FREQ=MONTHLY;BYDAY=XX", on(2026, 1, 15), dateMove{days: 16, byMonth: true}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			mv := &seriesMove{loc: time.UTC, date: tt.mv, day: tt.st.t.Day()}
			mv.shiftEvents(tt.rule, tt.st)
			if mv.lost != tt.lost {
				t.Errorf("lost = %v; want %v", mv.lost, tt.lost)
			}
		})
	}
}

// TestToggledStart checks the new DTSTART of a series whose all-day flag
// "all events" changes: moved by dates, each read where it is meant, and
// made timed at the clock time entered in the request's zone (spec section
// 3 item 4, FR-17).
func TestToggledStart(t *testing.T) {
	t.Parallel()
	berlin, newYork := loadLocation("Europe/Berlin"), loadLocation("America/New_York")
	timed := dateValue{t: time.Date(2026, 9, 4, 9, 0, 0, 0, berlin), tzid: "Europe/Berlin", param: "Europe/Berlin"}
	monthly := dateValue{t: time.Date(2026, 1, 30, 9, 0, 0, 0, berlin), tzid: "Europe/Berlin", param: "Europe/Berlin"}
	allDay := dateValue{t: date(2026, 1, 2, 0, 0), allDay: true}
	mid15 := dateValue{t: time.Date(2026, 1, 15, 9, 0, 0, 0, berlin), tzid: "Europe/Berlin", param: "Europe/Berlin"}
	allDay15 := dateValue{t: date(2026, 1, 15, 0, 0), allDay: true}
	on31st := dateValue{t: time.Date(2026, 1, 31, 9, 0, 0, 0, berlin), tzid: "Europe/Berlin", param: "Europe/Berlin"}
	allDay31st := dateValue{t: date(2026, 1, 31, 0, 0), allDay: true}
	tests := []struct {
		name      string
		rule      string
		st        dateValue
		rid, from time.Time // a zero rid: the event is shown at it
		start     time.Time
		tz        string
		want      time.Time
		err       error
	}{
		{"made all-day, same date", "FREQ=WEEKLY", timed, time.Time{}, date(2026, 11, 6, 8, 0), date(2026, 11, 6, 0, 0), "", date(2026, 9, 4, 0, 0), nil},
		{"made all-day, a day later", "FREQ=WEEKLY", timed, time.Time{}, date(2026, 11, 6, 8, 0), date(2026, 11, 7, 0, 0), "", date(2026, 9, 5, 0, 0), nil},
		{"made all-day, monthly by months", "FREQ=MONTHLY", monthly, time.Time{}, date(2026, 3, 30, 7, 0), date(2026, 5, 1, 0, 0), "", date(2026, 3, 1, 0, 0), nil},
		{"made all-day, monthly from an exception on another day", "FREQ=MONTHLY", mid15, date(2026, 2, 15, 8, 0), date(2026, 2, 28, 8, 0), date(2026, 3, 1, 0, 0), "", date(2026, 1, 16, 0, 0), nil},
		{"made timed in summer time", "FREQ=WEEKLY", allDay, time.Time{}, date(2026, 4, 3, 0, 0), date(2026, 4, 3, 7, 0), "Europe/Berlin", time.Date(2026, 1, 2, 9, 0, 0, 0, berlin), nil},
		{"made timed west of UTC", "FREQ=WEEKLY", allDay, time.Time{}, date(2026, 4, 3, 0, 0), date(2026, 4, 3, 13, 0), "America/New_York", time.Date(2026, 1, 2, 9, 0, 0, 0, newYork), nil},
		{"made timed without a zone", "FREQ=WEEKLY", allDay, time.Time{}, date(2026, 4, 3, 0, 0), date(2026, 4, 3, 9, 30), "", date(2026, 1, 2, 9, 30), nil},
		{"made timed, monthly from an exception on another day", "FREQ=MONTHLY", allDay15, date(2026, 2, 15, 0, 0), date(2026, 2, 28, 0, 0), date(2026, 3, 1, 8, 0), "Europe/Berlin", time.Date(2026, 1, 16, 9, 0, 0, 0, berlin), nil},
		{"made all-day, monthly from an event off DTSTART's day", "FREQ=MONTHLY", mid15, time.Time{}, date(2026, 1, 31, 8, 0), date(2026, 2, 1, 0, 0), "", time.Time{}, errMoveOffDay},
		{"made timed, monthly from an event off DTSTART's day", "FREQ=MONTHLY", allDay15, time.Time{}, date(2026, 1, 31, 0, 0), date(2026, 2, 1, 8, 0), "Europe/Berlin", time.Time{}, errMoveOffDay},
		{"made all-day, monthly onto February 30", "FREQ=MONTHLY", on31st, time.Time{}, date(2026, 3, 31, 7, 0), date(2026, 4, 30, 0, 0), "", time.Time{}, errMoveOffMonth},
		{"made timed, monthly onto February 30", "FREQ=MONTHLY", allDay31st, time.Time{}, date(2026, 3, 31, 0, 0), date(2026, 4, 30, 7, 0), "Europe/Berlin", time.Time{}, errMoveOffMonth},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			rid := tt.rid
			if rid.IsZero() {
				rid = tt.from
			}
			in := domain.EventInput{Start: tt.start, AllDay: !tt.st.allDay}
			got, err := toggledStart(tt.rule, tt.st, rid, tt.from, in, tt.tz)
			if !got.Equal(tt.want) || got.Location().String() != tt.want.Location().String() ||
				!errors.Is(err, tt.err) || (err == nil) != (tt.err == nil) {
				t.Errorf("toggledStart = %s, %v; want %s, %v", got, err, tt.want, tt.err)
			}
		})
	}
}

func TestHelpers(t *testing.T) {
	t.Parallel()
	for in, want := range map[string]bool{
		"HTTP/1.1 200 OK": true, "HTTP/1.1 404 Not Found": false, "": true, "garbage": false,
	} {
		if got := statusOK(in); got != want {
			t.Errorf("statusOK(%q) = %v", in, got)
		}
	}

	base, _ := url.Parse("https://dav.example/home/")
	for _, tt := range []struct {
		href  string
		cross bool
		ok    bool
	}{
		{"/home/cal/", false, true},
		{"cal/", false, true},
		{"https://dav.example/home/cal/", false, true},
		{"https://other.example/home/", false, false},
		{"https://other.example/home/", true, true},
		{"http://dav.example/home/", true, false},
		{"mailto:x@example.com", true, false},
		{"", false, false},
		{"%zz", false, false},
	} {
		_, err := resolveHref(base, tt.href, tt.cross)
		if (err == nil) != tt.ok {
			t.Errorf("resolveHref(%q, %v) err = %v", tt.href, tt.cross, err)
		}
	}

	for _, tt := range []struct {
		err  error
		want error
	}{
		{&statusError{Code: 401}, domain.ErrUnauthorized},
		{&statusError{Code: 410}, domain.ErrNotFound},
		{&statusError{Code: 412}, domain.ErrConflict},
		{&statusError{Code: 500}, domain.ErrUpstream},
		{domain.ErrReadOnly, domain.ErrReadOnly},
		{errors.New("boom"), domain.ErrUpstream},
	} {
		mustErr(t, mapError(tt.err), tt.want)
	}
	if mapError(nil) != nil {
		t.Error("mapError(nil) != nil")
	}
	mustErr(t, mapWriteError(&statusError{Code: 409}), domain.ErrConflict)

	if !canWrite(nil) {
		t.Error("nil privilege set must be writable")
	}
	if uid := newUID(); len(uid) != 36 || uid[14] != '4' {
		t.Errorf("newUID() = %q", uid)
	}
}

func TestMainComponent(t *testing.T) {
	t.Parallel()
	cal := mustParse(t, ics(
		"BEGIN:VEVENT", "UID:1", "DTSTAMP:20250101T000000Z", "RECURRENCE-ID:20250101T000000Z", "SUMMARY:override", "END:VEVENT",
		"BEGIN:VTODO", "UID:2", "DTSTAMP:20250101T000000Z", "END:VTODO",
	))
	if c := mainComponent(cal, ical.CompEvent); c == nil || text(c.Props, ical.PropSummary) != "override" {
		t.Fatalf("mainComponent = %+v", c)
	}
	if c := mainComponent(cal, ical.CompJournal); c != nil {
		t.Fatalf("unexpected component %+v", c)
	}
}
