package caldav

import (
	"net/http"
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
			got, err := expandObject(o, "cal", tt.from, tt.to)
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
	got, err := expandObject(o, "cal", date(2025, 3, 1, 0, 0), date(2025, 4, 1, 0, 0))
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
	got, err := expandObject(o, "cal", date(2025, 6, 1, 0, 0), date(2025, 7, 5, 0, 0))
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
	got, err := expandObject(o, "c", date(2025, 1, 1, 0, 0), date(2026, 1, 1, 0, 0))
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
			if _, err := expandObject(o, "c", date(2024, 1, 1, 0, 0), date(2026, 1, 1, 0, 0)); err == nil {
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
		wantEvent occ
	}{
		{
			name: "timed non-recurring is stored in UTC",
			in: domain.EventInput{
				Title: "Lunch", Description: "line1\nline2", Location: "Cafe",
				Start: date(2025, 3, 5, 11, 0), End: date(2025, 3, 5, 12, 0), Timezone: "Europe/Berlin",
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
				Timezone: "Europe/Berlin", RRule: "RRULE:FREQ=WEEKLY;BYDAY=MO",
			},
			wantLines: []string{
				"DTSTART;TZID=Europe/Berlin:20250317T090000", "RRULE:FREQ=WEEKLY;BYDAY=MO",
				"BEGIN:VTIMEZONE", "TZID:Europe/Berlin", "BEGIN:DAYLIGHT", "TZOFFSETTO:+0200",
			},
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
			objPath, _, err := decodeObjectID(e.mock.HomePath(), ev.ID)
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
		})
	}

	t.Run("DST-correct expansion of created series", func(t *testing.T) {
		t.Parallel()
		ev, err := e.svc.CreateEvent(ctx, e.cals["work"], domain.EventInput{
			Title: "Weekly", Start: date(2025, 3, 24, 8, 0), End: date(2025, 3, 24, 9, 0),
			Timezone: "Europe/Berlin", RRule: "FREQ=WEEKLY",
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
		{"unknown calendar", encodeID(e.mock.HomePath() + "nope/"), ok, domain.ErrNotFound},
		{"calendar outside home", encodeID("/other/cal/"), ok, domain.ErrNotFound},
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
	in.Timezone = "Europe/Berlin"
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
	missing := encodeID(e.paths["personal"] + "missing.ics")

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
		{"path traversal", encodeID(e.paths["personal"] + "../../x.ics"), `"x"`, in, domain.ErrNotFound},
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
