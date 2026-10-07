package caldav

import (
	"net/http"
	"path"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/tbckr/lucid/internal/caldav/caldavtest"
	"github.com/tbckr/lucid/internal/domain"
)

// repeatsOf returns the recurrence IDs of the repeats of the series id that
// ListTodoOccurrences reports from February to May 2025, by state: those a
// client picks one from (FR-17).
func repeatsOf(t *testing.T, e *env, id string) map[string][]time.Time {
	t.Helper()
	occs, err := e.svc.ListTodoOccurrences(t.Context(), e.cals["tasks"], date(2025, 2, 1, 0, 0), date(2025, 6, 1, 0, 0))
	mustNoErr(t, err)
	out := map[string][]time.Time{}
	for i := range occs {
		if o := &occs[i]; o.TodoID == id {
			out[o.State] = append(out[o.State], o.RecurrenceID)
		}
	}
	return out
}

// currentRepeat returns the recurrence ID of the current repeat of the
// series id, as ListTodoOccurrences reports it.
func currentRepeat(t *testing.T, e *env, id string) time.Time {
	t.Helper()
	cur := repeatsOf(t, e, id)[domain.OccurrenceCurrent]
	if len(cur) != 1 {
		t.Fatalf("current repeats = %v; want one", cur)
	}
	return cur[0]
}

// mustWriteNothing asserts that a change made after the mock's counts were
// reset wrote nothing: no PUT or DELETE, and the series id is still seeded,
// alone in the calendar.
func mustWriteNothing(t *testing.T, e *env, id, seeded string) {
	t.Helper()
	if n := e.mock.Count(http.MethodPut) + e.mock.Count(http.MethodDelete); n != 0 {
		t.Errorf("%d writes; want none", n)
	}
	if stored := storedObject(t, e, id); stored != seeded {
		t.Errorf("stored resource:\n%s\nwant it unchanged:\n%s", stored, seeded)
	}
	if paths := e.mock.ObjectPaths(e.paths["tasks"]); len(paths) != 1 {
		t.Errorf("objects = %v; want the series only", paths)
	}
}

// storedDetached returns the stored data of the detached copy in got.
func storedDetached(t *testing.T, e *env, got *domain.Todo) string {
	t.Helper()
	if got.DetachedCopy == nil {
		t.Fatalf("no detached copy in %+v", got)
	}
	return storedObject(t, e, got.DetachedCopy.ID)
}

// detachCurrent detaches the current repeat of the series id with the input
// in(f) as a client sends it for the todo f as listed, and returns the
// answer and its snapshot.
func detachCurrent(t *testing.T, e *env, id string, in func(f *domain.Todo) domain.TodoInput) (domain.Todo, *domain.Snapshot) {
	t.Helper()
	f := listedTodo(t, e, id)
	got, snap, err := e.svc.DetachTodoOccurrence(t.Context(), id, f.ETag, currentRepeat(t, e, id), in(&f))
	mustNoErr(t, err)
	return got, snap
}

// staleRepeats are repeats a view not reloaded since may still show that are
// no open repeats of their series any more: done, rolled past, excluded,
// cancelled, or never one of it, of a series that is still open or of one
// that is not (FR-17).
var staleRepeats = []struct {
	name      string
	master    []string
	overrides [][]string
	rid       time.Time
}{
	{
		name:      "a repeat another app completed",
		master:    []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY"},
		overrides: [][]string{{"RECURRENCE-ID:20250310T090000Z", "STATUS:COMPLETED"}},
		rid:       date(2025, 3, 10, 9, 0),
	},
	{
		name:      "a later repeat another app completed",
		master:    []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY"},
		overrides: [][]string{{"RECURRENCE-ID:20250317T090000Z", "STATUS:COMPLETED"}},
		rid:       date(2025, 3, 17, 9, 0),
	},
	{
		name:   "a repeat the series rolled past",
		master: []string{"DTSTART:20250317T090000Z", "RRULE:FREQ=WEEKLY"},
		rid:    date(2025, 3, 10, 9, 0),
	},
	{
		name:   "no repeat of the series",
		master: []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY"},
		rid:    date(2025, 3, 11, 9, 0),
	},
	{
		name:   "an excluded repeat",
		master: []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY", "EXDATE:20250317T090000Z"},
		rid:    date(2025, 3, 17, 9, 0),
	},
	{
		name:      "a cancelled repeat",
		master:    []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY"},
		overrides: [][]string{{"RECURRENCE-ID:20250317T090000Z", "STATUS:CANCELLED"}},
		rid:       date(2025, 3, 17, 9, 0),
	},
	{
		name:   "a completed series",
		master: []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY", "STATUS:COMPLETED", "COMPLETED:20250305T100000Z"},
		rid:    date(2025, 3, 10, 9, 0),
	},
	{
		name:   "a task without a rule",
		master: []string{"DTSTART:20250310T090000Z"},
		rid:    date(2025, 3, 10, 9, 0),
	},
}

// The routes of one repeat read the todo as UpdateTodo does, and refuse
// alike, before anything is written: a missing ETag, a calendar Lucid may
// not write, a todo that is gone, and a resource of an event (FR-17).
func TestLoadTodoRepeatRefuses(t *testing.T) {
	t.Parallel()
	weekly := []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY"}
	rid := date(2025, 3, 10, 9, 0)
	for _, tc := range []struct {
		name string
		// id seeds what the request names and returns its ID and ETag.
		id   func(t *testing.T, e *env) (id, etag string)
		want error
	}{
		{"no etag", func(t *testing.T, e *env) (string, string) {
			t.Helper()
			return seedSeries(t, e, weekly), ""
		}, domain.ErrInvalidInput},
		{"a read-only calendar", func(t *testing.T, e *env) (string, string) {
			t.Helper()
			return e.put(t, "holidays", "r.ics", "BEGIN:VTODO", "UID:r", "DTSTAMP:20240101T000000Z", "SUMMARY:Series",
				"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY", "END:VTODO"), `"x"`
		}, domain.ErrReadOnly},
		{"a todo that is gone", func(t *testing.T, e *env) (string, string) {
			t.Helper()
			id := seedSeries(t, e, weekly)
			f := listedTodo(t, e, id)
			mustNoErr(t, e.svc.DeleteTodo(t.Context(), id, f.ETag))
			return id, f.ETag
		}, domain.ErrNotFound},
		{"an event", func(t *testing.T, e *env) (string, string) {
			t.Helper()
			id := e.put(t, "work", "ev.ics", "BEGIN:VEVENT", "UID:ev", "DTSTAMP:20240101T000000Z", "SUMMARY:Event",
				"DTSTART:20250310T090000Z", "DTEND:20250310T100000Z", "RRULE:FREQ=WEEKLY", "END:VEVENT")
			// Its ETag as the server tells it, so that only its kind refuses.
			objPath, _, err := decodeObjectID(e.mock.HomePath(), id)
			mustNoErr(t, err)
			etag, err := e.svc.(*service).objectETag(t.Context(), objPath)
			mustNoErr(t, err)
			return id, etag
		}, domain.ErrNotFound},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			id, etag := tc.id(t, e)
			e.mock.ResetCounts()
			_, _, err := e.svc.DetachTodoOccurrence(t.Context(), id, etag, rid, domain.TodoInput{Title: "x", RRuleOmitted: true})
			mustErr(t, err, tc.want)
			_, _, err = e.svc.SkipTodoOccurrence(t.Context(), id, etag, rid)
			mustErr(t, err, tc.want)
			if n := e.mock.Count(http.MethodPut) + e.mock.Count(http.MethodDelete); n != 0 {
				t.Errorf("%d writes; want none", n)
			}
		})
	}
}

// Detaching the current repeat of a task series makes it a task of its own,
// changed as the client asks, while the series rolls on to its next repeat
// unchanged (FR-17; Review Focus 1 and 5).
func TestDetachTodoOccurrence(t *testing.T) {
	t.Parallel()

	// Review Focus 1: the copy is the repeat at its new time, under its new
	// title, open, with its alarm, its checklist as checked and its origin;
	// the series goes on at its own time on its next day, under its own
	// title, with its checklist unchecked.
	t.Run("the copy takes the change, the series keeps its time and title", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{
			"DTSTART;TZID=Europe/Berlin:20250310T090000", "DUE;TZID=Europe/Berlin:20250310T100000",
			"RRULE:FREQ=WEEKLY;BYDAY=MO,TH", "PRIORITY:3", `DESCRIPTION:Notes\n\n- [x] a`, "PERCENT-COMPLETE:40", "X-FOO:bar",
			"BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-PT15M", "DESCRIPTION:Reminder", "END:VALARM",
		})
		seeded := storedObject(t, e, id)
		got, snap := detachCurrent(t, e, id, func(f *domain.Todo) domain.TodoInput {
			in := movedBy(f, time.Hour)
			in.Title = "Renamed"
			return in
		})

		if got.Title != "Series" || got.Priority != 3 || got.Description != "Notes" || got.Status != domain.TodoNeedsAction ||
			!reflect.DeepEqual(got.Checklist, []domain.ChecklistItem{{Text: "a"}}) || got.DetachedFrom != "" || got.CompletedCopy != nil ||
			!sameTime(got.Start, ptr(date(2025, 3, 13, 8, 0))) || !sameTime(got.Due, ptr(date(2025, 3, 13, 9, 0))) ||
			!sameNext(got.Next, &domain.TodoDates{Start: ptr(date(2025, 3, 17, 8, 0)), Due: ptr(date(2025, 3, 17, 9, 0))}) {
			t.Errorf("rolled series = %+v; want it at Thursday 09:00, as it was", got)
		}
		c := got.DetachedCopy
		if c == nil {
			t.Fatalf("no detached copy in %+v", got)
		}
		if c.Title != "Renamed" || c.Priority != 3 || c.Description != "Notes" || c.Status != domain.TodoNeedsAction ||
			!reflect.DeepEqual(c.Checklist, []domain.ChecklistItem{{Text: "a", Done: true}}) || c.Completed != nil ||
			!sameTime(c.Start, ptr(date(2025, 3, 10, 9, 0))) || !sameTime(c.Due, ptr(date(2025, 3, 10, 10, 0))) ||
			c.Recurring || c.DetachedFrom != "r" || c.ID == id || c.UID == "r" || c.ETag == "" || c.CalendarID != e.cals["tasks"] {
			t.Errorf("detached copy = %+v; want the renamed repeat at Monday 10:00", c)
		}
		checkStored(t, "series", storedObject(t, e, id), []string{
			"DTSTART;TZID=Europe/Berlin:20250313T090000", "DUE;TZID=Europe/Berlin:20250313T100000",
			"RRULE:FREQ=WEEKLY;BYDAY=MO,TH\r\n", "SUMMARY:Series", `DESCRIPTION:Notes\n\n- [ ] a`, "PRIORITY:3",
			"STATUS:NEEDS-ACTION", "BEGIN:VALARM", "TRIGGER:-PT15M", "X-FOO:bar",
		}, []string{"Renamed", "PERCENT-COMPLETE", "COMPLETED", "X-LUCID-DETACHED-FROM"})
		checkStored(t, "copy", storedDetached(t, e, &got), []string{
			"DTSTART;TZID=Europe/Berlin:20250310T100000", "DUE;TZID=Europe/Berlin:20250310T110000", "BEGIN:VTIMEZONE",
			"SUMMARY:Renamed", "X-LUCID-DETACHED-FROM:r\r\n", "STATUS:NEEDS-ACTION", `DESCRIPTION:Notes\n\n- [x] a`,
			"PRIORITY:3", "BEGIN:VALARM", "TRIGGER:-PT15M", "DESCRIPTION:Reminder", "X-FOO:bar",
		}, []string{"RRULE:FREQ=WEEKLY", "\r\nUID:r\r\n", "PERCENT-COMPLETE", "COMPLETED", "RECURRENCE-ID"})
		if n := len(e.mock.ObjectPaths(e.paths["tasks"])); n != 2 {
			t.Errorf("%d objects; want the series and the detached task", n)
		}
		if cur := repeatsOf(t, e, id)[domain.OccurrenceCurrent]; len(cur) != 1 || !cur[0].Equal(date(2025, 3, 13, 8, 0)) {
			t.Errorf("current repeat = %v; want Thursday", cur)
		}
		if snap == nil || string(snap.Data) != seeded || snap.ETag != got.ETag ||
			!reflect.DeepEqual(snap.Created, []domain.CreatedRef{{ID: c.ID, ETag: c.ETag}}) {
			t.Errorf("snapshot = %+v; want the seeded series, and the copy as one that may not stay", snap)
		}
	})

	// An override's own fields and alarms are the repeat's: the copy takes
	// them, and the series keeps its own (FR-17).
	t.Run("a repeat an override changed keeps its own fields and alarms", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e,
			[]string{
				"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY",
				"BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-PT15M", "DESCRIPTION:Series alarm", "END:VALARM",
			},
			[]string{
				"RECURRENCE-ID:20250310T090000Z", "DTSTART:20250310T150000Z", "SUMMARY:Moved title",
				"BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-PT1H", "DESCRIPTION:Own alarm", "END:VALARM",
			})
		got, _ := detachCurrent(t, e, id, editInput)
		if c := got.DetachedCopy; c == nil || c.Title != "Moved title" || !sameTime(c.Start, ptr(date(2025, 3, 10, 15, 0))) {
			t.Errorf("detached copy = %+v; want the override's title and time", c)
		}
		cp := storedDetached(t, e, &got)
		checkStored(t, "copy", cp, []string{"SUMMARY:Moved title", "DTSTART:20250310T150000Z", "TRIGGER:-PT1H", "Own alarm"},
			[]string{"TRIGGER:-PT15M", "Series alarm", "RECURRENCE-ID"})
		if n := strings.Count(cp, "BEGIN:VALARM"); n != 1 {
			t.Errorf("copy has %d alarms; want the override's one:\n%s", n, cp)
		}
		checkStored(t, "series", storedObject(t, e, id), []string{"DTSTART:20250317T090000Z", "SUMMARY:Series", "TRIGGER:-PT15M"},
			[]string{"RECURRENCE-ID", "Moved title", "TRIGGER:-PT1H"})
	})

	// A series that carries the origin of another one (written by some
	// app) passes it on to its clones: the copy's own is set over it, never
	// added next to it (FR-17).
	t.Run("the origin is set over one the series carries", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY", "X-LUCID-DETACHED-FROM:abc"})
		got, _ := detachCurrent(t, e, id, editInput)
		cp := storedDetached(t, e, &got)
		if n := strings.Count(cp, "X-LUCID-DETACHED-FROM"); n != 1 || got.DetachedCopy.DetachedFrom != "r" {
			t.Errorf("copy has %d origins, reports %q; want only r:\n%s", n, got.DetachedCopy.DetachedFrom, cp)
		}
	})

	// A body without start takes the repeat's dates, as for PUT /todos/{id}
	// (FR-16).
	t.Run("dates left out are the repeat's", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "DUE:20250310T100000Z", "RRULE:FREQ=WEEKLY"})
		got, _ := detachCurrent(t, e, id, func(f *domain.Todo) domain.TodoInput {
			in := editInput(f)
			in.Start, in.StartOmitted, in.Title = nil, true, "Renamed"
			return in
		})
		if c := got.DetachedCopy; c == nil || c.Title != "Renamed" ||
			!sameTime(c.Start, ptr(date(2025, 3, 10, 9, 0))) || !sameTime(c.Due, ptr(date(2025, 3, 10, 10, 0))) {
			t.Errorf("detached copy = %+v; want the repeat's dates", c)
		}
	})

	// A current repeat off the rule leaves with its override, as on
	// completion; before one off the rule, the master cannot roll and the
	// repeat gets an EXDATE (A-10, FR-17).
	for _, tc := range []struct {
		name       string
		master     []string
		overrides  [][]string
		copyStart  time.Time
		next       time.Time
		has, lacks []string
	}{
		{
			name:      "a repeat off the rule leaves with its override",
			master:    []string{"DTSTART:20250309T090000Z", "RRULE:FREQ=WEEKLY", "EXDATE:20250309T090000Z"},
			overrides: [][]string{{"RECURRENCE-ID:20250310T090000Z", "DTSTART:20250310T150000Z"}},
			copyStart: date(2025, 3, 10, 15, 0),
			next:      date(2025, 3, 16, 9, 0),
			has:       []string{"DTSTART:20250316T090000Z"},
			lacks:     []string{"RECURRENCE-ID", "DTSTART:20250310T150000Z"},
		},
		{
			name:      "a repeat before one off the rule is excluded",
			master:    []string{"DTSTART:20250309T090000Z", "RRULE:FREQ=WEEKLY"},
			overrides: [][]string{{"RECURRENCE-ID:20250311T090000Z"}},
			copyStart: date(2025, 3, 9, 9, 0),
			next:      date(2025, 3, 11, 9, 0),
			has:       []string{"DTSTART:20250309T090000Z", "EXDATE:20250309T090000Z", "RECURRENCE-ID:20250311T090000Z"},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			id := seedSeries(t, e, tc.master, tc.overrides...)
			got, snap := detachCurrent(t, e, id, editInput)
			if c := got.DetachedCopy; c == nil || !sameTime(c.Start, &tc.copyStart) || !sameTime(got.Start, &tc.next) || snap == nil {
				t.Errorf("series = %+v, copy = %+v, snapshot %v; want the copy at %v, the series at %v",
					got, c, snap != nil, tc.copyStart, tc.next)
			}
			checkStored(t, "series", storedObject(t, e, id), tc.has, tc.lacks)
		})
	}

	// The last repeat has no next one for the series to roll to: "only this
	// one" is all of it, the change of the task itself; the rule of the
	// body is the series' and ignored (FR-17).
	t.Run("the last repeat changes the task itself", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY;COUNT=1"})
		seeded := storedObject(t, e, id)
		got, snap := detachCurrent(t, e, id, func(f *domain.Todo) domain.TodoInput {
			in := withRule(movedBy(f, 24*time.Hour), "FREQ=DAILY")
			in.Title = "Renamed"
			return in
		})
		if got.DetachedCopy != nil || got.Title != "Renamed" || !sameTime(got.Start, ptr(date(2025, 3, 11, 9, 0))) ||
			got.RRule != "FREQ=WEEKLY;UNTIL=20250311T090000Z" || got.Next != nil {
			t.Errorf("changed task = %+v; want it renamed and moved, the rule ending at it", got)
		}
		if paths := e.mock.ObjectPaths(e.paths["tasks"]); len(paths) != 1 {
			t.Errorf("objects = %v; want the series only", paths)
		}
		if snap == nil || string(snap.Data) != seeded || len(snap.Created) != 0 {
			t.Errorf("snapshot = %+v; want the seeded series alone", snap)
		}
	})

	t.Run("a later repeat is refused", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY;BYDAY=MO,TH"})
		seeded := storedObject(t, e, id)
		f := listedTodo(t, e, id)
		later := repeatsOf(t, e, id)[domain.OccurrenceUpcoming][0]
		e.mock.ResetCounts()
		_, _, err := e.svc.DetachTodoOccurrence(t.Context(), id, f.ETag, later, editInput(&f))
		mustErr(t, err, domain.ErrInvalidInput)
		mustWriteNothing(t, e, id, seeded)
	})

	// A view not reloaded since the series changed elsewhere is stale: the
	// repeat it shows is no open one any more (FR-17, NFR-26).
	for _, tc := range staleRepeats {
		t.Run("stale: "+tc.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			id := seedSeries(t, e, tc.master, tc.overrides...)
			seeded := storedObject(t, e, id)
			f := listedTodo(t, e, id)
			// The view showed the series open.
			in := editInput(&f)
			in.Status = domain.TodoNeedsAction
			e.mock.ResetCounts()
			_, _, err := e.svc.DetachTodoOccurrence(t.Context(), id, f.ETag, tc.rid, in)
			mustErr(t, err, domain.ErrConflict)
			mustWriteNothing(t, e, id, seeded)
		})
	}

	// The repeat, still open, would leave the attendees, whom a server that
	// schedules implicitly would tell only that the series rolled on, so a
	// series with any is refused, also at its last repeat (FR-17).
	for _, tc := range []struct {
		name      string
		master    []string
		overrides [][]string
	}{
		{"an attendee of the series", []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY", "ATTENDEE:mailto:you@example.com"}, nil},
		{
			"an organizer of an override",
			[]string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY"},
			[][]string{{"RECURRENCE-ID:20250317T090000Z", "DTSTART:20250318T090000Z", "ORGANIZER:mailto:me@example.com"}},
		},
		{"an attendee at the last repeat", []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY;COUNT=1", "ATTENDEE:mailto:you@example.com"}, nil},
	} {
		t.Run("refused with "+tc.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			id := seedSeries(t, e, tc.master, tc.overrides...)
			seeded := storedObject(t, e, id)
			f := listedTodo(t, e, id)
			rid := currentRepeat(t, e, id)
			e.mock.ResetCounts()
			_, _, err := e.svc.DetachTodoOccurrence(t.Context(), id, f.ETag, rid, editInput(&f))
			mustErr(t, err, domain.ErrSeriesSplitUnsupported)
			mustWriteNothing(t, e, id, seeded)
		})
	}

	// Completing goes through PUT /todos/{id}: a detached repeat stays open,
	// and the body is refused before anything is read (FR-17).
	for _, status := range []string{domain.TodoCompleted, domain.TodoCancelled} {
		t.Run("a body "+status+" is refused", func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY"})
			seeded := storedObject(t, e, id)
			f := listedTodo(t, e, id)
			rid := currentRepeat(t, e, id)
			in := editInput(&f)
			in.Status = status
			e.mock.ResetCounts()
			_, _, err := e.svc.DetachTodoOccurrence(t.Context(), id, f.ETag, rid, in)
			mustErr(t, err, domain.ErrInvalidInput)
			for _, m := range []string{http.MethodGet, "PROPFIND", "REPORT"} {
				if n := e.mock.Count(m); n != 0 {
					t.Errorf("%s count = %d; want nothing read", m, n)
				}
			}
			mustWriteNothing(t, e, id, seeded)
		})
	}

	t.Run("a rule Lucid cannot evaluate is refused", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=DAILY;BYDAY=XX"})
		seeded := storedObject(t, e, id)
		f := listedTodo(t, e, id)
		e.mock.ResetCounts()
		_, _, err := e.svc.DetachTodoOccurrence(t.Context(), id, f.ETag, date(2025, 3, 10, 9, 0), editInput(&f))
		mustErr(t, err, domain.ErrInvalidInput)
		mustWriteNothing(t, e, id, seeded)
	})

	t.Run("a stale etag is a conflict", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY"})
		seeded := storedObject(t, e, id)
		f := listedTodo(t, e, id)
		e.mock.ResetCounts()
		_, _, err := e.svc.DetachTodoOccurrence(t.Context(), id, "bogus", date(2025, 3, 10, 9, 0), editInput(&f))
		mustErr(t, err, domain.ErrConflict)
		mustWriteNothing(t, e, id, seeded)
	})

	// The series' write is refused: the detached task goes again, as a
	// completed copy does (FR-17, A-01).
	t.Run("a refused write of the series removes the copy", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY"})
		seeded := storedObject(t, e, id)
		f := listedTodo(t, e, id)
		rid := currentRepeat(t, e, id)
		objPath, _, err := decodeObjectID(e.mock.HomePath(), id)
		mustNoErr(t, err)
		e.mock.SetHook(func(w http.ResponseWriter, r *http.Request) bool {
			if r.Method == http.MethodPut && r.URL.Path == objPath {
				w.WriteHeader(http.StatusPreconditionFailed)
				return true
			}
			return false
		})
		e.mock.ResetCounts()
		_, _, err = e.svc.DetachTodoOccurrence(t.Context(), id, f.ETag, rid, editInput(&f))
		mustErr(t, err, domain.ErrConflict)
		if n := e.mock.Count(http.MethodDelete); n != 1 {
			t.Errorf("DELETE count = %d; want the copy's", n)
		}
		if stored := storedObject(t, e, id); stored != seeded {
			t.Errorf("series:\n%s\nwant it unchanged:\n%s", stored, seeded)
		}
		if paths := e.mock.ObjectPaths(e.paths["tasks"]); len(paths) != 1 {
			t.Errorf("objects = %v; want the series only", paths)
		}
	})

	t.Run("the undo restores the series and removes the copy", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY;BYDAY=MO,TH", `DESCRIPTION:- [x] a`})
		seeded := storedObject(t, e, id)
		before := listedTodo(t, e, id)
		_, snap := detachCurrent(t, e, id, editInput)
		if snap == nil {
			t.Fatal("no snapshot")
		}
		got, err := e.svc.RestoreTodo(t.Context(), *snap)
		mustNoErr(t, err)
		if stored := storedObject(t, e, id); stored != seeded {
			t.Errorf("restored resource:\n%s\nwant the seeded one:\n%s", stored, seeded)
		}
		if paths := e.mock.ObjectPaths(e.paths["tasks"]); len(paths) != 1 {
			t.Errorf("objects = %v; want the series only", paths)
		}
		if got.ETag == "" || !reflect.DeepEqual(got, before) {
			t.Errorf("restored todo = %+v; want it as listed before the change, %+v", got, before)
		}
	})

	// Review Focus 5: the detached task changed in another app since; the
	// series restored next to it would show that repeat twice, so the undo
	// is refused and writes nothing.
	t.Run("the undo is refused once the detached task changed", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY"})
		got, snap := detachCurrent(t, e, id, editInput)
		if snap == nil {
			t.Fatal("no snapshot")
		}
		rolled := storedObject(t, e, id)
		copyPath, _, err := decodeObjectID(e.mock.HomePath(), got.DetachedCopy.ID)
		mustNoErr(t, err)
		other := strings.Replace(storedDetached(t, e, &got), "SUMMARY:Series", "SUMMARY:Other", 1)
		if _, err := e.mock.PutObject(e.paths["tasks"], path.Base(copyPath), other); err != nil {
			t.Fatalf("PutObject: %v", err)
		}
		e.mock.ResetCounts()
		_, err = e.svc.RestoreTodo(t.Context(), *snap)
		mustErr(t, err, domain.ErrConflict)
		if n := e.mock.Count(http.MethodPut) + e.mock.Count(http.MethodDelete); n != 0 {
			t.Errorf("%d writes; want none", n)
		}
		if stored := storedObject(t, e, id); stored != rolled {
			t.Errorf("series:\n%s\nwant it as the detach left it:\n%s", stored, rolled)
		}
		if stored := storedDetached(t, e, &got); stored != other {
			t.Errorf("detached task:\n%s\nwant the other app's change:\n%s", stored, other)
		}
	})

	// An undo could never tell a detached task whose ETag is unknown from
	// one changed since, and would always be refused: there is none (FR-17).
	t.Run("no undo when the copy's etag is unknown", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY"})
		answerCreateWithoutETag(e.mock, e.paths["tasks"], "")
		got, snap := detachCurrent(t, e, id, editInput)
		if got.DetachedCopy == nil || got.DetachedCopy.ETag != "" || got.ETag == "" || snap != nil {
			t.Errorf("detach = %+v, snapshot %+v; want a copy without ETag, and no snapshot", got, snap)
		}
	})
}

// Skipping the current repeat of a task series rolls the series on to its
// next repeat, as completing it does, without a copy (FR-17).
func TestSkipTodoOccurrence(t *testing.T) {
	t.Parallel()

	t.Run("rolls on without a copy", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{
			"DTSTART;TZID=Europe/Berlin:20250310T090000", "RRULE:FREQ=WEEKLY;BYDAY=MO,TH",
			"PRIORITY:3", `DESCRIPTION:Notes\n\n- [x] a`, "PERCENT-COMPLETE:40",
		})
		seeded := storedObject(t, e, id)
		f := listedTodo(t, e, id)
		got, snap, err := e.svc.SkipTodoOccurrence(t.Context(), id, f.ETag, currentRepeat(t, e, id))
		mustNoErr(t, err)
		if got.Title != "Series" || got.Priority != 3 || got.Description != "Notes" || got.Status != domain.TodoNeedsAction ||
			!reflect.DeepEqual(got.Checklist, []domain.ChecklistItem{{Text: "a"}}) ||
			got.CompletedCopy != nil || got.DetachedCopy != nil || !sameTime(got.Start, ptr(date(2025, 3, 13, 8, 0))) {
			t.Errorf("rolled series = %+v; want it at Thursday, as it was", got)
		}
		checkStored(t, "series", storedObject(t, e, id), []string{
			"DTSTART;TZID=Europe/Berlin:20250313T090000", "RRULE:FREQ=WEEKLY;BYDAY=MO,TH\r\n", `DESCRIPTION:Notes\n\n- [ ] a`,
		}, []string{"PERCENT-COMPLETE"})
		if paths := e.mock.ObjectPaths(e.paths["tasks"]); len(paths) != 1 {
			t.Errorf("objects = %v; want the series only", paths)
		}
		if snap == nil || string(snap.Data) != seeded || snap.ETag != got.ETag || len(snap.Created) != 0 {
			t.Errorf("snapshot = %+v; want the seeded series alone", snap)
		}
	})

	t.Run("a repeat off the rule leaves with its override", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250309T090000Z", "RRULE:FREQ=WEEKLY", "EXDATE:20250309T090000Z"},
			[]string{"RECURRENCE-ID:20250310T090000Z", "DTSTART:20250310T150000Z"})
		f := listedTodo(t, e, id)
		got, _, err := e.svc.SkipTodoOccurrence(t.Context(), id, f.ETag, currentRepeat(t, e, id))
		mustNoErr(t, err)
		if !sameTime(got.Start, ptr(date(2025, 3, 16, 9, 0))) {
			t.Errorf("rolled series = %+v; want it at 16 March", got)
		}
		checkStored(t, "series", storedObject(t, e, id), []string{"DTSTART:20250316T090000Z"}, []string{"RECURRENCE-ID"})
	})

	// The client deletes the task instead: skipped, the last repeat would
	// leave a series without one.
	t.Run("the last repeat is refused", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY;COUNT=1"})
		seeded := storedObject(t, e, id)
		f := listedTodo(t, e, id)
		rid := currentRepeat(t, e, id)
		e.mock.ResetCounts()
		_, _, err := e.svc.SkipTodoOccurrence(t.Context(), id, f.ETag, rid)
		mustErr(t, err, domain.ErrInvalidInput)
		mustWriteNothing(t, e, id, seeded)
	})

	t.Run("a later repeat is refused", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY"})
		seeded := storedObject(t, e, id)
		f := listedTodo(t, e, id)
		later := repeatsOf(t, e, id)[domain.OccurrenceUpcoming][0]
		e.mock.ResetCounts()
		_, _, err := e.svc.SkipTodoOccurrence(t.Context(), id, f.ETag, later)
		mustErr(t, err, domain.ErrInvalidInput)
		mustWriteNothing(t, e, id, seeded)
	})

	for _, tc := range staleRepeats {
		t.Run("stale: "+tc.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			id := seedSeries(t, e, tc.master, tc.overrides...)
			seeded := storedObject(t, e, id)
			f := listedTodo(t, e, id)
			e.mock.ResetCounts()
			_, _, err := e.svc.SkipTodoOccurrence(t.Context(), id, f.ETag, tc.rid)
			mustErr(t, err, domain.ErrConflict)
			mustWriteNothing(t, e, id, seeded)
		})
	}

	t.Run("a rule Lucid cannot evaluate is refused", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=DAILY;BYDAY=XX"})
		seeded := storedObject(t, e, id)
		f := listedTodo(t, e, id)
		e.mock.ResetCounts()
		_, _, err := e.svc.SkipTodoOccurrence(t.Context(), id, f.ETag, date(2025, 3, 10, 9, 0))
		mustErr(t, err, domain.ErrInvalidInput)
		mustWriteNothing(t, e, id, seeded)
	})

	t.Run("the undo restores the repeat", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY;COUNT=3"})
		seeded := storedObject(t, e, id)
		before := listedTodo(t, e, id)
		_, snap, err := e.svc.SkipTodoOccurrence(t.Context(), id, before.ETag, currentRepeat(t, e, id))
		mustNoErr(t, err)
		if snap == nil {
			t.Fatal("no snapshot")
		}
		got, err := e.svc.RestoreTodo(t.Context(), *snap)
		mustNoErr(t, err)
		if stored := storedObject(t, e, id); stored != seeded {
			t.Errorf("restored resource:\n%s\nwant the seeded one:\n%s", stored, seeded)
		}
		if got.ETag == "" || !reflect.DeepEqual(got, before) {
			t.Errorf("restored todo = %+v; want it as listed before the change, %+v", got, before)
		}
	})

	// Skipping writes no new resource, so attendees are no refusal; as for
	// any change of such a resource, there is no undo (RFC 5545 section
	// 3.8.7.4).
	t.Run("a series with attendees skips without an undo", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY", "ATTENDEE:mailto:you@example.com"})
		f := listedTodo(t, e, id)
		got, snap, err := e.svc.SkipTodoOccurrence(t.Context(), id, f.ETag, currentRepeat(t, e, id))
		mustNoErr(t, err)
		if !sameTime(got.Start, ptr(date(2025, 3, 17, 9, 0))) || snap != nil {
			t.Errorf("rolled series = %+v, snapshot %+v; want it at 17 March, without one", got, snap)
		}
		checkStored(t, "series", storedObject(t, e, id), []string{"DTSTART:20250317T090000Z", "ATTENDEE:mailto:you@example.com"}, nil)
	})
}
