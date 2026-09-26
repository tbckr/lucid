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

	up, err := e.svc.UpdateEvent(t.Context(), id, evs[0].ETag, domain.EventInput{
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
	up, err := e.svc.UpdateEvent(ctx, inst.ID, inst.ETag, domain.EventInput{
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
	single, err := e.svc.UpdateEvent(ctx, up.ID, up.ETag, domain.EventInput{
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
			_, err := e.svc.UpdateEvent(ctx, tt.id, tt.etag, tt.in)
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
	_, err = e.svc.UpdateEvent(ctx, ev.ID, ev.ETag, domain.EventInput{Title: "y", Start: ev.Start, End: ev.End})
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
