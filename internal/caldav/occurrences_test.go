package caldav

import (
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
