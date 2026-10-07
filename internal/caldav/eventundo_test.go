package caldav

import (
	"context"
	"html"
	"io"
	"net/http"
	"path"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/tbckr/lucid/internal/caldav/caldavtest"
	"github.com/tbckr/lucid/internal/domain"
)

// eventSeed is a resource of a recurring series to change and undo, and the
// occurrence the changes are made on (FR-17).
type eventSeed struct {
	name  string
	lines []string  // the components of the resource
	rid   time.Time // RECURRENCE-ID of the second occurrence
}

// eventSeeds are series as other clients write them: in UTC, in a zone with
// an exception and a deleted event, and on whole days.
func eventSeeds() []eventSeed {
	return []eventSeed{
		{
			name: "utc weekly",
			lines: []string{
				"BEGIN:VEVENT", "UID:series", "DTSTAMP:20240101T000000Z", "SUMMARY:Standup",
				"DTSTART:20250310T090000Z", "DTEND:20250310T093000Z", "RRULE:FREQ=WEEKLY;COUNT=6",
				"END:VEVENT",
			},
			rid: date(2025, 3, 17, 9, 0),
		},
		{
			// The second occurrence is the exception, 09:00 CET (08:00Z).
			name: "berlin with an exception and a deleted event",
			lines: slices.Concat(berlinTimezone, []string{
				"BEGIN:VEVENT", "UID:series", "DTSTAMP:20240101T000000Z", "SUMMARY:Standup",
				"DTSTART;TZID=Europe/Berlin:20250310T090000", "DTEND;TZID=Europe/Berlin:20250310T093000",
				"RRULE:FREQ=WEEKLY", "EXDATE;TZID=Europe/Berlin:20250324T090000",
				"END:VEVENT",
				"BEGIN:VEVENT", "UID:series", "DTSTAMP:20240101T000000Z", "SUMMARY:Moved",
				"RECURRENCE-ID;TZID=Europe/Berlin:20250317T090000",
				"DTSTART;TZID=Europe/Berlin:20250317T110000", "DTEND;TZID=Europe/Berlin:20250317T113000",
				"END:VEVENT",
			}),
			rid: date(2025, 3, 17, 8, 0),
		},
		{
			name: "all-day",
			lines: []string{
				"BEGIN:VEVENT", "UID:series", "DTSTAMP:20240101T000000Z", "SUMMARY:Garbage",
				"DTSTART;VALUE=DATE:20250310", "DTEND;VALUE=DATE:20250311", "RRULE:FREQ=WEEKLY;BYDAY=MO",
				"END:VEVENT",
			},
			rid: date(2025, 3, 17, 0, 0),
		},
	}
}

// eventAction is a change of the event ev of a series, as the client makes
// it; it returns what the write returned.
type eventAction struct {
	name string
	do   func(ctx context.Context, e *env, ev domain.Event) (domain.Event, *domain.Snapshot, error)
}

// eventInputOf is what the frontend sends to save ev as it is shown.
func eventInputOf(ev domain.Event) domain.EventInput {
	return domain.EventInput{
		Title: ev.Title, Description: ev.Description, Location: ev.Location,
		Start: ev.Start, End: ev.End, AllDay: ev.AllDay, Timezone: ev.Timezone,
		RRule: ev.RRule, InstanceStart: ev.RecurrenceID,
	}
}

// occurrenceInputOf is what the frontend sends to save ev, shifted by d, as
// the only one changed.
func occurrenceInputOf(ev domain.Event, d time.Duration) domain.OccurrenceInput {
	return domain.OccurrenceInput{
		Title: ev.Title, Description: ev.Description, Location: ev.Location,
		Start: ev.Start.Add(d), End: ev.End.Add(d), AllDay: ev.AllDay, Timezone: ev.Timezone,
	}
}

// eventActions are the changes of a series that can be undone (FR-17).
func eventActions() []eventAction {
	return []eventAction{
		{"all events a day later", func(ctx context.Context, e *env, ev domain.Event) (domain.Event, *domain.Snapshot, error) {
			in := eventInputOf(ev)
			in.Start, in.End = ev.Start.Add(24*time.Hour), ev.End.Add(24*time.Hour)
			return e.svc.UpdateEvent(ctx, ev.ID, ev.ETag, in)
		}},
		{"a new rule", func(ctx context.Context, e *env, ev domain.Event) (domain.Event, *domain.Snapshot, error) {
			in := eventInputOf(ev)
			in.RRule = "FREQ=DAILY;COUNT=3"
			return e.svc.UpdateEvent(ctx, ev.ID, ev.ETag, in)
		}},
		{"no longer repeats", func(ctx context.Context, e *env, ev domain.Event) (domain.Event, *domain.Snapshot, error) {
			in := eventInputOf(ev)
			in.RRule = ""
			return e.svc.UpdateEvent(ctx, ev.ID, ev.ETag, in)
		}},
		{"only this moved", func(ctx context.Context, e *env, ev domain.Event) (domain.Event, *domain.Snapshot, error) {
			// An hour later, but a day for an all-day event, which carries
			// dates only.
			d := time.Hour
			if ev.AllDay {
				d = 24 * time.Hour
			}
			return e.svc.UpdateOccurrence(ctx, ev.ID, ev.ETag, *ev.RecurrenceID, occurrenceInputOf(ev, d))
		}},
		{"delete only this", func(ctx context.Context, e *env, ev domain.Event) (domain.Event, *domain.Snapshot, error) {
			_, snap, err := e.svc.DeleteOccurrence(ctx, ev.ID, ev.ETag, *ev.RecurrenceID)
			return domain.Event{}, snap, err
		}},
		{"delete this and following", func(ctx context.Context, e *env, ev domain.Event) (domain.Event, *domain.Snapshot, error) {
			_, snap, err := e.svc.DeleteFollowing(ctx, ev.ID, ev.ETag, *ev.RecurrenceID)
			return domain.Event{}, snap, err
		}},
		{"this and following moved", func(ctx context.Context, e *env, ev domain.Event) (domain.Event, *domain.Snapshot, error) {
			// An hour later, but a day for an all-day event.
			d := time.Hour
			if ev.AllDay {
				d = 24 * time.Hour
			}
			in := eventInputOf(ev)
			in.Start, in.End = ev.Start.Add(d), ev.End.Add(d)
			res, snap, err := e.svc.UpdateFollowing(ctx, ev.ID, ev.ETag, *ev.RecurrenceID, in)
			return res.Event, snap, err
		}},
	}
}

// Undoing a change of a recurring series writes back the resource exactly as
// the change read it, whatever other clients recorded in it (FR-17).
func TestRestoreEvent(t *testing.T) {
	t.Parallel()
	for _, sd := range eventSeeds() {
		for _, a := range eventActions() {
			t.Run(sd.name+", "+a.name, func(t *testing.T) {
				t.Parallel()
				e := newEnv(t, caldavtest.Options{})
				ctx := t.Context()
				id := e.put(t, "work", "series.ics", sd.lines...)
				seeded := storedObject(t, e, id)
				ev := shownEvent(t, e, "work", sd.rid)

				_, snap, err := a.do(ctx, e, ev)
				mustNoErr(t, err)
				if snap == nil {
					t.Fatal("the change returned no snapshot")
				}
				if snap.Kind != domain.SnapshotEvent || snap.ID != id || snap.ETag == "" {
					t.Errorf("snapshot = %+v; want an event snapshot of %s with the ETag after the change", snap, id)
				}
				if string(snap.Data) != seeded {
					t.Errorf("snapshot data:\n%s\nwant the seeded resource:\n%s", snap.Data, seeded)
				}
				if changed := storedObject(t, e, id); changed == seeded {
					t.Fatalf("the change left the resource as it was:\n%s", changed)
				}

				res, err := e.svc.RestoreEvent(ctx, *snap)
				mustNoErr(t, err)
				if res.ETag == "" || res.CopyKept {
					t.Errorf("restore = %+v; want the new ETag and no copy kept", res)
				}
				if got := storedObject(t, e, id); got != seeded {
					t.Errorf("restored resource:\n%s\nwant the seeded one:\n%s", got, seeded)
				}
				if paths := e.mock.ObjectPaths(e.paths["work"]); len(paths) != 1 {
					t.Errorf("objects = %v; want the series only", paths)
				}
			})
		}
	}
}

// TestRestoreSplit undoes "this and following events" (FR-17; spec section
// 6): the series S is written back as the split read it, and the new series
// N goes, as it has the ETag the split gave it. If N changed since, in Lucid
// or in another app, the undo is refused and nothing is written: S restored
// next to N would show every event from R on twice, and deleting N would
// lose that change. N gone since leaves nothing to delete. Only N changed
// between that check and its delete stays next to S restored, reported
// (Review Focus 4).
func TestRestoreSplit(t *testing.T) {
	t.Parallel()
	// split moves the fourth event of the weekly standup and the following
	// ones an hour later, and returns S's ID, S as seeded, N's path and the
	// snapshot.
	split := func(t *testing.T, e *env) (id, seeded, nPath string, snap domain.Snapshot) {
		t.Helper()
		id = e.put(t, "work", "series.ics", weeklyStandup()...)
		seeded = storedObject(t, e, id)
		ev := shownEvent(t, e, "work", date(2025, 3, 24, 8, 0))
		in := eventInputOf(ev)
		in.Start, in.End = ev.Start.Add(time.Hour), ev.End.Add(time.Hour)
		res, s, err := e.svc.UpdateFollowing(t.Context(), id, ev.ETag, *ev.RecurrenceID, in)
		mustNoErr(t, err)
		if s == nil {
			t.Fatal("UpdateFollowing returned no snapshot")
		}
		return id, seeded, mustDecode(t, e, res.Event.ID), *s
	}
	// refused asserts that RestoreEvent refuses snap with want, writing
	// nothing: S stays as the split left it, and N as it is now.
	refused := func(t *testing.T, e *env, id, nPath string, snap domain.Snapshot, want error) {
		t.Helper()
		s := storedObject(t, e, id)
		n, ok := e.mock.Object(nPath)
		if !ok {
			t.Fatalf("no new series at %s", nPath)
		}
		e.mock.ResetCounts()
		res, err := e.svc.RestoreEvent(t.Context(), snap)
		mustErr(t, err, want)
		if res != (domain.EventRestore{}) {
			t.Errorf("restore = %+v; want nothing with an error", res)
		}
		if writes := e.mock.Count(http.MethodPut) + e.mock.Count(http.MethodDelete); writes != 0 {
			t.Errorf("%d writes; want none", writes)
		}
		if got := storedObject(t, e, id); got != s {
			t.Errorf("series:\n%s\nwant it as the split left it:\n%s", got, s)
		}
		if got, _ := e.mock.Object(nPath); got != n {
			t.Errorf("new series:\n%s\nwant it unchanged:\n%s", got, n)
		}
	}
	// answerPropfind makes the mock answer a PROPFIND of objPath with the
	// multistatus of getetag, a property element, or with status, if set.
	answerPropfind := func(e *env, objPath string, status int, getetag string) {
		e.mock.SetHook(func(w http.ResponseWriter, r *http.Request) bool {
			if r.Method != "PROPFIND" || r.URL.Path != objPath {
				return false
			}
			if status != 0 {
				w.WriteHeader(status)
				return true
			}
			w.WriteHeader(http.StatusMultiStatus)
			_, _ = io.WriteString(w, `<d:multistatus xmlns:d="DAV:"><d:response><d:href>`+objPath+`</d:href>`+
				`<d:propstat><d:prop>`+getetag+`</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>`+
				`</d:response></d:multistatus>`)
			return true
		})
	}

	t.Run("the new series as the split left it", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id, seeded, _, snap := split(t, e)
		e.mock.ResetCounts()

		res, err := e.svc.RestoreEvent(t.Context(), snap)
		mustNoErr(t, err)
		if res.ETag == "" || res.CopyKept {
			t.Errorf("restore = %+v; want the new ETag and the new series gone", res)
		}
		if got := storedObject(t, e, id); got != seeded {
			t.Errorf("restored series:\n%s\nwant the seeded one:\n%s", got, seeded)
		}
		if paths := e.mock.ObjectPaths(e.paths["work"]); !slices.Equal(paths, []string{mustDecode(t, e, id)}) {
			t.Errorf("objects = %v; want the series only", paths)
		}
		if n := e.mock.Count(http.MethodPut) + e.mock.Count(http.MethodDelete); n != 2 {
			t.Errorf("%d writes; want S's PUT and N's DELETE", n)
		}
		// The cache shows the undo at once: R is back at its time.
		if shown := listedEvents(t, e); len(shown) != 9 ||
			!slices.Contains(shown, "2025-03-24T08:00:00Z/2025-03-24T09:00:00Z Standup") {
			t.Errorf("shown after the undo = %q; want the nine events of the series as seeded", shown)
		}
	})

	t.Run("the new series changed in another app", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id, _, nPath, snap := split(t, e)
		n, ok := e.mock.Object(nPath)
		if !ok {
			t.Fatalf("no new series at %s", nPath)
		}
		changed := strings.Replace(n, "SUMMARY:Standup", "SUMMARY:Retro", 1)
		if _, err := e.mock.PutObject(e.paths["work"], path.Base(nPath), changed); err != nil {
			t.Fatalf("PutObject: %v", err)
		}
		refused(t, e, id, nPath, snap, domain.ErrConflict)
	})

	t.Run("the new series changed in Lucid", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id, _, nPath, snap := split(t, e)
		// The second event of N, March 31, 10:00 in Berlin summer time.
		ev := shownEvent(t, e, "work", date(2025, 3, 31, 8, 0))
		if ev.ID != encodeID(nPath) {
			t.Fatalf("event = %+v; want one of the new series", ev)
		}
		_, _, err := e.svc.UpdateOccurrence(t.Context(), ev.ID, ev.ETag, *ev.RecurrenceID, occurrenceInputOf(ev, time.Hour))
		mustNoErr(t, err)
		refused(t, e, id, nPath, snap, domain.ErrConflict)
	})

	// Read without an ETag, or with a weak one, N cannot be told from one
	// changed since.
	t.Run("the new series' ETag unknown", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id, _, nPath, snap := split(t, e)
		answerPropfind(e, nPath, 0, "")
		refused(t, e, id, nPath, snap, domain.ErrConflict)
	})

	t.Run("the new series' ETag weak", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id, _, nPath, snap := split(t, e)
		// The split's own ETag, but weak: If-Match compares strongly.
		answerPropfind(e, nPath, 0, "<d:getetag>W/"+html.EscapeString(snap.Created[0].ETag)+"</d:getetag>")
		refused(t, e, id, nPath, snap, domain.ErrConflict)
	})

	// The undo can be tried again: see settleUndo.
	t.Run("the new series cannot be read", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id, _, nPath, snap := split(t, e)
		answerPropfind(e, nPath, http.StatusInternalServerError, "")
		refused(t, e, id, nPath, snap, domain.ErrUpstream)
	})

	// The services never hand out such a ref, but a snapshot could carry one.
	t.Run("a new series outside the calendar home", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id, _, nPath, snap := split(t, e)
		snap.Created = []domain.CreatedRef{{ID: encodeID("/elsewhere/new.ics"), ETag: snap.Created[0].ETag}}
		refused(t, e, id, nPath, snap, domain.ErrNotFound)
	})

	t.Run("the new series deleted since", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id, seeded, nPath, snap := split(t, e)
		mustNoErr(t, e.svc.DeleteEvent(t.Context(), encodeID(nPath), storedETag(t, e, nPath)))
		e.mock.ResetCounts()

		res, err := e.svc.RestoreEvent(t.Context(), snap)
		mustNoErr(t, err)
		if res.ETag == "" || res.CopyKept {
			t.Errorf("restore = %+v; want the new ETag and nothing kept", res)
		}
		if got := storedObject(t, e, id); got != seeded {
			t.Errorf("restored series:\n%s\nwant the seeded one:\n%s", got, seeded)
		}
		if paths := e.mock.ObjectPaths(e.paths["work"]); !slices.Equal(paths, []string{mustDecode(t, e, id)}) {
			t.Errorf("objects = %v; want the series only", paths)
		}
		if puts, deletes := e.mock.Count(http.MethodPut), e.mock.Count(http.MethodDelete); puts != 1 || deletes != 0 {
			t.Errorf("%d PUTs and %d DELETEs; want S's PUT only", puts, deletes)
		}
	})

	// Changed after the check, as the restore writes S, N stays: deleting it
	// would lose that change.
	t.Run("the new series changed after the check", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id, seeded, nPath, snap := split(t, e)
		n, ok := e.mock.Object(nPath)
		if !ok {
			t.Fatalf("no new series at %s", nPath)
		}
		changed := strings.Replace(n, "SUMMARY:Standup", "SUMMARY:Retro", 1)
		sPath := mustDecode(t, e, id)
		e.mock.SetHook(func(_ http.ResponseWriter, r *http.Request) bool {
			if r.Method == http.MethodPut && r.URL.Path == sPath {
				if _, err := e.mock.PutObject(e.paths["work"], path.Base(nPath), changed); err != nil {
					t.Errorf("PutObject: %v", err)
				}
			}
			return false
		})

		res, err := e.svc.RestoreEvent(t.Context(), snap)
		mustNoErr(t, err)
		if res.ETag == "" || !res.CopyKept {
			t.Errorf("restore = %+v; want the new ETag and the new series kept", res)
		}
		if got := storedObject(t, e, id); got != seeded {
			t.Errorf("restored series:\n%s\nwant the seeded one:\n%s", got, seeded)
		}
		if got, _ := e.mock.Object(nPath); got != changed {
			t.Errorf("new series:\n%s\nwant it as the other app changed it:\n%s", got, changed)
		}
	})
}

// An undo writes nothing over a later change of the series, and only
// restores for the account that made the change, a snapshot of an event, with
// an ETag, in a calendar that is writable (FR-17).
func TestRestoreEventFailures(t *testing.T) {
	t.Parallel()
	seed := eventSeeds()[0]
	// change moves the second occurrence of the seeded series an hour later
	// and returns the series' ID, its ETag after the change, and the snapshot.
	change := func(t *testing.T, e *env) (id string, ev domain.Event, snap domain.Snapshot) {
		t.Helper()
		id = e.put(t, "work", "series.ics", seed.lines...)
		ev = shownEvent(t, e, "work", seed.rid)
		moved, s, err := e.svc.UpdateOccurrence(t.Context(), id, ev.ETag, *ev.RecurrenceID, occurrenceInputOf(ev, time.Hour))
		mustNoErr(t, err)
		if s == nil {
			t.Fatal("UpdateOccurrence returned no snapshot")
		}
		ev.ETag = moved.ETag
		return id, ev, *s
	}
	// refused asserts that RestoreEvent refuses snap with want, after puts
	// PUTs the server rejected, and that nothing is written.
	refused := func(t *testing.T, e *env, id string, snap domain.Snapshot, want error, puts int) {
		t.Helper()
		before := storedObject(t, e, id)
		e.mock.ResetCounts()
		_, err := e.svc.RestoreEvent(t.Context(), snap)
		mustErr(t, err, want)
		if n := e.mock.Count(http.MethodPut); n != puts {
			t.Errorf("%d PUTs; want %d", n, puts)
		}
		if n := e.mock.Count(http.MethodDelete); n != 0 {
			t.Errorf("%d DELETEs; want none", n)
		}
		if got := storedObject(t, e, id); got != before {
			t.Errorf("series:\n%s\nwant unchanged:\n%s", got, before)
		}
	}

	t.Run("changed since", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id, ev, snap := change(t, e)
		_, _, err := e.svc.UpdateOccurrence(t.Context(), id, ev.ETag, *ev.RecurrenceID, occurrenceInputOf(ev, 2*time.Hour))
		mustNoErr(t, err)
		// The server rejects the restore's PUT: its If-Match no longer holds.
		refused(t, e, id, snap, domain.ErrConflict, 1)
		checkStored(t, "series", storedObject(t, e, id), []string{"DTSTART:20250317T110000Z"}, nil)
	})

	t.Run("another account", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id, _, snap := change(t, e)
		snap.Account = "other"
		refused(t, e, id, snap, domain.ErrNotFound, 0)
	})

	t.Run("a snapshot of a todo", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id, _, snap := change(t, e)
		snap.Kind = domain.SnapshotTodo
		refused(t, e, id, snap, domain.ErrNotFound, 0)
	})

	t.Run("no etag", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id, _, snap := change(t, e)
		snap.ETag = ""
		refused(t, e, id, snap, domain.ErrNotFound, 0)
	})

	t.Run("read-only calendar", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id, _, snap := change(t, e)
		snap.ID = encodeID(e.paths["holidays"] + "series.ics")
		refused(t, e, id, snap, domain.ErrReadOnly, 0)
	})
}

// A change that leaves no series to restore, or whose new ETag is unknown,
// hands out no snapshot: an undo could not tell its own change from another
// client's (FR-17).
func TestEventWritesWithoutSnapshot(t *testing.T) {
	t.Parallel()

	t.Run("single event", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		e.put(t, "work", "once.ics",
			"BEGIN:VEVENT", "UID:once", "DTSTAMP:20240101T000000Z", "SUMMARY:Once",
			"DTSTART:20250310T090000Z", "DTEND:20250310T093000Z", "END:VEVENT")
		evs, err := e.svc.ListEvents(t.Context(), e.cals["work"], date(2025, 3, 1, 0, 0), date(2025, 4, 1, 0, 0))
		mustNoErr(t, err)
		if len(evs) != 1 {
			t.Fatalf("events = %+v; want the single event", evs)
		}
		in := eventInputOf(evs[0])
		in.Title = "Changed"
		up, snap, err := e.svc.UpdateEvent(t.Context(), evs[0].ID, evs[0].ETag, in)
		mustNoErr(t, err)
		if up.Title != "Changed" || snap != nil {
			t.Errorf("update = %+v, snapshot returned: %v; want the change and no snapshot", up, snap != nil)
		}
	})

	// Deleting the last event deletes the resource, so there is no series to
	// restore.
	t.Run("last event deleted", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := e.put(t, "work", "series.ics",
			"BEGIN:VEVENT", "UID:series", "DTSTAMP:20240101T000000Z", "SUMMARY:Once",
			"DTSTART:20250310T090000Z", "DTEND:20250310T093000Z", "RRULE:FREQ=DAILY;COUNT=1", "END:VEVENT")
		ev := shownEvent(t, e, "work", date(2025, 3, 10, 9, 0))
		next, snap, err := e.svc.DeleteOccurrence(t.Context(), id, ev.ETag, *ev.RecurrenceID)
		mustNoErr(t, err)
		if next != "" || snap != nil {
			t.Errorf("DeleteOccurrence = %q, snapshot returned: %v; want neither", next, snap != nil)
		}
		if paths := e.mock.ObjectPaths(e.paths["work"]); len(paths) != 0 {
			t.Errorf("objects = %v; want none", paths)
		}
	})

	// With attendees the server may have scheduled the change with the
	// SEQUENCE it carries, and a restore would write an older one back (RFC
	// 5545 section 3.8.7.4), so there is none (FR-17). The resource is judged
	// as the change read it: deleting the one override that has the attendees
	// leaves none, but it had them.
	attendees := []string{"ORGANIZER:mailto:boss@example.com", "ATTENDEE;PARTSTAT=ACCEPTED:mailto:me@example.com"}
	series := func(extra ...string) []string {
		return slices.Concat([]string{
			"BEGIN:VEVENT", "UID:series", "DTSTAMP:20240101T000000Z", "SUMMARY:Standup",
			"DTSTART:20250310T090000Z", "DTEND:20250310T093000Z", "RRULE:FREQ=WEEKLY;COUNT=6",
		}, extra, []string{"END:VEVENT"})
	}
	override := func(extra ...string) []string {
		return slices.Concat([]string{
			"BEGIN:VEVENT", "UID:series", "DTSTAMP:20240101T000000Z", "SUMMARY:Moved",
			"RECURRENCE-ID:20250317T090000Z", "DTSTART:20250317T110000Z", "DTEND:20250317T113000Z",
		}, extra, []string{"END:VEVENT"})
	}
	// noSnapshotWithAttendees changes the series of lines at rid in every way
	// that can be undone otherwise.
	noSnapshotWithAttendees := func(t *testing.T, lines []string, rid time.Time) {
		t.Helper()
		for _, a := range eventActions() {
			if a.name != "all events a day later" && a.name != "only this moved" && a.name != "delete only this" {
				continue
			}
			t.Run(a.name, func(t *testing.T) {
				t.Parallel()
				e := newEnv(t, caldavtest.Options{})
				id := e.put(t, "work", "series.ics", lines...)
				seeded := storedObject(t, e, id)
				ev := shownEvent(t, e, "work", rid)

				_, snap, err := a.do(t.Context(), e, ev)
				mustNoErr(t, err)
				if snap != nil {
					t.Error("returned a snapshot; want none for a series with attendees")
				}
				if storedObject(t, e, id) == seeded {
					t.Error("the change did not write")
				}
			})
		}
	}

	t.Run("attendees on the series", func(t *testing.T) {
		t.Parallel()
		noSnapshotWithAttendees(t, series(attendees...), date(2025, 3, 17, 9, 0))
	})

	t.Run("an organizer only", func(t *testing.T) {
		t.Parallel()
		noSnapshotWithAttendees(t, series(attendees[0]), date(2025, 3, 17, 9, 0))
	})

	// The occurrence the change is made on has no attendees itself.
	t.Run("attendees on an override", func(t *testing.T) {
		t.Parallel()
		noSnapshotWithAttendees(t, slices.Concat(series(), override(attendees...)), date(2025, 3, 24, 9, 0))
	})

	// The change replaces or deletes the override that has the attendees.
	t.Run("attendees on the changed override", func(t *testing.T) {
		t.Parallel()
		noSnapshotWithAttendees(t, slices.Concat(series(), override(attendees...)), date(2025, 3, 17, 9, 0))
	})

	t.Run("unknown new etag", func(t *testing.T) {
		t.Parallel()
		seed := eventSeeds()[0]
		for _, a := range eventActions() {
			if a.name != "all events a day later" && a.name != "only this moved" && a.name != "delete only this" &&
				a.name != "delete this and following" {
				continue
			}
			t.Run(a.name, func(t *testing.T) {
				t.Parallel()
				e := newEnv(t, caldavtest.Options{})
				id := e.put(t, "work", "series.ics", seed.lines...)
				seeded := storedObject(t, e, id)
				ev := shownEvent(t, e, "work", seed.rid)
				objPath, _, err := decodeObjectID(e.mock.HomePath(), id)
				mustNoErr(t, err)
				answerWithoutETag(e.mock, objPath)

				up, snap, err := a.do(t.Context(), e, ev)
				mustNoErr(t, err)
				if snap != nil {
					t.Error("returned a snapshot; want none without the new ETag")
				}
				if up.ETag != "" {
					t.Errorf("event = %+v; want the ETag unknown", up)
				}
				if storedObject(t, e, id) == seeded {
					t.Error("the change did not write")
				}
			})
		}
	})
}
