package caldav

import (
	"cmp"
	"encoding/json"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/emersion/go-ical"

	"github.com/tbckr/lucid/internal/caldav/caldavtest"
	"github.com/tbckr/lucid/internal/domain"
)

// occ describes an expected occurrence.
type occ struct {
	title      string
	start, end time.Time
	rid        *time.Time // nil for non-recurring
	allDay     bool
}

func checkOccurrences(t *testing.T, got []domain.Event, want []occ) {
	t.Helper()
	if len(got) != len(want) {
		for i := range got {
			t.Logf("got %s %s - %s rid=%v", got[i].Title, got[i].Start, got[i].End, got[i].RecurrenceID)
		}
		t.Fatalf("got %d events; want %d", len(got), len(want))
	}
	for i, w := range want {
		ev := got[i]
		if ev.Title != w.title || !ev.Start.Equal(w.start) || !ev.End.Equal(w.end) || ev.AllDay != w.allDay {
			t.Errorf("event %d = %q %s - %s allDay=%v; want %q %s - %s allDay=%v",
				i, ev.Title, ev.Start, ev.End, ev.AllDay, w.title, w.start, w.end, w.allDay)
		}
		if ev.Start.Location() != time.UTC || ev.End.Location() != time.UTC {
			t.Errorf("event %d: times not in UTC", i)
		}
		switch {
		case w.rid == nil && (ev.RecurrenceID != nil || ev.Recurring || ev.Key != ev.ID):
			t.Errorf("event %d: unexpected recurrence data %+v", i, ev)
		case w.rid != nil && (ev.RecurrenceID == nil || !ev.RecurrenceID.Equal(*w.rid) || !ev.Recurring):
			t.Errorf("event %d: RecurrenceID = %v; want %v", i, ev.RecurrenceID, *w.rid)
		case w.rid != nil && ev.Key != ev.ID+"@"+w.rid.Format(time.RFC3339):
			t.Errorf("event %d: Key = %q", i, ev.Key)
		}
	}
}

func TestListEventsExpansion(t *testing.T) {
	t.Parallel()
	hdr := []string{"DTSTAMP:20250101T000000Z"}
	berlin := []string{
		"BEGIN:VTIMEZONE", "TZID:Europe/Berlin",
		"BEGIN:STANDARD", "DTSTART:19701025T030000", "TZOFFSETFROM:+0200", "TZOFFSETTO:+0100", "END:STANDARD",
		"END:VTIMEZONE",
	}
	ev := func(lines ...string) []string {
		out := append([]string{"BEGIN:VEVENT"}, hdr...)
		out = append(out, lines...)
		return append(out, "END:VEVENT")
	}
	cat := func(parts ...[]string) []string {
		var out []string
		for _, p := range parts {
			out = append(out, p...)
		}
		return out
	}

	tests := []struct {
		name     string
		lines    []string
		from, to time.Time
		want     []occ
	}{
		{
			name:  "single UTC event",
			lines: ev("UID:1", "SUMMARY:Single", "DTSTART:20250305T100000Z", "DTEND:20250305T113000Z"),
			from:  date(2025, 3, 1, 0, 0), to: date(2025, 4, 1, 0, 0),
			want: []occ{{title: "Single", start: date(2025, 3, 5, 10, 0), end: date(2025, 3, 5, 11, 30)}},
		},
		{
			name:  "outside window",
			lines: ev("UID:1", "SUMMARY:Single", "DTSTART:20250305T100000Z", "DTEND:20250305T113000Z"),
			from:  date(2025, 3, 5, 11, 30), to: date(2025, 4, 1, 0, 0),
		},
		{
			name:  "partially overlapping window",
			lines: ev("UID:1", "SUMMARY:Long", "DTSTART:20250228T100000Z", "DTEND:20250302T100000Z"),
			from:  date(2025, 3, 1, 0, 0), to: date(2025, 3, 2, 0, 0),
			want: []occ{{title: "Long", start: date(2025, 2, 28, 10, 0), end: date(2025, 3, 2, 10, 0)}},
		},
		{
			name:  "TZID and DURATION",
			lines: cat(berlin, ev("UID:1", "SUMMARY:Tz", "DTSTART;TZID=Europe/Berlin:20250305T100000", "DURATION:PT45M")),
			from:  date(2025, 3, 1, 0, 0), to: date(2025, 4, 1, 0, 0),
			want: []occ{{title: "Tz", start: date(2025, 3, 5, 9, 0), end: date(2025, 3, 5, 9, 45)}},
		},
		{
			name:  "floating time is UTC",
			lines: ev("UID:1", "SUMMARY:Float", "DTSTART:20250305T100000", "DTEND:20250305T110000"),
			from:  date(2025, 3, 1, 0, 0), to: date(2025, 4, 1, 0, 0),
			want: []occ{{title: "Float", start: date(2025, 3, 5, 10, 0), end: date(2025, 3, 5, 11, 0)}},
		},
		{
			name:  "zero duration event",
			lines: ev("UID:1", "SUMMARY:Point", "DTSTART:20250305T100000Z"),
			from:  date(2025, 3, 5, 10, 0), to: date(2025, 3, 5, 11, 0),
			want: []occ{{title: "Point", start: date(2025, 3, 5, 10, 0), end: date(2025, 3, 5, 10, 0)}},
		},
		{
			name:  "all-day event without DTEND",
			lines: ev("UID:1", "SUMMARY:Day", "DTSTART;VALUE=DATE:20250305"),
			from:  date(2025, 3, 5, 12, 0), to: date(2025, 3, 6, 0, 0),
			want: []occ{{title: "Day", start: date(2025, 3, 5, 0, 0), end: date(2025, 3, 6, 0, 0), allDay: true}},
		},
		{
			name:  "multi-day all-day event",
			lines: ev("UID:1", "SUMMARY:Trip", "DTSTART;VALUE=DATE:20250305", "DTEND;VALUE=DATE:20250308"),
			from:  date(2025, 3, 7, 0, 0), to: date(2025, 3, 10, 0, 0),
			want: []occ{{title: "Trip", start: date(2025, 3, 5, 0, 0), end: date(2025, 3, 8, 0, 0), allDay: true}},
		},
		{
			name: "weekly across DST change (Europe/Berlin)",
			lines: cat(berlin, ev("UID:1", "SUMMARY:Standup",
				"DTSTART;TZID=Europe/Berlin:20250317T090000", "DTEND;TZID=Europe/Berlin:20250317T091500",
				"RRULE:FREQ=WEEKLY;BYDAY=MO")),
			from: date(2025, 3, 20, 0, 0), to: date(2025, 4, 8, 0, 0),
			want: []occ{
				{title: "Standup", start: date(2025, 3, 24, 8, 0), end: date(2025, 3, 24, 8, 15), rid: ptr(date(2025, 3, 24, 8, 0))},
				{title: "Standup", start: date(2025, 3, 31, 7, 0), end: date(2025, 3, 31, 7, 15), rid: ptr(date(2025, 3, 31, 7, 0))},
				{title: "Standup", start: date(2025, 4, 7, 7, 0), end: date(2025, 4, 7, 7, 15), rid: ptr(date(2025, 4, 7, 7, 0))},
			},
		},
		{
			name: "EXDATE, RDATE and override",
			lines: cat(
				ev("UID:1", "SUMMARY:Series", "DTSTART:20250303T100000Z", "DTEND:20250303T110000Z",
					"RRULE:FREQ=WEEKLY;COUNT=5", "EXDATE:20250310T100000Z,20250331T100000Z",
					"RDATE:20250305T100000Z"),
				ev("UID:1", "SUMMARY:Moved", "RECURRENCE-ID:20250317T100000Z",
					"DTSTART:20250318T140000Z", "DTEND:20250318T150000Z"),
				ev("UID:1", "RECURRENCE-ID:20250324T100000Z", "STATUS:CANCELLED",
					"DTSTART:20250324T100000Z", "DTEND:20250324T110000Z"),
			),
			from: date(2025, 3, 1, 0, 0), to: date(2025, 4, 30, 0, 0),
			want: []occ{
				{title: "Series", start: date(2025, 3, 3, 10, 0), end: date(2025, 3, 3, 11, 0), rid: ptr(date(2025, 3, 3, 10, 0))},
				{title: "Series", start: date(2025, 3, 5, 10, 0), end: date(2025, 3, 5, 11, 0), rid: ptr(date(2025, 3, 5, 10, 0))},
				{title: "Moved", start: date(2025, 3, 18, 14, 0), end: date(2025, 3, 18, 15, 0), rid: ptr(date(2025, 3, 17, 10, 0))},
			},
		},
		{
			name: "override moved into window",
			lines: cat(
				ev("UID:1", "SUMMARY:Series", "DTSTART:20250303T100000Z", "DTEND:20250303T110000Z", "RRULE:FREQ=WEEKLY;COUNT=2"),
				ev("UID:1", "RECURRENCE-ID:20250303T100000Z", "DTSTART:20250320T100000Z", "DTEND:20250320T110000Z"),
			),
			from: date(2025, 3, 15, 0, 0), to: date(2025, 3, 25, 0, 0),
			want: []occ{
				{title: "Series", start: date(2025, 3, 20, 10, 0), end: date(2025, 3, 20, 11, 0), rid: ptr(date(2025, 3, 3, 10, 0))},
			},
		},
		{
			// RFC 5545 3.3.10: DTSTART is the first of COUNT occurrences, also
			// on a day the rule does not match.
			name: "DTSTART off the rule counts for COUNT",
			lines: ev("UID:1", "SUMMARY:Series", "DTSTART:20250309T100000Z", "DTEND:20250309T110000Z",
				"RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3"),
			from: date(2025, 3, 1, 0, 0), to: date(2025, 4, 1, 0, 0),
			want: []occ{
				{title: "Series", start: date(2025, 3, 9, 10, 0), end: date(2025, 3, 9, 11, 0), rid: ptr(date(2025, 3, 9, 10, 0))},
				{title: "Series", start: date(2025, 3, 10, 10, 0), end: date(2025, 3, 10, 11, 0), rid: ptr(date(2025, 3, 10, 10, 0))},
				{title: "Series", start: date(2025, 3, 17, 10, 0), end: date(2025, 3, 17, 11, 0), rid: ptr(date(2025, 3, 17, 10, 0))},
			},
		},
		{
			name:  "yearly all-day with EXDATE as date",
			lines: ev("UID:1", "SUMMARY:Birthday", "DTSTART;VALUE=DATE:20200310", "RRULE:FREQ=YEARLY", "EXDATE;VALUE=DATE:20240310"),
			from:  date(2023, 1, 1, 0, 0), to: date(2026, 1, 1, 0, 0),
			want: []occ{
				{title: "Birthday", start: date(2023, 3, 10, 0, 0), end: date(2023, 3, 11, 0, 0), allDay: true, rid: ptr(date(2023, 3, 10, 0, 0))},
				{title: "Birthday", start: date(2025, 3, 10, 0, 0), end: date(2025, 3, 11, 0, 0), allDay: true, rid: ptr(date(2025, 3, 10, 0, 0))},
			},
		},
		{
			name:  "occurrence started before window",
			lines: ev("UID:1", "SUMMARY:Night", "DTSTART:20250301T220000Z", "DURATION:PT4H", "RRULE:FREQ=DAILY"),
			from:  date(2025, 3, 5, 0, 0), to: date(2025, 3, 5, 12, 0),
			want: []occ{
				{title: "Night", start: date(2025, 3, 4, 22, 0), end: date(2025, 3, 5, 2, 0), rid: ptr(date(2025, 3, 4, 22, 0))},
			},
		},
		{
			name:  "orphan override only",
			lines: ev("UID:1", "SUMMARY:Invite", "RECURRENCE-ID:20250305T100000Z", "DTSTART:20250305T120000Z", "DTEND:20250305T130000Z"),
			from:  date(2025, 3, 1, 0, 0), to: date(2025, 4, 1, 0, 0),
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			o := calObject{path: "/user/calendars/c/x.ics", etag: `"1"`, cal: mustParse(t, ics(tt.lines...))}
			got, err := expandObject(o, objRef{id: "id", calendarID: "cal"}, tt.from, tt.to)
			mustNoErr(t, err)
			if tt.name == "orphan override only" {
				if len(got) != 1 || got[0].RecurrenceID == nil || got[0].Title != "Invite" {
					t.Fatalf("orphan: %+v", got)
				}
				return
			}
			sortEvents(got)
			checkOccurrences(t, got, tt.want)
		})
	}
}

// TestListEventsSkippedAndRepeatedTimes checks how a series shows its events
// at a time a daylight-saving change skips or repeats, as RFC 5545 section
// 3.3.5 reads such a time and section 3.3.10, as erratum 4271 corrects it,
// reads such an event: kept and counted, a skipped time an hour later that
// night, a repeated one the first; the series keeps its clock on every other
// day, and an EXDATE or UNTIL compares by that instant (#8, FR-17, FR-18).
func TestListEventsSkippedAndRepeatedTimes(t *testing.T) {
	t.Parallel()
	series := func(lines ...string) []string {
		return append(append([]string{"BEGIN:VEVENT", "UID:1", "DTSTAMP:20250101T000000Z", "SUMMARY:S", "DURATION:PT1H"}, lines...), "END:VEVENT")
	}
	events := func(starts ...time.Time) []occ {
		var out []occ
		for _, s := range starts {
			out = append(out, occ{title: "S", start: s, end: s.Add(time.Hour), rid: ptr(s)})
		}
		return out
	}
	const ny = "DTSTART;TZID=America/New_York:20260306T023000"
	tests := []struct {
		name  string
		lines []string
		want  []occ
	}{
		{
			name:  "a New York series shows its event on the night of the change at 03:30 EDT",
			lines: series(ny, "RRULE:FREQ=DAILY;COUNT=4"),
			want: events(date(2026, 3, 6, 7, 30), date(2026, 3, 7, 7, 30), date(2026, 3, 8, 7, 30),
				date(2026, 3, 9, 6, 30)),
		},
		{
			name:  "a Berlin series from a skipped time keeps its clock",
			lines: series("DTSTART;TZID=Europe/Berlin:20260329T023000", "RRULE:FREQ=DAILY;COUNT=3"),
			want:  events(date(2026, 3, 29, 1, 30), date(2026, 3, 30, 0, 30), date(2026, 3, 31, 0, 30)),
		},
		{
			name:  "an EXDATE in UTC at that instant deletes the event",
			lines: series(ny, "RRULE:FREQ=DAILY;COUNT=4", "EXDATE:20260308T073000Z"),
			want:  events(date(2026, 3, 6, 7, 30), date(2026, 3, 7, 7, 30), date(2026, 3, 9, 6, 30)),
		},
		{
			name:  "an EXDATE in the series' zone deletes it too",
			lines: series(ny, "RRULE:FREQ=DAILY;COUNT=4", "EXDATE;TZID=America/New_York:20260308T023000"),
			want:  events(date(2026, 3, 6, 7, 30), date(2026, 3, 7, 7, 30), date(2026, 3, 9, 6, 30)),
		},
		{
			name:  "a UTC UNTIL bounds by instant",
			lines: series(ny, "RRULE:FREQ=DAILY;UNTIL=20260308T070000Z"),
			want:  events(date(2026, 3, 6, 7, 30), date(2026, 3, 7, 7, 30)),
		},
		{
			name:  "a repeated time is the first",
			lines: series("DTSTART;TZID=Europe/Berlin:20261023T023000", "RRULE:FREQ=DAILY;COUNT=3"),
			want:  events(date(2026, 10, 23, 0, 30), date(2026, 10, 24, 0, 30), date(2026, 10, 25, 0, 30)),
		},
		{
			// 02:00 and 03:00 are the same instant that night.
			name:  "an hourly rule shows each instant once",
			lines: series("DTSTART;TZID=Europe/Berlin:20260329T000000", "RRULE:FREQ=HOURLY;COUNT=5"),
			want: events(date(2026, 3, 28, 23, 0), date(2026, 3, 29, 0, 0), date(2026, 3, 29, 1, 0),
				date(2026, 3, 29, 2, 0)),
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			o := calObject{path: "/user/calendars/c/x.ics", etag: `"1"`, cal: mustParse(t, ics(tt.lines...))}
			got, err := expandObject(o, objRef{id: "id", calendarID: "cal"}, date(2026, 1, 1, 0, 0), date(2027, 1, 1, 0, 0))
			mustNoErr(t, err)
			sortEvents(got)
			checkOccurrences(t, got, tt.want)
		})
	}
}

// TestListEventsOverrideFields checks that a present-but-empty override
// property is shown empty, while an absent one still falls back to the
// master (spec section 2 "Leere Felder", FR-17).
func TestListEventsOverrideFields(t *testing.T) {
	t.Parallel()
	lines := []string{
		"BEGIN:VEVENT", "UID:1", "DTSTAMP:20250101T000000Z", "SUMMARY:Series",
		"DESCRIPTION:Agenda", "LOCATION:Room 1",
		"DTSTART:20250303T100000Z", "DTEND:20250303T110000Z", "RRULE:FREQ=WEEKLY;COUNT=3",
		"END:VEVENT",
		"BEGIN:VEVENT", "UID:1", "DTSTAMP:20250101T000000Z", "SUMMARY:Series",
		"RECURRENCE-ID:20250310T100000Z", "DESCRIPTION:",
		"DTSTART:20250310T100000Z", "DTEND:20250310T110000Z",
		"END:VEVENT",
	}
	o := calObject{path: "/user/calendars/c/x.ics", etag: `"1"`, cal: mustParse(t, ics(lines...))}
	got, err := expandObject(o, objRef{id: "id", calendarID: "cal"}, date(2025, 3, 1, 0, 0), date(2025, 4, 1, 0, 0))
	mustNoErr(t, err)

	var found *domain.Event
	for i := range got {
		if got[i].RecurrenceID != nil && got[i].RecurrenceID.Equal(date(2025, 3, 10, 10, 0)) {
			found = &got[i]
			break
		}
	}
	if found == nil {
		t.Fatalf("override occurrence not found in %+v", got)
	}
	if found.Description != "" {
		t.Errorf("Description = %q; want empty", found.Description)
	}
	if found.Location != "Room 1" {
		t.Errorf("Location = %q; want %q", found.Location, "Room 1")
	}
}

// TestListEventsOverrideZone checks that an exception another client wrote
// in another zone than its series is listed in the series' zone, the one
// its rule recurs in and the server judges a move of the series in (#6,
// FR-17, FR-18), and that an override without a series keeps its own.
func TestListEventsOverrideZone(t *testing.T) {
	t.Parallel()
	series := func(dtstart string) []string {
		return []string{
			"BEGIN:VEVENT", "UID:1", "DTSTAMP:20250101T000000Z", "SUMMARY:Review",
			dtstart, "DURATION:PT30M", "RRULE:FREQ=MONTHLY;BYMONTHDAY=15", "END:VEVENT",
		}
	}
	override := func(rid, dtstart string) []string {
		return []string{
			"BEGIN:VEVENT", "UID:1", "DTSTAMP:20250101T000000Z", "SUMMARY:Review moved",
			rid, dtstart, "DURATION:PT30M", "END:VEVENT",
		}
	}
	for _, tt := range []struct {
		name  string
		lines []string
		want  string
	}{
		{
			"in UTC, of a series in Berlin",
			append(series("DTSTART;TZID=Europe/Berlin:20250115T233000"),
				override("RECURRENCE-ID:20250415T213000Z", "DTSTART:20250415T213000Z")...),
			"Europe/Berlin",
		},
		{
			"in New York, of a series in Berlin",
			append(series("DTSTART;TZID=Europe/Berlin:20250115T233000"),
				override("RECURRENCE-ID;TZID=Europe/Berlin:20250415T233000", "DTSTART;TZID=America/New_York:20250415T173000")...),
			"Europe/Berlin",
		},
		{
			"in Berlin, of a series in UTC",
			append(series("DTSTART:20250115T223000Z"),
				override("RECURRENCE-ID:20250415T223000Z", "DTSTART;TZID=Europe/Berlin:20250416T003000")...),
			"",
		},
		{
			"in New York, without a series",
			override("RECURRENCE-ID;TZID=Europe/Berlin:20250415T233000", "DTSTART;TZID=America/New_York:20250415T173000"),
			"America/New_York",
		},
	} {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			o := calObject{path: "/user/calendars/c/x.ics", etag: `"1"`, cal: mustParse(t, ics(tt.lines...))}
			got, err := expandObject(o, objRef{id: "id", calendarID: "cal"}, date(2025, 4, 1, 0, 0), date(2025, 5, 1, 0, 0))
			mustNoErr(t, err)
			if len(got) != 1 || got[0].Title != "Review moved" {
				t.Fatalf("got %+v; want the exception alone", got)
			}
			if got[0].Timezone != tt.want {
				t.Errorf("Timezone = %q; want %q", got[0].Timezone, tt.want)
			}
		})
	}
}

// TestListEventsReportsEndZone checks that an event reports the zone of its
// DTEND as endTimezone, DTSTART's where it has a DURATION or no end, and that
// every event of a series, an exception another client wrote with an end in
// another zone included, reports the series' (FR-17, FR-18).
func TestListEventsReportsEndZone(t *testing.T) {
	t.Parallel()
	event := func(extra ...string) []string {
		return append([]string{"BEGIN:VEVENT", "UID:1", "DTSTAMP:20261001T000000Z", "SUMMARY:Call"}, extra...)
	}
	for _, tt := range []struct {
		name          string
		lines         []string
		want, wantEnd string
		wantCount     int
	}{
		{
			"an end in another zone",
			append(event("DTSTART;TZID=Europe/Berlin:20261028T100000", "DTEND;TZID=America/New_York:20261028T130000"), "END:VEVENT"),
			"Europe/Berlin", "America/New_York", 1,
		},
		{
			"an end in the start's zone",
			append(event("DTSTART;TZID=Europe/Berlin:20261028T100000", "DTEND;TZID=Europe/Berlin:20261028T180000"), "END:VEVENT"),
			"Europe/Berlin", "Europe/Berlin", 1,
		},
		{
			"a duration",
			append(event("DTSTART;TZID=Europe/Berlin:20261028T100000", "DURATION:PT8H"), "END:VEVENT"),
			"Europe/Berlin", "Europe/Berlin", 1,
		},
		{
			"neither an end nor a duration",
			append(event("DTSTART;TZID=Europe/Berlin:20261028T100000"), "END:VEVENT"),
			"Europe/Berlin", "Europe/Berlin", 1,
		},
		{
			"an end in UTC",
			append(event("DTSTART;TZID=Europe/Berlin:20261028T100000", "DTEND:20261028T170000Z"), "END:VEVENT"),
			"Europe/Berlin", "", 1,
		},
		{
			"a start in UTC and an end in a zone",
			append(event("DTSTART:20261028T090000Z", "DTEND;TZID=Asia/Tokyo:20261028T200000"), "END:VEVENT"),
			"", "Asia/Tokyo", 1,
		},
		{
			"an end in a zone Lucid cannot resolve",
			append(event("DTSTART;TZID=Europe/Berlin:20261028T100000", "DTEND;TZID=Mars/Olympus:20261028T180000"), "END:VEVENT"),
			"Europe/Berlin", "", 1,
		},
		{
			"an all-day event",
			append(event("DTSTART;VALUE=DATE:20261028", "DTEND;VALUE=DATE:20261029"), "END:VEVENT"),
			"", "", 1,
		},
		{
			"a series whose exception ends in another zone",
			append(append(event("DTSTART;TZID=Europe/Berlin:20261028T100000", "DTEND;TZID=America/New_York:20261028T130000",
				"RRULE:FREQ=WEEKLY;COUNT=3", "END:VEVENT"),
				"BEGIN:VEVENT", "UID:1", "DTSTAMP:20261001T000000Z", "SUMMARY:Call moved",
				"RECURRENCE-ID;TZID=Europe/Berlin:20261104T100000",
				"DTSTART;TZID=Europe/Berlin:20261104T110000", "DTEND;TZID=Asia/Tokyo:20261105T020000"), "END:VEVENT"),
			"Europe/Berlin", "America/New_York", 3,
		},
		{
			"an exception of a series with a duration",
			append(append(event("DTSTART;TZID=Europe/Berlin:20261028T100000", "DURATION:PT1H",
				"RRULE:FREQ=WEEKLY;COUNT=3", "END:VEVENT"),
				"BEGIN:VEVENT", "UID:1", "DTSTAMP:20261001T000000Z", "SUMMARY:Call moved",
				"RECURRENCE-ID;TZID=Europe/Berlin:20261104T100000",
				"DTSTART;TZID=Europe/Berlin:20261104T110000", "DTEND;TZID=Asia/Tokyo:20261105T020000"), "END:VEVENT"),
			"Europe/Berlin", "Europe/Berlin", 3,
		},
		{
			"an exception without a series",
			append(event("RECURRENCE-ID;TZID=Europe/Berlin:20261104T100000",
				"DTSTART;TZID=Europe/Berlin:20261104T110000", "DTEND;TZID=Asia/Tokyo:20261105T020000"), "END:VEVENT"),
			"Europe/Berlin", "Asia/Tokyo", 1,
		},
	} {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			o := calObject{path: "/user/calendars/c/x.ics", etag: `"1"`, cal: mustParse(t, ics(tt.lines...))}
			got, err := expandObject(o, objRef{id: "id", calendarID: "cal"}, date(2026, 10, 1, 0, 0), date(2026, 12, 1, 0, 0))
			mustNoErr(t, err)
			if len(got) != tt.wantCount {
				t.Fatalf("got %d events; want %d: %+v", len(got), tt.wantCount, got)
			}
			for _, ev := range got {
				if ev.Timezone != tt.want || ev.EndTimezone != tt.wantEnd {
					t.Errorf("%s: Timezone = %q, EndTimezone = %q; want %q, %q", ev.Key, ev.Timezone, ev.EndTimezone, tt.want, tt.wantEnd)
				}
			}
		})
	}
}

// TestEventAtReportsEndZone checks that the event an edit answers with, which
// eventAt places, reports the end's zone as the list does (FR-18).
func TestEventAtReportsEndZone(t *testing.T) {
	t.Parallel()
	cal := mustParse(t, ics("BEGIN:VEVENT", "UID:1", "DTSTAMP:20261001T000000Z", "SUMMARY:Call",
		"DTSTART;TZID=Europe/Berlin:20261028T100000", "DTEND;TZID=America/New_York:20261028T130000", "END:VEVENT"))
	ev, err := eventAt(calObject{path: "/c/x.ics", cal: cal}, objRef{id: "id", calendarID: "cal"}, cal.Children[0], nil)
	mustNoErr(t, err)
	if ev.Timezone != "Europe/Berlin" || ev.EndTimezone != "America/New_York" {
		t.Errorf("Timezone = %q, EndTimezone = %q; want Europe/Berlin, America/New_York", ev.Timezone, ev.EndTimezone)
	}
}

// TestListEventsModified checks that expandObject sets Modified for
// occurrences an override visibly changes (start, duration, all-day, title,
// location or description), and not for occurrences it only differs from
// invisibly (PARTSTAT, VALARM), or orphan overrides whose own DTSTART
// matches their RECURRENCE-ID (FR-17).
func TestListEventsModified(t *testing.T) {
	t.Parallel()
	lines := []string{
		"BEGIN:VEVENT", "UID:1", "DTSTAMP:20250101T000000Z", "SUMMARY:Standup",
		"DTSTART;TZID=Europe/Berlin:20250602T090000", "DTEND;TZID=Europe/Berlin:20250602T091500",
		"RRULE:FREQ=WEEKLY;BYDAY=MO",
		"END:VEVENT",
		// moved DTSTART
		"BEGIN:VEVENT", "UID:1", "DTSTAMP:20250101T000000Z", "SUMMARY:Standup",
		"RECURRENCE-ID:20250602T070000Z", "DTSTART:20250602T100000Z", "DTEND:20250602T101500Z",
		"END:VEVENT",
		// other SUMMARY
		"BEGIN:VEVENT", "UID:1", "DTSTAMP:20250101T000000Z", "SUMMARY:Standup Special",
		"RECURRENCE-ID:20250609T070000Z", "DTSTART:20250609T070000Z", "DTEND:20250609T071500Z",
		"END:VEVENT",
		// other DTEND only (duration)
		"BEGIN:VEVENT", "UID:1", "DTSTAMP:20250101T000000Z", "SUMMARY:Standup",
		"RECURRENCE-ID:20250616T070000Z", "DTSTART:20250616T070000Z", "DTEND:20250616T080000Z",
		"END:VEVENT",
		// identical copy, differs only in PARTSTAT and an added VALARM
		"BEGIN:VEVENT", "UID:1", "DTSTAMP:20250101T000000Z", "SUMMARY:Standup",
		"RECURRENCE-ID:20250623T070000Z", "DTSTART:20250623T070000Z", "DTEND:20250623T071500Z",
		"ATTENDEE;PARTSTAT=DECLINED:mailto:bob@example.com",
		"BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Reminder", "TRIGGER:-PT15M", "END:VALARM",
		"END:VEVENT",
		// orphan override (RECURRENCE-ID is not a series instance), not moved
		"BEGIN:VEVENT", "UID:1", "DTSTAMP:20250101T000000Z", "SUMMARY:Standup",
		"RECURRENCE-ID:20250603T070000Z", "DTSTART:20250603T070000Z", "DTEND:20250603T071500Z",
		"END:VEVENT",
		// orphan override, moved
		"BEGIN:VEVENT", "UID:1", "DTSTAMP:20250101T000000Z", "SUMMARY:Standup",
		"RECURRENCE-ID:20250604T070000Z", "DTSTART:20250604T090000Z", "DTEND:20250604T091500Z",
		"END:VEVENT",
	}
	o := calObject{path: "/user/calendars/c/x.ics", etag: `"1"`, cal: mustParse(t, ics(lines...))}
	got, err := expandObject(o, objRef{id: "id", calendarID: "cal"}, date(2025, 6, 1, 0, 0), date(2025, 7, 5, 0, 0))
	mustNoErr(t, err)

	tests := []struct {
		name string
		rid  time.Time
		want bool
	}{
		{"moved DTSTART", date(2025, 6, 2, 7, 0), true},
		{"other SUMMARY", date(2025, 6, 9, 7, 0), true},
		{"other DTEND only (duration)", date(2025, 6, 16, 7, 0), true},
		{"identical copy with PARTSTAT and VALARM only", date(2025, 6, 23, 7, 0), false},
		{"no override", date(2025, 6, 30, 7, 0), false},
		{"orphan override, not moved", date(2025, 6, 3, 7, 0), false},
		{"orphan override, moved", date(2025, 6, 4, 7, 0), true},
	}
	if len(got) != len(tests) {
		for _, ev := range got {
			t.Logf("got %s rid=%v modified=%v", ev.Title, ev.RecurrenceID, ev.Modified)
		}
		t.Fatalf("got %d events; want %d", len(got), len(tests))
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			var found *domain.Event
			for i := range got {
				if got[i].RecurrenceID != nil && got[i].RecurrenceID.Equal(tt.rid) {
					found = &got[i]
					break
				}
			}
			if found == nil {
				t.Fatalf("no event with RecurrenceID %v", tt.rid)
			}
			if found.Modified != tt.want {
				t.Errorf("Modified = %v; want %v", found.Modified, tt.want)
			}
		})
	}
}

// TestListEventsMarksFirstAndAttendees checks the two fields the client
// decides "This and following events" with: First on the occurrence that is
// the series' first shown one, and HasAttendees on every event of a resource
// where the series or any override has an ORGANIZER or ATTENDEE (FR-17).
func TestListEventsMarksFirstAndAttendees(t *testing.T) {
	t.Parallel()
	weekly := []string{
		"UID:1", "DTSTAMP:20250101T000000Z", "SUMMARY:Series", "DTSTART:20250303T080000Z",
		"DTEND:20250303T090000Z", "RRULE:FREQ=WEEKLY;COUNT=4",
	}
	single := []string{
		"UID:1", "DTSTAMP:20250101T000000Z", "SUMMARY:Single", "DTSTART:20250303T080000Z",
		"DTEND:20250303T090000Z",
	}
	with := func(base []string, extra ...string) []string {
		return append(append([]string{}, base...), extra...)
	}
	// vevent is a VEVENT of the lines, and the overrides after it.
	vevent := func(master []string, overrides ...[]string) []string {
		out := append(append([]string{"BEGIN:VEVENT"}, master...), "END:VEVENT")
		for _, o := range overrides {
			out = append(out, "BEGIN:VEVENT", "UID:1", "DTSTAMP:20250101T000000Z", "SUMMARY:Series")
			out = append(out, o...)
			out = append(out, "END:VEVENT")
		}
		return out
	}
	mar := func(d, h int) time.Time { return date(2025, 3, d, h, 0) }

	tests := []struct {
		name      string
		lines     []string
		from      time.Time
		first     time.Time // the start of the event marked First, zero for none
		attendees bool
		count     int // events listed
	}{
		{"listed from its start", vevent(weekly), mar(1, 0), mar(3, 8), false, 4},
		{"listed from its second week", vevent(weekly), mar(8, 0), time.Time{}, false, 3},
		{"listed from within its first event", vevent(weekly), mar(3, 8), mar(3, 8), false, 4},
		{
			"first excluded by an EXDATE", vevent(with(weekly, "EXDATE:20250303T080000Z")), mar(1, 0),
			mar(10, 8), false, 3,
		},
		{
			"first excluded, listed from the week of the next", vevent(with(weekly, "EXDATE:20250303T080000Z")),
			mar(8, 0), mar(10, 8), false, 3,
		},
		{
			"first excluded, listed from the week after", vevent(with(weekly, "EXDATE:20250303T080000Z")),
			mar(11, 0),
			time.Time{},
			false, 2,
		},
		{
			"first cancelled by an override", vevent(weekly, []string{
				"RECURRENCE-ID:20250303T080000Z", "STATUS:CANCELLED", "DTSTART:20250303T080000Z", "DTEND:20250303T090000Z",
			}), mar(1, 0), mar(10, 8), false, 3,
		},
		{
			"first moved by its override", vevent(weekly, []string{
				"RECURRENCE-ID:20250303T080000Z", "DTSTART:20250320T080000Z", "DTEND:20250320T090000Z",
			}), mar(1, 0), mar(20, 8), false, 4,
		},
		{
			"first moved by its override, listed where the override is not", vevent(weekly, []string{
				"RECURRENCE-ID:20250303T080000Z", "DTSTART:20250320T080000Z", "DTEND:20250320T090000Z",
			}), mar(21, 0), time.Time{}, false, 1,
		},
		{"RDATE before DTSTART", vevent(with(weekly, "RDATE:20250301T080000Z")), mar(1, 0), mar(1, 8), false, 5},
		{"a single event", vevent(single), mar(1, 0), time.Time{}, false, 1},
		{"attendee of the series", vevent(with(weekly, "ATTENDEE:mailto:a@example.com")), mar(1, 0), mar(3, 8), true, 4},
		{
			"organizer of the series", vevent(with(weekly, "ORGANIZER:mailto:o@example.com")), mar(8, 0),
			time.Time{},
			true, 3,
		},
		{
			"attendee only of an override", vevent(weekly, []string{
				"RECURRENCE-ID:20250317T080000Z", "DTSTART:20250317T080000Z", "DTEND:20250317T090000Z",
				"ATTENDEE:mailto:a@example.com",
			}), mar(1, 0), mar(3, 8), true, 4,
		},
		{
			"attendee only of a cancelled override", vevent(weekly, []string{
				"RECURRENCE-ID:20250317T080000Z", "STATUS:CANCELLED", "DTSTART:20250317T080000Z",
				"ATTENDEE:mailto:a@example.com",
			}), mar(1, 0), mar(3, 8), true, 3,
		},
		{
			"attendee of a single event", vevent(with(single, "ATTENDEE:mailto:a@example.com")), mar(1, 0),
			time.Time{},
			true, 1,
		},
		{
			"invitation to one occurrence", []string{
				"BEGIN:VEVENT", "UID:1", "DTSTAMP:20250101T000000Z", "SUMMARY:Series",
				"RECURRENCE-ID:20250310T080000Z", "DTSTART:20250310T080000Z", "DTEND:20250310T090000Z",
				"ORGANIZER:mailto:o@example.com", "ATTENDEE:mailto:a@example.com", "END:VEVENT",
			}, mar(1, 0), time.Time{}, true, 1,
		},
		{
			"override without a series, no attendees", []string{
				"BEGIN:VEVENT", "UID:1", "DTSTAMP:20250101T000000Z", "SUMMARY:Series",
				"RECURRENCE-ID:20250310T080000Z", "DTSTART:20250310T080000Z", "DTEND:20250310T090000Z", "END:VEVENT",
			}, mar(1, 0), time.Time{}, false, 1,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			o := calObject{path: "/user/calendars/c/x.ics", etag: `"1"`, cal: mustParse(t, ics(tt.lines...))}
			got, err := expandObject(o, objRef{id: "id", calendarID: "cal"}, tt.from, date(2025, 5, 1, 0, 0))
			mustNoErr(t, err)
			if len(got) != tt.count {
				t.Fatalf("got %d events; want %d: %+v", len(got), tt.count, got)
			}
			var firsts []time.Time
			for _, ev := range got {
				if ev.First {
					firsts = append(firsts, ev.Start)
				}
				if ev.HasAttendees != tt.attendees {
					t.Errorf("event at %s: HasAttendees = %v; want %v", ev.Start, ev.HasAttendees, tt.attendees)
				}
			}
			switch {
			case tt.first.IsZero() && len(firsts) != 0:
				t.Errorf("First is set on %v; want none", firsts)
			case !tt.first.IsZero() && (len(firsts) != 1 || !firsts[0].Equal(tt.first)):
				t.Errorf("First is set on %v; want only %v", firsts, tt.first)
			}
		})
	}
}

// TestListEventsFirstAndAttendeesOnTheWire checks that ListEvents hands both
// fields out, in the JSON the API sends and without them where they do not
// hold (FR-17).
func TestListEventsFirstAndAttendeesOnTheWire(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	e.put(t, "work", "series.ics", "BEGIN:VEVENT", "UID:1", "DTSTAMP:20250101T000000Z", "SUMMARY:Series",
		"DTSTART:20250303T080000Z", "DTEND:20250303T090000Z", "RRULE:FREQ=WEEKLY;COUNT=2",
		"ATTENDEE:mailto:a@example.com", "END:VEVENT")
	e.put(t, "work", "plain.ics", "BEGIN:VEVENT", "UID:2", "DTSTAMP:20250101T000000Z", "SUMMARY:Plain",
		"DTSTART:20250304T080000Z", "DTEND:20250304T090000Z", "RRULE:FREQ=WEEKLY;COUNT=2", "END:VEVENT")

	evs := listed(t, e, "work", date(2025, 3, 1, 0, 0), date(2025, 4, 1, 0, 0))
	want := map[string]string{ // start -> JSON fields
		"2025-03-03T08:00:00Z": `"hasAttendees":true,"first":true`,
		"2025-03-10T08:00:00Z": `"hasAttendees":true`,
		"2025-03-04T08:00:00Z": `"first":true`,
		"2025-03-11T08:00:00Z": ``,
	}
	if len(evs) != len(want) {
		t.Fatalf("got %d events; want %d", len(evs), len(want))
	}
	for _, ev := range evs {
		b, err := json.Marshal(ev)
		mustNoErr(t, err)
		js := string(b)
		fields := want[ev.Start.Format(time.RFC3339)]
		for _, name := range []string{`"hasAttendees":true`, `"first":true`} {
			if has, wanted := strings.Contains(js, name), strings.Contains(fields, name); has != wanted {
				t.Errorf("event at %s: %s present = %v; want %v in %s", ev.Start, name, has, wanted, js)
			}
		}
	}
}

func sortEvents(evs []domain.Event) {
	for i := range evs {
		for j := i + 1; j < len(evs); j++ {
			if evs[j].Start.Before(evs[i].Start) {
				evs[i], evs[j] = evs[j], evs[i]
			}
		}
	}
}

func mustParse(t *testing.T, s string) *ical.Calendar {
	t.Helper()
	cal, err := ical.NewDecoder(strings.NewReader(s)).Decode()
	if err != nil {
		t.Fatalf("parse ics: %v", err)
	}
	return cal
}

func TestListEventsInstanceCap(t *testing.T) {
	t.Parallel()
	o := calObject{path: "/c/x.ics", cal: mustParse(t, ics("BEGIN:VEVENT", "UID:1", "DTSTAMP:20250101T000000Z",
		"DTSTART:20250101T000000Z", "RRULE:FREQ=MINUTELY", "END:VEVENT"))}
	got, err := expandObject(o, objRef{id: "id", calendarID: "c"}, date(2025, 1, 1, 0, 0), date(2026, 1, 1, 0, 0))
	mustNoErr(t, err)
	if len(got) != maxInstancesPerSeries {
		t.Fatalf("got %d instances; want cap %d", len(got), maxInstancesPerSeries)
	}
}

func TestListEventsInvalidData(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name  string
		lines []string
	}{
		{"missing DTSTART", []string{"BEGIN:VEVENT", "UID:1", "DTSTAMP:20250101T000000Z", "END:VEVENT"}},
		{"bad DTEND", []string{"BEGIN:VEVENT", "UID:1", "DTSTAMP:20250101T000000Z", "DTSTART:20250101T000000Z", "DTEND:garbage", "END:VEVENT"}},
		{"bad DURATION", []string{"BEGIN:VEVENT", "UID:1", "DTSTAMP:20250101T000000Z", "DTSTART:20250101T000000Z", "DURATION:1H", "END:VEVENT"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			o := calObject{path: "/c/x.ics", cal: mustParse(t, ics(tt.lines...))}
			if _, err := expandObject(o, objRef{id: "id", calendarID: "c"}, date(2024, 1, 1, 0, 0), date(2026, 1, 1, 0, 0)); err == nil {
				t.Fatal("expected error")
			}
		})
	}

	// Invalid objects are skipped by ListEvents, valid ones still returned.
	e := newEnv(t, caldavtest.Options{})
	e.put(t, "personal", "bad.ics", tests[0].lines...)
	e.put(t, "personal", "badrule.ics", "BEGIN:VEVENT", "UID:2", "DTSTAMP:20250101T000000Z",
		"DTSTART:20250301T100000Z", "RRULE:FREQ=SOMETIMES", "SUMMARY:Bad rule", "END:VEVENT")
	e.put(t, "personal", "good.ics", "BEGIN:VEVENT", "UID:3", "DTSTAMP:20250101T000000Z",
		"DTSTART:20250302T100000Z", "SUMMARY:Good", "END:VEVENT")
	evs, err := e.svc.ListEvents(t.Context(), e.cals["personal"], date(2025, 3, 1, 0, 0), date(2025, 4, 1, 0, 0))
	mustNoErr(t, err)
	if len(evs) != 2 || evs[0].Title != "Bad rule" || evs[1].Title != "Good" {
		t.Fatalf("got %+v", evs)
	}
	if _, err := e.svc.ListEvents(t.Context(), e.cals["personal"], date(2025, 4, 1, 0, 0), date(2025, 3, 1, 0, 0)); err == nil {
		t.Fatal("expected error for inverted range")
	}
}

func TestCreateEvent(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	ctx := t.Context()

	tests := []struct {
		name      string
		in        domain.EventInput
		wantLines []string // substrings of the stored object
		notLines  []string // substrings the stored object must not hold
		wantEvent occ
	}{
		{
			name: "timed non-recurring is stored in UTC",
			in: domain.EventInput{
				Title: "Lunch", Description: "line1\nline2", Location: "Cafe",
				Start: date(2025, 3, 5, 11, 0), End: date(2025, 3, 5, 12, 0), Timezone: ptr("Europe/Berlin"),
			},
			wantLines: []string{"DTSTART:20250305T110000Z", "DTEND:20250305T120000Z", "DESCRIPTION:line1\\nline2", "SEQUENCE:0"},
			wantEvent: occ{title: "Lunch", start: date(2025, 3, 5, 11, 0), end: date(2025, 3, 5, 12, 0)},
		},
		{
			name: "all-day",
			in: domain.EventInput{
				Title: "Holiday", AllDay: true, Start: date(2025, 3, 5, 0, 0), End: date(2025, 3, 7, 0, 0),
			},
			wantLines: []string{"DTSTART;VALUE=DATE:20250305", "DTEND;VALUE=DATE:20250307"},
			wantEvent: occ{title: "Holiday", start: date(2025, 3, 5, 0, 0), end: date(2025, 3, 7, 0, 0), allDay: true},
		},
		{
			name: "all-day with empty range",
			in: domain.EventInput{
				Title: "Partial", AllDay: true, Start: date(2025, 3, 5, 0, 0), End: date(2025, 3, 5, 0, 0),
			},
			wantLines: []string{"DTSTART;VALUE=DATE:20250305", "DTEND;VALUE=DATE:20250306"},
			wantEvent: occ{title: "Partial", start: date(2025, 3, 5, 0, 0), end: date(2025, 3, 6, 0, 0), allDay: true},
		},
		{
			name: "recurring keeps TZID and adds VTIMEZONE",
			in: domain.EventInput{
				Title: "Standup", Start: date(2025, 3, 17, 8, 0), End: date(2025, 3, 17, 8, 15),
				Timezone: ptr("Europe/Berlin"), RRule: "RRULE:FREQ=WEEKLY;BYDAY=MO",
			},
			wantLines: []string{
				"DTSTART;TZID=Europe/Berlin:20250317T090000", "RRULE:FREQ=WEEKLY;BYDAY=MO",
				"BEGIN:VTIMEZONE", "TZID:Europe/Berlin", "BEGIN:DAYLIGHT", "TZOFFSETTO:+0200",
			},
			wantEvent: occ{title: "Standup", start: date(2025, 3, 17, 8, 0), end: date(2025, 3, 17, 8, 15), rid: ptr(date(2025, 3, 17, 8, 0))},
		},
		{
			// A browser that reports UTC, such as Firefox with resistFingerprinting, writes no zone
			// of its own (FR-18).
			name: "recurring in UTC has no TZID and no VTIMEZONE",
			in: domain.EventInput{
				Title: "Standup", Start: date(2025, 3, 17, 8, 0), End: date(2025, 3, 17, 8, 15),
				Timezone: ptr("UTC"), RRule: "FREQ=WEEKLY",
			},
			wantLines: []string{"DTSTART:20250317T080000Z", "DTEND:20250317T081500Z", "RRULE:FREQ=WEEKLY"},
			notLines:  []string{"TZID", "VTIMEZONE"},
			wantEvent: occ{title: "Standup", start: date(2025, 3, 17, 8, 0), end: date(2025, 3, 17, 8, 15), rid: ptr(date(2025, 3, 17, 8, 0))},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			ev, err := e.svc.CreateEvent(ctx, e.cals["personal"], tt.in)
			mustNoErr(t, err)
			checkOccurrences(t, []domain.Event{ev}, []occ{tt.wantEvent})
			if ev.ETag == "" || ev.UID == "" || ev.CalendarID != e.cals["personal"] || ev.Location != tt.in.Location {
				t.Fatalf("unexpected event %+v", ev)
			}
			objPath, _, err := e.p.ids.decodeObjectID(e.mock.HomePath(), ev.ID)
			mustNoErr(t, err)
			if !strings.HasSuffix(objPath, "/"+ev.UID+".ics") {
				t.Fatalf("object path %q does not use UID", objPath)
			}
			data, ok := e.mock.Object(objPath)
			if !ok {
				t.Fatal("object not stored")
			}
			for _, l := range tt.wantLines {
				if !strings.Contains(data, l) {
					t.Errorf("stored object lacks %q:\n%s", l, data)
				}
			}
			for _, l := range tt.notLines {
				if strings.Contains(data, l) {
					t.Errorf("stored object holds %q:\n%s", l, data)
				}
			}
		})
	}

	t.Run("DST-correct expansion of created series", func(t *testing.T) {
		t.Parallel()
		ev, err := e.svc.CreateEvent(ctx, e.cals["work"], domain.EventInput{
			Title: "Weekly", Start: date(2025, 3, 24, 8, 0), End: date(2025, 3, 24, 9, 0),
			Timezone: ptr("Europe/Berlin"), RRule: "FREQ=WEEKLY",
		})
		mustNoErr(t, err)
		evs, err := e.svc.ListEvents(ctx, e.cals["work"], date(2025, 3, 30, 0, 0), date(2025, 4, 1, 0, 0))
		mustNoErr(t, err)
		checkOccurrences(t, evs, []occ{{title: "Weekly", start: date(2025, 3, 31, 7, 0), end: date(2025, 3, 31, 8, 0), rid: ptr(date(2025, 3, 31, 7, 0))}})
		if evs[0].Timezone != "Europe/Berlin" || evs[0].RRule != "FREQ=WEEKLY" || evs[0].ID != ev.ID {
			t.Fatalf("unexpected %+v", evs[0])
		}
	})
}

func TestCreateEventErrors(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	ok := domain.EventInput{Title: "x", Start: date(2025, 3, 5, 10, 0), End: date(2025, 3, 5, 11, 0)}
	tests := []struct {
		name  string
		calID string
		in    domain.EventInput
		want  error
	}{
		{"invalid rrule", e.cals["personal"], domain.EventInput{Title: "x", Start: ok.Start, End: ok.End, RRule: "FREQ=SOMETIMES"}, domain.ErrInvalidInput},
		{"rrule with newline", e.cals["personal"], domain.EventInput{Title: "x", Start: ok.Start, End: ok.End, RRule: "FREQ=DAILY\nX"}, domain.ErrInvalidInput},
		{"end before start", e.cals["personal"], domain.EventInput{Title: "x", Start: ok.End, End: ok.Start}, domain.ErrInvalidInput},
		{"read-only calendar", e.cals["holidays"], ok, domain.ErrReadOnly},
		{"todo-only calendar", e.cals["tasks"], ok, domain.ErrUnsupportedComponent},
		{"unknown calendar", e.p.ids.encode(e.mock.HomePath() + "nope/"), ok, domain.ErrNotFound},
		{"calendar outside home", e.p.ids.encode("/other/cal/"), ok, domain.ErrNotFound},
		{"garbage id", "!!!", ok, domain.ErrNotFound},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			_, err := e.svc.CreateEvent(t.Context(), tt.calID, tt.in)
			mustErr(t, err, tt.want)
		})
	}
}

func TestUpdateEventPreservesUnknownProperties(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	id := e.put(t, "personal", "keep.ics",
		"BEGIN:VEVENT", "UID:keep", "DTSTAMP:20240101T000000Z", "SEQUENCE:3",
		"SUMMARY:Old", "DESCRIPTION:Old description", "LOCATION:Old place",
		"DTSTART:20250305T100000Z", "DURATION:PT1H",
		"ATTENDEE;CN=Bob:mailto:bob@example.com", "X-CUSTOM-PROP:keep me", "CATEGORIES:A,B",
		"BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Reminder", "TRIGGER:-PT15M", "END:VALARM",
		"END:VEVENT")
	evs, err := e.svc.ListEvents(t.Context(), e.cals["personal"], date(2025, 3, 1, 0, 0), date(2025, 4, 1, 0, 0))
	mustNoErr(t, err)
	if len(evs) != 1 {
		t.Fatalf("got %d events", len(evs))
	}

	up, _, err := e.svc.UpdateEvent(t.Context(), id, evs[0].ETag, domain.EventInput{
		Title: "New", Start: date(2025, 3, 6, 10, 0), End: date(2025, 3, 6, 12, 0),
	})
	mustNoErr(t, err)
	if up.ETag == "" || up.ETag == evs[0].ETag || up.Title != "New" || up.Description != "" {
		t.Fatalf("unexpected update result %+v", up)
	}
	data, _ := e.mock.Object(e.paths["personal"] + "keep.ics")
	for _, want := range []string{
		"ATTENDEE;CN=Bob:mailto:bob@example.com", "X-CUSTOM-PROP:keep me", "CATEGORIES:A,B",
		"BEGIN:VALARM", "TRIGGER:-PT15M", "SEQUENCE:4", "SUMMARY:New",
		"DTSTART:20250306T100000Z", "DTEND:20250306T120000Z", "LAST-MODIFIED:",
	} {
		if !strings.Contains(data, want) {
			t.Errorf("updated object lacks %q:\n%s", want, data)
		}
	}
	for _, gone := range []string{"DURATION", "Old description", "LOCATION"} {
		if strings.Contains(data, gone) {
			t.Errorf("updated object still contains %q:\n%s", gone, data)
		}
	}
}

func TestUpdateRecurringInstance(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	e.put(t, "work", "series.ics",
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20240101T000000Z", "SUMMARY:Standup",
		"DTSTART;TZID=Europe/Berlin:20250303T090000", "DTEND;TZID=Europe/Berlin:20250303T091500",
		"RRULE:FREQ=WEEKLY;BYDAY=MO", "EXDATE;TZID=Europe/Berlin:20250310T090000",
		"END:VEVENT",
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20240101T000000Z", "SUMMARY:Special",
		"RECURRENCE-ID:20250317T080000Z", "DTSTART:20250317T120000Z", "DTEND:20250317T130000Z",
		"END:VEVENT")
	ctx := t.Context()
	evs, err := e.svc.ListEvents(ctx, e.cals["work"], date(2025, 3, 31, 0, 0), date(2025, 4, 1, 0, 0))
	mustNoErr(t, err)
	if len(evs) != 1 {
		t.Fatalf("got %d events", len(evs))
	}
	inst := evs[0] // Mar 31, 09:00 CEST = 07:00Z

	// Move the (summer) instance one hour later and make it 30 minutes long.
	up, _, err := e.svc.UpdateEvent(ctx, inst.ID, inst.ETag, domain.EventInput{
		Title: "Standup", Start: date(2025, 3, 31, 8, 0), End: date(2025, 3, 31, 8, 30),
		RRule: inst.RRule, InstanceStart: inst.RecurrenceID,
	})
	mustNoErr(t, err)
	checkOccurrences(t, []domain.Event{up}, []occ{{title: "Standup", start: date(2025, 3, 31, 8, 0), end: date(2025, 3, 31, 8, 30), rid: ptr(date(2025, 3, 31, 8, 0))}})

	data, _ := e.mock.Object(e.paths["work"] + "series.ics")
	for _, want := range []string{
		"DTSTART;TZID=Europe/Berlin:20250303T100000", "DTEND;TZID=Europe/Berlin:20250303T103000",
		"EXDATE;TZID=Europe/Berlin:20250310T100000", "RECURRENCE-ID:20250317T090000Z", "BEGIN:VTIMEZONE",
	} {
		if !strings.Contains(data, want) {
			t.Errorf("series lacks %q:\n%s", want, data)
		}
	}

	evs, err = e.svc.ListEvents(ctx, e.cals["work"], date(2025, 3, 1, 0, 0), date(2025, 4, 8, 0, 0))
	mustNoErr(t, err)
	checkOccurrences(t, evs, []occ{
		{title: "Standup", start: date(2025, 3, 3, 9, 0), end: date(2025, 3, 3, 9, 30), rid: ptr(date(2025, 3, 3, 9, 0))},
		{title: "Special", start: date(2025, 3, 17, 12, 0), end: date(2025, 3, 17, 13, 0), rid: ptr(date(2025, 3, 17, 9, 0))},
		{title: "Standup", start: date(2025, 3, 24, 9, 0), end: date(2025, 3, 24, 9, 30), rid: ptr(date(2025, 3, 24, 9, 0))},
		{title: "Standup", start: date(2025, 3, 31, 8, 0), end: date(2025, 3, 31, 8, 30), rid: ptr(date(2025, 3, 31, 8, 0))},
		{title: "Standup", start: date(2025, 4, 7, 8, 0), end: date(2025, 4, 7, 8, 30), rid: ptr(date(2025, 4, 7, 8, 0))},
	})

	// Removing the RRULE turns the series into a single event and drops
	// exceptions and overrides.
	single, _, err := e.svc.UpdateEvent(ctx, up.ID, up.ETag, domain.EventInput{
		Title: "Once", Start: date(2025, 4, 1, 8, 0), End: date(2025, 4, 1, 9, 0),
	})
	mustNoErr(t, err)
	checkOccurrences(t, []domain.Event{single}, []occ{{title: "Once", start: date(2025, 4, 1, 8, 0), end: date(2025, 4, 1, 9, 0)}})
	data, _ = e.mock.Object(e.paths["work"] + "series.ics")
	for _, gone := range []string{"RRULE:FREQ=WEEKLY", "EXDATE", "RECURRENCE-ID", "Special"} {
		if strings.Contains(data, gone) {
			t.Errorf("single event still contains %q:\n%s", gone, data)
		}
	}
}

// standupSeries is the fixture of TestUpdateRecurringInstance: a weekly
// standup on Mondays at 09:00 Europe/Berlin (08:00Z until 2025-03-30, 07:00Z
// after) from 2025-03-03, without 03-10, whose 03-17 event is an exception
// shown 12:00–13:00Z as "Special" (FR-17).
var standupSeries = []string{
	"BEGIN:VEVENT", "UID:series", "DTSTAMP:20240101T000000Z", "SUMMARY:Standup",
	"DTSTART;TZID=Europe/Berlin:20250303T090000", "DTEND;TZID=Europe/Berlin:20250303T091500",
	"RRULE:FREQ=WEEKLY;BYDAY=MO", "EXDATE;TZID=Europe/Berlin:20250310T090000",
	"END:VEVENT",
	"BEGIN:VEVENT", "UID:series", "DTSTAMP:20240101T000000Z", "SUMMARY:Special",
	"RECURRENCE-ID:20250317T080000Z", "DTSTART:20250317T120000Z", "DTEND:20250317T130000Z",
	"END:VEVENT",
}

// shownEvent returns the event of slug's calendar listed for March and April
// 2025 with the recurrence ID rid.
func shownEvent(t *testing.T, e *env, slug string, rid time.Time) domain.Event {
	t.Helper()
	evs, err := e.svc.ListEvents(t.Context(), e.cals[slug], date(2025, 3, 1, 0, 0), date(2025, 5, 1, 0, 0))
	mustNoErr(t, err)
	for i := range evs {
		if evs[i].RecurrenceID != nil && evs[i].RecurrenceID.Equal(rid) {
			return evs[i]
		}
	}
	t.Fatalf("no event with recurrence ID %v in %+v", rid, evs)
	return domain.Event{}
}

// stored returns the iCalendar data of the object name in slug's calendar.
func stored(t *testing.T, e *env, slug, name string) string {
	t.Helper()
	data, ok := e.mock.Object(e.paths[slug] + name)
	if !ok {
		t.Fatalf("object %s not stored", name)
	}
	return data
}

// seriesUpdate is the "all events" input that sets the event ev, as shown,
// to start–end with the given title and location.
func seriesUpdate(ev domain.Event, title, location string, start, end time.Time) domain.EventInput {
	return domain.EventInput{
		Title: title, Location: location, Start: start, End: end,
		RRule: ev.RRule, InstanceStart: ev.RecurrenceID,
	}
}

// TestUpdateSeriesFromException checks that "all events" from an exception
// moves the series by the distance from where the exception was shown, not
// from its RECURRENCE-ID, and that the exception moves along (spec section 3
// items 1, 2 and 5, FR-17).
func TestUpdateSeriesFromException(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	id := e.put(t, "work", "series.ics", standupSeries...)
	special := shownEvent(t, e, "work", date(2025, 3, 17, 8, 0))

	// Drag "Special" from 12:00Z to 13:00Z: the series moves by +1 h.
	up, _, err := e.svc.UpdateEvent(t.Context(), id, special.ETag,
		seriesUpdate(special, "Special", "", date(2025, 3, 17, 13, 0), date(2025, 3, 17, 14, 0)))
	mustNoErr(t, err)
	checkOccurrences(t, []domain.Event{up}, []occ{
		{title: "Special", start: date(2025, 3, 17, 13, 0), end: date(2025, 3, 17, 14, 0), rid: ptr(date(2025, 3, 17, 9, 0))},
	})

	evs, err := e.svc.ListEvents(t.Context(), e.cals["work"], date(2025, 3, 1, 0, 0), date(2025, 4, 1, 0, 0))
	mustNoErr(t, err)
	checkOccurrences(t, evs, []occ{
		{title: "Standup", start: date(2025, 3, 3, 9, 0), end: date(2025, 3, 3, 9, 15), rid: ptr(date(2025, 3, 3, 9, 0))},
		{title: "Special", start: date(2025, 3, 17, 13, 0), end: date(2025, 3, 17, 14, 0), rid: ptr(date(2025, 3, 17, 9, 0))},
		{title: "Standup", start: date(2025, 3, 24, 9, 0), end: date(2025, 3, 24, 9, 15), rid: ptr(date(2025, 3, 24, 9, 0))},
		{title: "Standup", start: date(2025, 3, 31, 8, 0), end: date(2025, 3, 31, 8, 15), rid: ptr(date(2025, 3, 31, 8, 0))},
	})
}

// TestUpdateSeriesChangedFieldsOnly checks that "all events" writes only the
// fields changed from the event as shown into the series, so an exception's
// own title does not replace the series' title, and that the edited
// exception takes the change too (spec section 3 items 3 and 5, FR-17).
func TestUpdateSeriesChangedFieldsOnly(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	id := e.put(t, "work", "series.ics", standupSeries...)
	special := shownEvent(t, e, "work", date(2025, 3, 17, 8, 0))

	_, _, err := e.svc.UpdateEvent(t.Context(), id, special.ETag,
		seriesUpdate(special, special.Title, "Room 2", special.Start, special.End))
	mustNoErr(t, err)

	ves := vevents(mustParse(t, stored(t, e, "work", "series.ics")))
	if len(ves) != 2 || ves[0].Props.Get(ical.PropRecurrenceID) != nil || ves[1].Props.Get(ical.PropRecurrenceID) == nil {
		t.Fatalf("want the series, then its exception; got %d VEVENTs", len(ves))
	}
	master, override := ves[0], ves[1]
	for _, tt := range []struct {
		name      string
		c         *ical.Component
		prop      string
		wantValue string
	}{
		{"series title", master, ical.PropSummary, "Standup"},
		{"series location", master, ical.PropLocation, "Room 2"},
		{"exception title", override, ical.PropSummary, "Special"},
		{"exception location", override, ical.PropLocation, "Room 2"},
		{"exception sequence", override, ical.PropSequence, "1"},
	} {
		if got := text(tt.c.Props, tt.prop); got != tt.wantValue {
			t.Errorf("%s = %q; want %q", tt.name, got, tt.wantValue)
		}
	}
	// The event was shown where it was saved: nothing moves.
	wantDateProp(t, master, ical.PropDateTimeStart, "20250303T090000", "Europe/Berlin", false)
	wantDateProp(t, master, ical.PropDateTimeEnd, "20250303T091500", "Europe/Berlin", false)
}

// TestRuleChangeFromAnExceptionKeepsItsTitleOut checks that changing the rule
// from an exception takes only the changed title into the series, as "all
// events" with the rule as it is does: the exception's own title does not
// replace the series' title (spec section 3 items 3 and 4, FR-17).
func TestRuleChangeFromAnExceptionKeepsItsTitleOut(t *testing.T) {
	t.Parallel()
	for _, tt := range []struct {
		name, title string
		wantMaster  string // the series' title afterwards
		wantBumped  bool   // whether the exception is bumped: its text changed
	}{
		{"title unchanged", "Special", "Standup", false},
		{"title changed", "Renamed", "Renamed", true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			id := e.put(t, "work", "series.ics",
				"BEGIN:VEVENT", "UID:series", "DTSTAMP:20240101T000000Z", "SUMMARY:Standup",
				"DTSTART:20250310T080000Z", "DTEND:20250310T083000Z", "RRULE:FREQ=WEEKLY",
				"END:VEVENT",
				"BEGIN:VEVENT", "UID:series", "DTSTAMP:20240101T000000Z", "SUMMARY:Special",
				"RECURRENCE-ID:20250317T080000Z", "DTSTART:20250317T080000Z", "DTEND:20250317T083000Z",
				"END:VEVENT")
			special := shownEvent(t, e, "work", date(2025, 3, 17, 8, 0))

			_, _, err := e.svc.UpdateEvent(t.Context(), id, special.ETag, domain.EventInput{
				Title: tt.title, Start: special.Start, End: special.End,
				RRule: "FREQ=DAILY;COUNT=5", InstanceStart: special.RecurrenceID,
			})
			mustNoErr(t, err)

			wantStored(t, e, "work", "series.ics", "SUMMARY:"+tt.wantMaster, "RRULE:FREQ=DAILY;COUNT=5")
			ves := vevents(mustParse(t, stored(t, e, "work", "series.ics")))
			if len(ves) != 2 || ves[0].Props.Get(ical.PropRecurrenceID) != nil || ves[1].Props.Get(ical.PropRecurrenceID) == nil {
				t.Fatalf("want the series, then its exception; got %d VEVENTs", len(ves))
			}
			if got := text(ves[0].Props, ical.PropSummary); got != tt.wantMaster {
				t.Errorf("series title = %q; want %q", got, tt.wantMaster)
			}
			if got := text(ves[1].Props, ical.PropSummary); got != tt.title {
				t.Errorf("exception title = %q; want %q", got, tt.title)
			}
			// The series is always bumped; the exception only where its text was
			// rewritten, as every other write to an override does.
			if got := text(ves[0].Props, ical.PropSequence); got != "1" {
				t.Errorf("series sequence = %q; want 1", got)
			}
			wantSeq, wantModified := "", ""
			if tt.wantBumped {
				wantSeq, wantModified = "1", text(ves[0].Props, ical.PropLastModified)
			}
			if got := text(ves[1].Props, ical.PropSequence); got != wantSeq {
				t.Errorf("exception sequence = %q; want %q", got, wantSeq)
			}
			if got := text(ves[1].Props, ical.PropLastModified); got != wantModified {
				t.Errorf("exception last-modified = %q; want %q", got, wantModified)
			}
		})
	}
}

// TestUpdateSeriesKeepsOtherExceptions checks that "all events" from a plain
// event moves the RECURRENCE-IDs of the other exceptions along, but leaves
// their own times and fields, and writes the series as the first VEVENT
// (spec section 2 step 7, section 3 item 6, FR-17).
func TestUpdateSeriesKeepsOtherExceptions(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	id := e.put(t, "work", "series.ics",
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20240101T000000Z", "SUMMARY:B",
		"RECURRENCE-ID:20250317T080000Z", "DTSTART:20250317T080000Z", "DTEND:20250317T081500Z",
		"END:VEVENT",
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20240101T000000Z", "SUMMARY:Standup",
		"DTSTART;TZID=Europe/Berlin:20250303T090000", "DTEND;TZID=Europe/Berlin:20250303T091500",
		"RRULE:FREQ=WEEKLY;BYDAY=MO",
		"END:VEVENT",
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20240101T000000Z", "SUMMARY:Standup",
		"RECURRENCE-ID:20250310T080000Z", "DTSTART:20250310T120000Z", "DTEND:20250310T121500Z",
		"END:VEVENT")
	plain := shownEvent(t, e, "work", date(2025, 3, 24, 8, 0))

	_, _, err := e.svc.UpdateEvent(t.Context(), id, plain.ETag,
		seriesUpdate(plain, "Standup", "", date(2025, 3, 24, 9, 0), date(2025, 3, 24, 9, 15)))
	mustNoErr(t, err)

	evs, err := e.svc.ListEvents(t.Context(), e.cals["work"], date(2025, 3, 1, 0, 0), date(2025, 4, 1, 0, 0))
	mustNoErr(t, err)
	checkOccurrences(t, evs, []occ{
		{title: "Standup", start: date(2025, 3, 3, 9, 0), end: date(2025, 3, 3, 9, 15), rid: ptr(date(2025, 3, 3, 9, 0))},
		{title: "Standup", start: date(2025, 3, 10, 12, 0), end: date(2025, 3, 10, 12, 15), rid: ptr(date(2025, 3, 10, 9, 0))},
		{title: "B", start: date(2025, 3, 17, 8, 0), end: date(2025, 3, 17, 8, 15), rid: ptr(date(2025, 3, 17, 9, 0))},
		{title: "Standup", start: date(2025, 3, 24, 9, 0), end: date(2025, 3, 24, 9, 15), rid: ptr(date(2025, 3, 24, 9, 0))},
		{title: "Standup", start: date(2025, 3, 31, 8, 0), end: date(2025, 3, 31, 8, 15), rid: ptr(date(2025, 3, 31, 8, 0))},
	})
	if ves := vevents(mustParse(t, stored(t, e, "work", "series.ics"))); ves[0].Props.Get(ical.PropRecurrenceID) != nil {
		t.Errorf("first VEVENT is an exception, not the series")
	}
}

// TestUpdateSeriesShiftsUntil checks that "all events" moves UNTIL with the
// series, so a series moved later keeps its last event (spec section 3 item
// 8, FR-17).
func TestUpdateSeriesShiftsUntil(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	id := e.put(t, "work", "series.ics",
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20240101T000000Z", "SUMMARY:Standup",
		"DTSTART;TZID=Europe/Berlin:20250303T090000", "DTEND;TZID=Europe/Berlin:20250303T091500",
		"RRULE:FREQ=WEEKLY;UNTIL=20250317T080000Z",
		"END:VEVENT")
	ev := shownEvent(t, e, "work", date(2025, 3, 10, 8, 0))

	_, _, err := e.svc.UpdateEvent(t.Context(), id, ev.ETag,
		seriesUpdate(ev, "Standup", "", date(2025, 3, 10, 9, 0), date(2025, 3, 10, 9, 15)))
	mustNoErr(t, err)

	if data := stored(t, e, "work", "series.ics"); !strings.Contains(data, "RRULE:FREQ=WEEKLY;UNTIL=20250317T090000Z") {
		t.Errorf("UNTIL not moved:\n%s", data)
	}
	evs, err := e.svc.ListEvents(t.Context(), e.cals["work"], date(2025, 3, 1, 0, 0), date(2025, 4, 1, 0, 0))
	mustNoErr(t, err)
	checkOccurrences(t, evs, []occ{
		{title: "Standup", start: date(2025, 3, 3, 9, 0), end: date(2025, 3, 3, 9, 15), rid: ptr(date(2025, 3, 3, 9, 0))},
		{title: "Standup", start: date(2025, 3, 10, 9, 0), end: date(2025, 3, 10, 9, 15), rid: ptr(date(2025, 3, 10, 9, 0))},
		{title: "Standup", start: date(2025, 3, 17, 9, 0), end: date(2025, 3, 17, 9, 15), rid: ptr(date(2025, 3, 17, 9, 0))},
	})
}

// TestUpdateSeriesWeekday is the probe of 2026-10-02 as a regression test:
// moving an event of a weekly series on Mondays to a Tuesday moves the
// series' weekday along, not only its DTSTART (spec section 3 "Wochentage
// und feste Tage" case 2, FR-17).
func TestUpdateSeriesWeekday(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	id := e.put(t, "work", "series.ics",
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20240101T000000Z", "SUMMARY:Standup",
		"DTSTART;TZID=Europe/Berlin:20250303T090000", "DTEND;TZID=Europe/Berlin:20250303T091500",
		"RRULE:FREQ=WEEKLY;BYDAY=MO",
		"END:VEVENT")
	monday := shownEvent(t, e, "work", date(2025, 3, 31, 7, 0)) // 09:00 CEST

	_, _, err := e.svc.UpdateEvent(t.Context(), id, monday.ETag,
		seriesUpdate(monday, "Standup", "", date(2025, 4, 1, 7, 0), date(2025, 4, 1, 7, 15)))
	mustNoErr(t, err)

	data := stored(t, e, "work", "series.ics")
	for _, want := range []string{"RRULE:FREQ=WEEKLY;BYDAY=TU", "DTSTART;TZID=Europe/Berlin:20250304T090000"} {
		if !strings.Contains(data, want) {
			t.Errorf("series lacks %q:\n%s", want, data)
		}
	}
	evs, err := e.svc.ListEvents(t.Context(), e.cals["work"], date(2025, 3, 1, 0, 0), date(2025, 3, 20, 0, 0))
	mustNoErr(t, err)
	checkOccurrences(t, evs, []occ{
		{title: "Standup", start: date(2025, 3, 4, 8, 0), end: date(2025, 3, 4, 8, 15), rid: ptr(date(2025, 3, 4, 8, 0))},
		{title: "Standup", start: date(2025, 3, 11, 8, 0), end: date(2025, 3, 11, 8, 15), rid: ptr(date(2025, 3, 11, 8, 0))},
		{title: "Standup", start: date(2025, 3, 18, 8, 0), end: date(2025, 3, 18, 8, 15), rid: ptr(date(2025, 3, 18, 8, 0))},
	})
}

// TestUpdateSeriesFixedDays checks that "all events" refuses to move a
// series on fixed days to another day, leaving the resource as it was, and
// still moves it within the same day (spec section 3 "Wochentage und feste
// Tage" case 3, FR-17).
func TestUpdateSeriesFixedDays(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	id := e.put(t, "work", "series.ics",
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20240101T000000Z", "SUMMARY:Review",
		"DTSTART;TZID=Europe/Berlin:20250303T090000", "DTEND;TZID=Europe/Berlin:20250303T091500",
		"RRULE:FREQ=MONTHLY;BYMONTHDAY=3",
		"END:VEVENT")
	april := shownEvent(t, e, "work", date(2025, 4, 3, 7, 0)) // 09:00 CEST
	before := stored(t, e, "work", "series.ics")

	_, _, err := e.svc.UpdateEvent(t.Context(), id, april.ETag,
		seriesUpdate(april, "Review", "", date(2025, 4, 4, 7, 0), date(2025, 4, 4, 7, 15)))
	mustErr(t, err, domain.ErrSeriesMoveUnsupported)
	if after := stored(t, e, "work", "series.ics"); after != before {
		t.Fatalf("refused move changed the resource:\n%s", after)
	}

	_, _, err = e.svc.UpdateEvent(t.Context(), id, april.ETag,
		seriesUpdate(april, "Review", "", date(2025, 4, 3, 9, 0), date(2025, 4, 3, 9, 15)))
	mustNoErr(t, err)
	data := stored(t, e, "work", "series.ics")
	for _, want := range []string{"RRULE:FREQ=MONTHLY;BYMONTHDAY=3", "DTSTART;TZID=Europe/Berlin:20250303T110000"} {
		if !strings.Contains(data, want) {
			t.Errorf("series lacks %q:\n%s", want, data)
		}
	}
	evs, err := e.svc.ListEvents(t.Context(), e.cals["work"], date(2025, 3, 1, 0, 0), date(2025, 5, 1, 0, 0))
	mustNoErr(t, err)
	checkOccurrences(t, evs, []occ{
		{title: "Review", start: date(2025, 3, 3, 10, 0), end: date(2025, 3, 3, 10, 15), rid: ptr(date(2025, 3, 3, 10, 0))},
		{title: "Review", start: date(2025, 4, 3, 9, 0), end: date(2025, 4, 3, 9, 15), rid: ptr(date(2025, 4, 3, 9, 0))},
	})
}

// TestUpdateSeriesNewRule checks that "all events" with a changed rule
// writes the rule and the fields changed from the event as shown into the
// series and the edited exception, and still moves the series by the
// distance from where the edited exception was shown (spec section 3 items
// 2 and 4, FR-17).
func TestUpdateSeriesNewRule(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	id := e.put(t, "work", "series.ics", standupSeries...)
	special := shownEvent(t, e, "work", date(2025, 3, 17, 8, 0))

	in := seriesUpdate(special, "Planning", "", date(2025, 3, 17, 13, 0), date(2025, 3, 17, 14, 0))
	in.RRule = "FREQ=WEEKLY;BYDAY=MO;COUNT=3"
	_, _, err := e.svc.UpdateEvent(t.Context(), id, special.ETag, in)
	mustNoErr(t, err)

	data := stored(t, e, "work", "series.ics")
	for _, want := range []string{
		"RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3", "SUMMARY:Planning",
		"DTSTART;TZID=Europe/Berlin:20250303T100000", "DTEND;TZID=Europe/Berlin:20250303T110000",
		"EXDATE;TZID=Europe/Berlin:20250310T100000", "RECURRENCE-ID:20250317T090000Z",
	} {
		if !strings.Contains(data, want) {
			t.Errorf("series lacks %q:\n%s", want, data)
		}
	}
	evs, err := e.svc.ListEvents(t.Context(), e.cals["work"], date(2025, 3, 1, 0, 0), date(2025, 4, 1, 0, 0))
	mustNoErr(t, err)
	checkOccurrences(t, evs, []occ{
		{title: "Planning", start: date(2025, 3, 3, 9, 0), end: date(2025, 3, 3, 10, 0), rid: ptr(date(2025, 3, 3, 9, 0))},
		{title: "Planning", start: date(2025, 3, 17, 12, 0), end: date(2025, 3, 17, 13, 0), rid: ptr(date(2025, 3, 17, 9, 0))},
	})
}

// TestUpdateSeriesRDateOnly checks that "all events" from a series made of
// RDATEs alone, whose empty rule comes back unchanged, moves the series
// rather than turning it into a single event (spec section 3, FR-17).
func TestUpdateSeriesRDateOnly(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	id := e.put(t, "work", "series.ics",
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20240101T000000Z", "SUMMARY:Lecture",
		"DTSTART:20250303T100000Z", "DTEND:20250303T110000Z", "RDATE:20250305T100000Z,20250310T100000Z",
		"END:VEVENT")
	ev := shownEvent(t, e, "work", date(2025, 3, 5, 10, 0))

	_, _, err := e.svc.UpdateEvent(t.Context(), id, ev.ETag,
		seriesUpdate(ev, "Lecture", "", date(2025, 3, 5, 11, 0), date(2025, 3, 5, 12, 0)))
	mustNoErr(t, err)

	evs, err := e.svc.ListEvents(t.Context(), e.cals["work"], date(2025, 3, 1, 0, 0), date(2025, 4, 1, 0, 0))
	mustNoErr(t, err)
	checkOccurrences(t, evs, []occ{
		{title: "Lecture", start: date(2025, 3, 3, 11, 0), end: date(2025, 3, 3, 12, 0), rid: ptr(date(2025, 3, 3, 11, 0))},
		{title: "Lecture", start: date(2025, 3, 5, 11, 0), end: date(2025, 3, 5, 12, 0), rid: ptr(date(2025, 3, 5, 11, 0))},
		{title: "Lecture", start: date(2025, 3, 10, 11, 0), end: date(2025, 3, 10, 12, 0), rid: ptr(date(2025, 3, 10, 11, 0))},
	})
}

// TestUpdateEventAnswerTellsFirstAndAttendees checks that the answer of a
// save tells First and HasAttendees as ListEvents does, also where it is no
// event ListEvents showed at a moved recurrence ID: a new rule, or a single
// event (FR-17). "This and following events" at a series' first event answers
// with it.
func TestUpdateEventAnswerTellsFirstAndAttendees(t *testing.T) {
	t.Parallel()
	organizer := "ORGANIZER:mailto:boss@example.com"
	weekly := []string{
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20240101T000000Z", "SUMMARY:Standup", organizer,
		"DTSTART:20250303T090000Z", "DTEND:20250303T100000Z", "RRULE:FREQ=WEEKLY", "END:VEVENT",
	}
	tests := []struct {
		name      string
		lines     []string
		rid       *time.Time // nil: the single event
		rule      string
		wantFirst bool
	}{
		{"a new rule from the first event", weekly, ptr(date(2025, 3, 3, 9, 0)), "FREQ=WEEKLY;COUNT=5", true},
		{"a new rule from the second event", weekly, ptr(date(2025, 3, 10, 9, 0)), "FREQ=WEEKLY;COUNT=5", false},
		{"a moved series", weekly, ptr(date(2025, 3, 3, 9, 0)), "FREQ=WEEKLY", true},
		{"a single event", []string{
			"BEGIN:VEVENT", "UID:once", "DTSTAMP:20240101T000000Z", "SUMMARY:Once", "ATTENDEE:mailto:me@example.com",
			"DTSTART:20250310T090000Z", "DTEND:20250310T100000Z", "END:VEVENT",
		}, nil, "", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			id := e.put(t, "work", "event.ics", tt.lines...)
			evs := listed(t, e, "work", date(2025, 3, 1, 0, 0), date(2025, 4, 1, 0, 0))
			i := slices.IndexFunc(evs, func(ev domain.Event) bool {
				return tt.rid == nil || (ev.RecurrenceID != nil && ev.RecurrenceID.Equal(*tt.rid))
			})
			if i < 0 {
				t.Fatalf("no event at %v in %+v", tt.rid, evs)
			}
			in := eventInputOf(evs[i])
			in.Title, in.RRule = "Changed", tt.rule
			if tt.rule == "FREQ=WEEKLY" {
				in.Start, in.End = in.Start.Add(time.Hour), in.End.Add(time.Hour)
			}
			got, _, err := e.svc.UpdateEvent(t.Context(), id, evs[i].ETag, in)
			mustNoErr(t, err)
			if got.First != tt.wantFirst || !got.HasAttendees {
				t.Errorf("answer first %v, attendees %v; want first %v, attendees true", got.First, got.HasAttendees,
					tt.wantFirst)
			}
		})
	}
}

// listed returns the events of slug's calendar listed for [from, to).
func listed(t *testing.T, e *env, slug string, from, to time.Time) []domain.Event {
	t.Helper()
	evs, err := e.svc.ListEvents(t.Context(), e.cals[slug], from, to)
	mustNoErr(t, err)
	return evs
}

// wantStored asserts that the object name in slug's calendar contains every
// line of want.
func wantStored(t *testing.T, e *env, slug, name string, want ...string) {
	t.Helper()
	data := stored(t, e, slug, name)
	for _, line := range want {
		if !strings.Contains(data, line) {
			t.Errorf("series lacks %q:\n%s", line, data)
		}
	}
}

// mustRefuseMove asserts that UpdateEvent refuses in for the event ev of
// the series id in the object series.ics of the work calendar as a move
// the series cannot follow, and leaves that object as it was (FR-17).
func mustRefuseMove(t *testing.T, e *env, id string, ev domain.Event, in domain.EventInput) {
	t.Helper()
	before := stored(t, e, "work", "series.ics")
	_, _, err := e.svc.UpdateEvent(t.Context(), id, ev.ETag, in)
	mustErr(t, err, domain.ErrSeriesMoveUnsupported)
	if after := stored(t, e, "work", "series.ics"); after != before {
		t.Fatalf("refused move changed the resource:\n%s", after)
	}
}

// TestUpdateSeriesWithoutZoneJudgedInUTC checks that "all events" judges a
// series on fixed days whose DTSTART has no zone Lucid knows (UTC, floating,
// an unknown TZID) by its days in UTC, and reports it without a zone, which
// is what the browser's moveAllRefusal reads in UTC too, wherever it is
// (FR-17). In Berlin, 23:30Z to 00:30Z stays on one day, and 22:30Z to
// 23:30Z crosses midnight.
func TestUpdateSeriesWithoutZoneJudgedInUTC(t *testing.T) {
	t.Parallel()
	for _, tt := range []struct {
		name string
		prop func(name, value string) string // the date property name with value in this form
	}{
		{"utc", func(name, v string) string { return name + ":" + v + "Z" }},
		{"floating", func(name, v string) string { return name + ":" + v }},
		{"unknown tzid", func(name, v string) string { return name + ";TZID=Nowhere/Land:" + v }},
	} {
		// series stores the monthly series on the 15th from start to end, and
		// returns its ID and its event at rid, shown without a zone.
		series := func(t *testing.T, e *env, start, end string, rid time.Time) (string, domain.Event) {
			t.Helper()
			id := e.put(t, "work", "series.ics",
				"BEGIN:VEVENT", "UID:series", "DTSTAMP:20240101T000000Z", "SUMMARY:Review",
				tt.prop("DTSTART", start), tt.prop("DTEND", end), "RRULE:FREQ=MONTHLY;BYMONTHDAY=15", "END:VEVENT")
			ev := shownEvent(t, e, "work", rid)
			if ev.Timezone != "" {
				t.Fatalf("timezone = %q, want none", ev.Timezone)
			}
			return id, ev
		}
		t.Run(tt.name+" refuses the next UTC day", func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			id, ev := series(t, e, "20250315T233000", "20250316T000000", date(2025, 3, 15, 23, 30))
			mustRefuseMove(t, e, id, ev, seriesUpdate(ev, "Review", "", date(2025, 3, 16, 0, 30), date(2025, 3, 16, 1, 0)))
		})
		t.Run(tt.name+" moves within the UTC day", func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			id, ev := series(t, e, "20250315T223000", "20250315T230000", date(2025, 3, 15, 22, 30))
			_, _, err := e.svc.UpdateEvent(t.Context(), id, ev.ETag,
				seriesUpdate(ev, "Review", "", date(2025, 3, 15, 23, 30), date(2025, 3, 16, 0, 0)))
			mustNoErr(t, err)
		})
	}
}

// TestUpdateSeriesKeepsRefsOnWallClock is the review's first reproduction
// as a regression test: "all events" one day later, from a January event of
// a Saturday series in Europe/Berlin, moves its EXDATE and its exception's
// RECURRENCE-ID by one calendar day on the series' wall clock. Moved by 24
// hours instead, both landed an hour off across a daylight-saving change,
// so the deleted event came back and the exception was orphaned next to the
// plain event it replaces (spec section 3 item 2, FR-17).
func TestUpdateSeriesKeepsRefsOnWallClock(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	id := e.put(t, "work", "series.ics",
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Run",
		"DTSTART;TZID=Europe/Berlin:20260103T090000", "DTEND;TZID=Europe/Berlin:20260103T100000",
		"RRULE:FREQ=WEEKLY;BYDAY=SA", "EXDATE;TZID=Europe/Berlin:20260328T090000",
		"END:VEVENT",
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Special",
		"RECURRENCE-ID;TZID=Europe/Berlin:20261024T090000",
		"DTSTART;TZID=Europe/Berlin:20261024T150000", "DTEND;TZID=Europe/Berlin:20261024T160000",
		"END:VEVENT")
	evs := listed(t, e, "work", date(2026, 1, 10, 0, 0), date(2026, 1, 11, 0, 0))
	if len(evs) != 1 {
		t.Fatalf("got %d events on 2026-01-10; want 1", len(evs))
	}

	up, _, err := e.svc.UpdateEvent(t.Context(), id, evs[0].ETag,
		seriesUpdate(evs[0], "Run", "", date(2026, 1, 11, 8, 0), date(2026, 1, 11, 9, 0)))
	mustNoErr(t, err)
	checkOccurrences(t, []domain.Event{up}, []occ{
		{title: "Run", start: date(2026, 1, 11, 8, 0), end: date(2026, 1, 11, 9, 0), rid: ptr(date(2026, 1, 11, 8, 0))},
	})

	wantStored(t, e, "work", "series.ics",
		"RRULE:FREQ=WEEKLY;BYDAY=SU", "DTSTART;TZID=Europe/Berlin:20260104T090000",
		"EXDATE;TZID=Europe/Berlin:20260329T090000", "RECURRENCE-ID;TZID=Europe/Berlin:20261025T090000")
	// 03-29, the day of the change to summer time, stays deleted.
	checkOccurrences(t, listed(t, e, "work", date(2026, 3, 22, 0, 0), date(2026, 4, 6, 0, 0)), []occ{
		{title: "Run", start: date(2026, 3, 22, 8, 0), end: date(2026, 3, 22, 9, 0), rid: ptr(date(2026, 3, 22, 8, 0))},
		{title: "Run", start: date(2026, 4, 5, 7, 0), end: date(2026, 4, 5, 8, 0), rid: ptr(date(2026, 4, 5, 7, 0))},
	})
	// 10-25, the day of the change back, is the exception, at its own time.
	checkOccurrences(t, listed(t, e, "work", date(2026, 10, 18, 0, 0), date(2026, 11, 2, 0, 0)), []occ{
		{title: "Run", start: date(2026, 10, 18, 7, 0), end: date(2026, 10, 18, 8, 0), rid: ptr(date(2026, 10, 18, 7, 0))},
		{title: "Special", start: date(2026, 10, 24, 13, 0), end: date(2026, 10, 24, 14, 0), rid: ptr(date(2026, 10, 25, 8, 0))},
		{title: "Run", start: date(2026, 11, 1, 8, 0), end: date(2026, 11, 1, 9, 0), rid: ptr(date(2026, 11, 1, 8, 0))},
	})
}

// TestUpdateSeriesAcrossDSTChange is the review's second reproduction as a
// regression test: "all events" from Friday 09:00 CET to Monday 09:00 CEST,
// as a drag to another day sends it, keeps the series at 09:00 Berlin time.
// Moved by the 71 hours in between instead, it went to 08:00 (spec section 3
// item 2, FR-17).
func TestUpdateSeriesAcrossDSTChange(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	id := e.put(t, "work", "series.ics",
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Review",
		"DTSTART;TZID=Europe/Berlin:20260102T090000", "DTEND;TZID=Europe/Berlin:20260102T093000",
		"RRULE:FREQ=WEEKLY;BYDAY=FR",
		"END:VEVENT")
	evs := listed(t, e, "work", date(2026, 3, 27, 0, 0), date(2026, 3, 28, 0, 0))
	if len(evs) != 1 {
		t.Fatalf("got %d events on 2026-03-27; want 1", len(evs))
	}

	up, _, err := e.svc.UpdateEvent(t.Context(), id, evs[0].ETag,
		seriesUpdate(evs[0], "Review", "", date(2026, 3, 30, 7, 0), date(2026, 3, 30, 7, 30)))
	mustNoErr(t, err)
	checkOccurrences(t, []domain.Event{up}, []occ{
		{title: "Review", start: date(2026, 3, 30, 7, 0), end: date(2026, 3, 30, 7, 30), rid: ptr(date(2026, 3, 30, 7, 0))},
	})

	wantStored(t, e, "work", "series.ics",
		"RRULE:FREQ=WEEKLY;BYDAY=MO", "DTSTART;TZID=Europe/Berlin:20260105T090000", "DTEND;TZID=Europe/Berlin:20260105T093000")
	checkOccurrences(t, listed(t, e, "work", date(2026, 3, 20, 0, 0), date(2026, 4, 7, 0, 0)), []occ{
		{title: "Review", start: date(2026, 3, 23, 8, 0), end: date(2026, 3, 23, 8, 30), rid: ptr(date(2026, 3, 23, 8, 0))},
		{title: "Review", start: date(2026, 3, 30, 7, 0), end: date(2026, 3, 30, 7, 30), rid: ptr(date(2026, 3, 30, 7, 0))},
		{title: "Review", start: date(2026, 4, 6, 7, 0), end: date(2026, 4, 6, 7, 30), rid: ptr(date(2026, 4, 6, 7, 0))},
	})
}

// TestUpdateSeriesNewRuleAcrossDSTChange checks that "all events" with a
// changed rule moves the series on its wall clock too, like the unchanged
// rule in TestUpdateSeriesAcrossDSTChange (spec section 3 items 2 and 4,
// FR-17).
func TestUpdateSeriesNewRuleAcrossDSTChange(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	id := e.put(t, "work", "series.ics",
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Review",
		"DTSTART;TZID=Europe/Berlin:20260102T090000", "DTEND;TZID=Europe/Berlin:20260102T093000",
		"RRULE:FREQ=WEEKLY;BYDAY=FR", "EXDATE;TZID=Europe/Berlin:20260320T090000",
		"END:VEVENT")
	evs := listed(t, e, "work", date(2026, 3, 27, 0, 0), date(2026, 3, 28, 0, 0))
	if len(evs) != 1 {
		t.Fatalf("got %d events on 2026-03-27; want 1", len(evs))
	}

	in := seriesUpdate(evs[0], "Review", "", date(2026, 3, 30, 7, 0), date(2026, 3, 30, 7, 30))
	in.RRule = "FREQ=WEEKLY;BYDAY=MO;COUNT=20"
	_, _, err := e.svc.UpdateEvent(t.Context(), id, evs[0].ETag, in)
	mustNoErr(t, err)

	wantStored(t, e, "work", "series.ics",
		"RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=20", "DTSTART;TZID=Europe/Berlin:20260105T090000",
		"DTEND;TZID=Europe/Berlin:20260105T093000", "EXDATE;TZID=Europe/Berlin:20260323T090000")
	checkOccurrences(t, listed(t, e, "work", date(2026, 3, 16, 0, 0), date(2026, 4, 7, 0, 0)), []occ{
		{title: "Review", start: date(2026, 3, 16, 8, 0), end: date(2026, 3, 16, 8, 30), rid: ptr(date(2026, 3, 16, 8, 0))},
		{title: "Review", start: date(2026, 3, 30, 7, 0), end: date(2026, 3, 30, 7, 30), rid: ptr(date(2026, 3, 30, 7, 0))},
		{title: "Review", start: date(2026, 4, 6, 7, 0), end: date(2026, 4, 6, 7, 30), rid: ptr(date(2026, 4, 6, 7, 0))},
	})
}

// reviewSeries is a series at 10:00 Berlin time from Tuesday 2026-10-06 with
// the rule rule, and the VEVENTs of exceptions after it. Berlin changes back
// from summer time on 10-25, so its events are at 08:00 UTC before and at
// 09:00 UTC after.
func reviewSeries(rule string, exceptions ...string) []string {
	return slices.Concat([]string{
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20260101T000000Z", "SUMMARY:Review",
		"DTSTART;TZID=Europe/Berlin:20261006T100000", "DTEND;TZID=Europe/Berlin:20261006T110000",
		"RRULE:" + rule, "END:VEVENT",
	}, exceptions)
}

// listedAt returns the event of slug's calendar with the recurrence ID rid,
// listed in [from, to).
func listedAt(t *testing.T, e *env, slug string, rid, from, to time.Time) domain.Event {
	t.Helper()
	evs := listed(t, e, slug, from, to)
	for i := range evs {
		if evs[i].RecurrenceID != nil && evs[i].RecurrenceID.Equal(rid) {
			return evs[i]
		}
	}
	t.Fatalf("no event with recurrence ID %v in [%v, %v)", rid, from, to)
	return domain.Event{}
}

// seriesEvents returns the events titled title an hour long from starts, each
// an event of its series' rule.
func seriesEvents(title string, starts ...time.Time) []occ {
	out := make([]occ, len(starts))
	for i, s := range starts {
		out[i] = occ{title: title, start: s, end: s.Add(time.Hour), rid: ptr(s)}
	}
	return out
}

// TestUpdateSeriesNewRuleReadAtEditedEvent is the reproduction of issue #9
// as a regression test: "All events" with a changed rule from a later event
// reads the rule where the editor builds it, at that event, as far from its
// place in the rule as the form moves it: what the rule leaves to its start,
// the weekday of FREQ=WEEKLY, the day of FREQ=MONTHLY, the month and day of
// FREQ=YEARLY and the clock time, and the periods its INTERVAL counts.
// DTSTART goes to the rule's first event from where the series started,
// moved as the event moved, with the rule as sent, so the edited event stays
// an event of the series, and DTSTART one of its rule, as RFC 5545 section
// 3.8.5.3 asks. A weekly series from Tuesday 10-06 changed to "Every month on
// day 10" from its 11-10 event repeated on the 6th instead, and with the day
// written out, kept 10-06 as an event off the rule (FR-17).
func TestUpdateSeriesNewRuleReadAtEditedEvent(t *testing.T) {
	t.Parallel()
	for _, c := range []struct {
		name, rule string
		rid, start time.Time // the edited event, and where it is entered
		newRule    string
		dtstart    string
		from, to   time.Time
		events     []time.Time // the series' events listed in [from, to)
	}{
		{
			name: "weekly to monthly", rule: "FREQ=WEEKLY",
			rid: date(2026, 11, 10, 9, 0), start: date(2026, 11, 10, 9, 0), newRule: "FREQ=MONTHLY",
			dtstart: "DTSTART;TZID=Europe/Berlin:20261010T100000", from: date(2026, 10, 1, 0, 0), to: date(2027, 1, 1, 0, 0),
			events: []time.Time{date(2026, 10, 10, 8, 0), date(2026, 11, 10, 9, 0), date(2026, 12, 10, 9, 0)},
		},
		{
			name: "monthly to weekly", rule: "FREQ=MONTHLY",
			rid: date(2026, 11, 6, 9, 0), start: date(2026, 11, 6, 9, 0), newRule: "FREQ=WEEKLY",
			dtstart: "DTSTART;TZID=Europe/Berlin:20261009T100000", from: date(2026, 10, 1, 0, 0), to: date(2026, 10, 31, 0, 0),
			events: []time.Time{date(2026, 10, 9, 8, 0), date(2026, 10, 16, 8, 0), date(2026, 10, 23, 8, 0), date(2026, 10, 30, 9, 0)},
		},
		{
			name: "weekly to yearly", rule: "FREQ=WEEKLY",
			rid: date(2026, 11, 10, 9, 0), start: date(2026, 11, 10, 9, 0), newRule: "FREQ=YEARLY",
			dtstart: "DTSTART;TZID=Europe/Berlin:20261110T100000", from: date(2026, 10, 1, 0, 0), to: date(2027, 1, 1, 0, 0),
			events: []time.Time{date(2026, 11, 10, 9, 0)},
		},
		{
			name: "two weekdays to weekly", rule: "FREQ=WEEKLY;BYDAY=TU,TH",
			rid: date(2026, 11, 12, 9, 0), start: date(2026, 11, 12, 9, 0), newRule: "FREQ=WEEKLY",
			dtstart: "DTSTART;TZID=Europe/Berlin:20261008T100000", from: date(2026, 10, 1, 0, 0), to: date(2026, 10, 23, 0, 0),
			events: []time.Time{date(2026, 10, 8, 8, 0), date(2026, 10, 15, 8, 0), date(2026, 10, 22, 8, 0)},
		},
		{
			name: "every other week in the edited event's weeks", rule: "FREQ=WEEKLY",
			rid: date(2026, 11, 10, 9, 0), start: date(2026, 11, 10, 9, 0), newRule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU",
			dtstart: "DTSTART;TZID=Europe/Berlin:20261013T100000", from: date(2026, 10, 1, 0, 0), to: date(2026, 11, 25, 0, 0),
			events: []time.Time{date(2026, 10, 13, 8, 0), date(2026, 10, 27, 9, 0), date(2026, 11, 10, 9, 0), date(2026, 11, 24, 9, 0)},
		},
		{
			// Counted from the new DTSTART, not from where the search starts.
			name: "count", rule: "FREQ=WEEKLY",
			rid: date(2026, 11, 10, 9, 0), start: date(2026, 11, 10, 9, 0), newRule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;COUNT=3",
			dtstart: "DTSTART;TZID=Europe/Berlin:20261013T100000", from: date(2026, 10, 1, 0, 0), to: date(2027, 1, 1, 0, 0),
			events: []time.Time{date(2026, 10, 13, 8, 0), date(2026, 10, 27, 9, 0), date(2026, 11, 10, 9, 0)},
		},
		{
			name: "day written out", rule: "FREQ=WEEKLY",
			rid: date(2026, 11, 10, 9, 0), start: date(2026, 11, 10, 9, 0), newRule: "FREQ=MONTHLY;BYMONTHDAY=10",
			dtstart: "DTSTART;TZID=Europe/Berlin:20261010T100000", from: date(2026, 10, 1, 0, 0), to: date(2026, 11, 30, 0, 0),
			events: []time.Time{date(2026, 10, 10, 8, 0), date(2026, 11, 10, 9, 0)},
		},
		{
			name: "moved to another time", rule: "FREQ=WEEKLY",
			rid: date(2026, 11, 10, 9, 0), start: date(2026, 11, 10, 13, 0), newRule: "FREQ=MONTHLY",
			dtstart: "DTSTART;TZID=Europe/Berlin:20261010T140000", from: date(2026, 10, 1, 0, 0), to: date(2026, 11, 30, 0, 0),
			events: []time.Time{date(2026, 10, 10, 12, 0), date(2026, 11, 10, 13, 0)},
		},
		{
			// The series' start moves a day too, to Wednesday 10-07.
			name: "moved to another day", rule: "FREQ=WEEKLY",
			rid: date(2026, 11, 10, 9, 0), start: date(2026, 11, 11, 9, 0), newRule: "FREQ=MONTHLY",
			dtstart: "DTSTART;TZID=Europe/Berlin:20261011T100000", from: date(2026, 10, 1, 0, 0), to: date(2026, 11, 30, 0, 0),
			events: []time.Time{date(2026, 10, 11, 8, 0), date(2026, 11, 11, 9, 0)},
		},
		{
			name: "from the first event", rule: "FREQ=WEEKLY",
			rid: date(2026, 10, 6, 8, 0), start: date(2026, 10, 6, 8, 0), newRule: "FREQ=MONTHLY",
			dtstart: "DTSTART;TZID=Europe/Berlin:20261006T100000", from: date(2026, 10, 1, 0, 0), to: date(2026, 11, 30, 0, 0),
			events: []time.Time{date(2026, 10, 6, 8, 0), date(2026, 11, 6, 9, 0)},
		},
	} {
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			id := e.put(t, "work", "series.ics", reviewSeries(c.rule)...)
			ev := listedAt(t, e, "work", c.rid, c.rid, c.rid.Add(time.Second))

			in := seriesUpdate(ev, "Review", "", c.start, c.start.Add(time.Hour))
			in.RRule, in.Timezone = c.newRule, ptr("Europe/Berlin")
			up, _, err := e.svc.UpdateEvent(t.Context(), id, ev.ETag, in)
			mustNoErr(t, err)

			wantStored(t, e, "work", "series.ics", c.dtstart, "RRULE:"+c.newRule)
			checkOccurrences(t, listed(t, e, "work", c.from, c.to), seriesEvents("Review", c.events...))
			// The answer says what the list shows.
			edited := seriesEvents("Review", c.start)
			checkOccurrences(t, []domain.Event{up}, edited)
			checkOccurrences(t, listed(t, e, "work", c.start, c.start.Add(time.Second)), edited)
		})
	}
}

// TestUpdateSeriesNewRuleReadAtExceptionsPlace checks that a changed rule
// from an exception another client moved off its place in the rule is read
// at that place, its RECURRENCE-ID, as the editor reads it (#7, #9, FR-17):
// the exception of 11-10 shown on Wednesday 11-11 makes "Every month" the
// 10th, and stays the event of 11-10.
func TestUpdateSeriesNewRuleReadAtExceptionsPlace(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	id := e.put(t, "work", "series.ics", reviewSeries("FREQ=WEEKLY",
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20260101T000000Z", "SUMMARY:Review",
		"RECURRENCE-ID;TZID=Europe/Berlin:20261110T100000",
		"DTSTART;TZID=Europe/Berlin:20261111T100000", "DTEND;TZID=Europe/Berlin:20261111T110000",
		"END:VEVENT")...)
	ev := listedAt(t, e, "work", date(2026, 11, 10, 9, 0), date(2026, 11, 11, 0, 0), date(2026, 11, 12, 0, 0))

	in := seriesUpdate(ev, "Review", "", ev.Start, ev.End)
	in.RRule, in.Timezone = "FREQ=MONTHLY", ptr("Europe/Berlin")
	_, _, err := e.svc.UpdateEvent(t.Context(), id, ev.ETag, in)
	mustNoErr(t, err)

	wantStored(t, e, "work", "series.ics", "DTSTART;TZID=Europe/Berlin:20261010T100000", "RRULE:FREQ=MONTHLY")
	checkOccurrences(t, listed(t, e, "work", date(2026, 10, 1, 0, 0), date(2026, 11, 30, 0, 0)), []occ{
		{title: "Review", start: date(2026, 10, 10, 8, 0), end: date(2026, 10, 10, 9, 0), rid: ptr(date(2026, 10, 10, 8, 0))},
		{title: "Review", start: date(2026, 11, 11, 9, 0), end: date(2026, 11, 11, 10, 0), rid: ptr(date(2026, 11, 10, 9, 0))},
	})
}

// TestUpdateSeriesNewRuleReadInTheNewZone checks that a changed rule that
// moves a series into another zone is read at the edited event there (#9,
// FR-17, FR-18): the New York series' event of Tuesday 11-10 at 18:00 is
// Wednesday 11-11 at 00:00 in Berlin, so "Every month" is the 11th there,
// from the first after the series' start, 03-17 at 18:00 New York time and
// 03-18 at 00:00 in Berlin.
func TestUpdateSeriesNewRuleReadInTheNewZone(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	id := e.put(t, "work", "series.ics", nySeries(nil)...)
	ev := listedAt(t, e, "work", date(2026, 11, 10, 23, 0), date(2026, 11, 10, 23, 0), date(2026, 11, 10, 23, 1))

	in := seriesUpdate(ev, "Call", "", ev.Start, ev.End)
	in.RRule, in.Timezone = "FREQ=MONTHLY", ptr("Europe/Berlin")
	_, _, err := e.svc.UpdateEvent(t.Context(), id, ev.ETag, in)
	mustNoErr(t, err)

	wantStored(t, e, "work", "series.ics", "DTSTART;TZID=Europe/Berlin:20260411T000000", "RRULE:FREQ=MONTHLY")
	checkOccurrences(t, listed(t, e, "work", date(2026, 3, 1, 0, 0), date(2026, 5, 15, 0, 0)),
		seriesEvents("Call", date(2026, 4, 10, 22, 0), date(2026, 5, 10, 22, 0)))
	checkOccurrences(t, listed(t, e, "work", date(2026, 11, 10, 0, 0), date(2026, 11, 12, 0, 0)),
		seriesEvents("Call", date(2026, 11, 10, 23, 0)))
}

// TestUpdateSeriesNewRuleAllDayReadAtEditedEvent checks that a changed rule
// of a series that is or turns all-day, or turns timed, is read at the
// edited event's date (#9, FR-17): "Every month" from the event of 11-10 is
// the 10th, from 10-10.
func TestUpdateSeriesNewRuleAllDayReadAtEditedEvent(t *testing.T) {
	t.Parallel()
	allDaySeries := []string{
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20260101T000000Z", "SUMMARY:Review",
		"DTSTART;VALUE=DATE:20261006", "DTEND;VALUE=DATE:20261007", "RRULE:FREQ=WEEKLY", "END:VEVENT",
	}
	day := func(m time.Month, d int) occ {
		return occ{title: "Review", start: date(2026, m, d, 0, 0), end: date(2026, m, d+1, 0, 0), rid: ptr(date(2026, m, d, 0, 0)), allDay: true}
	}
	for _, c := range []struct {
		name    string
		series  []string
		rid     time.Time
		allDay  bool
		start   time.Time
		dtstart string
		events  []occ
	}{
		{
			name: "made all-day", series: reviewSeries("FREQ=WEEKLY"), rid: date(2026, 11, 10, 9, 0),
			allDay: true, start: date(2026, 11, 10, 0, 0), dtstart: "DTSTART;VALUE=DATE:20261010",
			events: []occ{day(10, 10), day(11, 10)},
		},
		{
			name: "all-day", series: allDaySeries, rid: date(2026, 11, 10, 0, 0),
			allDay: true, start: date(2026, 11, 10, 0, 0), dtstart: "DTSTART;VALUE=DATE:20261010",
			events: []occ{day(10, 10), day(11, 10)},
		},
		{
			name: "made timed", series: allDaySeries, rid: date(2026, 11, 10, 0, 0),
			start: date(2026, 11, 10, 13, 0), dtstart: "DTSTART;TZID=Europe/Berlin:20261010T140000",
			events: seriesEvents("Review", date(2026, 10, 10, 12, 0), date(2026, 11, 10, 13, 0)),
		},
	} {
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			id := e.put(t, "work", "series.ics", c.series...)
			ev := listedAt(t, e, "work", c.rid, c.rid, c.rid.Add(time.Second))

			end := c.start.Add(time.Hour)
			if c.allDay {
				end = c.start.AddDate(0, 0, 1)
			}
			in := seriesUpdate(ev, "Review", "", c.start, end)
			in.AllDay, in.RRule = c.allDay, "FREQ=MONTHLY"
			if !c.allDay {
				in.Timezone = ptr("Europe/Berlin")
			}
			_, _, err := e.svc.UpdateEvent(t.Context(), id, ev.ETag, in)
			mustNoErr(t, err)

			wantStored(t, e, "work", "series.ics", c.dtstart, "RRULE:FREQ=MONTHLY")
			checkOccurrences(t, listed(t, e, "work", date(2026, 10, 1, 0, 0), date(2026, 11, 30, 0, 0)), c.events)
		})
	}
}

// TestUpdateSeriesNewRuleStartsAtSkippedTime checks that a changed rule
// whose first event from the series' start is at a time its zone skips
// starts there, at the series' 02:30 on the night Berlin changes to summer
// time, where the event shows at 03:30 (#8, #9, FR-17): a daily series at
// 02:30 from Monday 2027-03-22 changed to "Every week on Sunday" from its
// event of 04-04 starts on 03-28.
func TestUpdateSeriesNewRuleStartsAtSkippedTime(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	id := e.put(t, "work", "series.ics",
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20260101T000000Z", "SUMMARY:Backup",
		"DTSTART;TZID=Europe/Berlin:20270322T023000", "DTEND;TZID=Europe/Berlin:20270322T033000",
		"RRULE:FREQ=DAILY", "END:VEVENT")
	ev := listedAt(t, e, "work", date(2027, 4, 4, 0, 30), date(2027, 4, 4, 0, 30), date(2027, 4, 4, 0, 31))

	in := seriesUpdate(ev, "Backup", "", ev.Start, ev.End)
	in.RRule, in.Timezone = "FREQ=WEEKLY", ptr("Europe/Berlin")
	_, _, err := e.svc.UpdateEvent(t.Context(), id, ev.ETag, in)
	mustNoErr(t, err)

	wantStored(t, e, "work", "series.ics", "DTSTART;TZID=Europe/Berlin:20270328T023000", "RRULE:FREQ=WEEKLY")
	checkOccurrences(t, listed(t, e, "work", date(2027, 3, 20, 0, 0), date(2027, 4, 5, 0, 0)),
		seriesEvents("Backup", date(2027, 3, 28, 1, 30), date(2027, 4, 4, 0, 30)))
}

// TestUpdateSeriesNewRuleOffEditedEventMovesStart checks that a changed rule
// the edited event is no event of, as the repeat editor can build it, moves
// DTSTART to the rule's first event from where the series started, as for a
// rule the edited event is on (#11, FR-17): the weekly series from Tuesday
// 10-06 changed to "Every week on Friday" from its event of 11-10 starts on
// Friday 10-09, also from its first event, ended after 10 events, and
// all-day. The edited event is gone, and the answer is the series' next
// event, 11-13. Kept at 10-06, the start was an event off the rule, which
// Lucid listed before the Fridays and rrule-go leaves out.
func TestUpdateSeriesNewRuleOffEditedEventMovesStart(t *testing.T) {
	t.Parallel()
	allDay := []string{
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20260101T000000Z", "SUMMARY:Review",
		"DTSTART;VALUE=DATE:20261006", "DTEND;VALUE=DATE:20261007", "RRULE:FREQ=WEEKLY", "END:VEVENT",
	}
	for _, c := range []struct {
		name   string
		lines  []string
		rid    time.Time
		rule   string
		stored string
		answer time.Time // zero: not checked
	}{
		{"later", reviewSeries("FREQ=WEEKLY"), date(2026, 11, 10, 9, 0), "FREQ=WEEKLY;BYDAY=FR", "DTSTART;TZID=Europe/Berlin:20261009T100000", date(2026, 11, 13, 9, 0)},
		{"first", reviewSeries("FREQ=WEEKLY"), date(2026, 10, 6, 8, 0), "FREQ=WEEKLY;BYDAY=FR", "DTSTART;TZID=Europe/Berlin:20261009T100000", date(2026, 10, 9, 8, 0)},
		{"count", reviewSeries("FREQ=WEEKLY"), date(2026, 11, 10, 9, 0), "FREQ=WEEKLY;BYDAY=FR;COUNT=10", "DTSTART;TZID=Europe/Berlin:20261009T100000", date(2026, 11, 13, 9, 0)},
		{"all-day", allDay, date(2026, 11, 10, 0, 0), "FREQ=WEEKLY;BYDAY=FR", "DTSTART;VALUE=DATE:20261009", time.Time{}},
	} {
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			id := e.put(t, "work", "series.ics", c.lines...)
			ev := listedAt(t, e, "work", c.rid, c.rid, c.rid.Add(time.Minute))

			in := seriesUpdate(ev, "Review", "", ev.Start, ev.End)
			in.RRule, in.Timezone, in.AllDay = c.rule, ptr("Europe/Berlin"), ev.AllDay
			up, _, err := e.svc.UpdateEvent(t.Context(), id, ev.ETag, in)
			mustNoErr(t, err)

			wantStored(t, e, "work", "series.ics", c.stored, "RRULE:"+c.rule)
			if !c.answer.IsZero() && (!up.Start.Equal(c.answer) || up.RecurrenceID == nil || !up.RecurrenceID.Equal(c.answer)) {
				t.Errorf("answer at %v (recurrence ID %v); want %v", up.Start, up.RecurrenceID, c.answer)
			}
			switch c.name {
			case "later":
				checkOccurrences(t, listed(t, e, "work", date(2026, 10, 1, 0, 0), date(2026, 10, 12, 0, 0)),
					seriesEvents("Review", date(2026, 10, 9, 8, 0)))
			case "count":
				evs := listed(t, e, "work", date(2026, 10, 1, 0, 0), date(2027, 1, 1, 0, 0))
				if len(evs) != 10 || !evs[9].Start.Equal(date(2026, 12, 11, 9, 0)) {
					t.Errorf("got %d events, the last at %v; want 10 to 2026-12-11T09:00Z", len(evs), evs[len(evs)-1].Start)
				}
			}
		})
	}
}

// TestListEventsMarksOverrides checks that the event list marks every event
// an override describes, whatever it changes, also one that differs only
// invisibly, which Modified leaves out, and one whose RECURRENCE-ID the rule
// no longer has, and no event of the rule (#11, FR-17): such an event keeps
// its place when the rule changes, which the repeat editor says.
func TestListEventsMarksOverrides(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	e.put(t, "work", "series.ics", reviewSeries("FREQ=WEEKLY;BYDAY=FR",
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20260101T000000Z", "SUMMARY:Review",
		"RECURRENCE-ID;TZID=Europe/Berlin:20261110T100000",
		"DTSTART;TZID=Europe/Berlin:20261110T100000", "DTEND;TZID=Europe/Berlin:20261110T110000",
		"END:VEVENT",
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20260101T000000Z", "SUMMARY:Review", "X-PROBE:1",
		"RECURRENCE-ID;TZID=Europe/Berlin:20261113T100000",
		"DTSTART;TZID=Europe/Berlin:20261113T100000", "DTEND;TZID=Europe/Berlin:20261113T110000",
		"END:VEVENT")...)

	evs := listed(t, e, "work", date(2026, 11, 9, 0, 0), date(2026, 11, 21, 0, 0))
	checkOccurrences(t, evs, seriesEvents("Review", date(2026, 11, 10, 9, 0), date(2026, 11, 13, 9, 0), date(2026, 11, 20, 9, 0)))
	for i, want := range []bool{true, true, false} {
		if evs[i].Override != want || evs[i].Modified {
			t.Errorf("event at %v: Override %v, Modified %v; want %v, false", evs[i].Start, evs[i].Override, evs[i].Modified, want)
		}
	}
}

// TestUpdateSeriesNewRuleKeepsEditedException checks that an exception at
// the edited event stays where it is when a changed rule no longer has its
// RECURRENCE-ID, as every other exception does, while the series moves to
// the rule (#11, FR-17): "Every week on Friday" from the exception of
// Tuesday 11-10 lists it there and the series' event on Friday 11-13.
func TestUpdateSeriesNewRuleKeepsEditedException(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	id := e.put(t, "work", "series.ics", reviewSeries("FREQ=WEEKLY",
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20260101T000000Z", "SUMMARY:Review with Kim",
		"RECURRENCE-ID;TZID=Europe/Berlin:20261110T100000",
		"DTSTART;TZID=Europe/Berlin:20261110T100000", "DTEND;TZID=Europe/Berlin:20261110T110000",
		"END:VEVENT")...)
	ev := listedAt(t, e, "work", date(2026, 11, 10, 9, 0), date(2026, 11, 10, 9, 0), date(2026, 11, 10, 9, 1))

	in := seriesUpdate(ev, "Review with Kim", "", ev.Start, ev.End)
	in.RRule, in.Timezone = "FREQ=WEEKLY;BYDAY=FR", ptr("Europe/Berlin")
	_, _, err := e.svc.UpdateEvent(t.Context(), id, ev.ETag, in)
	mustNoErr(t, err)

	wantStored(t, e, "work", "series.ics", "DTSTART;TZID=Europe/Berlin:20261009T100000")
	want := slices.Concat(
		[]occ{{title: "Review with Kim", start: date(2026, 11, 10, 9, 0), end: date(2026, 11, 10, 10, 0), rid: ptr(date(2026, 11, 10, 9, 0))}},
		seriesEvents("Review", date(2026, 11, 13, 9, 0)))
	checkOccurrences(t, listed(t, e, "work", date(2026, 11, 9, 0, 0), date(2026, 11, 16, 0, 0)), want)
}

// TestUpdateSeriesNewRuleKeepsStartOffOldRule checks that a changed rule
// leaves DTSTART where the series moved it where DTSTART was no event of the
// rule before, a start set off the rule, as the repeat editor lets a new
// series start and other clients write it, and the start of a series of
// dates (FR-17): the series from Tuesday 10-06 that repeats on Fridays,
// ended after 10 events from its event of 11-13, keeps its Tuesday, which
// counts as the first of the 10, and so it does from that Tuesday. What a
// preset leaves to its start is written out as the edited event gives it, so
// it repeats on the day it named, not the start's (#11): "Every month on day
// 13" from 11-13 is BYMONTHDAY=13. Where an INTERVAL would count from
// another period than the edited event's, DTSTART goes onto the rule, and the
// start set off the rule stays as an RDATE.
func TestUpdateSeriesNewRuleKeepsStartOffOldRule(t *testing.T) {
	t.Parallel()
	fridays := reviewSeries("FREQ=WEEKLY;BYDAY=FR")
	dates := []string{
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20260101T000000Z", "SUMMARY:Review",
		"DTSTART;TZID=Europe/Berlin:20261006T100000", "DTEND;TZID=Europe/Berlin:20261006T110000",
		"RDATE;TZID=Europe/Berlin:20261113T100000", "END:VEVENT",
	}
	for _, c := range []struct {
		name     string
		lines    []string
		rid      time.Time
		rule     string
		stored   []string // with the rule written, a whole line
		from, to time.Time
		listed   []time.Time // nil: not checked
	}{
		{
			"end only", fridays, date(2026, 11, 13, 9, 0), "FREQ=WEEKLY;BYDAY=FR;COUNT=10",
			[]string{"DTSTART;TZID=Europe/Berlin:20261006T100000", "RRULE:FREQ=WEEKLY;BYDAY=FR;COUNT=10"},
			time.Time{},
			time.Time{},
			nil,
		},
		{
			"preset", fridays, date(2026, 11, 13, 9, 0), "FREQ=MONTHLY",
			[]string{"DTSTART;TZID=Europe/Berlin:20261006T100000", "RRULE:FREQ=MONTHLY;BYMONTHDAY=13"},
			date(2026, 10, 1, 0, 0), date(2027, 1, 1, 0, 0),
			[]time.Time{date(2026, 10, 6, 8, 0), date(2026, 10, 13, 8, 0), date(2026, 11, 13, 9, 0), date(2026, 12, 13, 9, 0)},
		},
		{
			"first event", fridays, date(2026, 10, 6, 8, 0), "FREQ=WEEKLY;BYDAY=MO",
			[]string{"DTSTART;TZID=Europe/Berlin:20261006T100000", "RRULE:FREQ=WEEKLY;BYDAY=MO"},
			time.Time{},
			time.Time{},
			nil,
		},
		{
			"in phase", fridays, date(2026, 11, 6, 9, 0), "FREQ=WEEKLY;INTERVAL=2",
			[]string{"DTSTART;TZID=Europe/Berlin:20261006T100000", "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=FR"},
			date(2026, 10, 1, 0, 0), date(2026, 11, 21, 0, 0),
			[]time.Time{date(2026, 10, 6, 8, 0), date(2026, 10, 9, 8, 0), date(2026, 10, 23, 8, 0), date(2026, 11, 6, 9, 0), date(2026, 11, 20, 9, 0)},
		},
		{
			"out of phase", fridays, date(2026, 11, 13, 9, 0), "FREQ=WEEKLY;INTERVAL=2",
			[]string{"DTSTART;TZID=Europe/Berlin:20261016T100000", "RDATE;TZID=Europe/Berlin:20261006T100000", "RRULE:FREQ=WEEKLY;INTERVAL=2"},
			date(2026, 10, 1, 0, 0), date(2026, 11, 14, 0, 0),
			[]time.Time{date(2026, 10, 6, 8, 0), date(2026, 10, 16, 8, 0), date(2026, 10, 30, 9, 0), date(2026, 11, 13, 9, 0)},
		},
		{
			"dates", dates, date(2026, 11, 13, 9, 0), "FREQ=WEEKLY",
			[]string{"DTSTART;TZID=Europe/Berlin:20261006T100000", "RRULE:FREQ=WEEKLY;BYDAY=FR", "RDATE;TZID=Europe/Berlin:20261113T100000"},
			time.Time{},
			time.Time{},
			nil,
		},
	} {
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			id := e.put(t, "work", "series.ics", c.lines...)
			ev := listedAt(t, e, "work", c.rid, c.rid, c.rid.Add(time.Minute))

			in := seriesUpdate(ev, "Review", "", ev.Start, ev.End)
			in.RRule, in.Timezone = c.rule, ptr("Europe/Berlin")
			_, _, err := e.svc.UpdateEvent(t.Context(), id, ev.ETag, in)
			mustNoErr(t, err)

			data := stored(t, e, "work", "series.ics")
			for _, line := range c.stored {
				if !strings.Contains(data, line+"\r\n") {
					t.Errorf("series lacks the line %q:\n%s", line, data)
				}
			}
			if c.listed != nil {
				checkOccurrences(t, listed(t, e, "work", c.from, c.to), seriesEvents("Review", c.listed...))
			}
		})
	}
}

// TestSpellOut checks the rule a series whose start was set off its old rule
// keeps it with (#11, FR-17): what the new rule leaves to its start is
// written out as the edited event gives it, where the start gives it
// otherwise, the month with the day of a yearly rule, as rrule-go and RFC
// 5545 take the month from the start only without a day; parts the rule
// names itself, and a rule Lucid cannot read, stay as they are.
func TestSpellOut(t *testing.T) {
	t.Parallel()
	start := atWall(date(2026, 10, 6, 10, 0), time.UTC)
	day := func(t time.Time) dateValue { return dateValue{t: t, wall: t, allDay: true} }
	for _, c := range []struct {
		name, rule    string
		start, edited dateValue
		want          string
	}{
		{"weekly", "FREQ=WEEKLY", start, atWall(date(2026, 11, 13, 10, 0), time.UTC), "FREQ=WEEKLY;BYDAY=FR"},
		{"weekly with a count", "FREQ=WEEKLY;COUNT=5", start, atWall(date(2026, 11, 13, 10, 0), time.UTC), "FREQ=WEEKLY;COUNT=5;BYDAY=FR"},
		{"monthly", "FREQ=MONTHLY", start, atWall(date(2026, 11, 13, 10, 0), time.UTC), "FREQ=MONTHLY;BYMONTHDAY=13"},
		{"yearly", "FREQ=YEARLY", start, atWall(date(2027, 11, 13, 10, 0), time.UTC), "FREQ=YEARLY;BYMONTH=11;BYMONTHDAY=13"},
		{"yearly in another month", "FREQ=YEARLY", start, atWall(date(2027, 3, 6, 10, 0), time.UTC), "FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=6"},
		{"yearly in its own months", "FREQ=YEARLY;BYMONTH=3,6", start, atWall(date(2027, 3, 13, 10, 0), time.UTC), "FREQ=YEARLY;BYMONTH=3,6;BYMONTHDAY=13"},
		{"at another time", "FREQ=DAILY", start, atWall(date(2026, 11, 13, 14, 30), time.UTC), "FREQ=DAILY;BYHOUR=14;BYMINUTE=30"},
		{"daily", "FREQ=DAILY", start, atWall(date(2026, 11, 13, 10, 0), time.UTC), "FREQ=DAILY"},
		{"on the start's weekday", "FREQ=WEEKLY", start, atWall(date(2026, 11, 10, 10, 0), time.UTC), "FREQ=WEEKLY"},
		{"with its own days", "FREQ=WEEKLY;BYDAY=MO", start, atWall(date(2026, 11, 13, 10, 0), time.UTC), "FREQ=WEEKLY;BYDAY=MO"},
		{"unreadable", "FREQ=SOMETIMES", start, atWall(date(2026, 11, 13, 10, 0), time.UTC), "FREQ=SOMETIMES"},
		{"all-day", "FREQ=WEEKLY", day(date(2026, 10, 6, 0, 0)), day(date(2026, 11, 13, 0, 0)), "FREQ=WEEKLY;BYDAY=FR"},
	} {
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			if got := spellOut(c.rule, c.start, c.edited); got != c.want {
				t.Errorf("spellOut(%q, %v, %v) = %q; want %q", c.rule, c.start.t, c.edited.t, got, c.want)
			}
		})
	}
}

// TestInPhase checks whether a start counts a rule's INTERVAL in the edited
// event's periods (#11, FR-17): a whole number of intervals of years,
// months, weeks from the rule's WKST, days or hours apart; always for an
// INTERVAL of 1 and a rule Lucid cannot read.
func TestInPhase(t *testing.T) {
	t.Parallel()
	start := atWall(date(2026, 10, 6, 10, 0), time.UTC) // a Tuesday
	for _, c := range []struct {
		rule   string
		edited time.Time
		want   bool
	}{
		{"FREQ=WEEKLY;INTERVAL=2", date(2026, 11, 6, 10, 0), true},
		{"FREQ=WEEKLY;INTERVAL=2", date(2026, 11, 13, 10, 0), false},
		{"FREQ=WEEKLY;INTERVAL=2", date(2026, 10, 11, 10, 0), true},
		{"FREQ=WEEKLY;INTERVAL=2;WKST=SU", date(2026, 10, 11, 10, 0), false},
		{"FREQ=MONTHLY;INTERVAL=3", date(2027, 1, 13, 10, 0), true},
		{"FREQ=MONTHLY;INTERVAL=3", date(2026, 12, 13, 10, 0), false},
		{"FREQ=YEARLY;INTERVAL=2", date(2028, 3, 1, 10, 0), true},
		{"FREQ=YEARLY;INTERVAL=2", date(2027, 3, 1, 10, 0), false},
		{"FREQ=DAILY;INTERVAL=3", date(2026, 10, 9, 10, 0), true},
		{"FREQ=DAILY;INTERVAL=3", date(2026, 10, 10, 10, 0), false},
		{"FREQ=HOURLY;INTERVAL=5", date(2026, 10, 7, 11, 0), true},
		{"FREQ=HOURLY;INTERVAL=5", date(2026, 10, 7, 12, 0), false},
		{"FREQ=WEEKLY", date(2026, 11, 13, 10, 0), true},
		{"FREQ=SOMETIMES", date(2026, 11, 13, 10, 0), true},
	} {
		t.Run(c.rule+" "+c.edited.Format("2006-01-02T15"), func(t *testing.T) {
			t.Parallel()
			if got := inPhase(c.rule, start, atWall(c.edited, time.UTC)); got != c.want {
				t.Errorf("inPhase(%q, %v, %v) = %v; want %v", c.rule, start.t, c.edited, got, c.want)
			}
		})
	}
}

// TestStartsOnRule checks whether a series' DTSTART is an event of its rule
// (#9, FR-17): a rule that leaves its days and times to DTSTART always has
// it; one with other days, hours or minutes, or none Lucid can read, not.
func TestStartsOnRule(t *testing.T) {
	t.Parallel()
	tuesday := atWall(date(2026, 10, 6, 10, 0), time.UTC)
	for _, c := range []struct {
		rule string
		want bool
	}{
		{"FREQ=MONTHLY", true},
		{"FREQ=WEEKLY;BYDAY=TU,TH", true},
		{"FREQ=WEEKLY;BYDAY=FR", false},
		{"FREQ=DAILY;BYHOUR=9", false},
		// rrule-go would look for 09:00 among 10:00, 14:00, 18:00, ... forever.
		{"FREQ=HOURLY;INTERVAL=4;BYHOUR=9", false},
		{"FREQ=WEEKLY;UNTIL=20261001T000000Z", true},
		{"", false},
		{"FREQ=MONTHLY;BYMONTH=13", false},
	} {
		t.Run(c.rule, func(t *testing.T) {
			t.Parallel()
			if got := startsOnRule(c.rule, tuesday); got != c.want {
				t.Errorf("startsOnRule(%q, %v) = %v; want %v", c.rule, tuesday.t, got, c.want)
			}
		})
	}
}

// TestStartOnRule checks where a series whose rule changes from its event
// edited starts, once moved to start (#9, #11, FR-17): at the rule's first
// event from start on, or from edited where it lies before start, read at
// edited, of every frequency, with its INTERVAL counted in edited's periods,
// also where the week starts on another day, with the parts it gives itself,
// and for a rule edited is no event of; at start for one Lucid cannot read
// and for one whose UNTIL comes before that event.
func TestStartOnRule(t *testing.T) {
	t.Parallel()
	tuesday := date(2026, 10, 6, 10, 0)
	for _, c := range []struct {
		name, rule string
		edited     time.Time
		want       time.Time
		start      time.Time // Tuesday 2026-10-06 at 10:00 if zero
	}{
		{"every three days", "FREQ=DAILY;INTERVAL=3", date(2026, 10, 20, 10, 0), date(2026, 10, 8, 10, 0), time.Time{}},
		{"daily at another time", "FREQ=DAILY", date(2026, 10, 20, 14, 0), date(2026, 10, 6, 14, 0), time.Time{}},
		{"daily at its own hours", "FREQ=DAILY;BYHOUR=9,17", date(2026, 10, 8, 17, 0), date(2026, 10, 6, 17, 0), time.Time{}},
		{"every five hours", "FREQ=HOURLY;INTERVAL=5", date(2026, 10, 7, 9, 30), date(2026, 10, 6, 13, 30), time.Time{}},
		{
			"every seven minutes", "FREQ=MINUTELY;INTERVAL=7", date(2026, 10, 6, 10, 30).Add(20 * time.Second),
			date(2026, 10, 6, 10, 2).Add(20 * time.Second),
			time.Time{},
		},
		{
			"every thirteen seconds", "FREQ=SECONDLY;INTERVAL=13", date(2026, 10, 6, 10, 1),
			date(2026, 10, 6, 10, 0).Add(8 * time.Second),
			time.Time{},
		},
		{"every other week from Sunday", "FREQ=WEEKLY;INTERVAL=2;WKST=SU;BYDAY=SU,TU", date(2026, 11, 15, 10, 0), date(2026, 10, 6, 10, 0), time.Time{}},
		{"every other week from Monday", "FREQ=WEEKLY;INTERVAL=2;WKST=MO;BYDAY=SU,TU", date(2026, 11, 15, 10, 0), date(2026, 10, 13, 10, 0), time.Time{}},
		{"every three months", "FREQ=MONTHLY;INTERVAL=3", date(2027, 2, 10, 10, 0), date(2026, 11, 10, 10, 0), time.Time{}},
		{"every other year", "FREQ=YEARLY;INTERVAL=2", date(2029, 11, 10, 10, 0), date(2027, 11, 10, 10, 0), time.Time{}},
		{"yearly in its own months", "FREQ=YEARLY;BYMONTH=3,6", date(2027, 6, 10, 10, 0), date(2027, 3, 10, 10, 0), time.Time{}},
		{"an end before the edited event", "FREQ=WEEKLY;INTERVAL=2;UNTIL=20261101T000000Z", date(2026, 11, 10, 10, 0), date(2026, 10, 13, 10, 0), time.Time{}},
		// The second of Monday, Wednesday and Friday in each whole week: rrule-go
		// counts only the days from DTSTART on in DTSTART's week.
		{
			"by position in the week", "FREQ=WEEKLY;WKST=SU;BYDAY=MO,WE,FR;BYSETPOS=2", date(2026, 11, 11, 10, 0),
			date(2026, 10, 14, 10, 0), date(2026, 10, 8, 10, 0),
		},
		{"the last day of the month", "FREQ=MONTHLY;BYMONTHDAY=-1", date(2026, 11, 30, 10, 0), date(2026, 10, 31, 10, 0), time.Time{}},
		{"the 31st", "FREQ=MONTHLY", date(2026, 12, 31, 10, 0), date(2026, 10, 31, 10, 0), time.Time{}},
		{"February 29", "FREQ=YEARLY", date(2028, 2, 29, 10, 0), date(2028, 2, 29, 10, 0), time.Time{}},
		{"from the series' start", "FREQ=MONTHLY", tuesday, tuesday, time.Time{}},
		{"off the rule", "FREQ=WEEKLY;BYDAY=FR", date(2026, 11, 10, 10, 0), date(2026, 10, 9, 10, 0), time.Time{}},
		{"from the series' start off the rule", "FREQ=WEEKLY;BYDAY=FR", tuesday, date(2026, 10, 9, 10, 0), time.Time{}},
		// "This and following" from an RDATE: the new series starts after it (#11).
		{"edited before the start", "FREQ=WEEKLY;BYDAY=FR", date(2026, 10, 1, 10, 0), date(2026, 10, 2, 10, 0), time.Time{}},
		{"an end before its first event", "FREQ=WEEKLY;BYDAY=FR;UNTIL=20261007T000000Z", tuesday, tuesday, time.Time{}},
		// rrule-go would look for 09:00 among 02:00, 06:00, 10:00, ... forever.
		{"hours off the rule", "FREQ=HOURLY;INTERVAL=4;BYHOUR=9", date(2026, 10, 7, 10, 0), tuesday, time.Time{}},
		{"minutes off the rule", "FREQ=MINUTELY;INTERVAL=15;BYMINUTE=0", date(2026, 10, 6, 11, 5), tuesday, time.Time{}},
		{"seconds off the rule", "FREQ=SECONDLY;INTERVAL=2;BYSECOND=1", date(2026, 10, 6, 10, 1), tuesday, time.Time{}},
		{"unreadable", "FREQ=SOMETIMES", date(2026, 11, 10, 10, 0), tuesday, time.Time{}},
		{"out of range", "FREQ=MONTHLY;BYMONTH=13", date(2026, 11, 10, 10, 0), tuesday, time.Time{}},
	} {
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			start := cmp.Or(c.start, tuesday)
			got := startOnRule(c.rule, atWall(start, time.UTC), atWall(c.edited, time.UTC))
			if !got.t.Equal(c.want) || !got.wall.Equal(c.want) {
				t.Errorf("startOnRule(%q, %v, %v) = %v (wall %v); want %v", c.rule, start, c.edited, got.t, got.wall, c.want)
			}
		})
	}
}

// TestUpdateSeriesNewRuleIntoAnotherZone is the reproduction of issue #5 as
// a regression test: a changed rule moves a New York series on Tuesday and
// Thursday at 18:00, from 2026-03-17, into Berlin from its event on
// Wednesday 11-11 at 00:00 Berlin time, where it shows, on the days that
// event is on there. DTSTART takes the event's place in Berlin, the
// Wednesday at 00:00, and the references take Berlin's TZID and stay with
// their events. DTSTART kept as an instant went to Tuesday 23:00 Berlin
// time, as New York changes to summer time weeks before Berlin, and moved
// every event to 23:00; the references stayed in New York's TZID, so the
// deleted event came back (FR-17, FR-18).
func TestUpdateSeriesNewRuleIntoAnotherZone(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	id := e.put(t, "work", "series.ics",
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20260101T000000Z", "SUMMARY:Call",
		"DTSTART;TZID=America/New_York:20260317T180000", "DTEND;TZID=America/New_York:20260317T190000",
		"RRULE:FREQ=WEEKLY;BYDAY=TU,TH", "EXDATE;TZID=America/New_York:20260319T180000",
		"RDATE;TZID=America/New_York:20261121T180000",
		"END:VEVENT",
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20260101T000000Z", "SUMMARY:Special",
		"RECURRENCE-ID;TZID=America/New_York:20261112T180000",
		"DTSTART;TZID=America/New_York:20261112T120000", "DTEND;TZID=America/New_York:20261112T130000",
		"END:VEVENT")
	evs := listed(t, e, "work", date(2026, 11, 10, 0, 0), date(2026, 11, 11, 0, 0))
	if len(evs) != 1 {
		t.Fatalf("got %d events on 2026-11-10; want 1", len(evs))
	}

	in := seriesUpdate(evs[0], "Call", "", date(2026, 11, 10, 23, 0), date(2026, 11, 11, 0, 0))
	in.RRule, in.Timezone = "FREQ=WEEKLY;INTERVAL=2;BYDAY=WE,FR", ptr("Europe/Berlin")
	up, _, err := e.svc.UpdateEvent(t.Context(), id, evs[0].ETag, in)
	mustNoErr(t, err)

	checkStored(t, "series", stored(t, e, "work", "series.ics"), []string{
		"DTSTART;TZID=Europe/Berlin:20260318T000000", "DTEND;TZID=Europe/Berlin:20260318T010000",
		"EXDATE;TZID=Europe/Berlin:20260320T000000", "RDATE;TZID=Europe/Berlin:20261122T000000",
		"RECURRENCE-ID;TZID=Europe/Berlin:20261113T000000",
		// The exception keeps its own times.
		"DTSTART;TZID=America/New_York:20261112T120000",
	}, []string{"EXDATE;TZID=America/New_York", "RDATE;TZID=America/New_York", "RECURRENCE-ID;TZID=America/New_York"})
	// The answer says what the list shows.
	edited := occ{title: "Call", start: date(2026, 11, 10, 23, 0), end: date(2026, 11, 11, 0, 0), rid: ptr(date(2026, 11, 10, 23, 0))}
	checkOccurrences(t, []domain.Event{up}, []occ{edited})
	checkOccurrences(t, listed(t, e, "work", date(2026, 11, 9, 0, 0), date(2026, 11, 24, 0, 0)), []occ{
		edited,
		{title: "Special", start: date(2026, 11, 12, 17, 0), end: date(2026, 11, 12, 18, 0), rid: ptr(date(2026, 11, 12, 23, 0))},
		{title: "Call", start: date(2026, 11, 21, 23, 0), end: date(2026, 11, 22, 0, 0), rid: ptr(date(2026, 11, 21, 23, 0))},
	})
	// Wednesday 03-18 at 00:00 Berlin time; Friday's event stays deleted.
	checkOccurrences(t, listed(t, e, "work", date(2026, 3, 16, 0, 0), date(2026, 3, 24, 0, 0)), []occ{
		{title: "Call", start: date(2026, 3, 17, 23, 0), end: date(2026, 3, 18, 0, 0), rid: ptr(date(2026, 3, 17, 23, 0))},
	})
}

// nySeries is the New York series on Tuesday and Thursday at 18:00 from
// 2026-03-17 of TestUpdateSeriesNewRuleIntoAnotherZone, a day later in
// Berlin from April to 10-24, then the same day until 10-31, when New York
// changes back from summer time a week after Berlin, with extra lines in its
// VEVENT and the VEVENTs of exceptions after it.
func nySeries(extra []string, exceptions ...string) []string {
	return slices.Concat([]string{
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20260101T000000Z", "SUMMARY:Call",
		"DTSTART;TZID=America/New_York:20260317T180000", "DTEND;TZID=America/New_York:20260317T190000",
		"RRULE:FREQ=WEEKLY;BYDAY=TU,TH",
	}, extra, []string{"END:VEVENT"}, exceptions)
}

// TestUpdateSeriesNewRuleIntoAnotherZoneMoved checks that a changed rule
// from an event moved on Berlin's clock into another week where the two
// zones are another hour apart puts it where it was entered, Tuesday 11-03
// at 23:00, and the series with it: read where the event was in the rule,
// 10-27, the series would go an hour earlier (issue #5, FR-17, FR-18).
func TestUpdateSeriesNewRuleIntoAnotherZoneMoved(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	id := e.put(t, "work", "series.ics", nySeries(nil)...)
	evs := listed(t, e, "work", date(2026, 10, 27, 0, 0), date(2026, 10, 28, 0, 0))
	if len(evs) != 1 {
		t.Fatalf("got %d events on 2026-10-27; want 1", len(evs))
	}

	in := seriesUpdate(evs[0], "Call", "", date(2026, 11, 3, 22, 0), date(2026, 11, 3, 23, 0))
	in.RRule, in.Timezone = "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH", ptr("Europe/Berlin")
	up, _, err := e.svc.UpdateEvent(t.Context(), id, evs[0].ETag, in)
	mustNoErr(t, err)

	wantStored(t, e, "work", "series.ics", "DTSTART;TZID=Europe/Berlin:20260324T230000")
	edited := occ{title: "Call", start: date(2026, 11, 3, 22, 0), end: date(2026, 11, 3, 23, 0), rid: ptr(date(2026, 11, 3, 22, 0))}
	checkOccurrences(t, []domain.Event{up}, []occ{edited})
	checkOccurrences(t, listed(t, e, "work", date(2026, 11, 2, 0, 0), date(2026, 11, 9, 0, 0)), []occ{
		edited,
		{title: "Call", start: date(2026, 11, 5, 22, 0), end: date(2026, 11, 5, 23, 0), rid: ptr(date(2026, 11, 5, 22, 0))},
	})
}

// TestUpdateSeriesNewRuleIntoAnotherZoneFromException checks that a changed
// rule from an exception moved into another week where the two zones are
// another hour apart reads the series where the exception is in the rule,
// as the editor reads the rule there: its 10-29 event, Thursday 23:00 in
// Berlin, moved to Sunday 11-01 at 16:00. Read where the exception shows,
// DTSTART went to Wednesday at 00:00, off the rule the editor showed, every
// event to 00:00, and the exception's RECURRENCE-ID onto a Friday, which
// orphaned it (issue #5, FR-17, FR-18).
func TestUpdateSeriesNewRuleIntoAnotherZoneFromException(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	id := e.put(t, "work", "series.ics", nySeries(nil,
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20260101T000000Z", "SUMMARY:Moved",
		"RECURRENCE-ID;TZID=America/New_York:20261029T180000",
		"DTSTART;TZID=America/New_York:20261101T100000", "DTEND;TZID=America/New_York:20261101T110000",
		"END:VEVENT")...)
	evs := listed(t, e, "work", date(2026, 11, 1, 0, 0), date(2026, 11, 2, 0, 0))
	if len(evs) != 1 {
		t.Fatalf("got %d events on 2026-11-01; want 1", len(evs))
	}

	in := seriesUpdate(evs[0], "Moved", "", evs[0].Start, evs[0].End)
	in.RRule, in.Timezone = "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH", ptr("Europe/Berlin")
	_, _, err := e.svc.UpdateEvent(t.Context(), id, evs[0].ETag, in)
	mustNoErr(t, err)

	checkStored(t, "series", stored(t, e, "work", "series.ics"), []string{
		"DTSTART;TZID=Europe/Berlin:20260317T230000", "DTEND;TZID=Europe/Berlin:20260318T000000",
		"RECURRENCE-ID;TZID=Europe/Berlin:20261029T230000",
	}, []string{"RECURRENCE-ID;TZID=America/New_York"})
	checkOccurrences(t, listed(t, e, "work", date(2026, 3, 16, 0, 0), date(2026, 3, 21, 0, 0)), []occ{
		{title: "Call", start: date(2026, 3, 17, 22, 0), end: date(2026, 3, 17, 23, 0), rid: ptr(date(2026, 3, 17, 22, 0))},
		{title: "Call", start: date(2026, 3, 19, 22, 0), end: date(2026, 3, 19, 23, 0), rid: ptr(date(2026, 3, 19, 22, 0))},
	})
	checkOccurrences(t, listed(t, e, "work", date(2026, 10, 26, 0, 0), date(2026, 11, 2, 0, 0)), []occ{
		{title: "Call", start: date(2026, 10, 27, 22, 0), end: date(2026, 10, 27, 23, 0), rid: ptr(date(2026, 10, 27, 22, 0))},
		{title: "Moved", start: date(2026, 11, 1, 15, 0), end: date(2026, 11, 1, 16, 0), rid: ptr(date(2026, 10, 29, 22, 0))},
	})
}

// TestUpdateSeriesNewRuleWithoutZone checks that a changed rule moves a
// series without a zone, from another app, into the browser's zone at the
// time its edited event shows there in January, also in summer, and with
// its deleted events: a Monday series at 08:00 UTC from July. Into Berlin,
// DTSTART kept as an instant went to 10:00 summer time, which put the
// January events at 10:00, and the January EXDATE, kept in UTC, then
// matched none of them. Into UTC, a floating EXDATE stayed floating next to
// a DTSTART in UTC (issue #5, FR-17, FR-18).
func TestUpdateSeriesNewRuleWithoutZone(t *testing.T) {
	t.Parallel()
	for _, form := range []struct {
		name string
		prop func(name, value string) string // the date property name with value in this form
	}{
		{"utc", func(name, v string) string { return name + ":" + v + "Z" }},
		{"floating", func(name, v string) string { return name + ":" + v }},
		{"unknown tzid", func(name, v string) string { return name + ";TZID=Nowhere/Land:" + v }},
	} {
		for _, zone := range []struct {
			name        string
			want, lacks []string // in the series as stored
			hour        int      // the hour of the July events, in UTC
		}{
			{"Europe/Berlin", []string{
				"DTSTART;TZID=Europe/Berlin:20260706T090000", "DTEND;TZID=Europe/Berlin:20260706T093000",
				"EXDATE;TZID=Europe/Berlin:20260713T090000", "EXDATE;TZID=Europe/Berlin:20270111T090000",
			}, []string{"EXDATE:", "Nowhere/Land"}, 7},
			{"UTC", []string{
				"DTSTART:20260706T080000Z", "DTEND:20260706T083000Z", "EXDATE:20260713T080000Z", "EXDATE:20270111T080000Z",
			}, []string{"EXDATE;", "T080000\r\n", "Nowhere/Land"}, 8},
		} {
			t.Run(form.name+" into "+zone.name, func(t *testing.T) {
				t.Parallel()
				e := newEnv(t, caldavtest.Options{})
				id := e.put(t, "work", "series.ics",
					"BEGIN:VEVENT", "UID:series", "DTSTAMP:20260101T000000Z", "SUMMARY:Sync",
					form.prop("DTSTART", "20260706T080000"), form.prop("DTEND", "20260706T083000"),
					"RRULE:FREQ=WEEKLY;BYDAY=MO",
					form.prop("EXDATE", "20260713T080000"), form.prop("EXDATE", "20270111T080000"),
					"END:VEVENT")
				evs := listed(t, e, "work", date(2027, 1, 18, 0, 0), date(2027, 1, 19, 0, 0))
				if len(evs) != 1 {
					t.Fatalf("got %d events on 2027-01-18; want 1", len(evs))
				}

				in := seriesUpdate(evs[0], "Sync", "", date(2027, 1, 18, 8, 0), date(2027, 1, 18, 8, 30))
				in.RRule, in.Timezone = "FREQ=WEEKLY;BYDAY=MO,TH", ptr(zone.name)
				_, _, err := e.svc.UpdateEvent(t.Context(), id, evs[0].ETag, in)
				mustNoErr(t, err)

				checkStored(t, "series", stored(t, e, "work", "series.ics"), zone.want, zone.lacks)
				h := zone.hour
				checkOccurrences(t, listed(t, e, "work", date(2026, 7, 6, 0, 0), date(2026, 7, 17, 0, 0)), []occ{
					{title: "Sync", start: date(2026, 7, 6, h, 0), end: date(2026, 7, 6, h, 30), rid: ptr(date(2026, 7, 6, h, 0))},
					{title: "Sync", start: date(2026, 7, 9, h, 0), end: date(2026, 7, 9, h, 30), rid: ptr(date(2026, 7, 9, h, 0))},
					{title: "Sync", start: date(2026, 7, 16, h, 0), end: date(2026, 7, 16, h, 30), rid: ptr(date(2026, 7, 16, h, 0))},
				})
				checkOccurrences(t, listed(t, e, "work", date(2027, 1, 11, 0, 0), date(2027, 1, 19, 0, 0)), []occ{
					{title: "Sync", start: date(2027, 1, 14, 8, 0), end: date(2027, 1, 14, 8, 30), rid: ptr(date(2027, 1, 14, 8, 0))},
					{title: "Sync", start: date(2027, 1, 18, 8, 0), end: date(2027, 1, 18, 8, 30), rid: ptr(date(2027, 1, 18, 8, 0))},
				})
			})
		}
	}
}

// TestUpdateSeriesNewRuleIntoUTC checks that a changed rule from a browser
// in UTC moves a Berlin series into UTC by date, at 08:00 as its January
// event shows there, with its references in UTC, and leaves a DATE and a
// PERIOD, which Lucid does not carry, as they are (issue #5, FR-17, FR-18).
func TestUpdateSeriesNewRuleIntoUTC(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	id := e.put(t, "work", "series.ics",
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20260101T000000Z", "SUMMARY:Sync",
		"DTSTART;TZID=Europe/Berlin:20260706T090000", "DTEND;TZID=Europe/Berlin:20260706T093000",
		"RRULE:FREQ=WEEKLY;BYDAY=MO", "EXDATE:20260713T070000Z", "EXDATE;VALUE=DATE:20260720",
		"RDATE;VALUE=PERIOD;TZID=Europe/Berlin:20261121T090000/PT1H",
		"END:VEVENT",
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20260101T000000Z", "SUMMARY:Special",
		"RECURRENCE-ID;TZID=Europe/Berlin:20261102T090000",
		"DTSTART;TZID=Europe/Berlin:20261102T120000", "DTEND;TZID=Europe/Berlin:20261102T123000",
		"END:VEVENT")
	evs := listed(t, e, "work", date(2027, 1, 18, 0, 0), date(2027, 1, 19, 0, 0))
	if len(evs) != 1 {
		t.Fatalf("got %d events on 2027-01-18; want 1", len(evs))
	}

	in := seriesUpdate(evs[0], "Sync", "", date(2027, 1, 18, 8, 0), date(2027, 1, 18, 8, 30))
	in.RRule, in.Timezone = "FREQ=WEEKLY;BYDAY=MO,TH", ptr("UTC")
	_, _, err := e.svc.UpdateEvent(t.Context(), id, evs[0].ETag, in)
	mustNoErr(t, err)

	checkStored(t, "series", stored(t, e, "work", "series.ics"), []string{
		"DTSTART:20260706T080000Z", "DTEND:20260706T083000Z", "EXDATE:20260713T080000Z",
		"RECURRENCE-ID:20261102T080000Z", "EXDATE;VALUE=DATE:20260720\r\n",
		"RDATE;TZID=Europe/Berlin;VALUE=PERIOD:20261121T090000/PT1H",
	}, []string{"EXDATE:20260713T070000Z", "RECURRENCE-ID;TZID=Europe/Berlin"})
	checkOccurrences(t, listed(t, e, "work", date(2026, 7, 6, 0, 0), date(2026, 7, 17, 0, 0)), []occ{
		{title: "Sync", start: date(2026, 7, 6, 8, 0), end: date(2026, 7, 6, 8, 30), rid: ptr(date(2026, 7, 6, 8, 0))},
		{title: "Sync", start: date(2026, 7, 9, 8, 0), end: date(2026, 7, 9, 8, 30), rid: ptr(date(2026, 7, 9, 8, 0))},
		{title: "Sync", start: date(2026, 7, 16, 8, 0), end: date(2026, 7, 16, 8, 30), rid: ptr(date(2026, 7, 16, 8, 0))},
	})
	checkOccurrences(t, listed(t, e, "work", date(2026, 11, 2, 0, 0), date(2026, 11, 3, 0, 0)), []occ{
		{title: "Special", start: date(2026, 11, 2, 11, 0), end: date(2026, 11, 2, 11, 30), rid: ptr(date(2026, 11, 2, 8, 0))},
	})
}

// TestUpdateSeriesMadeAllDayKeepsRefs checks that turning a series all-day
// leaves its references in their own zone, also where the request names
// another, which an all-day series has no use for: they keep their value
// type and move by the shift, see docs/RECURRING-EVENTS.md, Limits (FR-17).
func TestUpdateSeriesMadeAllDayKeepsRefs(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	id := e.put(t, "work", "series.ics",
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Review",
		"DTSTART;TZID=Europe/Berlin:20260904T090000", "DTEND;TZID=Europe/Berlin:20260904T100000",
		"RRULE:FREQ=WEEKLY", "EXDATE;TZID=Europe/Berlin:20260911T090000",
		"END:VEVENT")
	evs := listed(t, e, "work", date(2026, 11, 6, 0, 0), date(2026, 11, 7, 0, 0))
	if len(evs) != 1 {
		t.Fatalf("got %d events on 2026-11-06; want 1", len(evs))
	}

	in := seriesUpdate(evs[0], "Review", "", date(2026, 11, 6, 0, 0), date(2026, 11, 7, 0, 0))
	in.AllDay, in.Timezone = true, ptr("America/New_York")
	_, _, err := e.svc.UpdateEvent(t.Context(), id, evs[0].ETag, in)
	mustNoErr(t, err)

	checkStored(t, "series", stored(t, e, "work", "series.ics"),
		[]string{"DTSTART;VALUE=DATE:20260904", "EXDATE;TZID=Europe/Berlin:20260911T"}, []string{"America/New_York"})
}

// TestUpdateSeriesAllDay checks that "all events" moves an all-day series,
// with its DATE values EXDATE and UNTIL, by whole days (spec section 3 items
// 2 and 8, FR-17).
func TestUpdateSeriesAllDay(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	id := e.put(t, "work", "series.ics",
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Gym",
		"DTSTART;VALUE=DATE:20260102", "DTEND;VALUE=DATE:20260103",
		"RRULE:FREQ=WEEKLY;BYDAY=FR;UNTIL=20260410", "EXDATE;VALUE=DATE:20260320",
		"END:VEVENT")
	evs := listed(t, e, "work", date(2026, 3, 27, 0, 0), date(2026, 3, 28, 0, 0))
	if len(evs) != 1 {
		t.Fatalf("got %d events on 2026-03-27; want 1", len(evs))
	}

	in := seriesUpdate(evs[0], "Gym", "", date(2026, 3, 30, 0, 0), date(2026, 3, 31, 0, 0))
	in.AllDay = true
	up, _, err := e.svc.UpdateEvent(t.Context(), id, evs[0].ETag, in)
	mustNoErr(t, err)
	checkOccurrences(t, []domain.Event{up}, []occ{
		{title: "Gym", start: date(2026, 3, 30, 0, 0), end: date(2026, 3, 31, 0, 0), rid: ptr(date(2026, 3, 30, 0, 0)), allDay: true},
	})

	wantStored(t, e, "work", "series.ics",
		"RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260413", "DTSTART;VALUE=DATE:20260105", "DTEND;VALUE=DATE:20260106",
		"EXDATE;VALUE=DATE:20260323")
	checkOccurrences(t, listed(t, e, "work", date(2026, 3, 14, 0, 0), date(2026, 4, 30, 0, 0)), []occ{
		{title: "Gym", start: date(2026, 3, 16, 0, 0), end: date(2026, 3, 17, 0, 0), rid: ptr(date(2026, 3, 16, 0, 0)), allDay: true},
		{title: "Gym", start: date(2026, 3, 30, 0, 0), end: date(2026, 3, 31, 0, 0), rid: ptr(date(2026, 3, 30, 0, 0)), allDay: true},
		{title: "Gym", start: date(2026, 4, 6, 0, 0), end: date(2026, 4, 7, 0, 0), rid: ptr(date(2026, 4, 6, 0, 0)), allDay: true},
		{title: "Gym", start: date(2026, 4, 13, 0, 0), end: date(2026, 4, 14, 0, 0), rid: ptr(date(2026, 4, 13, 0, 0)), allDay: true},
	})
}

// TestUpdateSeriesDateUntil checks that "all events" moves the DATE UNTIL of
// a timed series, as some clients write it, by the days of the move only,
// also across a daylight-saving change (spec section 3 item 8, FR-17).
func TestUpdateSeriesDateUntil(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	id := e.put(t, "work", "series.ics",
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Review",
		"DTSTART;TZID=Europe/Berlin:20260102T090000", "DTEND;TZID=Europe/Berlin:20260102T093000",
		"RRULE:FREQ=WEEKLY;BYDAY=FR;UNTIL=20260410",
		"END:VEVENT")
	evs := listed(t, e, "work", date(2026, 3, 27, 0, 0), date(2026, 3, 28, 0, 0))
	if len(evs) != 1 {
		t.Fatalf("got %d events on 2026-03-27; want 1", len(evs))
	}

	_, _, err := e.svc.UpdateEvent(t.Context(), id, evs[0].ETag,
		seriesUpdate(evs[0], "Review", "", date(2026, 3, 30, 7, 0), date(2026, 3, 30, 7, 30)))
	mustNoErr(t, err)

	wantStored(t, e, "work", "series.ics", "RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260413")
}

// TestUpdateSeriesMonthlyKeepsDayOfMonth checks that "all events" moves a
// monthly series without BY parts, and its references, by calendar months
// and days, so that each keeps its day of the month: from the 03-30 event to
// 04-02, the 30th becomes the 2nd in every month. Counted in days, the
// override's RECURRENCE-ID 06-30 went to 07-03 and was orphaned next to the
// plain 07-02 event it replaces (spec section 3 item 2, FR-17).
func TestUpdateSeriesMonthlyKeepsDayOfMonth(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	id := e.put(t, "work", "series.ics",
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Rent",
		"DTSTART;TZID=Europe/Berlin:20260130T090000", "DTEND;TZID=Europe/Berlin:20260130T100000",
		"RRULE:FREQ=MONTHLY", "EXDATE;TZID=Europe/Berlin:20260530T090000",
		"END:VEVENT",
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Special",
		"RECURRENCE-ID;TZID=Europe/Berlin:20260630T090000",
		"DTSTART;TZID=Europe/Berlin:20260630T150000", "DTEND;TZID=Europe/Berlin:20260630T160000",
		"END:VEVENT")
	evs := listed(t, e, "work", date(2026, 3, 30, 0, 0), date(2026, 3, 31, 0, 0))
	if len(evs) != 1 {
		t.Fatalf("got %d events on 2026-03-30; want 1", len(evs))
	}

	up, _, err := e.svc.UpdateEvent(t.Context(), id, evs[0].ETag,
		seriesUpdate(evs[0], "Rent", "", date(2026, 4, 2, 7, 0), date(2026, 4, 2, 8, 0)))
	mustNoErr(t, err)
	checkOccurrences(t, []domain.Event{up}, []occ{
		{title: "Rent", start: date(2026, 4, 2, 7, 0), end: date(2026, 4, 2, 8, 0), rid: ptr(date(2026, 4, 2, 7, 0))},
	})

	wantStored(t, e, "work", "series.ics",
		"RRULE:FREQ=MONTHLY", "DTSTART;TZID=Europe/Berlin:20260202T090000", "DTEND;TZID=Europe/Berlin:20260202T100000",
		"EXDATE;TZID=Europe/Berlin:20260602T090000", "RECURRENCE-ID;TZID=Europe/Berlin:20260702T090000")
	// 06-02 stays deleted, and the exception replaces the 07-02 event, at its
	// own time.
	checkOccurrences(t, listed(t, e, "work", date(2026, 4, 1, 0, 0), date(2026, 8, 1, 0, 0)), []occ{
		{title: "Rent", start: date(2026, 4, 2, 7, 0), end: date(2026, 4, 2, 8, 0), rid: ptr(date(2026, 4, 2, 7, 0))},
		{title: "Rent", start: date(2026, 5, 2, 7, 0), end: date(2026, 5, 2, 8, 0), rid: ptr(date(2026, 5, 2, 7, 0))},
		{title: "Special", start: date(2026, 6, 30, 13, 0), end: date(2026, 6, 30, 14, 0), rid: ptr(date(2026, 7, 2, 7, 0))},
	})
}

// TestUpdateSeriesMonthlyFromMovedException checks that "all events" from
// an exception shown on another day than its RECURRENCE-ID counts the
// months and days of a monthly series from that RECURRENCE-ID: the
// exception of 02-15, shown on 02-28 and moved one day to 03-01, moves the
// series from the 15th to the 16th. Counted from 02-28 to 03-01, a month
// less 27 days, DTSTART went to 01-19, the EXDATE to 04-18 and the
// RECURRENCE-ID to 02-16, each by another amount (spec section 3 items 1
// and 2, FR-17).
func TestUpdateSeriesMonthlyFromMovedException(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	id := e.put(t, "work", "series.ics",
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Rent",
		"DTSTART;TZID=Europe/Berlin:20260115T090000", "DTEND;TZID=Europe/Berlin:20260115T100000",
		"RRULE:FREQ=MONTHLY", "EXDATE;TZID=Europe/Berlin:20260415T090000",
		"END:VEVENT",
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Special",
		"RECURRENCE-ID;TZID=Europe/Berlin:20260215T090000",
		"DTSTART;TZID=Europe/Berlin:20260228T090000", "DTEND;TZID=Europe/Berlin:20260228T100000",
		"END:VEVENT")
	evs := listed(t, e, "work", date(2026, 2, 28, 0, 0), date(2026, 3, 1, 0, 0))
	if len(evs) != 1 || evs[0].Title != "Special" {
		t.Fatalf("got %+v on 2026-02-28; want the exception", evs)
	}

	up, _, err := e.svc.UpdateEvent(t.Context(), id, evs[0].ETag,
		seriesUpdate(evs[0], "Special", "", date(2026, 3, 1, 8, 0), date(2026, 3, 1, 9, 0)))
	mustNoErr(t, err)
	checkOccurrences(t, []domain.Event{up}, []occ{
		{title: "Special", start: date(2026, 3, 1, 8, 0), end: date(2026, 3, 1, 9, 0), rid: ptr(date(2026, 2, 16, 8, 0))},
	})

	wantStored(t, e, "work", "series.ics",
		"DTSTART;TZID=Europe/Berlin:20260116T090000", "EXDATE;TZID=Europe/Berlin:20260416T090000",
		"RECURRENCE-ID;TZID=Europe/Berlin:20260216T090000")
	// The exception replaces the 02-16 event, and 04-16 stays deleted.
	checkOccurrences(t, listed(t, e, "work", date(2026, 1, 1, 0, 0), date(2026, 6, 1, 0, 0)), []occ{
		{title: "Rent", start: date(2026, 1, 16, 8, 0), end: date(2026, 1, 16, 9, 0), rid: ptr(date(2026, 1, 16, 8, 0))},
		{title: "Special", start: date(2026, 3, 1, 8, 0), end: date(2026, 3, 1, 9, 0), rid: ptr(date(2026, 2, 16, 8, 0))},
		{title: "Rent", start: date(2026, 3, 16, 8, 0), end: date(2026, 3, 16, 9, 0), rid: ptr(date(2026, 3, 16, 8, 0))},
		{title: "Rent", start: date(2026, 5, 16, 7, 0), end: date(2026, 5, 16, 8, 0), rid: ptr(date(2026, 5, 16, 7, 0))},
	})
}

// TestUpdateSeriesMonthlyFromRDateOnAnotherDay checks that "all events"
// refuses to change the date of a monthly series from an event on another
// day of the month than DTSTART's, here an RDATE, and leaves the resource
// as it was: counted in months and days from 01-31, the rule's events would
// move by another number of days than the RDATE; counted in days, they
// would leave DTSTART's day of the month. A change of the clock time alone
// still moves every value (spec section 3 item 2, FR-17).
func TestUpdateSeriesMonthlyFromRDateOnAnotherDay(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	id := e.put(t, "work", "series.ics",
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Rent",
		"DTSTART;TZID=Europe/Berlin:20260115T090000", "DTEND;TZID=Europe/Berlin:20260115T100000",
		"RRULE:FREQ=MONTHLY", "RDATE;TZID=Europe/Berlin:20260131T090000",
		"EXDATE;TZID=Europe/Berlin:20260415T090000",
		"END:VEVENT")
	evs := listed(t, e, "work", date(2026, 1, 31, 0, 0), date(2026, 2, 1, 0, 0))
	if len(evs) != 1 {
		t.Fatalf("got %d events on 2026-01-31; want 1", len(evs))
	}

	mustRefuseMove(t, e, id, evs[0], seriesUpdate(evs[0], "Rent", "", date(2026, 2, 1, 8, 0), date(2026, 2, 1, 9, 0)))
	// Also where every value would stay in its month, and with a new rule.
	mustRefuseMove(t, e, id, evs[0], seriesUpdate(evs[0], "Rent", "", date(2026, 1, 30, 8, 0), date(2026, 1, 30, 9, 0)))
	newRule := seriesUpdate(evs[0], "Rent", "", date(2026, 1, 30, 8, 0), date(2026, 1, 30, 9, 0))
	newRule.RRule = "FREQ=MONTHLY;COUNT=12"
	mustRefuseMove(t, e, id, evs[0], newRule)

	_, _, err := e.svc.UpdateEvent(t.Context(), id, evs[0].ETag,
		seriesUpdate(evs[0], "Rent", "", date(2026, 1, 31, 9, 0), date(2026, 1, 31, 10, 0)))
	mustNoErr(t, err)
	wantStored(t, e, "work", "series.ics",
		"DTSTART;TZID=Europe/Berlin:20260115T100000", "RDATE;TZID=Europe/Berlin:20260131T100000",
		"EXDATE;TZID=Europe/Berlin:20260415T100000")
}

// TestUpdateSeriesMonthlyOntoDayMonthsLack checks that "all events" refuses
// to move a monthly series onto a day of the month that some of its months
// lack, and leaves the resource as it was: from the 03-15 event to 03-31,
// DTSTART went to 01-31, and the series lost its events in February,
// April, June, September and November (spec section 3 item 2, FR-17).
func TestUpdateSeriesMonthlyOntoDayMonthsLack(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	id := e.put(t, "work", "series.ics",
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Rent",
		"DTSTART;TZID=Europe/Berlin:20260115T090000", "DTEND;TZID=Europe/Berlin:20260115T100000",
		"RRULE:FREQ=MONTHLY",
		"END:VEVENT")
	evs := listed(t, e, "work", date(2026, 3, 15, 0, 0), date(2026, 3, 16, 0, 0))
	if len(evs) != 1 {
		t.Fatalf("got %d events on 2026-03-15; want 1", len(evs))
	}

	// 09:00 Berlin summer time.
	mustRefuseMove(t, e, id, evs[0], seriesUpdate(evs[0], "Rent", "", date(2026, 3, 31, 7, 0), date(2026, 3, 31, 8, 0)))
}

// TestUpdateSeriesMonthlyRefMovedOffItsMonth checks that "all events"
// refuses a move that puts a reference of a monthly series on a day its
// month lacks, and leaves the resource as it was: from the 03-15 event to
// 04-14, a month less a day, the RDATE of 01-31 went to February 30, which
// is March 2 (spec section 3 item 2, FR-17).
func TestUpdateSeriesMonthlyRefMovedOffItsMonth(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	id := e.put(t, "work", "series.ics",
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Rent",
		"DTSTART;TZID=Europe/Berlin:20260115T090000", "DTEND;TZID=Europe/Berlin:20260115T100000",
		"RRULE:FREQ=MONTHLY", "RDATE;TZID=Europe/Berlin:20260131T090000",
		"END:VEVENT")
	evs := listed(t, e, "work", date(2026, 3, 15, 0, 0), date(2026, 3, 16, 0, 0))
	if len(evs) != 1 {
		t.Fatalf("got %d events on 2026-03-15; want 1", len(evs))
	}

	mustRefuseMove(t, e, id, evs[0], seriesUpdate(evs[0], "Rent", "", date(2026, 4, 14, 7, 0), date(2026, 4, 14, 8, 0)))
}

// TestUpdateSeriesMonthlyFrom31stTo30th checks that "all events" moves a
// monthly series on the 31st to the 30th, where every value keeps its
// month: DTSTART and the EXDATE go back a day, and the series repeats on
// the 30th (spec section 3 item 2, FR-17).
func TestUpdateSeriesMonthlyFrom31stTo30th(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	id := e.put(t, "work", "series.ics",
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Rent",
		"DTSTART;TZID=Europe/Berlin:20260131T090000", "DTEND;TZID=Europe/Berlin:20260131T100000",
		"RRULE:FREQ=MONTHLY", "EXDATE;TZID=Europe/Berlin:20260531T090000",
		"END:VEVENT")
	evs := listed(t, e, "work", date(2026, 3, 31, 0, 0), date(2026, 4, 1, 0, 0))
	if len(evs) != 1 {
		t.Fatalf("got %d events on 2026-03-31; want 1", len(evs))
	}

	_, _, err := e.svc.UpdateEvent(t.Context(), id, evs[0].ETag,
		seriesUpdate(evs[0], "Rent", "", date(2026, 3, 30, 7, 0), date(2026, 3, 30, 8, 0)))
	mustNoErr(t, err)

	wantStored(t, e, "work", "series.ics",
		"DTSTART;TZID=Europe/Berlin:20260130T090000", "EXDATE;TZID=Europe/Berlin:20260530T090000")
	// 05-30 stays deleted.
	checkOccurrences(t, listed(t, e, "work", date(2026, 3, 1, 0, 0), date(2026, 7, 1, 0, 0)), []occ{
		{title: "Rent", start: date(2026, 3, 30, 7, 0), end: date(2026, 3, 30, 8, 0), rid: ptr(date(2026, 3, 30, 7, 0))},
		{title: "Rent", start: date(2026, 4, 30, 7, 0), end: date(2026, 4, 30, 8, 0), rid: ptr(date(2026, 4, 30, 7, 0))},
		{title: "Rent", start: date(2026, 6, 30, 7, 0), end: date(2026, 6, 30, 8, 0), rid: ptr(date(2026, 6, 30, 7, 0))},
	})
}

// TestUpdateSeriesMovesValuesOffItsDayPastMonthEnd checks that "all events"
// moving a monthly or yearly series by days within the month carries a
// value on another day than DTSTART's past the end of its month, as a move
// in calendar days does, rather than refusing it: an UNTIL at the end of a
// month or year, or an RDATE on the 31st, moves with the events (spec
// section 3 items 2 and 8, FR-17).
func TestUpdateSeriesMovesValuesOffItsDayPastMonthEnd(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name       string
		series     []string // DTSTART, DTEND, RRULE and RDATE lines
		shown      time.Time
		allDay     bool
		days       int // how far the shown event moves
		wantStored []string
	}{
		{
			"monthly on the 15th, UNTIL at the end of the year",
			[]string{"DTSTART;TZID=Europe/Berlin:20260115T090000", "DTEND;TZID=Europe/Berlin:20260115T100000", "RRULE:FREQ=MONTHLY;UNTIL=20261231T225959Z"},
			date(2026, 3, 15, 8, 0), false, 1,
			[]string{"RRULE:FREQ=MONTHLY;UNTIL=20270101T225959Z", "DTSTART;TZID=Europe/Berlin:20260116T090000"},
		},
		{
			"all-day monthly on the 15th, a DATE UNTIL at the end of the year",
			[]string{"DTSTART;VALUE=DATE:20260115", "DTEND;VALUE=DATE:20260116", "RRULE:FREQ=MONTHLY;UNTIL=20261231"},
			date(2026, 3, 15, 0, 0), true, 1,
			[]string{"RRULE:FREQ=MONTHLY;UNTIL=20270101", "DTSTART;VALUE=DATE:20260116"},
		},
		{
			"monthly on the 1st, UNTIL at the end of June",
			[]string{"DTSTART;TZID=Europe/Berlin:20260101T090000", "DTEND;TZID=Europe/Berlin:20260101T100000", "RRULE:FREQ=MONTHLY;UNTIL=20260630T215959Z"},
			date(2026, 3, 1, 8, 0), false, 1,
			[]string{"RRULE:FREQ=MONTHLY;UNTIL=20260701T215959Z", "DTSTART;TZID=Europe/Berlin:20260102T090000"},
		},
		{
			"yearly on 03-15, UNTIL at the end of a year",
			[]string{"DTSTART;TZID=Europe/Berlin:20260315T090000", "DTEND;TZID=Europe/Berlin:20260315T100000", "RRULE:FREQ=YEARLY;UNTIL=20301231T225959Z"},
			date(2027, 3, 15, 8, 0), false, 1,
			[]string{"RRULE:FREQ=YEARLY;UNTIL=20310101T225959Z", "DTSTART;TZID=Europe/Berlin:20260316T090000"},
		},
		{
			"monthly on the 15th, an RDATE on the 31st",
			[]string{"DTSTART;TZID=Europe/Berlin:20260115T090000", "DTEND;TZID=Europe/Berlin:20260115T100000", "RRULE:FREQ=MONTHLY", "RDATE;TZID=Europe/Berlin:20260131T090000"},
			date(2026, 3, 15, 8, 0), false, 1,
			[]string{"RDATE;TZID=Europe/Berlin:20260201T090000", "DTSTART;TZID=Europe/Berlin:20260116T090000"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			lines := append([]string{"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Rent"}, tt.series...)
			id := e.put(t, "work", "series.ics", append(lines, "END:VEVENT")...)
			evs := listed(t, e, "work", tt.shown, tt.shown.Add(time.Hour))
			if len(evs) != 1 {
				t.Fatalf("got %d events at %s; want 1", len(evs), tt.shown)
			}

			start := evs[0].Start.AddDate(0, 0, tt.days)
			in := seriesUpdate(evs[0], "Rent", "", start, start.Add(evs[0].End.Sub(evs[0].Start)))
			in.AllDay = tt.allDay
			_, _, err := e.svc.UpdateEvent(t.Context(), id, evs[0].ETag, in)
			mustNoErr(t, err)
			wantStored(t, e, "work", "series.ics", tt.wantStored...)
		})
	}
}

// TestUpdateSeriesMonthlyUntilMovedOffItsMonth checks that "all events"
// still refuses a move by months and days that carries UNTIL past the end
// of its month, and leaves the resource as it was: from the 03-01 event of
// a series on the 1st to 02-28, a month back and 27 days on, UNTIL of 12-31
// went to November 58, which is December 28, and the series gained an
// event (spec section 3 items 2 and 8, FR-17).
func TestUpdateSeriesMonthlyUntilMovedOffItsMonth(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	id := e.put(t, "work", "series.ics",
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Rent",
		"DTSTART;TZID=Europe/Berlin:20260101T090000", "DTEND;TZID=Europe/Berlin:20260101T100000",
		"RRULE:FREQ=MONTHLY;UNTIL=20261231T225959Z",
		"END:VEVENT")
	evs := listed(t, e, "work", date(2026, 3, 1, 0, 0), date(2026, 3, 2, 0, 0))
	if len(evs) != 1 {
		t.Fatalf("got %d events on 2026-03-01; want 1", len(evs))
	}

	mustRefuseMove(t, e, id, evs[0], seriesUpdate(evs[0], "Rent", "", date(2026, 2, 28, 8, 0), date(2026, 2, 28, 9, 0)))
}

// TestUpdateSeriesYearlyOntoFebruary29 checks that "all events" refuses to
// move a yearly series onto February 29, which DTSTART's year 2026 lacks,
// and leaves the resource as it was: DTSTART stayed on March 1 while the
// edited event was shown on 2028-02-29 (spec section 3 item 2, FR-17).
func TestUpdateSeriesYearlyOntoFebruary29(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	id := e.put(t, "work", "series.ics",
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Review",
		"DTSTART;TZID=Europe/Berlin:20260301T090000", "DTEND;TZID=Europe/Berlin:20260301T100000",
		"RRULE:FREQ=YEARLY",
		"END:VEVENT")
	evs := listed(t, e, "work", date(2028, 3, 1, 0, 0), date(2028, 3, 2, 0, 0))
	if len(evs) != 1 {
		t.Fatalf("got %d events on 2028-03-01; want 1", len(evs))
	}

	mustRefuseMove(t, e, id, evs[0], seriesUpdate(evs[0], "Review", "", date(2028, 2, 29, 8, 0), date(2028, 2, 29, 9, 0)))
}

// TestUpdateSeriesNewRuleOntoDayMonthLacks checks that a save of a monthly
// series that changes its rule refuses the move too when DTSTART lands on
// a day its month lacks, and leaves the resource as it was: from the 03-31
// event to 04-30, a month less a day, DTSTART went from 01-31 to February
// 30, which is March 2 (spec section 3 items 2 and 4, FR-17).
func TestUpdateSeriesNewRuleOntoDayMonthLacks(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	id := e.put(t, "work", "series.ics", monthlyOn31st...)
	evs := listed(t, e, "work", date(2026, 3, 31, 0, 0), date(2026, 4, 1, 0, 0))
	if len(evs) != 1 {
		t.Fatalf("got %d events on 2026-03-31; want 1", len(evs))
	}

	in := seriesUpdate(evs[0], "Rent", "", date(2026, 4, 30, 7, 0), date(2026, 4, 30, 8, 0))
	in.RRule = "FREQ=MONTHLY;COUNT=12"
	mustRefuseMove(t, e, id, evs[0], in)
}

// TestUpdateSeriesMadeAllDayOntoDayMonthLacks checks that a save that makes
// a monthly series all-day refuses the move too when DTSTART lands on a
// day its month lacks, and leaves the resource as it was: from the 03-31
// event to 04-30, DTSTART went from 01-31 to February 30, which is March 2
// (spec section 3 items 2 and 4, FR-17).
func TestUpdateSeriesMadeAllDayOntoDayMonthLacks(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	id := e.put(t, "work", "series.ics", monthlyOn31st...)
	evs := listed(t, e, "work", date(2026, 3, 31, 0, 0), date(2026, 4, 1, 0, 0))
	if len(evs) != 1 {
		t.Fatalf("got %d events on 2026-03-31; want 1", len(evs))
	}

	in := seriesUpdate(evs[0], "Rent", "", date(2026, 4, 30, 0, 0), date(2026, 5, 1, 0, 0))
	in.AllDay = true
	mustRefuseMove(t, e, id, evs[0], in)
}

// monthlyOn31st is a monthly series from 2026-01-31 09:00 Berlin time.
var monthlyOn31st = []string{
	"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Rent",
	"DTSTART;TZID=Europe/Berlin:20260131T090000", "DTEND;TZID=Europe/Berlin:20260131T100000",
	"RRULE:FREQ=MONTHLY",
	"END:VEVENT",
}

// TestUpdateSeriesYearlyKeepsDayOfMonth checks that "all events" moves a
// yearly series by calendar months and days too: from 02-28 to 03-01, its
// UNTIL in the leap year 2028 goes to 03-01 as well, not to 02-29, so the
// series keeps its last event (spec section 3 items 2 and 8, FR-17).
func TestUpdateSeriesYearlyKeepsDayOfMonth(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	id := e.put(t, "work", "series.ics",
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Review",
		"DTSTART;TZID=Europe/Berlin:20260228T090000", "DTEND;TZID=Europe/Berlin:20260228T100000",
		"RRULE:FREQ=YEARLY;UNTIL=20280228T080000Z",
		"END:VEVENT")
	evs := listed(t, e, "work", date(2027, 2, 28, 0, 0), date(2027, 3, 1, 0, 0))
	if len(evs) != 1 {
		t.Fatalf("got %d events on 2027-02-28; want 1", len(evs))
	}

	_, _, err := e.svc.UpdateEvent(t.Context(), id, evs[0].ETag,
		seriesUpdate(evs[0], "Review", "", date(2027, 3, 1, 8, 0), date(2027, 3, 1, 9, 0)))
	mustNoErr(t, err)

	wantStored(t, e, "work", "series.ics",
		"RRULE:FREQ=YEARLY;UNTIL=20280301T080000Z", "DTSTART;TZID=Europe/Berlin:20260301T090000")
	checkOccurrences(t, listed(t, e, "work", date(2026, 1, 1, 0, 0), date(2029, 1, 1, 0, 0)), []occ{
		{title: "Review", start: date(2026, 3, 1, 8, 0), end: date(2026, 3, 1, 9, 0), rid: ptr(date(2026, 3, 1, 8, 0))},
		{title: "Review", start: date(2027, 3, 1, 8, 0), end: date(2027, 3, 1, 9, 0), rid: ptr(date(2027, 3, 1, 8, 0))},
		{title: "Review", start: date(2028, 3, 1, 8, 0), end: date(2028, 3, 1, 9, 0), rid: ptr(date(2028, 3, 1, 8, 0))},
	})
}

// TestUpdateSeriesMonthlyKeepsDuration checks that a monthly series moved
// by calendar months and days keeps its duration where DTSTART and DTEND lie
// in months of different lengths: DTEND moves as DTSTART does, not by the
// months and days on its own (spec section 3 item 2, FR-17).
func TestUpdateSeriesMonthlyKeepsDuration(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	id := e.put(t, "work", "series.ics",
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Trip",
		"DTSTART;VALUE=DATE:20260131", "DTEND;VALUE=DATE:20260202", "RRULE:FREQ=MONTHLY",
		"END:VEVENT")
	evs := listed(t, e, "work", date(2026, 3, 31, 0, 0), date(2026, 4, 1, 0, 0))
	if len(evs) != 1 {
		t.Fatalf("got %d events on 2026-03-31; want 1", len(evs))
	}

	in := seriesUpdate(evs[0], "Trip", "", date(2026, 4, 2, 0, 0), date(2026, 4, 4, 0, 0))
	in.AllDay = true
	_, _, err := e.svc.UpdateEvent(t.Context(), id, evs[0].ETag, in)
	mustNoErr(t, err)

	wantStored(t, e, "work", "series.ics", "DTSTART;VALUE=DATE:20260202", "DTEND;VALUE=DATE:20260204")
	checkOccurrences(t, listed(t, e, "work", date(2026, 4, 1, 0, 0), date(2026, 5, 10, 0, 0)), []occ{
		{title: "Trip", start: date(2026, 4, 2, 0, 0), end: date(2026, 4, 4, 0, 0), rid: ptr(date(2026, 4, 2, 0, 0)), allDay: true},
		{title: "Trip", start: date(2026, 5, 2, 0, 0), end: date(2026, 5, 4, 0, 0), rid: ptr(date(2026, 5, 2, 0, 0)), allDay: true},
	})
}

// TestUpdateSeriesMadeAllDayAcrossDSTChange checks that "all events" making
// a timed series all-day from an event on the other side of a
// daylight-saving change than DTSTART keeps DTSTART's date: the edited
// event's date is read in the series' zone, the date entered as written.
// Measured on the wall clock and read in UTC, DTSTART went to the day
// before (spec section 3 item 4, FR-17).
func TestUpdateSeriesMadeAllDayAcrossDSTChange(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	id := e.put(t, "work", "series.ics",
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Review",
		"DTSTART;TZID=Europe/Berlin:20260904T090000", "DTEND;TZID=Europe/Berlin:20260904T100000",
		"RRULE:FREQ=WEEKLY",
		"END:VEVENT")
	evs := listed(t, e, "work", date(2026, 11, 6, 0, 0), date(2026, 11, 7, 0, 0))
	if len(evs) != 1 {
		t.Fatalf("got %d events on 2026-11-06; want 1", len(evs))
	}

	in := seriesUpdate(evs[0], "Review", "", date(2026, 11, 6, 0, 0), date(2026, 11, 7, 0, 0))
	in.AllDay = true
	up, _, err := e.svc.UpdateEvent(t.Context(), id, evs[0].ETag, in)
	mustNoErr(t, err)
	checkOccurrences(t, []domain.Event{up}, []occ{
		{title: "Review", start: date(2026, 11, 6, 0, 0), end: date(2026, 11, 7, 0, 0), rid: ptr(date(2026, 11, 6, 0, 0)), allDay: true},
	})

	wantStored(t, e, "work", "series.ics", "DTSTART;VALUE=DATE:20260904", "DTEND;VALUE=DATE:20260905")
	checkOccurrences(t, listed(t, e, "work", date(2026, 9, 1, 0, 0), date(2026, 9, 12, 0, 0)), []occ{
		{title: "Review", start: date(2026, 9, 4, 0, 0), end: date(2026, 9, 5, 0, 0), rid: ptr(date(2026, 9, 4, 0, 0)), allDay: true},
		{title: "Review", start: date(2026, 9, 11, 0, 0), end: date(2026, 9, 12, 0, 0), rid: ptr(date(2026, 9, 11, 0, 0)), allDay: true},
	})
	checkOccurrences(t, listed(t, e, "work", date(2026, 11, 6, 0, 0), date(2026, 11, 7, 0, 0)), []occ{
		{title: "Review", start: date(2026, 11, 6, 0, 0), end: date(2026, 11, 7, 0, 0), rid: ptr(date(2026, 11, 6, 0, 0)), allDay: true},
	})
}

// TestUpdateSeriesMadeTimedAcrossDSTChange checks that "all events" giving
// an all-day series a time, from an event on the other side of a
// daylight-saving change than DTSTART, writes DTSTART at the clock time
// entered in the request's zone, so every event lists at that time. Moved
// in UTC, the all-day series' zone, DTSTART went to 08:00 Berlin time (spec
// section 3 item 4, FR-17).
func TestUpdateSeriesMadeTimedAcrossDSTChange(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	id := e.put(t, "work", "series.ics",
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Gym",
		"DTSTART;VALUE=DATE:20260102", "DTEND;VALUE=DATE:20260103",
		"RRULE:FREQ=WEEKLY",
		"END:VEVENT")
	evs := listed(t, e, "work", date(2026, 4, 3, 0, 0), date(2026, 4, 4, 0, 0))
	if len(evs) != 1 {
		t.Fatalf("got %d events on 2026-04-03; want 1", len(evs))
	}

	// 09:00 Berlin summer time.
	in := seriesUpdate(evs[0], "Gym", "", date(2026, 4, 3, 7, 0), date(2026, 4, 3, 8, 0))
	in.Timezone = ptr("Europe/Berlin")
	up, _, err := e.svc.UpdateEvent(t.Context(), id, evs[0].ETag, in)
	mustNoErr(t, err)
	checkOccurrences(t, []domain.Event{up}, []occ{
		{title: "Gym", start: date(2026, 4, 3, 7, 0), end: date(2026, 4, 3, 8, 0), rid: ptr(date(2026, 4, 3, 7, 0))},
	})

	wantStored(t, e, "work", "series.ics",
		"DTSTART;TZID=Europe/Berlin:20260102T090000", "DTEND;TZID=Europe/Berlin:20260102T100000")
	// 09:00 Berlin time on both sides of the change on 03-29.
	checkOccurrences(t, listed(t, e, "work", date(2026, 3, 20, 0, 0), date(2026, 4, 11, 0, 0)), []occ{
		{title: "Gym", start: date(2026, 3, 20, 8, 0), end: date(2026, 3, 20, 9, 0), rid: ptr(date(2026, 3, 20, 8, 0))},
		{title: "Gym", start: date(2026, 3, 27, 8, 0), end: date(2026, 3, 27, 9, 0), rid: ptr(date(2026, 3, 27, 8, 0))},
		{title: "Gym", start: date(2026, 4, 3, 7, 0), end: date(2026, 4, 3, 8, 0), rid: ptr(date(2026, 4, 3, 7, 0))},
		{title: "Gym", start: date(2026, 4, 10, 7, 0), end: date(2026, 4, 10, 8, 0), rid: ptr(date(2026, 4, 10, 7, 0))},
	})
}

// TestUpdateSeriesMovedIntoSkippedTime is issue #8's first case: "All
// events" an hour later from the 03-30 event of a daily Berlin series at
// 01:30 whose DTSTART is the night of the change to summer time puts DTSTART
// at 02:30, the time Berlin skips that night, as written, and the series
// keeps 02:30 on every other day. Written from its instant, 03:30, it moved
// every event to 03:30 (FR-17, FR-18).
func TestUpdateSeriesMovedIntoSkippedTime(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	id := e.put(t, "work", "series.ics",
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20260101T000000Z", "SUMMARY:Night",
		"DTSTART;TZID=Europe/Berlin:20260329T013000", "DURATION:PT30M", "RRULE:FREQ=DAILY",
		"END:VEVENT")
	evs := listed(t, e, "work", date(2026, 3, 29, 23, 0), date(2026, 3, 30, 0, 0))
	if len(evs) != 1 {
		t.Fatalf("got %d events on 2026-03-30; want 1", len(evs))
	}

	up, _, err := e.svc.UpdateEvent(t.Context(), id, evs[0].ETag,
		seriesUpdate(evs[0], "Night", "", date(2026, 3, 30, 0, 30), date(2026, 3, 30, 1, 0)))
	mustNoErr(t, err)

	edited := occ{title: "Night", start: date(2026, 3, 30, 0, 30), end: date(2026, 3, 30, 1, 0), rid: ptr(date(2026, 3, 30, 0, 30))}
	checkOccurrences(t, []domain.Event{up}, []occ{edited})
	checkStored(t, "series", stored(t, e, "work", "series.ics"), []string{"DTSTART;TZID=Europe/Berlin:20260329T023000"}, []string{"T033000"})
	// 03:30 CEST on the night of the change, 02:30 after it.
	checkOccurrences(t, listed(t, e, "work", date(2026, 3, 28, 0, 0), date(2026, 4, 1, 0, 0)), []occ{
		{title: "Night", start: date(2026, 3, 29, 1, 30), end: date(2026, 3, 29, 2, 0), rid: ptr(date(2026, 3, 29, 1, 30))},
		edited,
		{title: "Night", start: date(2026, 3, 31, 0, 30), end: date(2026, 3, 31, 1, 0), rid: ptr(date(2026, 3, 31, 0, 30))},
	})
}

// TestUpdateSeriesFromSkippedTime moves a daily Berlin series at 02:30 with
// "All events" from its event on the night Berlin skips that time, shown at
// 03:30, to 04:30: the move counts from the series' 02:30, as its rule has
// that event, so the series goes to 04:30 and the event lands where it was
// dropped, as the answer says. Counted from the 03:30 it shows at, the series
// went to 03:30, and the answer named an event the list did not have (#8,
// FR-17).
func TestUpdateSeriesFromSkippedTime(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	id := e.put(t, "work", "series.ics",
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20260101T000000Z", "SUMMARY:Night",
		"DTSTART;TZID=Europe/Berlin:20260325T023000", "DTEND;TZID=Europe/Berlin:20260325T033000", "RRULE:FREQ=DAILY",
		"END:VEVENT")
	evs := listed(t, e, "work", date(2026, 3, 29, 0, 0), date(2026, 3, 29, 12, 0))
	if len(evs) != 1 || !evs[0].Start.Equal(date(2026, 3, 29, 1, 30)) {
		t.Fatalf("events on 2026-03-29 = %+v; want one at 01:30Z", evs)
	}

	up, _, err := e.svc.UpdateEvent(t.Context(), id, evs[0].ETag,
		seriesUpdate(evs[0], "Night", "", date(2026, 3, 29, 2, 30), date(2026, 3, 29, 3, 30)))
	mustNoErr(t, err)

	edited := occ{title: "Night", start: date(2026, 3, 29, 2, 30), end: date(2026, 3, 29, 3, 30), rid: ptr(date(2026, 3, 29, 2, 30))}
	checkOccurrences(t, []domain.Event{up}, []occ{edited})
	wantStored(t, e, "work", "series.ics",
		"DTSTART;TZID=Europe/Berlin:20260325T043000", "DTEND;TZID=Europe/Berlin:20260325T053000")
	checkOccurrences(t, listed(t, e, "work", date(2026, 3, 29, 0, 0), date(2026, 3, 31, 0, 0)), []occ{
		edited,
		{title: "Night", start: date(2026, 3, 30, 2, 30), end: date(2026, 3, 30, 3, 30), rid: ptr(date(2026, 3, 30, 2, 30))},
	})
}

// TestUpdateSeriesKeepsSkippedTime saves the event of a daily Berlin series
// at 02:30 on the night Berlin skips that time, shown at 03:30, at the time
// it shows, which is the only one a browser can send for it: the series keeps
// 02:30, whether the title or the rule changes, the edit goes to this and the
// following events, or the rule fixes the time; so does a drop from the day
// before into that skipped hour, sent as the hour after it. Measured from
// 02:30, each of them moved the series to 03:30 (#8, FR-17, FR-18).
func TestUpdateSeriesKeepsSkippedTime(t *testing.T) {
	t.Parallel()
	night := date(2026, 3, 29, 1, 30) // 02:30 on 03-29, shown at 03:30 CEST
	tests := []struct {
		name      string
		rule      string
		on        time.Time // the event edited
		edit      func(in *domain.EventInput)
		following bool
		start     string    // the series' DTSTART as stored, or N's
		shown     time.Time // an event of the series, or of N, after the save
	}{
		{
			name: "a new title", rule: "FREQ=DAILY", on: night,
			edit:  func(in *domain.EventInput) { in.Title = "Renamed" },
			start: "DTSTART;TZID=Europe/Berlin:20260325T023000", shown: date(2026, 3, 30, 0, 30),
		},
		{
			name: "a new rule", rule: "FREQ=DAILY", on: night,
			edit:  func(in *domain.EventInput) { in.RRule = "FREQ=DAILY;INTERVAL=2" },
			start: "DTSTART;TZID=Europe/Berlin:20260325T023000", shown: date(2026, 3, 31, 0, 30),
		},
		{
			name: "a new title for this and the following events", rule: "FREQ=DAILY", on: night, following: true,
			edit:  func(in *domain.EventInput) { in.Title = "Renamed" },
			start: "DTSTART;TZID=Europe/Berlin:20260329T023000", shown: date(2026, 3, 30, 0, 30),
		},
		{
			name: "a new title of a rule that fixes its time", rule: "FREQ=DAILY;BYHOUR=2;BYMINUTE=30", on: night,
			edit:  func(in *domain.EventInput) { in.Title = "Renamed" },
			start: "DTSTART;TZID=Europe/Berlin:20260325T023000", shown: date(2026, 3, 30, 0, 30),
		},
		{
			name: "a drop from the day before into the skipped hour", rule: "FREQ=DAILY", on: date(2026, 3, 28, 1, 30),
			edit: func(in *domain.EventInput) {
				in.Start, in.End = night, night.Add(time.Hour)
			},
			start: "DTSTART;TZID=Europe/Berlin:20260326T023000", shown: date(2026, 3, 30, 0, 30),
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			id := e.put(t, "work", "series.ics",
				"BEGIN:VEVENT", "UID:series", "DTSTAMP:20260101T000000Z", "SUMMARY:Night",
				"DTSTART;TZID=Europe/Berlin:20260325T023000", "DTEND;TZID=Europe/Berlin:20260325T033000", "RRULE:"+tt.rule,
				"END:VEVENT")
			evs := listed(t, e, "work", tt.on, tt.on.Add(time.Second))
			if len(evs) != 1 {
				t.Fatalf("got %d events at %v; want 1", len(evs), tt.on)
			}
			in := seriesUpdate(evs[0], "Night", "", evs[0].Start, evs[0].End)
			tt.edit(&in)
			var data string
			if tt.following {
				_, _, err := e.svc.UpdateFollowing(t.Context(), id, evs[0].ETag, tt.on, in)
				mustNoErr(t, err)
				_, data = newSeriesIn(t, e, id)
			} else {
				_, _, err := e.svc.UpdateEvent(t.Context(), id, evs[0].ETag, in)
				mustNoErr(t, err)
				data = stored(t, e, "work", "series.ics")
			}
			checkStored(t, "series", data, []string{tt.start}, []string{"DTSTART;TZID=Europe/Berlin:20260325T033000", "DTSTART;TZID=Europe/Berlin:20260329T033000"})
			got := listed(t, e, "work", tt.shown, tt.shown.Add(time.Second))
			if len(got) != 1 || !got[0].Start.Equal(tt.shown) {
				t.Errorf("events at %v = %+v; want one starting there", tt.shown, got)
			}
		})
	}
}

// TestUpdateSeriesMadeTimedAtSkippedTime is issue #8's second case: a
// weekly all-day series from the night of the change to summer time, made
// timed at 02:30 Berlin time from its 04-05 event, gets DTSTART at 02:30,
// the time Berlin skips that night, as written (FR-17, FR-18).
func TestUpdateSeriesMadeTimedAtSkippedTime(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	id := e.put(t, "work", "series.ics",
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20260101T000000Z", "SUMMARY:Gym",
		"DTSTART;VALUE=DATE:20260329", "DTEND;VALUE=DATE:20260330", "RRULE:FREQ=WEEKLY",
		"END:VEVENT")
	evs := listed(t, e, "work", date(2026, 4, 5, 0, 0), date(2026, 4, 6, 0, 0))
	if len(evs) != 1 {
		t.Fatalf("got %d events on 2026-04-05; want 1", len(evs))
	}

	in := seriesUpdate(evs[0], "Gym", "", date(2026, 4, 5, 0, 30), date(2026, 4, 5, 1, 30))
	in.Timezone = ptr("Europe/Berlin")
	_, _, err := e.svc.UpdateEvent(t.Context(), id, evs[0].ETag, in)
	mustNoErr(t, err)

	checkStored(t, "series", stored(t, e, "work", "series.ics"), []string{"DTSTART;TZID=Europe/Berlin:20260329T023000"}, []string{"T033000"})
	checkOccurrences(t, listed(t, e, "work", date(2026, 3, 28, 0, 0), date(2026, 4, 13, 0, 0)), []occ{
		{title: "Gym", start: date(2026, 3, 29, 1, 30), end: date(2026, 3, 29, 2, 30), rid: ptr(date(2026, 3, 29, 1, 30))},
		{title: "Gym", start: date(2026, 4, 5, 0, 30), end: date(2026, 4, 5, 1, 30), rid: ptr(date(2026, 4, 5, 0, 30))},
		{title: "Gym", start: date(2026, 4, 12, 0, 30), end: date(2026, 4, 12, 1, 30), rid: ptr(date(2026, 4, 12, 0, 30))},
	})
}

// TestUpdateSeriesNewRuleIntoSkippedTime is issue #8's third case: a weekly
// New York series from Saturday 2026-03-28 at 20:30, 02:30 in Berlin, whose
// repeat is changed in Berlin from its December event at 02:30, goes to
// Berlin by date (#5) with DTSTART at 02:30 on 03-29, the time Berlin skips
// that night, as written; the edited event stays at 02:30 (FR-17, FR-18).
func TestUpdateSeriesNewRuleIntoSkippedTime(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	id := e.put(t, "work", "series.ics",
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20260101T000000Z", "SUMMARY:Call",
		"DTSTART;TZID=America/New_York:20260328T203000", "DTEND;TZID=America/New_York:20260328T213000",
		"RRULE:FREQ=WEEKLY",
		"END:VEVENT")
	evs := listed(t, e, "work", date(2026, 12, 6, 0, 0), date(2026, 12, 7, 0, 0))
	if len(evs) != 1 {
		t.Fatalf("got %d events on 2026-12-06; want 1", len(evs))
	}

	in := seriesUpdate(evs[0], "Call", "", date(2026, 12, 6, 1, 30), date(2026, 12, 6, 2, 30))
	in.RRule, in.Timezone = "FREQ=WEEKLY;INTERVAL=2", ptr("Europe/Berlin")
	up, _, err := e.svc.UpdateEvent(t.Context(), id, evs[0].ETag, in)
	mustNoErr(t, err)

	edited := occ{title: "Call", start: date(2026, 12, 6, 1, 30), end: date(2026, 12, 6, 2, 30), rid: ptr(date(2026, 12, 6, 1, 30))}
	checkOccurrences(t, []domain.Event{up}, []occ{edited})
	checkStored(t, "series", stored(t, e, "work", "series.ics"), []string{"DTSTART;TZID=Europe/Berlin:20260329T023000"}, []string{"T033000"})
	checkOccurrences(t, listed(t, e, "work", date(2026, 12, 1, 0, 0), date(2026, 12, 8, 0, 0)), []occ{edited})
	checkOccurrences(t, listed(t, e, "work", date(2026, 3, 28, 0, 0), date(2026, 4, 1, 0, 0)), []occ{
		{title: "Call", start: date(2026, 3, 29, 1, 30), end: date(2026, 3, 29, 2, 30), rid: ptr(date(2026, 3, 29, 1, 30))},
	})
}

// TestUpdateSeriesNewRuleCarriesSkippedExdate is issue #8's carried
// reference: the EXDATE of a daily New York series at 02:30 on the night New
// York skips that time goes to Berlin with the series by its wall clock as
// written, 02:30, to 08:30, where the new series' event of that day is, so
// the deleted event stays deleted. Carried from its instant, it went to 07:30
// (FR-17, FR-18).
func TestUpdateSeriesNewRuleCarriesSkippedExdate(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	id := e.put(t, "work", "series.ics",
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20260101T000000Z", "SUMMARY:Pill",
		"DTSTART;TZID=America/New_York:20260301T023000", "DURATION:PT1H", "RRULE:FREQ=DAILY",
		"EXDATE;TZID=America/New_York:20260308T023000",
		"END:VEVENT")
	evs := listed(t, e, "work", date(2026, 12, 1, 0, 0), date(2026, 12, 2, 0, 0))
	if len(evs) != 1 {
		t.Fatalf("got %d events on 2026-12-01; want 1", len(evs))
	}

	in := seriesUpdate(evs[0], "Pill", "", date(2026, 12, 1, 7, 30), date(2026, 12, 1, 8, 30))
	in.RRule, in.Timezone = "FREQ=DAILY;INTERVAL=1", ptr("Europe/Berlin")
	_, _, err := e.svc.UpdateEvent(t.Context(), id, evs[0].ETag, in)
	mustNoErr(t, err)

	checkStored(t, "series", stored(t, e, "work", "series.ics"),
		[]string{"DTSTART;TZID=Europe/Berlin:20260301T083000", "EXDATE;TZID=Europe/Berlin:20260308T083000"},
		[]string{"EXDATE;TZID=Europe/Berlin:20260308T073000", "EXDATE;TZID=Europe/Berlin:20260308T093000"})
	checkOccurrences(t, listed(t, e, "work", date(2026, 3, 7, 0, 0), date(2026, 3, 10, 0, 0)), []occ{
		{title: "Pill", start: date(2026, 3, 7, 7, 30), end: date(2026, 3, 7, 8, 30), rid: ptr(date(2026, 3, 7, 7, 30))},
		{title: "Pill", start: date(2026, 3, 9, 7, 30), end: date(2026, 3, 9, 8, 30), rid: ptr(date(2026, 3, 9, 7, 30))},
	})
}

func TestUpdateAndDeleteErrors(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	ctx := t.Context()
	in := domain.EventInput{Title: "x", Start: date(2025, 3, 5, 10, 0), End: date(2025, 3, 5, 11, 0)}
	ev, err := e.svc.CreateEvent(ctx, e.cals["personal"], in)
	mustNoErr(t, err)
	todo, err := e.svc.CreateTodo(ctx, e.cals["tasks"], domain.TodoInput{Title: "t"})
	mustNoErr(t, err)
	roID := e.put(t, "holidays", "h.ics", "BEGIN:VEVENT", "UID:h", "DTSTAMP:20240101T000000Z", "DTSTART:20250101T000000Z", "END:VEVENT")
	missing := e.p.ids.encode(e.paths["personal"] + "missing.ics")

	tests := []struct {
		name string
		id   string
		etag string
		in   domain.EventInput
		want error
	}{
		{"stale etag", ev.ID, `"stale"`, in, domain.ErrConflict},
		{"missing etag", ev.ID, "", in, domain.ErrInvalidInput},
		{"invalid input", ev.ID, ev.ETag, domain.EventInput{Title: "x"}, domain.ErrInvalidInput},
		{"missing object", missing, `"x"`, in, domain.ErrNotFound},
		{"read-only", roID, `"x"`, in, domain.ErrReadOnly},
		{"todo is not an event", todo.ID, todo.ETag, in, domain.ErrNotFound},
		{"calendar id instead of object id", e.cals["personal"], `"x"`, in, domain.ErrNotFound},
		{"path traversal", e.p.ids.encode(e.paths["personal"] + "../../x.ics"), `"x"`, in, domain.ErrNotFound},
	}
	for _, tt := range tests {
		t.Run("update "+tt.name, func(t *testing.T) {
			t.Parallel()
			_, _, err := e.svc.UpdateEvent(ctx, tt.id, tt.etag, tt.in)
			mustErr(t, err, tt.want)
		})
	}
	for _, tt := range tests {
		if tt.name == "invalid input" || tt.name == "todo is not an event" {
			continue
		}
		t.Run("delete "+tt.name, func(t *testing.T) {
			t.Parallel()
			err := e.svc.DeleteEvent(ctx, tt.id, tt.etag)
			mustErr(t, err, tt.want)
		})
	}
}

func TestUpdateEventConflictOnPut(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	ctx := t.Context()
	ev, err := e.svc.CreateEvent(ctx, e.cals["personal"], domain.EventInput{Title: "x", Start: date(2025, 3, 5, 10, 0), End: date(2025, 3, 5, 11, 0)})
	mustNoErr(t, err)
	// Simulate a concurrent change between GET and PUT.
	e.mock.SetHook(func(w http.ResponseWriter, r *http.Request) bool {
		if r.Method == http.MethodPut {
			w.WriteHeader(http.StatusPreconditionFailed)
			return true
		}
		return false
	})
	_, _, err = e.svc.UpdateEvent(ctx, ev.ID, ev.ETag, domain.EventInput{Title: "y", Start: ev.Start, End: ev.End})
	mustErr(t, err, domain.ErrConflict)
}

func TestDeleteEvent(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	ctx := t.Context()
	ev, err := e.svc.CreateEvent(ctx, e.cals["personal"], domain.EventInput{Title: "x", Start: date(2025, 3, 5, 10, 0), End: date(2025, 3, 5, 11, 0)})
	mustNoErr(t, err)
	evs, err := e.svc.ListEvents(ctx, e.cals["personal"], date(2025, 3, 1, 0, 0), date(2025, 4, 1, 0, 0))
	mustNoErr(t, err)
	if len(evs) != 1 {
		t.Fatalf("got %d events", len(evs))
	}
	mustNoErr(t, e.svc.DeleteEvent(ctx, ev.ID, ev.ETag))
	evs, err = e.svc.ListEvents(ctx, e.cals["personal"], date(2025, 3, 1, 0, 0), date(2025, 4, 1, 0, 0))
	mustNoErr(t, err)
	if len(evs) != 0 {
		t.Fatalf("event not deleted (cache not invalidated?): %+v", evs)
	}
	mustErr(t, e.svc.DeleteEvent(ctx, ev.ID, ev.ETag), domain.ErrNotFound)
}
