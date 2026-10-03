package caldav

import (
	"strings"
	"testing"
	"time"

	"github.com/emersion/go-ical"

	"github.com/tbckr/lucid/internal/caldav/caldavtest"
	"github.com/tbckr/lucid/internal/domain"
)

// vevents returns the top-level VEVENT children of cal, in order.
func vevents(cal *ical.Calendar) []*ical.Component {
	var out []*ical.Component
	for _, c := range cal.Children {
		if c.Name == ical.CompEvent {
			out = append(out, c)
		}
	}
	return out
}

// wantDateProp asserts that the date property name of c has the given raw
// value, TZID param ("" for none) and VALUE=DATE param.
func wantDateProp(t *testing.T, c *ical.Component, name, wantValue, wantTZID string, wantDateOnly bool) {
	t.Helper()
	p := c.Props.Get(name)
	if p == nil {
		t.Fatalf("%s missing", name)
	}
	if p.Value != wantValue {
		t.Errorf("%s value = %q; want %q", name, p.Value, wantValue)
	}
	if got := p.Params.Get(ical.ParamTimezoneID); got != wantTZID {
		t.Errorf("%s TZID param = %q; want %q", name, got, wantTZID)
	}
	wantValueParam := ""
	if wantDateOnly {
		wantValueParam = "DATE"
	}
	if got := p.Params.Get(ical.ParamValue); got != wantValueParam {
		t.Errorf("%s VALUE param = %q; want %q", name, got, wantValueParam)
	}
}

// TestUpdateOccurrenceCreatesOverride checks that UpdateOccurrence writes a
// full override for each form a series' DTSTART can be written in: a
// RECURRENCE-ID and DTSTART in that same form, the master's other
// properties and children (ATTENDEE, DESCRIPTION, VALARM) kept, and none of
// the recurrence-defining ones (spec section 2, FR-17).
func TestUpdateOccurrenceCreatesOverride(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name                    string
		dtstartLine, dtendLine  string
		rid, newStart, newEnd   time.Time
		allDay                  bool
		wantValue, wantNewValue string
		wantTZID                string
		wantDateOnly            bool
	}{
		{
			name: "TZID", dtstartLine: "DTSTART;TZID=Europe/Berlin:20250303T090000", dtendLine: "DTEND;TZID=Europe/Berlin:20250303T091500",
			rid: date(2025, 3, 10, 8, 0), newStart: date(2025, 3, 10, 10, 0), newEnd: date(2025, 3, 10, 10, 15),
			wantValue: "20250310T090000", wantNewValue: "20250310T110000", wantTZID: "Europe/Berlin",
		},
		{
			name: "UTC", dtstartLine: "DTSTART:20250303T080000Z", dtendLine: "DTEND:20250303T081500Z",
			rid: date(2025, 3, 10, 8, 0), newStart: date(2025, 3, 10, 10, 0), newEnd: date(2025, 3, 10, 10, 15),
			wantValue: "20250310T080000Z", wantNewValue: "20250310T100000Z",
		},
		{
			name: "floating", dtstartLine: "DTSTART:20250303T090000", dtendLine: "DTEND:20250303T091500",
			rid: date(2025, 3, 10, 9, 0), newStart: date(2025, 3, 10, 11, 0), newEnd: date(2025, 3, 10, 11, 15),
			wantValue: "20250310T090000", wantNewValue: "20250310T110000",
		},
		{
			name: "all-day", dtstartLine: "DTSTART;VALUE=DATE:20250303", dtendLine: "DTEND;VALUE=DATE:20250304",
			rid: date(2025, 3, 10, 0, 0), newStart: date(2025, 3, 11, 0, 0), newEnd: date(2025, 3, 12, 0, 0),
			allDay: true, wantValue: "20250310", wantNewValue: "20250311", wantDateOnly: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			ctx := t.Context()
			e.put(t, "work", "series.ics",
				"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Standup",
				tt.dtstartLine, tt.dtendLine, "RRULE:FREQ=WEEKLY",
				"DESCRIPTION:Agenda", "ATTENDEE:mailto:bob@example.com",
				"BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Reminder", "TRIGGER:-PT15M", "END:VALARM",
				"END:VEVENT")
			evs, err := e.svc.ListEvents(ctx, e.cals["work"], date(2025, 3, 1, 0, 0), date(2025, 4, 1, 0, 0))
			mustNoErr(t, err)
			if len(evs) == 0 {
				t.Fatal("no occurrences seeded")
			}
			id, etag := evs[0].ID, evs[0].ETag

			up, err := e.svc.UpdateOccurrence(ctx, id, etag, tt.rid, domain.OccurrenceInput{
				Title: "Moved", Description: "Agenda", Start: tt.newStart, End: tt.newEnd, AllDay: tt.allDay,
			})
			mustNoErr(t, err)
			if up.Title != "Moved" || !up.Modified {
				t.Fatalf("unexpected update result %+v", up)
			}

			objPath, _, err := decodeObjectID(e.mock.HomePath(), id)
			mustNoErr(t, err)
			data, ok := e.mock.Object(objPath)
			if !ok {
				t.Fatal("object not stored")
			}
			cal := mustParse(t, data)
			ves := vevents(cal)
			if len(ves) != 2 {
				t.Fatalf("got %d VEVENTs; want 2", len(ves))
			}
			master, override := ves[0], ves[1]
			if master.Props.Get(ical.PropRecurrenceID) != nil {
				t.Error("first VEVENT has a RECURRENCE-ID")
			}
			if override.Props.Get(ical.PropRecurrenceID) == nil {
				t.Fatal("second VEVENT lacks a RECURRENCE-ID")
			}
			wantDateProp(t, override, ical.PropRecurrenceID, tt.wantValue, tt.wantTZID, tt.wantDateOnly)
			wantDateProp(t, override, ical.PropDateTimeStart, tt.wantNewValue, tt.wantTZID, tt.wantDateOnly)
			if override.Props.Get(ical.PropAttendee) == nil {
				t.Error("override lacks ATTENDEE")
			}
			if override.Props.Get(ical.PropDescription) == nil {
				t.Error("override lacks DESCRIPTION")
			}
			if n := len(override.Children); n != 1 || override.Children[0].Name != ical.CompAlarm {
				t.Errorf("override has %d children; want one VALARM", n)
			}
			for _, name := range []string{ical.PropRecurrenceRule, ical.PropRecurrenceDates, ical.PropExceptionDates} {
				if override.Props.Get(name) != nil {
					t.Errorf("override still has %s", name)
				}
			}

			dur := tt.newEnd.Sub(tt.newStart)
			o1Start, o2Start := tt.rid.AddDate(0, 0, -7), tt.rid.AddDate(0, 0, 7)
			evs, err = e.svc.ListEvents(ctx, e.cals["work"], date(2025, 3, 3, 0, 0), date(2025, 3, 18, 0, 0))
			mustNoErr(t, err)
			checkOccurrences(t, evs, []occ{
				{title: "Standup", start: o1Start, end: o1Start.Add(dur), rid: ptr(o1Start), allDay: tt.allDay},
				{title: "Moved", start: tt.newStart, end: tt.newEnd, rid: ptr(tt.rid), allDay: tt.allDay},
				{title: "Standup", start: o2Start, end: o2Start.Add(dur), rid: ptr(o2Start), allDay: tt.allDay},
			})
		})
	}
}

// TestUpdateOccurrenceEditsExistingOverride checks that updating an
// occurrence that already has an override edits it in place, rather than
// adding a second one (spec section 2 step 4, FR-17).
func TestUpdateOccurrenceEditsExistingOverride(t *testing.T) {
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
	evs, err := e.svc.ListEvents(ctx, e.cals["work"], date(2025, 3, 1, 0, 0), date(2025, 4, 1, 0, 0))
	mustNoErr(t, err)
	var inst domain.Event
	for _, ev := range evs {
		if ev.Title == "Special" {
			inst = ev
		}
	}
	if inst.ID == "" {
		t.Fatal("Special occurrence not found")
	}

	rid := date(2025, 3, 17, 8, 0)
	up, err := e.svc.UpdateOccurrence(ctx, inst.ID, inst.ETag, rid, domain.OccurrenceInput{
		Title: "Retro", Start: date(2025, 3, 17, 12, 0), End: date(2025, 3, 17, 13, 0),
	})
	mustNoErr(t, err)
	if up.Title != "Retro" {
		t.Errorf("Title = %q; want Retro", up.Title)
	}

	objPath, _, err := decodeObjectID(e.mock.HomePath(), inst.ID)
	mustNoErr(t, err)
	data, ok := e.mock.Object(objPath)
	if !ok {
		t.Fatal("object not stored")
	}
	ves := vevents(mustParse(t, data))
	if len(ves) != 2 {
		t.Fatalf("got %d VEVENTs; want 2 (no new override added)", len(ves))
	}
	var override *ical.Component
	for _, c := range ves {
		if c.Props.Get(ical.PropRecurrenceID) != nil {
			override = c
		}
	}
	if override == nil {
		t.Fatal("no override VEVENT")
	}
	rp, err := parseDateProp(override.Props.Get(ical.PropRecurrenceID))
	mustNoErr(t, err)
	if !rp.t.Equal(rid) {
		t.Errorf("RECURRENCE-ID = %v; want %v", rp.t, rid)
	}
	if got := text(override.Props, ical.PropSummary); got != "Retro" {
		t.Errorf("SUMMARY = %q; want Retro", got)
	}
}

// TestUpdateOccurrenceOrphan checks that UpdateOccurrence can edit an
// override whose RECURRENCE-ID is not an instance of the rule — one Lucid
// already shows as an orphan (spec section 2 step 2, FR-17).
func TestUpdateOccurrenceOrphan(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	e.put(t, "work", "series.ics",
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Standup",
		"DTSTART;TZID=Europe/Berlin:20250303T090000", "DTEND;TZID=Europe/Berlin:20250303T091500",
		"RRULE:FREQ=WEEKLY;BYDAY=MO",
		"END:VEVENT",
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Extra",
		"RECURRENCE-ID;TZID=Europe/Berlin:20250304T090000", "DTSTART;TZID=Europe/Berlin:20250304T090000",
		"DTEND;TZID=Europe/Berlin:20250304T091500",
		"END:VEVENT")
	ctx := t.Context()
	// 2025-03-04 is a Tuesday: not an instance of the Monday-only rule.
	rid := date(2025, 3, 4, 8, 0)
	evs, err := e.svc.ListEvents(ctx, e.cals["work"], date(2025, 3, 1, 0, 0), date(2025, 4, 1, 0, 0))
	mustNoErr(t, err)
	var orphan domain.Event
	for _, ev := range evs {
		if ev.Title == "Extra" {
			orphan = ev
		}
	}
	if orphan.ID == "" {
		t.Fatal("orphan occurrence not found")
	}

	up, err := e.svc.UpdateOccurrence(ctx, orphan.ID, orphan.ETag, rid, domain.OccurrenceInput{
		Title: "Changed", Start: date(2025, 3, 4, 10, 0), End: date(2025, 3, 4, 10, 15),
	})
	mustNoErr(t, err)
	if up.Title != "Changed" {
		t.Errorf("Title = %q; want Changed", up.Title)
	}

	objPath, _, err := decodeObjectID(e.mock.HomePath(), orphan.ID)
	mustNoErr(t, err)
	data, _ := e.mock.Object(objPath)
	if len(vevents(mustParse(t, data))) != 2 {
		t.Fatalf("expected the orphan's existing override to be reused, not a new one")
	}
}

// TestUpdateOccurrenceUnparseableRule checks that the DTSTART event of a
// series whose rule rrule-go cannot parse, which ListEvents still shows, can
// be changed on its own (FR-17).
func TestUpdateOccurrenceUnparseableRule(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	id := e.put(t, "work", "series.ics",
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Standup",
		"DTSTART:20250303T080000Z", "DTEND:20250303T081500Z", "RRULE:FREQ=WEEKLY;BYDAY=XX",
		"END:VEVENT")
	ctx := t.Context()
	rid := date(2025, 3, 3, 8, 0)
	evs, err := e.svc.ListEvents(ctx, e.cals["work"], date(2025, 3, 1, 0, 0), date(2025, 4, 1, 0, 0))
	mustNoErr(t, err)
	checkOccurrences(t, evs, []occ{{title: "Standup", start: rid, end: rid.Add(15 * time.Minute), rid: ptr(rid)}})

	up, err := e.svc.UpdateOccurrence(ctx, id, evs[0].ETag, rid, domain.OccurrenceInput{
		Title: "Changed", Start: date(2025, 3, 3, 10, 0), End: date(2025, 3, 3, 10, 15),
	})
	mustNoErr(t, err)
	if up.Title != "Changed" || !up.Start.Equal(date(2025, 3, 3, 10, 0)) {
		t.Errorf("got %q at %s; want Changed at 10:00", up.Title, up.Start)
	}

	evs, err = e.svc.ListEvents(ctx, e.cals["work"], date(2025, 3, 1, 0, 0), date(2025, 4, 1, 0, 0))
	mustNoErr(t, err)
	checkOccurrences(t, evs, []occ{
		{title: "Changed", start: date(2025, 3, 3, 10, 0), end: date(2025, 3, 3, 10, 15), rid: ptr(rid)},
	})
}

// TestUpdateOccurrenceEmptyDescription checks that clearing a field on an
// occurrence writes an existing, empty property rather than removing it, so
// the reader (textOr) does not fall back to the series' value (spec section
// 2 step 8, FR-17).
func TestUpdateOccurrenceEmptyDescription(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	e.put(t, "work", "series.ics",
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Standup",
		"DESCRIPTION:Agenda", "DTSTART:20250303T090000Z", "DTEND:20250303T091500Z", "RRULE:FREQ=WEEKLY",
		"END:VEVENT")
	ctx := t.Context()
	rid := date(2025, 3, 10, 9, 0)
	evs, err := e.svc.ListEvents(ctx, e.cals["work"], date(2025, 3, 1, 0, 0), date(2025, 4, 1, 0, 0))
	mustNoErr(t, err)
	id, etag := evs[0].ID, evs[0].ETag

	up, err := e.svc.UpdateOccurrence(ctx, id, etag, rid, domain.OccurrenceInput{
		Title: "Standup", Description: "", Start: rid, End: rid.Add(15 * time.Minute),
	})
	mustNoErr(t, err)
	if up.Description != "" {
		t.Errorf("Description = %q; want empty", up.Description)
	}

	objPath, _, err := decodeObjectID(e.mock.HomePath(), id)
	mustNoErr(t, err)
	data, _ := e.mock.Object(objPath)
	ves := vevents(mustParse(t, data))
	var override *ical.Component
	for _, c := range ves {
		if c.Props.Get(ical.PropRecurrenceID) != nil {
			override = c
		}
	}
	if override == nil {
		t.Fatal("no override VEVENT")
	}
	p := override.Props.Get(ical.PropDescription)
	if p == nil {
		t.Fatal("override lacks a DESCRIPTION property")
	}
	if p.Value != "" {
		t.Errorf("DESCRIPTION value = %q; want empty", p.Value)
	}

	evs, err = e.svc.ListEvents(ctx, e.cals["work"], date(2025, 3, 10, 0, 0), date(2025, 3, 11, 0, 0))
	mustNoErr(t, err)
	if len(evs) != 1 || evs[0].Description != "" {
		t.Fatalf("got %+v; want one occurrence with empty description", evs)
	}
}

// TestUpdateOccurrenceErrors checks the error cases of UpdateOccurrence
// (spec section 2 steps 1-3, FR-17).
func TestUpdateOccurrenceErrors(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	ctx := t.Context()
	e.put(t, "work", "series.ics",
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Standup",
		"DTSTART;TZID=Europe/Berlin:20250303T090000", "DTEND;TZID=Europe/Berlin:20250303T091500",
		"RRULE:FREQ=WEEKLY;BYDAY=MO", "EXDATE;TZID=Europe/Berlin:20250310T090000",
		"END:VEVENT")
	single, err := e.svc.CreateEvent(ctx, e.cals["personal"], domain.EventInput{
		Title: "Once", Start: date(2025, 3, 5, 10, 0), End: date(2025, 3, 5, 11, 0),
	})
	mustNoErr(t, err)

	evs, err := e.svc.ListEvents(ctx, e.cals["work"], date(2025, 3, 1, 0, 0), date(2025, 4, 1, 0, 0))
	mustNoErr(t, err)
	id, etag := evs[0].ID, evs[0].ETag
	in := domain.OccurrenceInput{Title: "x", Start: date(2025, 3, 10, 10, 0), End: date(2025, 3, 10, 10, 15)}

	tests := []struct {
		name string
		id   string
		etag string
		rid  time.Time
		in   domain.OccurrenceInput
		want error
	}{
		{"recurrenceID not an instance", id, etag, date(2025, 3, 11, 8, 0), in, domain.ErrNotFound},
		{"recurrenceID on an EXDATE", id, etag, date(2025, 3, 10, 8, 0), in, domain.ErrNotFound},
		{"single event, no RRULE", single.ID, single.ETag, single.Start, in, domain.ErrNotFound},
		{"allDay mismatch", id, etag, date(2025, 3, 3, 8, 0), domain.OccurrenceInput{Title: "x", AllDay: true, Start: in.Start, End: in.End}, domain.ErrInvalidInput},
		{"wrong etag", id, `"stale"`, date(2025, 3, 3, 8, 0), in, domain.ErrConflict},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			_, err := e.svc.UpdateOccurrence(ctx, tt.id, tt.etag, tt.rid, tt.in)
			mustErr(t, err, tt.want)
		})
	}
}

// exdateInstants returns the parsed instants of all EXDATE values of c.
func exdateInstants(t *testing.T, c *ical.Component) []time.Time {
	t.Helper()
	var out []time.Time
	for _, p := range c.Props.Values(ical.PropExceptionDates) {
		dvs, err := parseDateList(&p)
		mustNoErr(t, err)
		for _, d := range dvs {
			out = append(out, d.t)
		}
	}
	return out
}

// countEqual returns how many of ts equal t.
func countEqual(ts []time.Time, t time.Time) int {
	n := 0
	for _, x := range ts {
		if x.Equal(t) {
			n++
		}
	}
	return n
}

// storedETag returns the ETag the CalDAV server gives the object at
// objPath, read with a GET past Lucid's cache.
func storedETag(t *testing.T, e *env, objPath string) string {
	t.Helper()
	s, ok := e.svc.(*service)
	if !ok {
		t.Fatalf("service is a %T", e.svc)
	}
	_, etag, _, err := s.getObject(t.Context(), objPath)
	mustNoErr(t, err)
	if etag == "" {
		t.Fatal("the server gave no ETag")
	}
	return etag
}

// TestDeleteOccurrence checks that DeleteOccurrence excludes only the
// occurrence at recurrenceID: an EXDATE in the series' form, an existing
// override at the same instant removed in the same write, and the resource
// itself deleted once no occurrence is left. It returns the ETag of the
// resource it keeps, none for one it deletes. No case ever writes
// STATUS:CANCELLED (spec section 2 "DeleteOccurrence", FR-17).
func TestDeleteOccurrence(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name  string
		lines []string
		rid   time.Time
		check func(t *testing.T, e *env, cal *ical.Calendar, stored bool)
	}{
		{
			name: "plain",
			lines: []string{
				"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Standup",
				"DTSTART;TZID=Europe/Berlin:20250303T090000", "DTEND;TZID=Europe/Berlin:20250303T091500",
				"RRULE:FREQ=WEEKLY",
				"END:VEVENT",
			},
			rid: date(2025, 3, 10, 8, 0),
			check: func(t *testing.T, e *env, cal *ical.Calendar, stored bool) {
				t.Helper()
				if !stored {
					t.Fatal("object not stored")
				}
				master := vevents(cal)[0]
				wantDateProp(t, master, ical.PropExceptionDates, "20250310T090000", "Europe/Berlin", false)

				evs, err := e.svc.ListEvents(t.Context(), e.cals["work"], date(2025, 3, 3, 0, 0), date(2025, 3, 18, 0, 0))
				mustNoErr(t, err)
				checkOccurrences(t, evs, []occ{
					{title: "Standup", start: date(2025, 3, 3, 8, 0), end: date(2025, 3, 3, 8, 15), rid: ptr(date(2025, 3, 3, 8, 0))},
					{title: "Standup", start: date(2025, 3, 17, 8, 0), end: date(2025, 3, 17, 8, 15), rid: ptr(date(2025, 3, 17, 8, 0))},
				})
			},
		},
		{
			name: "all-day",
			lines: []string{
				"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Standup",
				"DTSTART;VALUE=DATE:20250303", "DTEND;VALUE=DATE:20250304",
				"RRULE:FREQ=WEEKLY",
				"END:VEVENT",
			},
			rid: date(2025, 3, 10, 0, 0),
			check: func(t *testing.T, e *env, cal *ical.Calendar, stored bool) {
				t.Helper()
				if !stored {
					t.Fatal("object not stored")
				}
				master := vevents(cal)[0]
				wantDateProp(t, master, ical.PropExceptionDates, "20250310", "", true)

				evs, err := e.svc.ListEvents(t.Context(), e.cals["work"], date(2025, 3, 3, 0, 0), date(2025, 3, 18, 0, 0))
				mustNoErr(t, err)
				checkOccurrences(t, evs, []occ{
					{title: "Standup", start: date(2025, 3, 3, 0, 0), end: date(2025, 3, 4, 0, 0), rid: ptr(date(2025, 3, 3, 0, 0)), allDay: true},
					{title: "Standup", start: date(2025, 3, 17, 0, 0), end: date(2025, 3, 18, 0, 0), rid: ptr(date(2025, 3, 17, 0, 0)), allDay: true},
				})
			},
		},
		{
			name: "with override",
			lines: []string{
				"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Standup",
				"DTSTART;TZID=Europe/Berlin:20250303T090000", "DTEND;TZID=Europe/Berlin:20250303T091500",
				"RRULE:FREQ=WEEKLY;BYDAY=MO",
				"END:VEVENT",
				"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Special",
				"RECURRENCE-ID:20250317T080000Z", "DTSTART:20250317T120000Z", "DTEND:20250317T130000Z",
				"END:VEVENT",
			},
			rid: date(2025, 3, 17, 8, 0),
			check: func(t *testing.T, e *env, cal *ical.Calendar, stored bool) {
				t.Helper()
				if !stored {
					t.Fatal("object not stored")
				}
				ves := vevents(cal)
				if len(ves) != 1 {
					t.Fatalf("got %d VEVENTs; want 1 (override removed)", len(ves))
				}
				wantDateProp(t, ves[0], ical.PropExceptionDates, "20250317T090000", "Europe/Berlin", false)
			},
		},
		{
			name: "override and EXDATE already there",
			lines: []string{
				"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Standup",
				"DTSTART;TZID=Europe/Berlin:20250303T090000", "DTEND;TZID=Europe/Berlin:20250303T091500",
				"RRULE:FREQ=WEEKLY;BYDAY=MO", "EXDATE:20250317T080000Z",
				"END:VEVENT",
				"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Special",
				"RECURRENCE-ID:20250317T080000Z", "DTSTART:20250317T120000Z", "DTEND:20250317T130000Z",
				"END:VEVENT",
			},
			rid: date(2025, 3, 17, 8, 0),
			check: func(t *testing.T, e *env, cal *ical.Calendar, stored bool) {
				t.Helper()
				if !stored {
					t.Fatal("object not stored")
				}
				ves := vevents(cal)
				if len(ves) != 1 {
					t.Fatalf("got %d VEVENTs; want 1 (override removed)", len(ves))
				}
				if n := countEqual(exdateInstants(t, ves[0]), date(2025, 3, 17, 8, 0)); n != 1 {
					t.Errorf("EXDATE values at 2025-03-17 = %d; want exactly 1", n)
				}
			},
		},
		{
			name: "first event",
			lines: []string{
				"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Standup",
				"DTSTART;TZID=Europe/Berlin:20250303T090000", "DTEND;TZID=Europe/Berlin:20250303T091500",
				"RRULE:FREQ=WEEKLY",
				"END:VEVENT",
			},
			rid: date(2025, 3, 3, 8, 0),
			check: func(t *testing.T, e *env, cal *ical.Calendar, stored bool) {
				t.Helper()
				if !stored {
					t.Fatal("object not stored")
				}
				evs, err := e.svc.ListEvents(t.Context(), e.cals["work"], date(2025, 3, 3, 0, 0), date(2025, 3, 18, 0, 0))
				mustNoErr(t, err)
				checkOccurrences(t, evs, []occ{
					{title: "Standup", start: date(2025, 3, 10, 8, 0), end: date(2025, 3, 10, 8, 15), rid: ptr(date(2025, 3, 10, 8, 0))},
					{title: "Standup", start: date(2025, 3, 17, 8, 0), end: date(2025, 3, 17, 8, 15), rid: ptr(date(2025, 3, 17, 8, 0))},
				})
			},
		},
		{
			name: "last one left",
			lines: []string{
				"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Standup",
				"DTSTART;TZID=Europe/Berlin:20250303T090000", "DTEND;TZID=Europe/Berlin:20250303T091500",
				"RRULE:FREQ=WEEKLY;COUNT=2", "EXDATE;TZID=Europe/Berlin:20250310T090000",
				"END:VEVENT",
			},
			rid: date(2025, 3, 3, 8, 0),
			check: func(t *testing.T, e *env, cal *ical.Calendar, stored bool) {
				t.Helper()
				if stored {
					t.Fatal("object still stored; want the resource deleted")
				}
			},
		},
		{
			// The rule runs out with this delete, but an RDATE is still an
			// event of the series: the resource stays.
			name: "last rule event, an RDATE left",
			lines: []string{
				"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Standup",
				"DTSTART;TZID=Europe/Berlin:20250303T090000", "DTEND;TZID=Europe/Berlin:20250303T091500",
				"RRULE:FREQ=WEEKLY;COUNT=2", "EXDATE;TZID=Europe/Berlin:20250310T090000",
				"RDATE;TZID=Europe/Berlin:20250312T090000",
				"END:VEVENT",
			},
			rid: date(2025, 3, 3, 8, 0),
			check: func(t *testing.T, e *env, cal *ical.Calendar, stored bool) {
				t.Helper()
				if !stored {
					t.Fatal("object not stored; want the resource kept for its RDATE")
				}
				evs, err := e.svc.ListEvents(t.Context(), e.cals["work"], date(2025, 3, 1, 0, 0), date(2025, 3, 18, 0, 0))
				mustNoErr(t, err)
				checkOccurrences(t, evs, []occ{
					{title: "Standup", start: date(2025, 3, 12, 8, 0), end: date(2025, 3, 12, 8, 15), rid: ptr(date(2025, 3, 12, 8, 0))},
				})
			},
		},
		{
			// The rule runs out with this delete, but an override is still
			// shown: one moved earlier from 03-10, which another client's
			// shorter COUNT has since left off the rule.
			name: "last rule event, a moved override left",
			lines: []string{
				"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Standup",
				"DTSTART;TZID=Europe/Berlin:20250303T090000", "DTEND;TZID=Europe/Berlin:20250303T091500",
				"RRULE:FREQ=WEEKLY;COUNT=1",
				"END:VEVENT",
				"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Moved",
				"RECURRENCE-ID;TZID=Europe/Berlin:20250310T090000",
				"DTSTART;TZID=Europe/Berlin:20250311T130000", "DTEND;TZID=Europe/Berlin:20250311T131500",
				"END:VEVENT",
			},
			rid: date(2025, 3, 3, 8, 0),
			check: func(t *testing.T, e *env, cal *ical.Calendar, stored bool) {
				t.Helper()
				if !stored {
					t.Fatal("object not stored; want the resource kept for its override")
				}
				if n := len(vevents(cal)); n != 2 {
					t.Fatalf("got %d VEVENTs; want 2 (series and override)", n)
				}
				evs, err := e.svc.ListEvents(t.Context(), e.cals["work"], date(2025, 3, 1, 0, 0), date(2025, 3, 18, 0, 0))
				mustNoErr(t, err)
				checkOccurrences(t, evs, []occ{
					{title: "Moved", start: date(2025, 3, 11, 12, 0), end: date(2025, 3, 11, 12, 15), rid: ptr(date(2025, 3, 10, 8, 0))},
				})
			},
		},
		{
			// A rule rrule-go cannot parse still shows its DTSTART event
			// (expandSeries), so that event can be deleted on its own too.
			// Lucid cannot tell which events of the rule are left, so the
			// resource stays, with the EXDATE.
			name: "unparseable rule, its DTSTART event",
			lines: []string{
				"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Standup",
				"DTSTART:20250303T080000Z", "DTEND:20250303T081500Z",
				"RRULE:FREQ=WEEKLY;COUNT=3;BYDAY=XX",
				"END:VEVENT",
			},
			rid: date(2025, 3, 3, 8, 0),
			check: func(t *testing.T, e *env, cal *ical.Calendar, stored bool) {
				t.Helper()
				if !stored {
					t.Fatal("object not stored; want the resource kept for its rule")
				}
				wantDateProp(t, vevents(cal)[0], ical.PropExceptionDates, "20250303T080000Z", "", false)
			},
		},
		{
			// An RFC 7529 rule, which rrule-go cannot read but other clients
			// expand: deleting its DTSTART event, the last event Lucid shows,
			// must not delete the resource and every event those clients
			// still show.
			name: "RSCALE rule, its DTSTART event",
			lines: []string{
				"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Rent",
				"DTSTART;TZID=Europe/Berlin:20250331T090000", "DTEND;TZID=Europe/Berlin:20250331T091500",
				"RRULE:RSCALE=GREGORIAN;FREQ=MONTHLY;SKIP=BACKWARD;UNTIL=20251231T230000Z",
				"END:VEVENT",
			},
			rid: date(2025, 3, 31, 7, 0),
			check: func(t *testing.T, e *env, cal *ical.Calendar, stored bool) {
				t.Helper()
				if !stored {
					t.Fatal("object not stored; want the resource kept for its rule")
				}
				master := vevents(cal)[0]
				wantDateProp(t, master, ical.PropExceptionDates, "20250331T090000", "Europe/Berlin", false)
				if got := rruleString(master); got != "RSCALE=GREGORIAN;FREQ=MONTHLY;SKIP=BACKWARD;UNTIL=20251231T230000Z" {
					t.Errorf("RRULE = %q; want it kept as written", got)
				}
			},
		},
		{
			// A rule ruleInstances cannot parse: expandSeries still treats
			// DTSTART as an instance in that case (events.go), and
			// ListEvents still shows it (03-03), alongside the orphaned
			// override at 03-10. Deleting 03-10 must not delete the
			// resource and lose the still-visible 03-03 event.
			name: "unparseable rule",
			lines: []string{
				"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Standup",
				"DTSTART:20250303T080000Z", "DTEND:20250303T081500Z",
				"RRULE:FREQ=WEEKLY;COUNT=3;BYDAY=XX",
				"END:VEVENT",
				"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Special",
				"RECURRENCE-ID:20250310T080000Z", "DTSTART:20250310T120000Z", "DTEND:20250310T130000Z",
				"END:VEVENT",
			},
			rid: date(2025, 3, 10, 8, 0),
			check: func(t *testing.T, e *env, cal *ical.Calendar, stored bool) {
				t.Helper()
				if !stored {
					t.Fatal("object not stored; want the resource kept (DTSTART is still a visible event)")
				}
				ves := vevents(cal)
				if len(ves) != 1 {
					t.Fatalf("got %d VEVENTs; want 1 (override removed)", len(ves))
				}
				wantDateProp(t, ves[0], ical.PropExceptionDates, "20250310T080000Z", "", false)

				evs, err := e.svc.ListEvents(t.Context(), e.cals["work"], date(2025, 3, 1, 0, 0), date(2025, 3, 18, 0, 0))
				mustNoErr(t, err)
				checkOccurrences(t, evs, []occ{
					{title: "Standup", start: date(2025, 3, 3, 8, 0), end: date(2025, 3, 3, 8, 15), rid: ptr(date(2025, 3, 3, 8, 0))},
				})
			},
		},
		{
			// The override is stored before the series in the resource; a
			// write must still leave the series first (SOGo reads the first
			// VEVENT as the series), even though this delete does not touch
			// the override itself.
			name: "override before master",
			lines: []string{
				"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Special",
				"RECURRENCE-ID:20250317T080000Z", "DTSTART:20250317T120000Z", "DTEND:20250317T130000Z",
				"END:VEVENT",
				"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Standup",
				"DTSTART;TZID=Europe/Berlin:20250303T090000", "DTEND;TZID=Europe/Berlin:20250303T091500",
				"RRULE:FREQ=WEEKLY;BYDAY=MO",
				"END:VEVENT",
			},
			rid: date(2025, 3, 10, 8, 0),
			check: func(t *testing.T, e *env, cal *ical.Calendar, stored bool) {
				t.Helper()
				if !stored {
					t.Fatal("object not stored")
				}
				ves := vevents(cal)
				if len(ves) != 2 {
					t.Fatalf("got %d VEVENTs; want 2 (series and the untouched override)", len(ves))
				}
				if ves[0].Props.Get(ical.PropRecurrenceID) != nil {
					t.Error("first VEVENT has a RECURRENCE-ID; want the series first")
				}
				if got := text(ves[0].Props, ical.PropSummary); got != "Standup" {
					t.Errorf("first VEVENT SUMMARY = %q; want Standup", got)
				}
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			id := e.put(t, "work", "series.ics", tt.lines...)
			ctx := t.Context()
			evs, err := e.svc.ListEvents(ctx, e.cals["work"], date(2025, 3, 1, 0, 0), date(2025, 4, 1, 0, 0))
			mustNoErr(t, err)
			if len(evs) == 0 {
				t.Fatal("no occurrences seeded")
			}
			etag := evs[0].ETag

			next, err := e.svc.DeleteOccurrence(ctx, id, etag, tt.rid)
			mustNoErr(t, err)

			objPath, _, err := decodeObjectID(e.mock.HomePath(), id)
			mustNoErr(t, err)
			data, stored := e.mock.Object(objPath)
			var cal *ical.Calendar
			if stored {
				cal = mustParse(t, data)
				for _, c := range vevents(cal) {
					if strings.EqualFold(text(c.Props, ical.PropStatus), "CANCELLED") {
						t.Error("resource has STATUS:CANCELLED")
					}
				}
				if want := storedETag(t, e, objPath); next != want {
					t.Errorf("returned ETag %q; want the stored resource's %q", next, want)
				}
			} else if next != "" {
				t.Errorf("returned ETag %q for a deleted resource; want none", next)
			}
			tt.check(t, e, cal, stored)
		})
	}
}

// TestDeleteOccurrenceErrors checks the error cases of DeleteOccurrence
// (spec section 2 steps 1-2, FR-17).
func TestDeleteOccurrenceErrors(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	ctx := t.Context()
	e.put(t, "work", "series.ics",
		"BEGIN:VEVENT", "UID:series", "DTSTAMP:20250101T000000Z", "SUMMARY:Standup",
		"DTSTART;TZID=Europe/Berlin:20250303T090000", "DTEND;TZID=Europe/Berlin:20250303T091500",
		"RRULE:FREQ=WEEKLY;BYDAY=MO", "EXDATE;TZID=Europe/Berlin:20250310T090000",
		"END:VEVENT")
	single, err := e.svc.CreateEvent(ctx, e.cals["personal"], domain.EventInput{
		Title: "Once", Start: date(2025, 3, 5, 10, 0), End: date(2025, 3, 5, 11, 0),
	})
	mustNoErr(t, err)

	evs, err := e.svc.ListEvents(ctx, e.cals["work"], date(2025, 3, 1, 0, 0), date(2025, 4, 1, 0, 0))
	mustNoErr(t, err)
	id, etag := evs[0].ID, evs[0].ETag

	tests := []struct {
		name string
		id   string
		etag string
		rid  time.Time
		want error
	}{
		{"recurrenceID not an instance", id, etag, date(2025, 3, 11, 8, 0), domain.ErrNotFound},
		{"single event, no RRULE", single.ID, single.ETag, single.Start, domain.ErrNotFound},
		{"wrong etag", id, `"stale"`, date(2025, 3, 3, 8, 0), domain.ErrConflict},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			next, err := e.svc.DeleteOccurrence(ctx, tt.id, tt.etag, tt.rid)
			mustErr(t, err, tt.want)
			if next != "" {
				t.Errorf("returned ETag %q with an error; want none", next)
			}
		})
	}
}
