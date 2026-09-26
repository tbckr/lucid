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
		name    string
		value   string
		tzid    string
		want    time.Time
		allDay  bool
		wantTZ  string
		wantErr bool
	}{
		{name: "date", value: "20250305", want: date(2025, 3, 5, 0, 0), allDay: true},
		{name: "utc", value: "20250305T101500Z", want: date(2025, 3, 5, 10, 15)},
		{name: "floating", value: "20250305T101500", want: date(2025, 3, 5, 10, 15)},
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

func TestShiftDateProp(t *testing.T) {
	t.Parallel()
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
		shiftDateProp(p, time.Hour)
		if p.Value != tt.want {
			t.Errorf("shift(%q) = %q; want %q", tt.value, p.Value, tt.want)
		}
	}
	p := ical.NewProp(ical.PropExceptionDates)
	p.Value = "20250310"
	shiftDateProp(p, 48*time.Hour)
	if p.Value != "20250312" {
		t.Errorf("date shift = %q", p.Value)
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
