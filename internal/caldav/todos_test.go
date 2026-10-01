package caldav

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"reflect"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/emersion/go-ical"

	"github.com/tbckr/lucid/internal/caldav/caldavtest"
	"github.com/tbckr/lucid/internal/domain"
)

func TestChecklistRoundTrip(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name       string
		desc       string
		items      []domain.ChecklistItem
		wantJoined string
	}{
		{name: "empty", items: []domain.ChecklistItem{}},
		{name: "description only", desc: "Just text", items: []domain.ChecklistItem{}, wantJoined: "Just text"},
		{
			name:       "checklist only",
			items:      []domain.ChecklistItem{{Text: "oat", Done: false}, {Text: "soy", Done: true}},
			wantJoined: "- [ ] oat\n- [x] soy",
		},
		{
			name:       "both",
			desc:       "Buy:\n- not a task line in the middle\n\nthanks",
			items:      []domain.ChecklistItem{{Text: "a"}, {Text: "b", Done: true}},
			wantJoined: "Buy:\n- not a task line in the middle\n\nthanks\n\n- [ ] a\n- [x] b",
		},
		{
			name:       "item text with newline is flattened",
			items:      []domain.ChecklistItem{{Text: "multi\nline"}},
			wantJoined: "- [ ] multi line",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			joined := joinChecklist(tt.desc, tt.items)
			if joined != tt.wantJoined {
				t.Fatalf("joinChecklist = %q; want %q", joined, tt.wantJoined)
			}
			desc, items := splitChecklist(joined)
			if desc != tt.desc {
				t.Errorf("description = %q; want %q", desc, tt.desc)
			}
			want := tt.items
			if tt.name == "item text with newline is flattened" {
				want = []domain.ChecklistItem{{Text: "multi line"}}
			}
			if !reflect.DeepEqual(items, want) {
				t.Errorf("items = %+v; want %+v", items, want)
			}
		})
	}
}

func TestSplitChecklistForeignFormats(t *testing.T) {
	t.Parallel()
	tests := []struct {
		in       string
		wantDesc string
		want     []domain.ChecklistItem
	}{
		{"Note\r\n\r\n* [X] Done\r\n+ [ ]   spaced  \r\n\r\n", "Note", []domain.ChecklistItem{{Text: "Done", Done: true}, {Text: "spaced"}}},
		{"- [ ] a\nnot a task", "- [ ] a\nnot a task", []domain.ChecklistItem{}},
		{"-[ ] no space\n- [ ]", "-[ ] no space", []domain.ChecklistItem{}},
	}
	for _, tt := range tests {
		t.Run(tt.in, func(t *testing.T) {
			t.Parallel()
			desc, items := splitChecklist(tt.in)
			if desc != tt.wantDesc || !reflect.DeepEqual(items, tt.want) {
				t.Fatalf("splitChecklist(%q) = %q, %+v; want %q, %+v", tt.in, desc, items, tt.wantDesc, tt.want)
			}
		})
	}
}

func TestTodosCRUD(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	ctx := t.Context()
	cal := e.cals["tasks"]

	due := date(2025, 3, 7, 0, 0)
	created, err := e.svc.CreateTodo(ctx, cal, domain.TodoInput{
		Title: "Buy milk", Description: "From the shop",
		Checklist: []domain.ChecklistItem{{Text: "oat"}, {Text: "soy", Done: true}},
		Due:       &due, DueAllDay: true, Priority: 1,
	})
	mustNoErr(t, err)
	if created.Status != domain.TodoNeedsAction || created.Completed != nil || created.ETag == "" ||
		!created.DueAllDay || !created.Due.Equal(due) || created.Priority != 1 {
		t.Fatalf("unexpected created todo %+v", created)
	}

	todos, err := e.svc.ListTodos(ctx, cal)
	mustNoErr(t, err)
	if len(todos) != 1 || !reflect.DeepEqual(todos[0], created) {
		t.Fatalf("ListTodos = %+v; want [%+v]", todos, created)
	}
	objPath, _, _ := decodeObjectID(e.mock.HomePath(), created.ID)
	data, _ := e.mock.Object(objPath)
	for _, want := range []string{"DUE;VALUE=DATE:20250307", "PRIORITY:1", "STATUS:NEEDS-ACTION", `DESCRIPTION:From the shop\n\n- [ ] oat\n- [x] soy`} {
		if !strings.Contains(data, want) {
			t.Errorf("stored todo lacks %q:\n%s", want, data)
		}
	}

	// Completing sets COMPLETED and PERCENT-COMPLETE.
	timedDue := date(2025, 3, 8, 15, 30)
	done, _, err := e.svc.UpdateTodo(ctx, created.ID, created.ETag, domain.TodoInput{
		Title: "Buy milk", Checklist: created.Checklist, Due: &timedDue, Status: domain.TodoCompleted,
	})
	mustNoErr(t, err)
	if done.Completed == nil || !done.Completed.Equal(e.clock.Now()) || done.Status != domain.TodoCompleted ||
		done.DueAllDay || !done.Due.Equal(timedDue) || done.Priority != 0 || done.Description != "" {
		t.Fatalf("unexpected completed todo %+v", done)
	}
	data, _ = e.mock.Object(objPath)
	for _, want := range []string{"PERCENT-COMPLETE:100", "COMPLETED:20250301T120000Z", "DUE:20250308T153000Z", "SEQUENCE:1"} {
		if !strings.Contains(data, want) {
			t.Errorf("completed todo lacks %q:\n%s", want, data)
		}
	}

	// Staying completed keeps the original completion time.
	e.clock.Advance(time.Hour)
	again, _, err := e.svc.UpdateTodo(ctx, done.ID, done.ETag, domain.TodoInput{Title: "Buy milk!", Status: domain.TodoCompleted})
	mustNoErr(t, err)
	if again.Completed == nil || !again.Completed.Equal(*done.Completed) || again.Due != nil {
		t.Fatalf("completion time changed: %+v", again)
	}

	// Reopening clears it.
	reopened, _, err := e.svc.UpdateTodo(ctx, again.ID, again.ETag, domain.TodoInput{Title: "Buy milk", Status: domain.TodoInProcess})
	mustNoErr(t, err)
	if reopened.Completed != nil || reopened.Status != domain.TodoInProcess {
		t.Fatalf("unexpected reopened todo %+v", reopened)
	}
	data, _ = e.mock.Object(objPath)
	if strings.Contains(data, "COMPLETED:") || strings.Contains(data, "PERCENT-COMPLETE") {
		t.Errorf("reopened todo still completed:\n%s", data)
	}

	// Errors.
	_, _, err = e.svc.UpdateTodo(ctx, reopened.ID, created.ETag, domain.TodoInput{Title: "x"})
	mustErr(t, err, domain.ErrConflict)
	_, _, err = e.svc.UpdateTodo(ctx, reopened.ID, reopened.ETag, domain.TodoInput{})
	mustErr(t, err, domain.ErrInvalidInput)
	_, err = e.svc.CreateTodo(ctx, cal, domain.TodoInput{Title: "x", Priority: 12})
	mustErr(t, err, domain.ErrInvalidInput)
	_, err = e.svc.CreateTodo(ctx, e.cals["holidays"], domain.TodoInput{Title: "x"})
	mustErr(t, err, domain.ErrReadOnly)
	_, err = e.svc.CreateTodo(ctx, e.cals["personal"], domain.TodoInput{Title: "x"})
	mustErr(t, err, domain.ErrUnsupportedComponent)
	_, err = e.svc.CreateTodo(ctx, "bad", domain.TodoInput{Title: "x"})
	mustErr(t, err, domain.ErrNotFound)
	_, err = e.svc.ListTodos(ctx, "bad")
	mustErr(t, err, domain.ErrNotFound)
	_, _, err = e.svc.UpdateTodo(ctx, "bad", "x", domain.TodoInput{Title: "x"})
	mustErr(t, err, domain.ErrNotFound)
	_, _, err = e.svc.UpdateTodo(ctx, reopened.ID, "", domain.TodoInput{Title: "x"})
	mustErr(t, err, domain.ErrInvalidInput)
	later := due.Add(time.Hour)
	_, err = e.svc.CreateTodo(ctx, cal, domain.TodoInput{Title: "x", Start: &later, Due: &due})
	mustErr(t, err, domain.ErrInvalidInput)
	_, err = e.svc.CreateTodo(ctx, cal, domain.TodoInput{Title: "x", Start: &due, StartAllDay: true, Due: &later})
	mustErr(t, err, domain.ErrInvalidInput)
	same, err := e.svc.CreateTodo(ctx, cal, domain.TodoInput{Title: "x", Start: &due, Due: &due})
	mustNoErr(t, err)
	mustNoErr(t, e.svc.DeleteTodo(ctx, same.ID, same.ETag))

	// An event ID passed to UpdateTodo is not found.
	ev, err := e.svc.CreateEvent(ctx, e.cals["work"], domain.EventInput{Title: "e", Start: due, End: due})
	mustNoErr(t, err)
	_, _, err = e.svc.UpdateTodo(ctx, ev.ID, ev.ETag, domain.TodoInput{Title: "x"})
	mustErr(t, err, domain.ErrNotFound)

	mustErr(t, e.svc.DeleteTodo(ctx, reopened.ID, created.ETag), domain.ErrConflict)
	mustNoErr(t, e.svc.DeleteTodo(ctx, reopened.ID, reopened.ETag))
	todos, err = e.svc.ListTodos(ctx, cal)
	mustNoErr(t, err)
	if len(todos) != 0 {
		t.Fatalf("todo not deleted: %+v", todos)
	}
}

func TestListTodosParsesForeignData(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	e.put(t, "tasks", "b.ics", "BEGIN:VTODO", "UID:b", "DTSTAMP:20240101T000000Z", "SUMMARY:beta",
		"DUE;TZID=Europe/Berlin:20250310T120000", "PRIORITY:15", "status:completed", "COMPLETED:20250301T080000Z", "END:VTODO")
	e.put(t, "tasks", "a.ics", "BEGIN:VTODO", "UID:a", "DTSTAMP:20240101T000000Z", "SUMMARY:Alpha", "END:VTODO")
	todos, err := e.svc.ListTodos(t.Context(), e.cals["tasks"])
	mustNoErr(t, err)
	if len(todos) != 2 || todos[0].Title != "Alpha" || todos[1].Title != "beta" {
		t.Fatalf("unexpected todos %+v", todos)
	}
	b := todos[1]
	if !b.Due.Equal(date(2025, 3, 10, 11, 0)) || b.DueAllDay || b.Priority != 0 ||
		b.Status != domain.TodoCompleted || !b.Completed.Equal(date(2025, 3, 1, 8, 0)) || b.Checklist == nil {
		t.Fatalf("unexpected todo %+v", b)
	}
	if a := todos[0]; a.Status != domain.TodoNeedsAction || a.Due != nil || a.Checklist == nil {
		t.Fatalf("unexpected todo %+v", a)
	}
}

// sameTime reports whether a and b are both nil or the same instant.
func sameTime(a, b *time.Time) bool {
	if a == nil || b == nil {
		return a == b
	}
	return a.Equal(*b)
}

func TestListTodosReadsStart(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name                   string
		lines                  []string
		start, due             *time.Time
		startAllDay, dueAllDay bool
	}{
		{
			name:  "utc",
			lines: []string{"DTSTART:20250310T080000Z", "DUE:20250310T100000Z"},
			start: ptr(date(2025, 3, 10, 8, 0)), due: ptr(date(2025, 3, 10, 10, 0)),
		},
		{
			name:  "tzid",
			lines: []string{"DTSTART;TZID=Europe/Berlin:20250310T090000"},
			start: ptr(date(2025, 3, 10, 8, 0)),
		},
		{
			name:  "date",
			lines: []string{"DTSTART;VALUE=DATE:20250310", "DUE;VALUE=DATE:20250312"},
			start: ptr(date(2025, 3, 10, 0, 0)), startAllDay: true, due: ptr(date(2025, 3, 12, 0, 0)), dueAllDay: true,
		},
		{
			name:  "duration",
			lines: []string{"DTSTART:20250310T080000Z", "DURATION:PT90M"},
			start: ptr(date(2025, 3, 10, 8, 0)), due: ptr(date(2025, 3, 10, 9, 30)),
		},
		{
			// Nominal days keep the wall-clock time across the DST change (30 Mar 2025).
			name:  "tzid duration across dst",
			lines: []string{"DTSTART;TZID=Europe/Berlin:20250329T090000", "DURATION:P1D"},
			start: ptr(date(2025, 3, 29, 8, 0)), due: ptr(date(2025, 3, 30, 7, 0)),
		},
		{
			name:  "date duration",
			lines: []string{"DTSTART;VALUE=DATE:20250310", "DURATION:P2D"},
			start: ptr(date(2025, 3, 10, 0, 0)), startAllDay: true, due: ptr(date(2025, 3, 12, 0, 0)), dueAllDay: true,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			lines := append([]string{"BEGIN:VTODO", "UID:x", "DTSTAMP:20240101T000000Z", "SUMMARY:x"}, tc.lines...)
			e.put(t, "tasks", "x.ics", append(lines, "END:VTODO")...)
			todos, err := e.svc.ListTodos(t.Context(), e.cals["tasks"])
			mustNoErr(t, err)
			if len(todos) != 1 {
				t.Fatalf("ListTodos = %+v; want one todo", todos)
			}
			got := todos[0]
			if !sameTime(got.Start, tc.start) || got.StartAllDay != tc.startAllDay ||
				!sameTime(got.Due, tc.due) || got.DueAllDay != tc.dueAllDay {
				t.Errorf("start %v (all-day %v), due %v (all-day %v); want %v (%v), %v (%v)",
					got.Start, got.StartAllDay, got.Due, got.DueAllDay, tc.start, tc.startAllDay, tc.due, tc.dueAllDay)
			}
		})
	}
}

// Completing a todo from another client must not rewrite its dates: a
// DTSTART with TZID anchors the recurrence across DST changes. The series
// ends here, so completing it completes the master itself (FR-17).
func TestUpdateTodoKeepsUnchangedDates(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	ctx := t.Context()
	id := e.put(t, "tasks", "r.ics", "BEGIN:VTODO", "UID:r", "DTSTAMP:20240101T000000Z", "SUMMARY:Report",
		"DTSTART;TZID=Europe/Berlin:20250310T090000", "DUE;TZID=Europe/Berlin:20250310T110000", "RRULE:FREQ=WEEKLY;COUNT=1", "END:VTODO")
	todos, err := e.svc.ListTodos(ctx, e.cals["tasks"])
	mustNoErr(t, err)
	r := todos[0]
	_, _, err = e.svc.UpdateTodo(ctx, id, r.ETag, domain.TodoInput{
		Title: r.Title, Checklist: r.Checklist, Start: r.Start, StartAllDay: r.StartAllDay,
		Due: r.Due, DueAllDay: r.DueAllDay, Status: domain.TodoCompleted, RRuleOmitted: true,
	})
	mustNoErr(t, err)
	objPath, _, _ := decodeObjectID(e.mock.HomePath(), id)
	data, _ := e.mock.Object(objPath)
	for _, want := range []string{
		"DTSTART;TZID=Europe/Berlin:20250310T090000", "DUE;TZID=Europe/Berlin:20250310T110000", "STATUS:COMPLETED", "RRULE:FREQ=WEEKLY;COUNT=1",
	} {
		if !strings.Contains(data, want) {
			t.Errorf("stored todo lacks %q:\n%s", want, data)
		}
	}
}

func TestUpdateTodoWritesStart(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	ctx := t.Context()
	stored := func(id string) string {
		t.Helper()
		objPath, _, _ := decodeObjectID(e.mock.HomePath(), id)
		data, _ := e.mock.Object(objPath)
		return data
	}

	start, due := date(2025, 3, 10, 8, 0), date(2025, 3, 10, 10, 0)
	created, err := e.svc.CreateTodo(ctx, e.cals["tasks"], domain.TodoInput{Title: "Slides", Start: &start, Due: &due})
	mustNoErr(t, err)
	if !sameTime(created.Start, &start) || created.StartAllDay {
		t.Fatalf("unexpected created todo %+v", created)
	}
	for _, want := range []string{"DTSTART:20250310T080000Z", "DUE:20250310T100000Z"} {
		if data := stored(created.ID); !strings.Contains(data, want) {
			t.Errorf("stored todo lacks %q:\n%s", want, data)
		}
	}

	cleared, _, err := e.svc.UpdateTodo(ctx, created.ID, created.ETag, domain.TodoInput{Title: "Slides", Due: &due})
	mustNoErr(t, err)
	if data := stored(created.ID); cleared.Start != nil || strings.Contains(data, "DTSTART") {
		t.Errorf("start not cleared: %+v\n%s", cleared, data)
	}

	allDay := date(2025, 3, 10, 0, 0)
	_, _, err = e.svc.UpdateTodo(ctx, created.ID, cleared.ETag, domain.TodoInput{Title: "Slides", Start: &allDay, StartAllDay: true})
	mustNoErr(t, err)
	if data := stored(created.ID); !strings.Contains(data, "DTSTART;VALUE=DATE:20250310") {
		t.Errorf("stored todo lacks an all-day start:\n%s", data)
	}

	id := e.put(t, "tasks", "d.ics", "BEGIN:VTODO", "UID:d", "DTSTAMP:20240101T000000Z", "SUMMARY:Call",
		"DTSTART:20250310T080000Z", "DURATION:PT1H", "END:VTODO")
	todos, err := e.svc.ListTodos(ctx, e.cals["tasks"])
	mustNoErr(t, err)
	var d domain.Todo
	for _, x := range todos {
		if x.ID == id {
			d = x
		}
	}
	_, _, err = e.svc.UpdateTodo(ctx, id, d.ETag, domain.TodoInput{Title: d.Title, Start: d.Start, Due: d.Due})
	mustNoErr(t, err)
	if data := stored(id); strings.Contains(data, "DURATION") || !strings.Contains(data, "DUE:20250310T090000Z") {
		t.Errorf("DURATION not replaced by DUE:\n%s", data)
	}
}

// Todos from other clients may carry dates Lucid would not accept as input;
// sending them back unchanged (e.g. to complete the todo) must still work.
func TestUpdateTodoAcceptsUnchangedForeignDates(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name  string
		lines []string
	}{
		{"mixed types", []string{"DTSTART;VALUE=DATE:20250310", "DUE:20250312T170000Z"}},
		{"start after due", []string{"DTSTART:20250312T170000Z", "DUE:20250310T090000Z"}},
		{"negative duration", []string{"DTSTART:20250310T090000Z", "DURATION:-PT1H"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			ctx := t.Context()
			lines := append([]string{"BEGIN:VTODO", "UID:f", "DTSTAMP:20240101T000000Z", "SUMMARY:Foreign"}, tc.lines...)
			id := e.put(t, "tasks", "f.ics", append(lines, "END:VTODO")...)
			todos, err := e.svc.ListTodos(ctx, e.cals["tasks"])
			mustNoErr(t, err)
			f := todos[0]
			done, _, err := e.svc.UpdateTodo(ctx, id, f.ETag, domain.TodoInput{
				Title: f.Title, Checklist: f.Checklist, Start: f.Start, StartAllDay: f.StartAllDay,
				Due: f.Due, DueAllDay: f.DueAllDay, Status: domain.TodoCompleted,
			})
			mustNoErr(t, err)
			if done.Status != domain.TodoCompleted || !sameTime(done.Start, f.Start) {
				t.Fatalf("unexpected todo %+v", done)
			}

			// Changing the dates still has to produce a valid pair.
			later := f.Start.Add(24 * time.Hour)
			_, _, err = e.svc.UpdateTodo(ctx, id, done.ETag, domain.TodoInput{
				Title: f.Title, Start: &later, StartAllDay: false, Due: f.Start, DueAllDay: false,
			})
			mustErr(t, err, domain.ErrInvalidInput)
		})
	}
}

func TestUpdateTodoKeepsStart(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name  string
		lines []string
		in    func(f domain.Todo) domain.TodoInput
		keeps string
	}{
		{
			// A client that predates `start` omits it.
			name:  "omitted",
			lines: []string{"DTSTART;TZID=Europe/Berlin:20250310T090000", "DUE:20250312T170000Z"},
			in: func(f domain.Todo) domain.TodoInput {
				return domain.TodoInput{Title: f.Title, Due: f.Due, StartOmitted: true, Status: domain.TodoCompleted}
			},
			keeps: "DTSTART;TZID=Europe/Berlin:20250310T090000",
		},
		{
			// RFC 5545 requires DTSTART with RRULE.
			name:  "recurring",
			lines: []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY"},
			in: func(f domain.Todo) domain.TodoInput {
				return domain.TodoInput{Title: f.Title, RRuleOmitted: true}
			},
			keeps: "DTSTART:20250310T090000Z",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			ctx := t.Context()
			lines := append([]string{"BEGIN:VTODO", "UID:k", "DTSTAMP:20240101T000000Z", "SUMMARY:Keep"}, tc.lines...)
			id := e.put(t, "tasks", "k.ics", append(lines, "END:VTODO")...)
			todos, err := e.svc.ListTodos(ctx, e.cals["tasks"])
			mustNoErr(t, err)
			f := todos[0]
			got, _, err := e.svc.UpdateTodo(ctx, id, f.ETag, tc.in(f))
			mustNoErr(t, err)
			if !sameTime(got.Start, f.Start) || got.StartAllDay != f.StartAllDay {
				t.Errorf("start = %v; want %v", got.Start, f.Start)
			}
			objPath, _, _ := decodeObjectID(e.mock.HomePath(), id)
			if data, _ := e.mock.Object(objPath); !strings.Contains(data, tc.keeps) {
				t.Errorf("stored todo lacks %q:\n%s", tc.keeps, data)
			}
		})
	}
}

// sameNext reports whether a and b are both nil or carry the same dates and
// value types.
func sameNext(a, b *domain.TodoDates) bool {
	if a == nil || b == nil {
		return a == b
	}
	return sameTime(a.Start, b.Start) && a.StartAllDay == b.StartAllDay &&
		sameTime(a.Due, b.Due) && a.DueAllDay == b.DueAllDay
}

// A recurring todo is reported at its current occurrence, with the next one
// (FR-16, FR-17), however other clients recorded their progress in it.
func TestListTodosRecurring(t *testing.T) {
	t.Parallel()
	base := []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=DAILY"}
	withBase := func(lines ...string) []string { return append(slices.Clone(base), lines...) }
	for _, tc := range []struct {
		name                   string
		lines                  []string
		overrides              [][]string
		start, due             *time.Time
		startAllDay, dueAllDay bool
		next                   *domain.TodoDates
		rrule                  string
		fixedDays              bool
		ruleUnsupported        bool
	}{
		{
			name: "rolling weekly",
			lines: []string{
				"DTSTART;TZID=Europe/Berlin:20250310T090000", "DUE;TZID=Europe/Berlin:20250310T110000", "RRULE:FREQ=WEEKLY",
			},
			start: ptr(date(2025, 3, 10, 8, 0)), due: ptr(date(2025, 3, 10, 10, 0)),
			next:  &domain.TodoDates{Start: ptr(date(2025, 3, 17, 8, 0)), Due: ptr(date(2025, 3, 17, 10, 0))},
			rrule: "FREQ=WEEKLY",
		},
		{
			name:  "due only",
			lines: []string{"DUE;VALUE=DATE:20250310", "RRULE:FREQ=DAILY"},
			due:   ptr(date(2025, 3, 10, 0, 0)), dueAllDay: true,
			next:  &domain.TodoDates{Due: ptr(date(2025, 3, 11, 0, 0)), DueAllDay: true},
			rrule: "FREQ=DAILY",
		},
		{
			name:  "fixed days",
			lines: []string{"DTSTART;VALUE=DATE:20250310", "DUE;VALUE=DATE:20250310", "RRULE:FREQ=WEEKLY;BYDAY=MO,TH"},
			start: ptr(date(2025, 3, 10, 0, 0)), startAllDay: true, due: ptr(date(2025, 3, 10, 0, 0)), dueAllDay: true,
			next: &domain.TodoDates{
				Start: ptr(date(2025, 3, 13, 0, 0)), StartAllDay: true,
				Due: ptr(date(2025, 3, 13, 0, 0)), DueAllDay: true,
			},
			rrule: "FREQ=WEEKLY;BYDAY=MO,TH", fixedDays: true,
		},
		{
			// An override can change the value type an occurrence carries: a
			// date moved to a time stays timed, but the next occurrence,
			// still generated from the master, stays all-day (A-04).
			name:      "override changes the value type",
			lines:     []string{"DTSTART;VALUE=DATE:20250310", "DUE;VALUE=DATE:20250310", "RRULE:FREQ=WEEKLY;BYDAY=MO,TH"},
			overrides: [][]string{{"RECURRENCE-ID;VALUE=DATE:20250310", "DTSTART:20250310T140000Z", "DUE:20250310T150000Z"}},
			start:     ptr(date(2025, 3, 10, 14, 0)), due: ptr(date(2025, 3, 10, 15, 0)),
			next: &domain.TodoDates{
				Start: ptr(date(2025, 3, 13, 0, 0)), StartAllDay: true,
				Due: ptr(date(2025, 3, 13, 0, 0)), DueAllDay: true,
			},
			rrule: "FREQ=WEEKLY;BYDAY=MO,TH", fixedDays: true,
		},
		{
			// The test clock (2025-03-01 12:00) is past the first occurrence.
			name:  "overdue is oldest",
			lines: []string{"DTSTART:20250301T090000Z", "RRULE:FREQ=DAILY"},
			start: ptr(date(2025, 3, 1, 9, 0)),
			next:  &domain.TodoDates{Start: ptr(date(2025, 3, 2, 9, 0))},
			rrule: "FREQ=DAILY",
		},
		{
			name:  "thunderbird done",
			lines: base,
			overrides: [][]string{
				{"RECURRENCE-ID:20250310T090000Z", "STATUS:COMPLETED"},
				{"RECURRENCE-ID:20250311T090000Z", "STATUS:COMPLETED"},
			},
			start: ptr(date(2025, 3, 12, 9, 0)),
			next:  &domain.TodoDates{Start: ptr(date(2025, 3, 13, 9, 0))},
			rrule: "FREQ=DAILY",
		},
		{
			// 10:00 in Berlin is the 09:00 UTC occurrence.
			name:      "override matched by instant",
			lines:     base,
			overrides: [][]string{{"RECURRENCE-ID;TZID=Europe/Berlin:20250310T100000", "STATUS:COMPLETED"}},
			start:     ptr(date(2025, 3, 11, 9, 0)),
			next:      &domain.TodoDates{Start: ptr(date(2025, 3, 12, 9, 0))},
			rrule:     "FREQ=DAILY",
		},
		{
			name:      "moved override is current",
			lines:     base,
			overrides: [][]string{{"RECURRENCE-ID:20250310T090000Z", "DTSTART:20250310T150000Z"}},
			start:     ptr(date(2025, 3, 10, 15, 0)),
			next:      &domain.TodoDates{Start: ptr(date(2025, 3, 11, 9, 0))},
			rrule:     "FREQ=DAILY",
		},
		{
			name:      "exdate and cancelled",
			lines:     withBase("EXDATE:20250310T090000Z"),
			overrides: [][]string{{"RECURRENCE-ID:20250311T090000Z", "STATUS:CANCELLED"}},
			start:     ptr(date(2025, 3, 12, 9, 0)),
			next:      &domain.TodoDates{Start: ptr(date(2025, 3, 13, 9, 0))},
			rrule:     "FREQ=DAILY",
		},
		{
			name:  "kde pending",
			lines: withBase("X-KDE-LIBKCAL-DTRECURRENCE:20250314T090000Z"),
			start: ptr(date(2025, 3, 14, 9, 0)),
			next:  &domain.TodoDates{Start: ptr(date(2025, 3, 15, 9, 0))},
			rrule: "FREQ=DAILY",
		},
		{
			name:  "count ends",
			lines: []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=DAILY;COUNT=1"},
			start: ptr(date(2025, 3, 10, 9, 0)),
			rrule: "FREQ=DAILY;COUNT=1",
		},
		{
			// Rolling cannot keep an RDATE off the rule (FR-17).
			name:      "rdate only",
			lines:     []string{"DTSTART:20250310T090000Z", "RDATE:20250315T090000Z"},
			start:     ptr(date(2025, 3, 10, 9, 0)),
			fixedDays: true, ruleUnsupported: true,
		},
		{
			// As for events: an empty rule adds no occurrence to the anchor.
			name:  "empty rule",
			lines: []string{"DTSTART:20250310T090000Z", "RRULE:"},
			start: ptr(date(2025, 3, 10, 9, 0)),
		},
		{
			name:  "no occurrence left",
			lines: []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=DAILY;COUNT=1", "EXDATE:20250310T090000Z"},
			start: ptr(date(2025, 3, 10, 9, 0)),
			rrule: "FREQ=DAILY;COUNT=1",
		},
		{
			name:  "completed master",
			lines: []string{"STATUS:COMPLETED", "RRULE:FREQ=DAILY", "DTSTART:20250310T090000Z"},
			start: ptr(date(2025, 3, 10, 9, 0)),
			rrule: "FREQ=DAILY",
		},
		{
			name:  "unsupported",
			lines: []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=DAILY;BYDAY=XX"},
			start: ptr(date(2025, 3, 10, 9, 0)),
			rrule: "FREQ=DAILY;BYDAY=XX", fixedDays: true, ruleUnsupported: true,
		},
		{
			name:            "no date",
			lines:           []string{"RRULE:FREQ=DAILY"},
			rrule:           "FREQ=DAILY",
			ruleUnsupported: true,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			lines := append([]string{"BEGIN:VTODO", "UID:r", "DTSTAMP:20240101T000000Z", "SUMMARY:Series"}, tc.lines...)
			lines = append(lines, "END:VTODO")
			for _, o := range tc.overrides {
				lines = append(lines, "BEGIN:VTODO", "UID:r", "DTSTAMP:20240101T000000Z")
				lines = append(append(lines, o...), "END:VTODO")
			}
			e.put(t, "tasks", "r.ics", lines...)
			todos, err := e.svc.ListTodos(t.Context(), e.cals["tasks"])
			mustNoErr(t, err)
			if len(todos) != 1 {
				t.Fatalf("ListTodos = %+v; want one todo", todos)
			}
			got := todos[0]
			if !got.Recurring || got.RRule != tc.rrule || got.FixedDays != tc.fixedDays || got.RuleUnsupported != tc.ruleUnsupported {
				t.Errorf("recurring %v, rrule %q, fixedDays %v, ruleUnsupported %v; want true, %q, %v, %v",
					got.Recurring, got.RRule, got.FixedDays, got.RuleUnsupported, tc.rrule, tc.fixedDays, tc.ruleUnsupported)
			}
			if !sameTime(got.Start, tc.start) || got.StartAllDay != tc.startAllDay ||
				!sameTime(got.Due, tc.due) || got.DueAllDay != tc.dueAllDay {
				t.Errorf("start %v (all-day %v), due %v (all-day %v); want %v (%v), %v (%v)",
					got.Start, got.StartAllDay, got.Due, got.DueAllDay, tc.start, tc.startAllDay, tc.due, tc.dueAllDay)
			}
			if !sameNext(got.Next, tc.next) {
				t.Errorf("next = %+v; want %+v", got.Next, tc.next)
			}
		})
	}
}

// A recurring todo is reported at its current occurrence; an edit that sends
// those dates back unchanged must leave the series' stored dates alone, or
// the rule would restart there in UTC (FR-17).
func TestUpdateTodoKeepsSeriesDates(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name      string
		lines     []string
		overrides [][]string
		keeps     []string
		start     *time.Time // current occurrence reported after the edit
	}{
		{
			name: "tzid and count",
			lines: []string{
				"DTSTART;TZID=Europe/Berlin:20250310T090000", "DUE;TZID=Europe/Berlin:20250310T110000",
				"RRULE:FREQ=WEEKLY;COUNT=4",
			},
			overrides: [][]string{{"RECURRENCE-ID;TZID=Europe/Berlin:20250310T090000", "STATUS:COMPLETED"}},
			keeps: []string{
				"DTSTART;TZID=Europe/Berlin:20250310T090000", "DUE;TZID=Europe/Berlin:20250310T110000",
				"RRULE:FREQ=WEEKLY;COUNT=4", "RECURRENCE-ID;TZID=Europe/Berlin:20250310T090000",
			},
			start: ptr(date(2025, 3, 17, 8, 0)),
		},
		{
			name:      "moved override is current",
			lines:     []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=DAILY"},
			overrides: [][]string{{"RECURRENCE-ID:20250310T090000Z", "DTSTART:20250310T150000Z"}},
			keeps:     []string{"DTSTART:20250310T090000Z", "RECURRENCE-ID:20250310T090000Z"},
			start:     ptr(date(2025, 3, 10, 15, 0)),
		},
		{
			name:      "duration",
			lines:     []string{"DTSTART:20250310T090000Z", "DURATION:PT2H", "RRULE:FREQ=DAILY"},
			overrides: [][]string{{"RECURRENCE-ID:20250310T090000Z", "STATUS:COMPLETED"}},
			keeps:     []string{"DTSTART:20250310T090000Z", "DURATION:PT2H", "RECURRENCE-ID:20250310T090000Z"},
			start:     ptr(date(2025, 3, 11, 9, 0)),
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			ctx := t.Context()
			lines := append([]string{"BEGIN:VTODO", "UID:s", "DTSTAMP:20240101T000000Z", "SUMMARY:Series"}, tc.lines...)
			lines = append(lines, "END:VTODO")
			for _, o := range tc.overrides {
				lines = append(lines, "BEGIN:VTODO", "UID:s", "DTSTAMP:20240101T000000Z")
				lines = append(append(lines, o...), "END:VTODO")
			}
			id := e.put(t, "tasks", "s.ics", lines...)
			todos, err := e.svc.ListTodos(ctx, e.cals["tasks"])
			mustNoErr(t, err)
			f := todos[0]
			got, _, err := e.svc.UpdateTodo(ctx, id, f.ETag, domain.TodoInput{
				Title: "Renamed", Checklist: f.Checklist, Start: f.Start, StartAllDay: f.StartAllDay,
				Due: f.Due, DueAllDay: f.DueAllDay, RRuleOmitted: true,
			})
			mustNoErr(t, err)
			if got.Title != "Renamed" || !sameTime(got.Start, tc.start) || !sameTime(got.Due, f.Due) || !sameNext(got.Next, f.Next) {
				t.Errorf("updated todo = %+v; want %q at start %v, due %v, next %+v", got, "Renamed", tc.start, f.Due, f.Next)
			}
			objPath, _, _ := decodeObjectID(e.mock.HomePath(), id)
			data, _ := e.mock.Object(objPath)
			for _, want := range tc.keeps {
				if !strings.Contains(data, want) {
					t.Errorf("stored todo lacks %q:\n%s", want, data)
				}
			}
			if !strings.Contains(data, "SUMMARY:Renamed") {
				t.Errorf("stored todo lacks the new title:\n%s", data)
			}
		})
	}
}

// occurrenceDates returns the anchor dates (start, else due) and states of
// occs, in order.
func occurrenceDates(occs []domain.TodoOccurrence) (dates []time.Time, states []string) {
	for i := range occs {
		o := &occs[i]
		d := o.RecurrenceID
		switch {
		case o.Start != nil:
			d = *o.Start
		case o.Due != nil:
			d = *o.Due
		}
		dates, states = append(dates, d), append(states, o.State)
	}
	return dates, states
}

// checkTodoOccurrences asserts that got's anchor dates (start, else due) and
// states match wantDates/wantStates, in order.
func checkTodoOccurrences(t *testing.T, got []domain.TodoOccurrence, wantDates []time.Time, wantStates []string) {
	t.Helper()
	if len(got) != len(wantDates) {
		t.Fatalf("ListTodoOccurrences = %+v; want %d occurrences at %v", got, len(wantDates), wantDates)
	}
	dates, states := occurrenceDates(got)
	for i := range got {
		if !dates[i].Equal(wantDates[i]) || states[i] != wantStates[i] {
			t.Errorf("occurrence %d = %v/%s; want %v/%s", i, dates[i], states[i], wantDates[i], wantStates[i])
		}
	}
}

// A recurring todo reports the occurrences overlapping a window, in state
// relative to its current occurrence, however other clients recorded their
// progress in it (FR-16, FR-17).
func TestListTodoOccurrences(t *testing.T) {
	t.Parallel()

	t.Run("fixed days with thunderbird done", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		ctx := t.Context()
		id := e.put(t, "tasks", "r.ics",
			"BEGIN:VTODO", "UID:r", "DTSTAMP:20240101T000000Z", "SUMMARY:Bins",
			"DTSTART;VALUE=DATE:20250310", "DUE;VALUE=DATE:20250310", "RRULE:FREQ=WEEKLY;BYDAY=MO,TH", "END:VTODO",
			"BEGIN:VTODO", "UID:r", "DTSTAMP:20240101T000000Z", "RECURRENCE-ID;VALUE=DATE:20250310", "STATUS:COMPLETED", "END:VTODO",
		)
		cal := e.cals["tasks"]

		occs, err := e.svc.ListTodoOccurrences(ctx, cal, date(2025, 3, 10, 0, 0), date(2025, 3, 17, 0, 0))
		mustNoErr(t, err)
		checkTodoOccurrences(t, occs,
			[]time.Time{date(2025, 3, 10, 0, 0), date(2025, 3, 13, 0, 0)},
			[]string{domain.OccurrenceDone, domain.OccurrenceCurrent})
		if want := id + "@2025-03-13T00:00:00Z"; occs[1].Key != want {
			t.Errorf("key = %q; want %q", occs[1].Key, want)
		}

		occs, err = e.svc.ListTodoOccurrences(ctx, cal, date(2025, 3, 17, 0, 0), date(2025, 3, 24, 0, 0))
		mustNoErr(t, err)
		checkTodoOccurrences(t, occs,
			[]time.Time{date(2025, 3, 17, 0, 0), date(2025, 3, 20, 0, 0)},
			[]string{domain.OccurrenceUpcoming, domain.OccurrenceUpcoming})
	})

	t.Run("history before the anchor", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		e.put(t, "tasks", "h.ics",
			"BEGIN:VTODO", "UID:h", "DTSTAMP:20240101T000000Z", "SUMMARY:Recycling",
			"DTSTART;VALUE=DATE:20250313", "RRULE:FREQ=WEEKLY", "END:VTODO",
			"BEGIN:VTODO", "UID:h", "DTSTAMP:20240101T000000Z", "RECURRENCE-ID;VALUE=DATE:20250310", "STATUS:COMPLETED", "END:VTODO",
		)
		occs, err := e.svc.ListTodoOccurrences(t.Context(), e.cals["tasks"], date(2025, 3, 10, 0, 0), date(2025, 3, 14, 0, 0))
		mustNoErr(t, err)
		found := false
		for _, o := range occs {
			if o.Start != nil && o.Start.Equal(date(2025, 3, 10, 0, 0)) && o.State == domain.OccurrenceDone {
				found = true
			}
		}
		if !found {
			t.Fatalf("ListTodoOccurrences = %+v; want a done occurrence on 2025-03-10 (history before the anchor)", occs)
		}
	})

	t.Run("moved override", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		e.put(t, "tasks", "m.ics",
			"BEGIN:VTODO", "UID:m", "DTSTAMP:20240101T000000Z", "SUMMARY:Standup",
			"DTSTART:20250310T090000Z", "RRULE:FREQ=DAILY", "END:VTODO",
			"BEGIN:VTODO", "UID:m", "DTSTAMP:20240101T000000Z",
			"RECURRENCE-ID:20250311T090000Z", "DTSTART:20250311T150000Z", "SUMMARY:Later", "END:VTODO",
		)
		occs, err := e.svc.ListTodoOccurrences(t.Context(), e.cals["tasks"], date(2025, 3, 11, 0, 0), date(2025, 3, 12, 0, 0))
		mustNoErr(t, err)
		if len(occs) != 1 {
			t.Fatalf("ListTodoOccurrences = %+v; want one occurrence", occs)
		}
		got := occs[0]
		if got.Start == nil || !got.Start.Equal(date(2025, 3, 11, 15, 0)) || got.Title != "Later" {
			t.Errorf("moved occurrence = %+v; want start 2025-03-11T15:00Z, title %q", got, "Later")
		}
	})

	// An override far beyond the window can still move its occurrence back
	// into it: the walk that follows RECURRENCE-ID order stops once it is
	// past the window, but the override's own DTSTART/DUE must still be
	// checked (FR-17).
	t.Run("override moved back into the window from beyond it", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := e.put(t, "tasks", "b.ics",
			"BEGIN:VTODO", "UID:b", "DTSTAMP:20240101T000000Z", "SUMMARY:Weekly",
			"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY", "END:VTODO",
			"BEGIN:VTODO", "UID:b", "DTSTAMP:20240101T000000Z",
			"RECURRENCE-ID:20250324T090000Z", "DTSTART:20250312T090000Z", "DUE:20250312T100000Z", "END:VTODO",
		)
		occs, err := e.svc.ListTodoOccurrences(t.Context(), e.cals["tasks"], date(2025, 3, 10, 0, 0), date(2025, 3, 15, 0, 0))
		mustNoErr(t, err)
		checkTodoOccurrences(t, occs,
			[]time.Time{date(2025, 3, 10, 9, 0), date(2025, 3, 12, 9, 0)},
			[]string{domain.OccurrenceCurrent, domain.OccurrenceUpcoming})
		moved := occs[1]
		if want := id + "@2025-03-24T09:00:00Z"; moved.Key != want {
			t.Errorf("key = %q; want %q", moved.Key, want)
		}
		if !moved.RecurrenceID.Equal(date(2025, 3, 24, 9, 0)) {
			t.Errorf("recurrenceId = %v; want the original 2025-03-24T09:00Z", moved.RecurrenceID)
		}
		if moved.Due == nil || !moved.Due.Equal(date(2025, 3, 12, 10, 0)) {
			t.Errorf("due = %v; want 2025-03-12T10:00Z", moved.Due)
		}
	})

	// Probe P1: RFC 5545 3.3.10 counts DTSTART as the first occurrence, also
	// off the rule's days; rrule-go leaves it out and counts three more
	// (FR-17).
	t.Run("count includes an off-rule start", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		seedSeries(t, e, []string{"DTSTART:20250311T090000Z", "RRULE:FREQ=WEEKLY;BYDAY=MO,TH;COUNT=3"})
		occs, err := e.svc.ListTodoOccurrences(t.Context(), e.cals["tasks"], date(2025, 3, 1, 0, 0), date(2025, 4, 1, 0, 0))
		mustNoErr(t, err)
		checkTodoOccurrences(t, occs,
			[]time.Time{date(2025, 3, 11, 9, 0), date(2025, 3, 13, 9, 0), date(2025, 3, 17, 9, 0)},
			[]string{domain.OccurrenceCurrent, domain.OccurrenceUpcoming, domain.OccurrenceUpcoming})
	})

	// Probe P5: a move of an interval series to an earlier day leaves
	// another client's done override of an earlier repeat behind, off the
	// rule; it stays done where it was (A-10, FR-17).
	t.Run("a done repeat off the rule stays visible", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY"},
			[]string{"RECURRENCE-ID:20250310T090000Z", "STATUS:COMPLETED"})
		moveListed(t, e, id, -8*24*time.Hour) // the current 17 March to 9 March
		checkStored(t, "series", storedObject(t, e, id),
			[]string{"DTSTART:20250309T090000Z", "RECURRENCE-ID:20250310T090000Z"}, nil)
		occs, err := e.svc.ListTodoOccurrences(t.Context(), e.cals["tasks"], date(2025, 3, 1, 0, 0), date(2025, 3, 24, 0, 0))
		mustNoErr(t, err)
		checkTodoOccurrences(t, occs,
			[]time.Time{date(2025, 3, 9, 9, 0), date(2025, 3, 10, 9, 0), date(2025, 3, 16, 9, 0), date(2025, 3, 23, 9, 0)},
			[]string{domain.OccurrenceCurrent, domain.OccurrenceDone, domain.OccurrenceUpcoming, domain.OccurrenceUpcoming})
	})

	// The done repeat that the move above left off the rule, reopened by
	// the other client: it comes after the current repeat. Completing the
	// repeat before it cannot roll the master onto it without moving the
	// rule, so that repeat is excluded instead; completing it writes its
	// entry, and the master rolls from it onto the next instance, past the
	// EXDATE, which stays behind (A-10, FR-17).
	t.Run("an open repeat off the rule can be completed", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		ctx := t.Context()
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY"},
			[]string{"RECURRENCE-ID:20250310T090000Z", "DTSTART:20250310T150000Z", "STATUS:COMPLETED"})
		moveListed(t, e, id, -8*24*time.Hour) // the current 17 March to 9 March
		reopened := strings.Replace(storedObject(t, e, id), "STATUS:COMPLETED", "STATUS:NEEDS-ACTION", 1)
		if _, err := e.mock.PutObject(e.paths["tasks"], "r.ics", reopened); err != nil {
			t.Fatalf("PutObject: %v", err)
		}
		occs, err := e.svc.ListTodoOccurrences(ctx, e.cals["tasks"], date(2025, 3, 1, 0, 0), date(2025, 3, 20, 0, 0))
		mustNoErr(t, err)
		checkTodoOccurrences(t, occs,
			[]time.Time{date(2025, 3, 9, 9, 0), date(2025, 3, 10, 15, 0), date(2025, 3, 16, 9, 0)},
			[]string{domain.OccurrenceCurrent, domain.OccurrenceUpcoming, domain.OccurrenceUpcoming})

		got := completeListed(t, e, id) // 9 March
		if !sameTime(got.Start, ptr(date(2025, 3, 10, 15, 0))) ||
			!sameNext(got.Next, &domain.TodoDates{Start: ptr(date(2025, 3, 16, 9, 0))}) {
			t.Errorf("series = %+v; want the repeat off the rule current, then 16 March", got)
		}
		checkStored(t, "series", storedObject(t, e, id), []string{
			"DTSTART:20250309T090000Z", "EXDATE:20250309T090000Z", "RECURRENCE-ID:20250310T090000Z",
		}, nil)

		got = completeListed(t, e, id) // 10 March, off the rule
		if c := got.CompletedCopy; c == nil || !sameTime(c.Start, ptr(date(2025, 3, 10, 15, 0))) || c.Status != domain.TodoCompleted {
			t.Errorf("completed entry = %+v; want one at 2025-03-10T15:00Z", c)
		}
		if !sameTime(got.Start, ptr(date(2025, 3, 16, 9, 0))) ||
			!sameNext(got.Next, &domain.TodoDates{Start: ptr(date(2025, 3, 23, 9, 0))}) {
			t.Errorf("series = %+v; want 16 March current, then 23 March", got)
		}
		checkStored(t, "entry", storedCopy(t, e, &got),
			[]string{"DTSTART:20250310T150000Z", "STATUS:COMPLETED"}, []string{"RECURRENCE-ID", "RRULE"})
		checkStored(t, "series", storedObject(t, e, id),
			[]string{"DTSTART:20250316T090000Z", "RRULE:FREQ=WEEKLY\r\n", "EXDATE:20250309T090000Z"}, []string{"RECURRENCE-ID"})
		if n := len(e.mock.ObjectPaths(e.paths["tasks"])); n != 3 {
			t.Errorf("%d objects; want the series and two entries", n)
		}
		occs, err = e.svc.ListTodoOccurrences(ctx, e.cals["tasks"], date(2025, 3, 1, 0, 0), date(2025, 3, 31, 0, 0))
		mustNoErr(t, err)
		checkTodoOccurrences(t, occs,
			[]time.Time{date(2025, 3, 16, 9, 0), date(2025, 3, 23, 9, 0), date(2025, 3, 30, 9, 0)},
			[]string{domain.OccurrenceCurrent, domain.OccurrenceUpcoming, domain.OccurrenceUpcoming})
	})

	// Probe P10: an EXDATE of the other value type matches the repeat on its
	// day in the series' zone (A-11, FR-17).
	t.Run("a date EXDATE excludes a timed repeat", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=DAILY;COUNT=3", "EXDATE;VALUE=DATE:20250311"})
		occs, err := e.svc.ListTodoOccurrences(t.Context(), e.cals["tasks"], date(2025, 3, 1, 0, 0), date(2025, 4, 1, 0, 0))
		mustNoErr(t, err)
		checkTodoOccurrences(t, occs,
			[]time.Time{date(2025, 3, 10, 9, 0), date(2025, 3, 12, 9, 0)},
			[]string{domain.OccurrenceCurrent, domain.OccurrenceUpcoming})
	})

	// Midnight in Berlin is the evening before in UTC; its own date counts
	// (A-11, FR-17).
	t.Run("a timed EXDATE excludes an all-day repeat", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		seedSeries(t, e, []string{
			"DTSTART;VALUE=DATE:20250310", "RRULE:FREQ=DAILY;COUNT=3", "EXDATE;TZID=Europe/Berlin:20250311T000000",
		})
		occs, err := e.svc.ListTodoOccurrences(t.Context(), e.cals["tasks"], date(2025, 3, 1, 0, 0), date(2025, 4, 1, 0, 0))
		mustNoErr(t, err)
		checkTodoOccurrences(t, occs,
			[]time.Time{date(2025, 3, 10, 0, 0), date(2025, 3, 12, 0, 0)},
			[]string{domain.OccurrenceCurrent, domain.OccurrenceUpcoming})
	})

	// A RECURRENCE-ID of the other value type completes or moves the repeat
	// on its day in the series' zone, not the one at its instant: 20:00 in
	// New York is midnight UTC of the next day, the instant of the next
	// day's date (A-11, FR-17).
	t.Run("a date override matches the timed repeat on its day", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		seedSeries(t, e, []string{"DTSTART;TZID=America/New_York:20250310T200000", "RRULE:FREQ=DAILY;COUNT=3"},
			[]string{"RECURRENCE-ID;VALUE=DATE:20250311", "STATUS:COMPLETED"},
			[]string{"RECURRENCE-ID;VALUE=DATE:20250312", "DTSTART:20250313T030000Z"},
		)
		occs, err := e.svc.ListTodoOccurrences(t.Context(), e.cals["tasks"], date(2025, 3, 1, 0, 0), date(2025, 4, 1, 0, 0))
		mustNoErr(t, err)
		checkTodoOccurrences(t, occs,
			[]time.Time{date(2025, 3, 11, 0, 0), date(2025, 3, 12, 0, 0), date(2025, 3, 13, 3, 0)},
			[]string{domain.OccurrenceCurrent, domain.OccurrenceDone, domain.OccurrenceUpcoming})
	})

	t.Run("completed master, unsupported rule and single todo", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		e.put(t, "tasks", "c.ics", "BEGIN:VTODO", "UID:c", "DTSTAMP:20240101T000000Z", "SUMMARY:Done series",
			"STATUS:COMPLETED", "DTSTART:20250310T090000Z", "RRULE:FREQ=DAILY", "END:VTODO")
		e.put(t, "tasks", "u.ics", "BEGIN:VTODO", "UID:u", "DTSTAMP:20240101T000000Z", "SUMMARY:Bad rule",
			"DTSTART:20250310T090000Z", "RRULE:FREQ=DAILY;BYDAY=XX", "END:VTODO")
		e.put(t, "tasks", "s.ics", "BEGIN:VTODO", "UID:s", "DTSTAMP:20240101T000000Z", "SUMMARY:Single",
			"DTSTART:20250310T090000Z", "END:VTODO")
		occs, err := e.svc.ListTodoOccurrences(t.Context(), e.cals["tasks"], date(2025, 3, 1, 0, 0), date(2025, 4, 1, 0, 0))
		mustNoErr(t, err)
		if len(occs) != 0 {
			t.Fatalf("ListTodoOccurrences = %+v; want none", occs)
		}
	})

	t.Run("invalid window", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		same := date(2025, 3, 10, 0, 0)
		_, err := e.svc.ListTodoOccurrences(t.Context(), e.cals["tasks"], same, same)
		mustErr(t, err, domain.ErrInvalidInput)
	})

	t.Run("cache", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		ctx := t.Context()
		e.put(t, "tasks", "r.ics", "BEGIN:VTODO", "UID:r", "DTSTAMP:20240101T000000Z", "SUMMARY:Bins",
			"DTSTART:20250310T090000Z", "RRULE:FREQ=DAILY", "END:VTODO")
		e.mock.ResetCounts()
		_, err := e.svc.ListTodos(ctx, e.cals["tasks"])
		mustNoErr(t, err)
		_, err = e.svc.ListTodoOccurrences(ctx, e.cals["tasks"], date(2025, 3, 10, 0, 0), date(2025, 3, 20, 0, 0))
		mustNoErr(t, err)
		if got := e.mock.Count("REPORT"); got != 1 {
			t.Errorf("REPORT count = %d; want 1", got)
		}
	})
}

// seedSeries stores a recurring todo "Series" with the given master lines and
// overrides in the tasks calendar and returns its ID.
func seedSeries(t *testing.T, e *env, master []string, overrides ...[]string) string {
	t.Helper()
	lines := append([]string{"BEGIN:VTODO", "UID:r", "DTSTAMP:20240101T000000Z", "SUMMARY:Series"}, master...)
	lines = append(lines, "END:VTODO")
	for _, o := range overrides {
		lines = append(lines, "BEGIN:VTODO", "UID:r", "DTSTAMP:20240101T000000Z")
		lines = append(append(lines, o...), "END:VTODO")
	}
	return e.put(t, "tasks", "r.ics", lines...)
}

// listedTodo returns the todo with the given ID as ListTodos reports it.
func listedTodo(t *testing.T, e *env, id string) domain.Todo {
	t.Helper()
	todos, err := e.svc.ListTodos(t.Context(), e.cals["tasks"])
	mustNoErr(t, err)
	for i := range todos {
		if todos[i].ID == id {
			return todos[i]
		}
	}
	t.Fatalf("todo %s not in %+v", id, todos)
	return domain.Todo{}
}

// completeInput is what the frontend sends to complete f: its fields as
// reported, with status COMPLETED and no rrule.
func completeInput(f *domain.Todo) domain.TodoInput {
	return domain.TodoInput{
		Title: f.Title, Description: f.Description, Checklist: f.Checklist,
		Start: f.Start, StartAllDay: f.StartAllDay, Due: f.Due, DueAllDay: f.DueAllDay,
		Priority: f.Priority, Status: domain.TodoCompleted, RRuleOmitted: true,
	}
}

// completeListed completes the todo with the given ID as a client would.
func completeListed(t *testing.T, e *env, id string) domain.Todo {
	t.Helper()
	f := listedTodo(t, e, id)
	got, _, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, completeInput(&f))
	mustNoErr(t, err)
	return got
}

// storedObject returns the stored data of the object with the given ID.
func storedObject(t *testing.T, e *env, id string) string {
	t.Helper()
	objPath, _, err := decodeObjectID(e.mock.HomePath(), id)
	mustNoErr(t, err)
	data, ok := e.mock.Object(objPath)
	if !ok {
		t.Fatalf("no object %s", objPath)
	}
	return data
}

// checkStored asserts that data contains every string of has and none of lacks.
func checkStored(t *testing.T, what, data string, has, lacks []string) {
	t.Helper()
	for _, want := range has {
		if !strings.Contains(data, want) {
			t.Errorf("%s lacks %q:\n%s", what, want, data)
		}
	}
	for _, bad := range lacks {
		if strings.Contains(data, bad) {
			t.Errorf("%s contains %q:\n%s", what, bad, data)
		}
	}
}

// storedCopy returns the stored data of the completed copy in got.
func storedCopy(t *testing.T, e *env, got *domain.Todo) string {
	t.Helper()
	if got.CompletedCopy == nil {
		t.Fatalf("no completed copy in %+v", got)
	}
	return storedObject(t, e, got.CompletedCopy.ID)
}

// Completing the current occurrence of a recurring todo leaves a completed
// copy and rolls the series to its next occurrence (FR-15, FR-17).
func TestCompleteTodoOccurrence(t *testing.T) {
	t.Parallel()

	t.Run("rolls and copies", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{
			"DTSTART;TZID=Europe/Berlin:20250310T090000", "DUE;TZID=Europe/Berlin:20250310T110000", "RRULE:FREQ=WEEKLY",
			"PRIORITY:1", "DESCRIPTION:Notes\\n\\n- [x] a", "X-FOO:bar",
		})
		got := completeListed(t, e, id)

		if !sameTime(got.Start, ptr(date(2025, 3, 17, 8, 0))) || !sameTime(got.Due, ptr(date(2025, 3, 17, 10, 0))) ||
			got.Status != domain.TodoNeedsAction || got.Completed != nil || got.Priority != 1 || got.Description != "Notes" ||
			!reflect.DeepEqual(got.Checklist, []domain.ChecklistItem{{Text: "a"}}) || !got.Recurring ||
			!sameNext(got.Next, &domain.TodoDates{Start: ptr(date(2025, 3, 24, 8, 0)), Due: ptr(date(2025, 3, 24, 10, 0))}) {
			t.Errorf("rolled series = %+v", got)
		}
		c := got.CompletedCopy
		if c == nil {
			t.Fatalf("no completed copy in %+v", got)
		}
		if !sameTime(c.Start, ptr(date(2025, 3, 10, 8, 0))) || !sameTime(c.Due, ptr(date(2025, 3, 10, 10, 0))) ||
			c.Status != domain.TodoCompleted || !sameTime(c.Completed, ptr(e.clock.Now())) || c.Recurring ||
			c.Title != "Series" || c.Priority != 1 || c.Description != "Notes" || c.ID == id || c.ETag == "" ||
			c.CalendarID != e.cals["tasks"] || !reflect.DeepEqual(c.Checklist, []domain.ChecklistItem{{Text: "a", Done: true}}) {
			t.Errorf("completed copy = %+v", c)
		}
		if n := len(e.mock.ObjectPaths(e.paths["tasks"])); n != 2 {
			t.Errorf("%d objects; want the series and its copy", n)
		}
		checkStored(t, "master", storedObject(t, e, id), []string{
			"DTSTART;TZID=Europe/Berlin:20250317T090000", "DUE;TZID=Europe/Berlin:20250317T110000", "RRULE:FREQ=WEEKLY\r\n",
			"X-FOO:bar", "STATUS:NEEDS-ACTION", `DESCRIPTION:Notes\n\n- [ ] a`, "PRIORITY:1",
		}, []string{"COMPLETED", "PERCENT-COMPLETE"})
		checkStored(t, "copy", storedCopy(t, e, &got), []string{
			"DTSTART;TZID=Europe/Berlin:20250310T090000", "DUE;TZID=Europe/Berlin:20250310T110000", "BEGIN:VTIMEZONE",
			"STATUS:COMPLETED", "COMPLETED:20250301T120000Z", "PERCENT-COMPLETE:100", `DESCRIPTION:Notes\n\n- [x] a`, "PRIORITY:1",
		}, []string{"RRULE:FREQ=WEEKLY", "\r\nUID:r\r\n"}) // the VTIMEZONE has RRULEs of its own
	})

	t.Run("rolls one step when overdue", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250220T090000Z", "RRULE:FREQ=DAILY"})
		got := completeListed(t, e, id)
		if !sameTime(got.Start, ptr(date(2025, 2, 21, 9, 0))) {
			t.Errorf("start = %v; want 2025-02-21T09:00Z", got.Start)
		}
		checkStored(t, "master", storedObject(t, e, id), []string{"DTSTART:20250221T090000Z"}, nil)
		checkStored(t, "copy", storedCopy(t, e, &got), []string{"DTSTART:20250220T090000Z"}, nil)
	})

	t.Run("dst", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART;TZID=Europe/Berlin:20261019T090000", "RRULE:FREQ=WEEKLY"})
		got := completeListed(t, e, id)
		if !sameTime(got.Start, ptr(date(2026, 10, 26, 8, 0))) {
			t.Errorf("start = %v; want 2026-10-26T08:00Z", got.Start)
		}
		checkStored(t, "master", storedObject(t, e, id), []string{"DTSTART;TZID=Europe/Berlin:20261026T090000"}, nil)
	})

	t.Run("due only", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DUE;VALUE=DATE:20250310", "RRULE:FREQ=DAILY"})
		got := completeListed(t, e, id)
		if !sameTime(got.Due, ptr(date(2025, 3, 11, 0, 0))) || !got.DueAllDay ||
			!sameNext(got.Next, &domain.TodoDates{
				Start: ptr(date(2025, 3, 12, 0, 0)), StartAllDay: true,
				Due: ptr(date(2025, 3, 12, 0, 0)), DueAllDay: true,
			}) {
			t.Errorf("rolled series = %+v", got)
		}
		if c := got.CompletedCopy; c == nil || !sameTime(c.Due, ptr(date(2025, 3, 10, 0, 0))) || !c.DueAllDay {
			t.Errorf("completed copy = %+v", c)
		}
		checkStored(t, "master", storedObject(t, e, id), []string{"DTSTART;VALUE=DATE:20250311", "DUE;VALUE=DATE:20250311"}, nil)
		checkStored(t, "copy", storedCopy(t, e, &got), []string{"DTSTART;VALUE=DATE:20250310", "DUE;VALUE=DATE:20250310"}, nil)
	})

	t.Run("count to until and end", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		ctx := t.Context()
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=DAILY;COUNT=3"})

		first := completeListed(t, e, id)
		checkStored(t, "master", storedObject(t, e, id),
			[]string{"RRULE:FREQ=DAILY;UNTIL=20250312T090000Z\r\n", "DTSTART:20250311T090000Z"}, []string{"COUNT"})
		if first.CompletedCopy == nil || first.Next == nil {
			t.Fatalf("after the 1st completion: %+v", first)
		}

		second, _, err := e.svc.UpdateTodo(ctx, id, first.ETag, completeInput(&first))
		mustNoErr(t, err)
		checkStored(t, "master", storedObject(t, e, id), []string{"DTSTART:20250312T090000Z"}, nil)
		if second.CompletedCopy == nil || second.Next != nil {
			t.Fatalf("after the 2nd completion: %+v", second)
		}

		third, _, err := e.svc.UpdateTodo(ctx, id, second.ETag, completeInput(&second))
		mustNoErr(t, err)
		if third.CompletedCopy != nil || third.Status != domain.TodoCompleted {
			t.Errorf("after the last completion: %+v", third)
		}
		checkStored(t, "master", storedObject(t, e, id), []string{"STATUS:COMPLETED", "DTSTART:20250312T090000Z"}, nil)
		if n := len(e.mock.ObjectPaths(e.paths["tasks"])); n != 3 {
			t.Errorf("%d objects; want the series and 2 copies", n)
		}
	})

	t.Run("count to until all-day", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART;VALUE=DATE:20250310", "RRULE:FREQ=DAILY;COUNT=3"})
		completeListed(t, e, id)
		checkStored(t, "master", storedObject(t, e, id),
			[]string{"RRULE:FREQ=DAILY;UNTIL=20250312\r\n", "DTSTART;VALUE=DATE:20250311"}, []string{"COUNT"})
	})

	t.Run("overrides", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250309T090000Z", "RRULE:FREQ=DAILY"},
			[]string{"RECURRENCE-ID:20250309T090000Z", "STATUS:COMPLETED"},
			[]string{"RECURRENCE-ID:20250310T090000Z", "DTSTART:20250310T150000Z"},
		)
		got := completeListed(t, e, id)
		if !sameTime(got.Start, ptr(date(2025, 3, 11, 9, 0))) {
			t.Errorf("start = %v; want 2025-03-11T09:00Z", got.Start)
		}
		checkStored(t, "master", storedObject(t, e, id),
			[]string{"DTSTART:20250311T090000Z", "RECURRENCE-ID:20250309T090000Z"},
			[]string{"RECURRENCE-ID:20250310T090000Z", "DTSTART:20250310T150000Z"})
		checkStored(t, "copy", storedCopy(t, e, &got), []string{"DTSTART:20250310T150000Z"}, []string{"RECURRENCE-ID"})
	})

	// The master takes the rule's date for the next occurrence; its override
	// keeps moving it, instead of shifting the whole series (FR-17).
	t.Run("next override stays", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=DAILY"},
			[]string{"RECURRENCE-ID:20250311T090000Z", "DTSTART:20250311T150000Z"},
		)
		got := completeListed(t, e, id)
		if !sameTime(got.Start, ptr(date(2025, 3, 11, 15, 0))) ||
			!sameNext(got.Next, &domain.TodoDates{Start: ptr(date(2025, 3, 12, 9, 0))}) {
			t.Errorf("rolled series = %+v; want the moved 2025-03-11T15:00Z, then 2025-03-12T09:00Z", got)
		}
		checkStored(t, "master", storedObject(t, e, id),
			[]string{"DTSTART:20250311T090000Z", "RECURRENCE-ID:20250311T090000Z", "DTSTART:20250311T150000Z"}, nil)
	})

	// An override whose RECURRENCE-ID is a date in a timed series is that
	// day's repeat: the entry is its clone, and it goes with the roll (A-11,
	// FR-17).
	t.Run("a date override goes with its completion", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=DAILY"},
			[]string{"RECURRENCE-ID;VALUE=DATE:20250310", "DTSTART:20250310T150000Z", "SUMMARY:Moved"})
		got := completeListed(t, e, id)
		if c := got.CompletedCopy; c == nil || !sameTime(c.Start, ptr(date(2025, 3, 10, 15, 0))) || c.Title != "Moved" {
			t.Errorf("completed copy = %+v; want the override's 2025-03-10T15:00Z and title", c)
		}
		checkStored(t, "master", storedObject(t, e, id), []string{"DTSTART:20250311T090000Z"}, []string{"RECURRENCE-ID", "Moved"})
	})

	// A repeat off the rule followed by another one off the rule: the
	// master cannot roll onto the next, so only the completed repeat's
	// override goes. The change can be undone like any completion (A-10,
	// FR-17).
	t.Run("a repeat off the rule before another completes on its own", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250309T090000Z", "RRULE:FREQ=WEEKLY", "EXDATE:20250309T090000Z"},
			[]string{"RECURRENCE-ID:20250310T090000Z", "DTSTART:20250310T150000Z"},
			[]string{"RECURRENCE-ID:20250311T090000Z"},
		)
		f := listedTodo(t, e, id)
		got, snap, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, completeInput(&f))
		mustNoErr(t, err)
		c := got.CompletedCopy
		if c == nil || !sameTime(c.Start, ptr(date(2025, 3, 10, 15, 0))) {
			t.Fatalf("completed copy = %+v; want one at 2025-03-10T15:00Z", c)
		}
		if snap == nil || snap.CopyID != c.ID || snap.CopyETag != c.ETag || snap.ETag != got.ETag {
			t.Errorf("snapshot = %+v; want one with the copy %s (%s)", snap, c.ID, c.ETag)
		}
		if !sameTime(got.Start, ptr(date(2025, 3, 11, 9, 0))) ||
			!sameNext(got.Next, &domain.TodoDates{Start: ptr(date(2025, 3, 16, 9, 0))}) {
			t.Errorf("series = %+v; want 11 March current, then 16 March", got)
		}
		checkStored(t, "series", storedObject(t, e, id),
			[]string{"DTSTART:20250309T090000Z", "EXDATE:20250309T090000Z", "RECURRENCE-ID:20250311T090000Z"},
			[]string{"RECURRENCE-ID:20250310T090000Z", "DTSTART:20250310T150000Z"})
	})

	// The EXDATE that keeps the master from rolling onto a repeat off the
	// rule has the form of DTSTART, or of DUE for a series anchored on it
	// (A-10, FR-17).
	for _, tc := range []struct {
		name        string
		master      []string
		override    string
		start, due  *time.Time
		has, lacks  []string
		startAllDay bool
	}{
		{
			name:     "tzid",
			master:   []string{"DTSTART;TZID=Europe/Berlin:20250309T090000", "RRULE:FREQ=WEEKLY"},
			override: "RECURRENCE-ID;TZID=Europe/Berlin:20250311T090000",
			start:    ptr(date(2025, 3, 11, 8, 0)),
			has:      []string{"DTSTART;TZID=Europe/Berlin:20250309T090000", "EXDATE;TZID=Europe/Berlin:20250309T090000"},
		},
		{
			name:     "date",
			master:   []string{"DTSTART;VALUE=DATE:20250309", "RRULE:FREQ=WEEKLY"},
			override: "RECURRENCE-ID;VALUE=DATE:20250311",
			start:    ptr(date(2025, 3, 11, 0, 0)), startAllDay: true,
			has: []string{"DTSTART;VALUE=DATE:20250309", "EXDATE;VALUE=DATE:20250309"},
		},
		{
			name:     "anchored on due",
			master:   []string{"DUE:20250309T090000Z", "RRULE:FREQ=WEEKLY"},
			override: "RECURRENCE-ID:20250311T090000Z",
			due:      ptr(date(2025, 3, 11, 9, 0)),
			has:      []string{"DUE:20250309T090000Z", "EXDATE:20250309T090000Z"},
			lacks:    []string{"DTSTART"},
		},
	} {
		t.Run("a repeat before one off the rule is excluded, "+tc.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			id := seedSeries(t, e, tc.master, []string{tc.override})
			got := completeListed(t, e, id)
			if got.CompletedCopy == nil || !sameTime(got.Start, tc.start) || got.StartAllDay != tc.startAllDay || !sameTime(got.Due, tc.due) {
				t.Errorf("series = %+v; want the repeat off the rule current, at %v/%v", got, tc.start, tc.due)
			}
			checkStored(t, "series", storedObject(t, e, id), tc.has, tc.lacks)
		})
	}

	// The copy is a clone of the stored occurrence: what Lucid does not edit
	// stays, only the rule and its alarms and children go, and so do the
	// scheduling properties of a private record (FR-17).
	t.Run("copy keeps the master's other properties", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{
			"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY", "EXDATE:20250324T090000Z", "EXRULE:FREQ=MONTHLY",
			"CATEGORIES:Home", "RELATED-TO:parent-uid", "LOCATION:Desk", "URL:https://x", "X-FOO:bar",
			"RELATED-TO;RELTYPE=CHILD:kid", "ORGANIZER:mailto:me@example.com", "ATTENDEE:mailto:you@example.com",
			"SEQUENCE:7", "CREATED:20200101T000000Z",
			"BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-PT15M", "DESCRIPTION:Reminder", "END:VALARM",
		})
		got := completeListed(t, e, id)
		if c := got.CompletedCopy; c == nil || c.UID == "" || c.UID == "r" {
			t.Errorf("completed copy = %+v; want a new UID", c)
		}
		checkStored(t, "copy", storedCopy(t, e, &got), []string{
			"CATEGORIES:Home", "RELATED-TO:parent-uid", "LOCATION:Desk", "URL:https://x", "X-FOO:bar",
			"STATUS:COMPLETED", "PERCENT-COMPLETE:100", "DTSTART:20250310T090000Z",
			"SEQUENCE:0\r\n", "CREATED:20250301T120000Z",
		}, []string{
			"RRULE", "EXDATE", "EXRULE", "BEGIN:VALARM", "RELTYPE=CHILD", "\r\nUID:r\r\n", "ORGANIZER", "ATTENDEE",
			"SEQUENCE:7", "CREATED:20200101T000000Z",
		})
		// Cloning leaves the series' own properties alone.
		checkStored(t, "master", storedObject(t, e, id), []string{
			"RRULE:FREQ=WEEKLY", "EXDATE:20250324T090000Z", "EXRULE:FREQ=MONTHLY", "CATEGORIES:Home",
			"RELATED-TO:parent-uid", "RELATED-TO;RELTYPE=CHILD:kid", "BEGIN:VALARM", "X-FOO:bar",
			"ORGANIZER:mailto:me@example.com", "ATTENDEE:mailto:you@example.com",
		}, nil)
	})

	// Probe P3: the frontend knows only the series, so a request that
	// leaves its title and notes as they are must not overwrite the
	// override's own (FR-17).
	t.Run("copy of an overridden occurrence keeps its own fields", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY", "CATEGORIES:Home", "X-FOO:bar"},
			[]string{
				"RECURRENCE-ID:20250310T090000Z", "DTSTART:20250311T100000Z",
				"SUMMARY:Moved title", "DESCRIPTION:Override notes", "LOCATION:Here",
			})
		got := completeListed(t, e, id)
		if c := got.CompletedCopy; c == nil || c.Title != "Moved title" || c.Description != "Override notes" {
			t.Errorf("completed copy = %+v; want the override's title and notes", c)
		}
		checkStored(t, "copy", storedCopy(t, e, &got), []string{
			"SUMMARY:Moved title", "DESCRIPTION:Override notes", "LOCATION:Here", "CATEGORIES:Home", "X-FOO:bar",
			"DTSTART:20250311T100000Z",
		}, []string{"SUMMARY:Series", "RECURRENCE-ID"})
		checkStored(t, "master", storedObject(t, e, id),
			[]string{"SUMMARY:Series", "DTSTART:20250317T090000Z"}, []string{"Moved title", "LOCATION"})
	})

	// Review Focus 3: another client's override with only its dates keeps
	// the series' title and categories (FR-17).
	t.Run("copy of a minimal override keeps the series title", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e,
			[]string{"DTSTART:20250310T090000Z", "DUE:20250310T100000Z", "RRULE:FREQ=WEEKLY", "CATEGORIES:Home"},
			[]string{
				"RECURRENCE-ID:20250310T090000Z", "DTSTART:20250310T150000Z", "DUE:20250310T160000Z", "STATUS:IN-PROCESS",
			})
		got := completeListed(t, e, id)
		if c := got.CompletedCopy; c == nil || c.Title != "Series" || c.Status != domain.TodoCompleted {
			t.Errorf("completed copy = %+v; want the series' title, completed", c)
		}
		checkStored(t, "copy", storedCopy(t, e, &got), []string{
			"SUMMARY:Series", "CATEGORIES:Home", "DTSTART:20250310T150000Z", "DUE:20250310T160000Z", "STATUS:COMPLETED",
		}, []string{"RECURRENCE-ID", "IN-PROCESS"})
	})

	// What the client changes while completing goes to the copy, over an
	// override's own value, and to the series (FR-17).
	t.Run("a title changed while completing goes to the copy", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY"},
			[]string{"RECURRENCE-ID:20250310T090000Z", "SUMMARY:Moved title"})
		f := listedTodo(t, e, id)
		in := completeInput(&f)
		in.Title, in.Priority = "Renamed", 5
		got, _, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, in)
		mustNoErr(t, err)
		if c := got.CompletedCopy; got.Title != "Renamed" || c == nil || c.Title != "Renamed" || c.Priority != 5 {
			t.Errorf("rolled series = %+v, copy = %+v; want both renamed", got, c)
		}
		checkStored(t, "copy", storedCopy(t, e, &got), []string{"SUMMARY:Renamed", "PRIORITY:5"}, []string{"Moved title"})
		checkStored(t, "master", storedObject(t, e, id), []string{"SUMMARY:Renamed", "PRIORITY:5"}, nil)
	})

	// Notes and checklist share DESCRIPTION; a change to one keeps the
	// override's other (FR-17).
	t.Run("a checklist checked while completing keeps the override's notes", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY", `DESCRIPTION:Notes\n\n- [ ] a`},
			[]string{"RECURRENCE-ID:20250310T090000Z", "DESCRIPTION:Override notes"})
		f := listedTodo(t, e, id)
		in := completeInput(&f)
		in.Checklist = []domain.ChecklistItem{{Text: "a", Done: true}}
		got, _, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, in)
		mustNoErr(t, err)
		checkStored(t, "copy", storedCopy(t, e, &got), []string{`DESCRIPTION:Override notes\n\n- [x] a`}, nil)
		checkStored(t, "master", storedObject(t, e, id), []string{`DESCRIPTION:Notes\n\n- [ ] a`}, nil)
	})

	t.Run("duration stays", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "DURATION:PT2H", "RRULE:FREQ=DAILY"})
		got := completeListed(t, e, id)
		if !sameTime(got.Due, ptr(date(2025, 3, 11, 11, 0))) {
			t.Errorf("due = %v; want 2025-03-11T11:00Z", got.Due)
		}
		checkStored(t, "master", storedObject(t, e, id), []string{"DTSTART:20250311T090000Z", "DURATION:PT2H"}, []string{"DUE"})
		// DUE stands for the master's DURATION; RFC 5545 allows only one.
		checkStored(t, "copy", storedCopy(t, e, &got), []string{"DTSTART:20250310T090000Z", "DUE:20250310T110000Z"}, []string{"DURATION"})
	})

	// A rolled series keeps the date form other clients wrote (FR-17).
	t.Run("floating", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000", "RRULE:FREQ=DAILY;COUNT=3"})
		got := completeListed(t, e, id)
		checkStored(t, "master", storedObject(t, e, id),
			[]string{"DTSTART:20250311T090000\r\n", "RRULE:FREQ=DAILY;UNTIL=20250312T090000\r\n"}, nil)
		checkStored(t, "copy", storedCopy(t, e, &got), []string{"DTSTART:20250310T090000\r\n"}, nil)
	})

	// Lucid reads the wall clock of a zone it cannot resolve as UTC, so an
	// UNTIL it computed would miss the last occurrence's real instant by the
	// zone's offset; the COUNT goes down by the occurrence left behind
	// instead (FR-17).
	t.Run("unknown zone lowers COUNT instead of writing UNTIL", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART;TZID=W. Europe Standard Time:20250310T090000", "RRULE:FREQ=WEEKLY;COUNT=3"})
		completeListed(t, e, id)
		checkStored(t, "master", storedObject(t, e, id),
			[]string{"DTSTART;TZID=W. Europe Standard Time:20250317T090000", "RRULE:FREQ=WEEKLY;COUNT=2\r\n"}, []string{"UNTIL"})
		occs, err := e.svc.ListTodoOccurrences(t.Context(), e.cals["tasks"], date(2025, 3, 1, 0, 0), date(2025, 4, 1, 0, 0))
		mustNoErr(t, err)
		checkTodoOccurrences(t, occs,
			[]time.Time{date(2025, 3, 17, 9, 0), date(2025, 3, 24, 9, 0)},
			[]string{domain.OccurrenceCurrent, domain.OccurrenceUpcoming})
	})

	for _, tc := range []struct{ name, tzid string }{
		{"unknown tzid", "W. Europe Standard Time"},
		{"prefixed tzid", "/mozilla.org/20050126_1/Europe/Berlin"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			id := e.put(t, "tasks", "r.ics",
				"BEGIN:VTIMEZONE", "TZID:"+tc.tzid,
				"BEGIN:STANDARD", "DTSTART:19701025T030000", "TZOFFSETFROM:+0200", "TZOFFSETTO:+0100",
				"RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU", "END:STANDARD",
				"BEGIN:DAYLIGHT", "DTSTART:19700329T020000", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0200",
				"RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU", "END:DAYLIGHT",
				"END:VTIMEZONE",
				"BEGIN:VTODO", "UID:r", "DTSTAMP:20240101T000000Z", "SUMMARY:Series",
				"DTSTART;TZID="+tc.tzid+":20250310T090000", "DUE;TZID="+tc.tzid+":20250310T110000", "RRULE:FREQ=WEEKLY",
				"END:VTODO",
			)
			got := completeListed(t, e, id)
			master, cp := storedObject(t, e, id), storedCopy(t, e, &got)
			checkStored(t, "master", master,
				[]string{"DTSTART;TZID=" + tc.tzid + ":20250317T090000", "DUE;TZID=" + tc.tzid + ":20250317T110000"}, nil)
			checkStored(t, "copy", cp,
				[]string{"DTSTART;TZID=" + tc.tzid + ":20250310T090000", "DUE;TZID=" + tc.tzid + ":20250310T110000", "TZID:" + tc.tzid}, nil)
			for what, data := range map[string]string{"master": master, "copy": cp} {
				if n := strings.Count(data, "BEGIN:VTIMEZONE"); n != 1 {
					t.Errorf("%s has %d VTIMEZONEs; want the original only:\n%s", what, n, data)
				}
			}
		})
	}

	// The rolling model cannot keep an RDATE off the rule without shifting
	// the rule, so such a series is not completed in Lucid (FR-17).
	t.Run("rdate rejected", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250110T090000Z", "RRULE:FREQ=MONTHLY", "RDATE:20250120T090000Z"})
		f := listedTodo(t, e, id)
		before := storedObject(t, e, id)
		_, _, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, completeInput(&f))
		mustErr(t, err, domain.ErrInvalidInput)
		if n := len(e.mock.ObjectPaths(e.paths["tasks"])); n != 1 {
			t.Errorf("%d objects; want only the series", n)
		}
		if after := storedObject(t, e, id); after != before {
			t.Errorf("series changed:\n%s\nwant:\n%s", after, before)
		}
	})

	t.Run("kde", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=DAILY", "X-KDE-LIBKCAL-DTRECURRENCE:20250314T090000Z"})
		got := completeListed(t, e, id)
		checkStored(t, "master", storedObject(t, e, id), []string{"DTSTART:20250315T090000Z"}, []string{"X-KDE-LIBKCAL-DTRECURRENCE"})
		checkStored(t, "copy", storedCopy(t, e, &got), []string{"DTSTART:20250314T090000Z"}, []string{"X-KDE-LIBKCAL-DTRECURRENCE"})
	})

	// The copy is the occurrence as the client describes it; the series
	// rolls on from what is stored (FR-17).
	t.Run("changed dates go to the copy", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "DUE:20250310T100000Z", "RRULE:FREQ=WEEKLY"})
		f := listedTodo(t, e, id)
		in := completeInput(&f)
		in.Start, in.Due = ptr(date(2025, 3, 11, 9, 0)), ptr(date(2025, 3, 11, 10, 0))
		got, _, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, in)
		mustNoErr(t, err)
		checkStored(t, "master", storedObject(t, e, id), []string{"DTSTART:20250317T090000Z", "DUE:20250317T100000Z"}, nil)
		checkStored(t, "copy", storedCopy(t, e, &got), []string{"DTSTART:20250311T090000Z", "DUE:20250311T100000Z"}, nil)
	})

	t.Run("conflict deletes the copy", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=DAILY"})
		f := listedTodo(t, e, id)
		objPath, _, _ := decodeObjectID(e.mock.HomePath(), id)
		e.mock.SetHook(func(w http.ResponseWriter, r *http.Request) bool {
			if r.Method == http.MethodPut && r.URL.Path == objPath {
				w.WriteHeader(http.StatusPreconditionFailed)
				return true
			}
			return false
		})
		e.mock.ResetCounts()
		_, _, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, completeInput(&f))
		mustErr(t, err, domain.ErrConflict)
		if n := len(e.mock.ObjectPaths(e.paths["tasks"])); n != 1 {
			t.Errorf("%d objects; want only the series", n)
		}
		if n := e.mock.Count(http.MethodDelete); n != 1 {
			t.Errorf("DELETE count = %d; want 1", n)
		}
		checkStored(t, "master", storedObject(t, e, id), []string{"DTSTART:20250310T090000Z"}, []string{"COMPLETED"})
	})

	t.Run("failed delete keeps the copy and logs", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		var logs bytes.Buffer
		e.p.log = slog.New(slog.NewTextHandler(&logs, nil))
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=DAILY"})
		f := listedTodo(t, e, id)
		objPath, _, _ := decodeObjectID(e.mock.HomePath(), id)
		e.mock.SetHook(func(w http.ResponseWriter, r *http.Request) bool {
			switch {
			case r.Method == http.MethodPut && r.URL.Path == objPath:
				w.WriteHeader(http.StatusPreconditionFailed)
				return true
			case r.Method == http.MethodDelete:
				w.WriteHeader(http.StatusInternalServerError)
				return true
			}
			return false
		})
		_, _, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, completeInput(&f))
		mustErr(t, err, domain.ErrConflict)
		paths := e.mock.ObjectPaths(e.paths["tasks"])
		if len(paths) != 2 {
			t.Fatalf("objects = %v; want the series and the stray copy", paths)
		}
		copyPath := paths[0]
		if copyPath == objPath {
			copyPath = paths[1]
		}
		checkStored(t, "log", logs.String(),
			[]string{"could not remove the copy of a completed occurrence", "path=" + copyPath, "error="}, []string{"Series"})
	})

	// The client may go away between the two PUTs (a closed tab): the copy
	// still has to go, or it stays next to the open occurrence in every
	// client (FR-17).
	t.Run("cancelled request still deletes the copy", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=DAILY"})
		f := listedTodo(t, e, id)
		objPath, _, _ := decodeObjectID(e.mock.HomePath(), id)
		ctx, cancel := context.WithCancel(t.Context())
		defer cancel()
		e.mock.SetHook(func(w http.ResponseWriter, r *http.Request) bool {
			if r.Method == http.MethodPut && r.URL.Path == objPath {
				// The client disconnects while the master is being written.
				cancel()
				w.WriteHeader(http.StatusPreconditionFailed)
				return true
			}
			return false
		})
		e.mock.ResetCounts()
		if _, _, err := e.svc.UpdateTodo(ctx, id, f.ETag, completeInput(&f)); err == nil {
			t.Fatal("UpdateTodo succeeded; want an error")
		}
		if n := len(e.mock.ObjectPaths(e.paths["tasks"])); n != 1 {
			t.Errorf("%d objects; want only the series", n)
		}
		if n := e.mock.Count(http.MethodDelete); n != 1 {
			t.Errorf("DELETE count = %d; want 1", n)
		}
		checkStored(t, "master", storedObject(t, e, id), []string{"DTSTART:20250310T090000Z"}, []string{"COMPLETED"})
	})

	t.Run("failed copy changes nothing", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=DAILY"})
		f := listedTodo(t, e, id)
		e.mock.SetHook(func(w http.ResponseWriter, r *http.Request) bool {
			if r.Method == http.MethodPut && r.Header.Get("If-None-Match") == "*" {
				w.WriteHeader(http.StatusForbidden)
				return true
			}
			return false
		})
		e.mock.ResetCounts()
		_, _, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, completeInput(&f))
		mustErr(t, err, domain.ErrReadOnly)
		if n := e.mock.Count(http.MethodPut); n != 1 {
			t.Errorf("PUT count = %d; want only the copy's", n)
		}
		checkStored(t, "master", storedObject(t, e, id), []string{"DTSTART:20250310T090000Z"}, []string{"STATUS", "SEQUENCE"})
	})

	// COUNT becomes UNTIL only if the rule can be walked to its end; else
	// nothing is written (FR-17).
	t.Run("count beyond the cap rejected", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", fmt.Sprintf("RRULE:FREQ=DAILY;COUNT=%d", maxRRuleIterations+1)})
		f := listedTodo(t, e, id)
		e.mock.ResetCounts()
		_, _, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, completeInput(&f))
		mustErr(t, err, domain.ErrInvalidInput)
		if n := e.mock.Count(http.MethodPut); n != 0 {
			t.Errorf("PUT count = %d; want 0", n)
		}
	})

	t.Run("stale etag", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=DAILY"})
		f := listedTodo(t, e, id)
		e.mock.ResetCounts()
		_, _, err := e.svc.UpdateTodo(t.Context(), id, "bogus", completeInput(&f))
		mustErr(t, err, domain.ErrConflict)
		if n := e.mock.Count(http.MethodPut); n != 0 {
			t.Errorf("PUT count = %d; want 0", n)
		}
	})

	t.Run("unsupported rejected", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=DAILY;BYDAY=XX"})
		f := listedTodo(t, e, id)
		e.mock.ResetCounts()
		_, _, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, completeInput(&f))
		mustErr(t, err, domain.ErrInvalidInput)
		if n := len(e.mock.ObjectPaths(e.paths["tasks"])); n != 1 || e.mock.Count(http.MethodPut) != 0 {
			t.Errorf("%d objects, %d PUTs; want 1 and none", n, e.mock.Count(http.MethodPut))
		}
	})

	t.Run("reopen completed series", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{
			"STATUS:COMPLETED", "COMPLETED:20250305T100000Z", "PERCENT-COMPLETE:100", "DTSTART:20250310T090000Z", "RRULE:FREQ=DAILY",
		})
		f := listedTodo(t, e, id)
		in := completeInput(&f)
		in.Status = domain.TodoNeedsAction
		got, _, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, in)
		mustNoErr(t, err)
		if got.Status != domain.TodoNeedsAction || got.CompletedCopy != nil {
			t.Errorf("reopened series = %+v", got)
		}
		if n := len(e.mock.ObjectPaths(e.paths["tasks"])); n != 1 {
			t.Errorf("%d objects; want only the series", n)
		}
		checkStored(t, "master", storedObject(t, e, id), []string{"DTSTART:20250310T090000Z", "STATUS:NEEDS-ACTION"}, []string{"COMPLETED"})
	})
}

// editInput is what the frontend sends to save f: its fields as reported,
// without rrule.
func editInput(f *domain.Todo) domain.TodoInput {
	in := completeInput(f)
	in.Status = f.Status
	return in
}

// moveListed moves the todo with the given ID by d as a client would.
func moveListed(t *testing.T, e *env, id string, d time.Duration) domain.Todo {
	t.Helper()
	f := listedTodo(t, e, id)
	in := editInput(&f)
	if f.Start != nil {
		in.Start = ptr(f.Start.Add(d))
	}
	if f.Due != nil {
		in.Due = ptr(f.Due.Add(d))
	}
	got, _, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, in)
	mustNoErr(t, err)
	return got
}

// checkMoveWindow asserts that w is the window [from, until), each nil for
// none.
func checkMoveWindow(t *testing.T, w *domain.MoveWindow, from, until *time.Time) {
	t.Helper()
	if w == nil || !sameTime(w.From, from) || !sameTime(w.Until, until) {
		t.Errorf("moveWindow = %+v; want from %v until %v", w, from, until)
	}
}

// mustWindowErr asserts that err is the ValidationError with message msg.
func mustWindowErr(t *testing.T, err error, msg string) {
	t.Helper()
	var ve *domain.ValidationError
	if !errors.As(err, &ve) || ve.Msg != msg {
		t.Fatalf("error = %v; want the validation error %q", err, msg)
	}
}

// withRule returns in with its rrule set to rr ("" removes the rule).
func withRule(in domain.TodoInput, rr string) domain.TodoInput {
	in.RRule, in.RRuleOmitted = rr, false
	return in
}

// Moving a series moves its current occurrence, and the rule with it; the
// rule itself can be set, changed and removed like an event's (FR-10, FR-17).
func TestUpdateTodoSeries(t *testing.T) {
	t.Parallel()
	berlinWeekly := []string{
		"DTSTART;TZID=Europe/Berlin:20250310T090000", "DUE;TZID=Europe/Berlin:20250310T110000", "RRULE:FREQ=WEEKLY",
	}

	t.Run("move interval series", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, berlinWeekly)
		f := listedTodo(t, e, id)
		in := editInput(&f)
		in.Start, in.Due = ptr(f.Start.AddDate(0, 0, 2)), ptr(f.Due.AddDate(0, 0, 2))
		got, _, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, in)
		mustNoErr(t, err)
		if !sameTime(got.Start, ptr(date(2025, 3, 12, 8, 0))) || !sameTime(got.Due, ptr(date(2025, 3, 12, 10, 0))) ||
			!sameNext(got.Next, &domain.TodoDates{Start: ptr(date(2025, 3, 19, 8, 0)), Due: ptr(date(2025, 3, 19, 10, 0))}) {
			t.Errorf("moved series = %+v", got)
		}
		checkStored(t, "master", storedObject(t, e, id), []string{
			"DTSTART;TZID=Europe/Berlin:20250312T090000", "DUE;TZID=Europe/Berlin:20250312T110000", "RRULE:FREQ=WEEKLY\r\n",
		}, nil)
	})

	// The stored form stays, whatever the browser's zone; COUNT loses the
	// occurrence before the moved one, so that as many remain (FR-17).
	t.Run("move drops the current override and kde", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{
			"DTSTART:20250310T090000Z", "DUE:20250310T100000Z", "RRULE:FREQ=DAILY;COUNT=5", "X-KDE-LIBKCAL-DTRECURRENCE:20250311T090000Z",
		}, []string{"RECURRENCE-ID:20250311T090000Z", "DTSTART:20250311T150000Z", "DUE:20250311T160000Z"})
		f := listedTodo(t, e, id)
		if !sameTime(f.Start, ptr(date(2025, 3, 11, 15, 0))) {
			t.Fatalf("current occurrence = %+v; want the moved 2025-03-11T15:00Z", f)
		}
		in := editInput(&f)
		in.Start, in.Due, in.Timezone = ptr(date(2025, 3, 11, 16, 0)), ptr(date(2025, 3, 11, 17, 0)), "Europe/Berlin"
		got, _, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, in)
		mustNoErr(t, err)
		if !sameTime(got.Start, in.Start) || !sameNext(got.Next, &domain.TodoDates{Start: ptr(date(2025, 3, 12, 16, 0)), Due: ptr(date(2025, 3, 12, 17, 0))}) {
			t.Errorf("moved series = %+v", got)
		}
		checkStored(t, "master", storedObject(t, e, id),
			[]string{"DTSTART:20250311T160000Z", "DUE:20250311T170000Z", "RRULE:FREQ=DAILY;COUNT=4\r\n"},
			[]string{"RECURRENCE-ID", "X-KDE-LIBKCAL-DTRECURRENCE", "TZID"})
	})

	// Re-anchored on its current occurrence, a COUNT would count again from
	// there; the occurrences before it no longer count (FR-17).
	t.Run("move keeps the number of occurrences left", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=DAILY;COUNT=5"},
			[]string{"RECURRENCE-ID:20250310T090000Z", "STATUS:COMPLETED"})
		moveListed(t, e, id, time.Hour)
		checkStored(t, "master", storedObject(t, e, id),
			[]string{"DTSTART:20250311T100000Z", "RRULE:FREQ=DAILY;COUNT=4\r\n", "RECURRENCE-ID:20250310T090000Z"}, nil)
		occs, err := e.svc.ListTodoOccurrences(t.Context(), e.cals["tasks"], date(2025, 3, 1, 0, 0), date(2025, 4, 1, 0, 0))
		mustNoErr(t, err)
		checkTodoOccurrences(t, occs,
			[]time.Time{
				date(2025, 3, 10, 9, 0), date(2025, 3, 11, 10, 0), date(2025, 3, 12, 10, 0),
				date(2025, 3, 13, 10, 0), date(2025, 3, 14, 10, 0),
			},
			[]string{
				domain.OccurrenceDone, domain.OccurrenceCurrent, domain.OccurrenceUpcoming,
				domain.OccurrenceUpcoming, domain.OccurrenceUpcoming,
			})
	})

	// UNTIL moves along too, or a series moved later loses its last
	// occurrence, such as one whose COUNT a completion converted (FR-17).
	t.Run("move keeps the end of an until rule", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=DAILY;UNTIL=20250312T090000Z"},
			[]string{"RECURRENCE-ID:20250310T090000Z", "STATUS:COMPLETED"})
		moveListed(t, e, id, time.Hour)
		checkStored(t, "master", storedObject(t, e, id), []string{"RRULE:FREQ=DAILY;UNTIL=20250312T100000Z\r\n"}, nil)
		occs, err := e.svc.ListTodoOccurrences(t.Context(), e.cals["tasks"], date(2025, 3, 11, 0, 0), date(2025, 4, 1, 0, 0))
		mustNoErr(t, err)
		checkTodoOccurrences(t, occs,
			[]time.Time{date(2025, 3, 11, 10, 0), date(2025, 3, 12, 10, 0)},
			[]string{domain.OccurrenceCurrent, domain.OccurrenceUpcoming})
	})

	// The last occurrence takes UNTIL along wherever it moves, or clients
	// that end the series at UNTIL would drop it (FR-17).
	t.Run("move of the last occurrence extends until", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=DAILY;COUNT=3"})
		completeListed(t, e, id)
		completeListed(t, e, id)
		got := moveListed(t, e, id, time.Hour)
		if got.Next != nil {
			t.Errorf("next = %+v; want none", got.Next)
		}
		checkStored(t, "master", storedObject(t, e, id),
			[]string{"DTSTART:20250312T100000Z", "RRULE:FREQ=DAILY;UNTIL=20250312T100000Z\r\n"}, nil)
		occs, err := e.svc.ListTodoOccurrences(t.Context(), e.cals["tasks"], date(2025, 3, 1, 0, 0), date(2025, 4, 1, 0, 0))
		mustNoErr(t, err)
		checkTodoOccurrences(t, occs, []time.Time{date(2025, 3, 12, 10, 0)}, []string{domain.OccurrenceCurrent})
	})

	// Wherever a move lands, UNTIL does not end before it, also where it
	// stays, as on fixed days, whose last repeat can move to any later day
	// (FR-17).
	t.Run("move beyond until extends it", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20250312T090000Z"})
		moveListed(t, e, id, 28*24*time.Hour)
		checkStored(t, "master", storedObject(t, e, id),
			[]string{"DTSTART:20250407T090000Z", "RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20250407T090000Z\r\n"}, nil)
		occs, err := e.svc.ListTodoOccurrences(t.Context(), e.cals["tasks"], date(2025, 3, 1, 0, 0), date(2025, 5, 1, 0, 0))
		mustNoErr(t, err)
		checkTodoOccurrences(t, occs, []time.Time{date(2025, 4, 7, 9, 0)}, []string{domain.OccurrenceCurrent})
	})

	// The last occurrence takes UNTIL along in either direction, on the
	// rule's grid or off it, so that it stays the only one left (FR-17).
	for _, tc := range []struct {
		name   string
		master []string
		by     time.Duration
		want   []string
		at     time.Time
	}{
		{
			name:   "a day earlier",
			master: []string{"DTSTART:20250317T090000Z", "RRULE:FREQ=WEEKLY;UNTIL=20250317T090000Z"},
			by:     -24 * time.Hour,
			want:   []string{"DTSTART:20250316T090000Z", "RRULE:FREQ=WEEKLY;UNTIL=20250316T090000Z\r\n"},
			at:     date(2025, 3, 16, 9, 0),
		},
		{
			name:   "a week earlier",
			master: []string{"DTSTART:20250317T090000Z", "RRULE:FREQ=WEEKLY;UNTIL=20250317T090000Z"},
			by:     -7 * 24 * time.Hour,
			want:   []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY;UNTIL=20250310T090000Z\r\n"},
			at:     date(2025, 3, 10, 9, 0),
		},
		{
			name:   "an hour earlier on fixed days",
			master: []string{"DTSTART:20250313T090000Z", "RRULE:FREQ=WEEKLY;BYDAY=MO,TH;UNTIL=20250313T090000Z"},
			by:     -time.Hour,
			want:   []string{"DTSTART:20250313T080000Z", "RRULE:FREQ=WEEKLY;BYDAY=MO,TH;UNTIL=20250313T080000Z\r\n"},
			at:     date(2025, 3, 13, 8, 0),
		},
	} {
		t.Run("move of the last occurrence "+tc.name+" keeps it the only one", func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			id := seedSeries(t, e, tc.master)
			moveListed(t, e, id, tc.by)
			checkStored(t, "master", storedObject(t, e, id), tc.want, nil)
			occs, err := e.svc.ListTodoOccurrences(t.Context(), e.cals["tasks"], date(2025, 3, 1, 0, 0), date(2025, 4, 1, 0, 0))
			mustNoErr(t, err)
			checkTodoOccurrences(t, occs, []time.Time{tc.at}, []string{domain.OccurrenceCurrent})
		})
	}

	// Whether the moved occurrence is the last one is decided on the rule as
	// it was: moved earlier, off the grid, by more than the series has left,
	// the shifted UNTIL lies before the old occurrence, which is no reason to
	// end the series at the new anchor. The done repeats it moved back past
	// stay done where they were, off the rule (A-10, FR-17).
	t.Run("move earlier than the remaining span keeps later occurrences", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY;UNTIL=20250407T090000Z"},
			[]string{"RECURRENCE-ID:20250310T090000Z", "STATUS:COMPLETED"},
			[]string{"RECURRENCE-ID:20250317T090000Z", "STATUS:COMPLETED"},
		)
		f := listedTodo(t, e, id)
		if !sameTime(f.Start, ptr(date(2025, 3, 24, 9, 0))) {
			t.Fatalf("current occurrence = %+v; want 2025-03-24T09:00Z", f)
		}
		got := moveListed(t, e, id, -20*24*time.Hour)
		if !sameTime(got.Start, ptr(date(2025, 3, 4, 9, 0))) || !sameNext(got.Next, &domain.TodoDates{Start: ptr(date(2025, 3, 11, 9, 0))}) {
			t.Errorf("moved series = %+v", got)
		}
		checkStored(t, "master", storedObject(t, e, id),
			[]string{"DTSTART:20250304T090000Z", "RRULE:FREQ=WEEKLY;UNTIL=20250318T090000Z\r\n"}, nil)
		occs, err := e.svc.ListTodoOccurrences(t.Context(), e.cals["tasks"], date(2025, 3, 1, 0, 0), date(2025, 4, 1, 0, 0))
		mustNoErr(t, err)
		checkTodoOccurrences(t, occs,
			[]time.Time{
				date(2025, 3, 4, 9, 0), date(2025, 3, 10, 9, 0), date(2025, 3, 11, 9, 0),
				date(2025, 3, 17, 9, 0), date(2025, 3, 18, 9, 0),
			},
			[]string{
				domain.OccurrenceCurrent, domain.OccurrenceDone, domain.OccurrenceUpcoming,
				domain.OccurrenceDone, domain.OccurrenceUpcoming,
			})
	})

	// A move by whole periods takes UNTIL along like any other: moved
	// earlier, a series gains no occurrence at its end, also where UNTIL
	// comes from a COUNT (FR-17).
	for _, tc := range []struct {
		name     string
		master   []string
		complete bool
		by       time.Duration
		want     []string
		at       []time.Time
	}{
		{
			name:   "until",
			master: []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY;UNTIL=20250324T090000Z"},
			by:     -7 * 24 * time.Hour,
			want:   []string{"DTSTART:20250303T090000Z", "RRULE:FREQ=WEEKLY;UNTIL=20250317T090000Z\r\n"},
			at:     []time.Time{date(2025, 3, 3, 9, 0), date(2025, 3, 10, 9, 0), date(2025, 3, 17, 9, 0)},
		},
		{
			// The completion rolls the series to 17 March, with its COUNT as the UNTIL of 24 March.
			name:     "count",
			master:   []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY;COUNT=3"},
			complete: true,
			by:       -14 * 24 * time.Hour,
			want:     []string{"DTSTART:20250303T090000Z", "RRULE:FREQ=WEEKLY;UNTIL=20250310T090000Z\r\n"},
			at:       []time.Time{date(2025, 3, 3, 9, 0), date(2025, 3, 10, 9, 0)},
		},
	} {
		t.Run("move earlier by whole periods adds no occurrence, "+tc.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			id := seedSeries(t, e, tc.master)
			if tc.complete {
				completeListed(t, e, id)
			}
			moveListed(t, e, id, tc.by)
			checkStored(t, "master", storedObject(t, e, id), tc.want, nil)
			occs, err := e.svc.ListTodoOccurrences(t.Context(), e.cals["tasks"], date(2025, 3, 1, 0, 0), date(2025, 5, 1, 0, 0))
			mustNoErr(t, err)
			states := []string{domain.OccurrenceCurrent}
			for range tc.at[1:] {
				states = append(states, domain.OccurrenceUpcoming)
			}
			checkTodoOccurrences(t, occs, tc.at, states)
		})
	}

	for _, tc := range []struct {
		name     string
		master   []string
		override []string
		want     string
		anchor   time.Time
	}{
		{
			name:     "utc",
			master:   []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY;UNTIL=20250317T090000Z"},
			override: []string{"RECURRENCE-ID:20250310T090000Z", "STATUS:COMPLETED"},
			want:     "RRULE:FREQ=WEEKLY;UNTIL=20250324T090000Z\r\n",
			anchor:   date(2025, 3, 24, 9, 0),
		},
		{
			name:     "date",
			master:   []string{"DTSTART;VALUE=DATE:20250310", "RRULE:FREQ=WEEKLY;UNTIL=20250317"},
			override: []string{"RECURRENCE-ID;VALUE=DATE:20250310", "STATUS:COMPLETED"},
			want:     "RRULE:FREQ=WEEKLY;UNTIL=20250324\r\n",
			anchor:   date(2025, 3, 24, 0, 0),
		},
	} {
		t.Run("move of the last occurrence by whole periods extends until, "+tc.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			id := seedSeries(t, e, tc.master, tc.override)
			moveListed(t, e, id, 7*24*time.Hour)
			checkStored(t, "master", storedObject(t, e, id), []string{tc.want}, nil)
			occs, err := e.svc.ListTodoOccurrences(t.Context(), e.cals["tasks"], date(2025, 3, 20, 0, 0), date(2025, 4, 20, 0, 0))
			mustNoErr(t, err)
			checkTodoOccurrences(t, occs, []time.Time{tc.anchor}, []string{domain.OccurrenceCurrent})
		})
	}

	// Overrides and EXDATEs of later occurrences move with an interval
	// series, or they would match no occurrence any more (FR-17).
	t.Run("move shifts later exceptions", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY", "EXDATE:20250331T090000Z"},
			[]string{"RECURRENCE-ID:20250317T090000Z", "STATUS:COMPLETED"},
			[]string{"RECURRENCE-ID:20250324T090000Z", "DTSTART:20250325T090000Z", "SUMMARY:Moved"},
		)
		moveListed(t, e, id, 48*time.Hour)
		checkStored(t, "master", storedObject(t, e, id), []string{
			"DTSTART:20250312T090000Z", "EXDATE:20250402T090000Z", "RECURRENCE-ID:20250319T090000Z",
			"RECURRENCE-ID:20250326T090000Z", "DTSTART:20250327T090000Z",
		}, nil)
		occs, err := e.svc.ListTodoOccurrences(t.Context(), e.cals["tasks"], date(2025, 3, 10, 0, 0), date(2025, 4, 10, 0, 0))
		mustNoErr(t, err)
		checkTodoOccurrences(t, occs,
			[]time.Time{date(2025, 3, 12, 9, 0), date(2025, 3, 19, 9, 0), date(2025, 3, 27, 9, 0), date(2025, 4, 9, 9, 0)},
			[]string{domain.OccurrenceCurrent, domain.OccurrenceDone, domain.OccurrenceUpcoming, domain.OccurrenceUpcoming})
		if moved := occs[2]; moved.Title != "Moved" || !moved.RecurrenceID.Equal(date(2025, 3, 26, 9, 0)) {
			t.Errorf("moved occurrence = %+v; want %q with recurrenceId 2025-03-26T09:00Z", moved, "Moved")
		}
	})

	// A move by whole periods moves the later exceptions and the end along
	// like any other, and moving back by as much puts them back: that is
	// how a move is undone (FR-17).
	t.Run("move by whole periods shifts later exceptions, and back", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		master := []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY;UNTIL=20250407T090000Z", "EXDATE:20250331T090000Z"}
		moved := []string{"RECURRENCE-ID:20250324T090000Z", "DTSTART:20250325T090000Z", "SUMMARY:Moved"}
		id := seedSeries(t, e, master, moved)
		moveListed(t, e, id, 7*24*time.Hour)
		checkStored(t, "master", storedObject(t, e, id), []string{
			"DTSTART:20250317T090000Z", "RRULE:FREQ=WEEKLY;UNTIL=20250414T090000Z\r\n", "EXDATE:20250407T090000Z",
			"RECURRENCE-ID:20250331T090000Z", "DTSTART:20250401T090000Z",
		}, nil)
		occs, err := e.svc.ListTodoOccurrences(t.Context(), e.cals["tasks"], date(2025, 3, 1, 0, 0), date(2025, 5, 1, 0, 0))
		mustNoErr(t, err)
		checkTodoOccurrences(t, occs,
			[]time.Time{date(2025, 3, 17, 9, 0), date(2025, 3, 24, 9, 0), date(2025, 4, 1, 9, 0), date(2025, 4, 14, 9, 0)},
			[]string{domain.OccurrenceCurrent, domain.OccurrenceUpcoming, domain.OccurrenceUpcoming, domain.OccurrenceUpcoming})

		moveListed(t, e, id, -7*24*time.Hour)
		checkStored(t, "master", storedObject(t, e, id), slices.Concat(master, moved, []string{"UNTIL=20250407T090000Z\r\n"}), nil)
	})

	// References move in the series' wall clock and keep the form they are
	// written in, with a monthly or yearly rule by calendar months; a series
	// anchored on its current occurrence keeps its COUNT (FR-17).
	for _, tc := range []struct {
		name      string
		master    []string
		overrides [][]string
		by        time.Duration
		want      []string
	}{
		{
			// Friday 09:00 CET to Monday 09:00 CEST: 71 hours, 3 days on the clock.
			name: "across dst",
			master: []string{
				"DTSTART;TZID=Europe/Berlin:20250328T090000", "RRULE:FREQ=WEEKLY;COUNT=3", "EXDATE;TZID=Europe/Berlin:20250404T090000",
			},
			by: 71 * time.Hour,
			want: []string{
				"DTSTART;TZID=Europe/Berlin:20250331T090000", "RRULE:FREQ=WEEKLY;COUNT=3\r\n", "EXDATE;TZID=Europe/Berlin:20250407T090000",
			},
		},
		{
			name:   "all-day",
			master: []string{"DTSTART;VALUE=DATE:20250310", "DUE;VALUE=DATE:20250310", "RRULE:FREQ=WEEKLY", "EXDATE;VALUE=DATE:20250324"},
			by:     24 * time.Hour,
			want:   []string{"DTSTART;VALUE=DATE:20250311", "DUE;VALUE=DATE:20250311", "EXDATE;VALUE=DATE:20250325"},
		},
		{
			name:      "floating",
			master:    []string{"DTSTART:20250310T090000", "RRULE:FREQ=WEEKLY"},
			overrides: [][]string{{"RECURRENCE-ID:20250317T090000", "STATUS:COMPLETED"}},
			by:        time.Hour,
			want:      []string{"DTSTART:20250310T100000\r\n", "RECURRENCE-ID:20250317T100000\r\n"},
		},
		{
			// 10 March to 10 April is a month, not 31 days: 10 June goes to 10 July.
			name:      "monthly by a month",
			master:    []string{"DTSTART;VALUE=DATE:20250310", "RRULE:FREQ=MONTHLY;UNTIL=20250810", "EXDATE;VALUE=DATE:20250510"},
			overrides: [][]string{{"RECURRENCE-ID;VALUE=DATE:20250610", "DTSTART;VALUE=DATE:20250612"}},
			by:        31 * 24 * time.Hour,
			want: []string{
				"DTSTART;VALUE=DATE:20250410", "RRULE:FREQ=MONTHLY;UNTIL=20250910\r\n", "EXDATE;VALUE=DATE:20250610",
				"RECURRENCE-ID;VALUE=DATE:20250710", "DTSTART;VALUE=DATE:20250712",
			},
		},
		{
			// A year on from 10 March 2025 is not 365 days on from 10 March 2027, past 29 February 2028.
			name: "yearly by a year",
			master: []string{
				"DTSTART;TZID=Europe/Berlin:20250310T090000", "RRULE:FREQ=YEARLY;UNTIL=20290310T080000Z",
				"EXDATE;TZID=Europe/Berlin:20280310T090000",
			},
			overrides: [][]string{{"RECURRENCE-ID;TZID=Europe/Berlin:20270310T090000", "DTSTART;TZID=Europe/Berlin:20270311T090000"}},
			by:        365 * 24 * time.Hour,
			want: []string{
				"DTSTART;TZID=Europe/Berlin:20260310T090000", "RRULE:FREQ=YEARLY;UNTIL=20300310T080000Z\r\n",
				"EXDATE;TZID=Europe/Berlin:20290310T090000", "RECURRENCE-ID;TZID=Europe/Berlin:20280310T090000",
				"DTSTART;TZID=Europe/Berlin:20280311T090000",
			},
		},
		{
			name:      "monthly off the grid",
			master:    []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=MONTHLY"},
			overrides: [][]string{{"RECURRENCE-ID:20250610T090000Z", "DTSTART:20250612T090000Z"}},
			by:        5 * 24 * time.Hour,
			want:      []string{"DTSTART:20250315T090000Z", "RECURRENCE-ID:20250615T090000Z", "DTSTART:20250617T090000Z"},
		},
		{
			// A month and five days: 10 June goes to 15 July, not 36 days on to 16 July.
			name:      "monthly by a month and days",
			master:    []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=MONTHLY"},
			overrides: [][]string{{"RECURRENCE-ID:20250610T090000Z", "DTSTART:20250612T090000Z"}},
			by:        36 * 24 * time.Hour,
			want:      []string{"DTSTART:20250415T090000Z", "RECURRENCE-ID:20250715T090000Z", "DTSTART:20250717T090000Z"},
		},
	} {
		t.Run("move shifts later references, "+tc.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			id := seedSeries(t, e, tc.master, tc.overrides...)
			moveListed(t, e, id, tc.by)
			checkStored(t, "master", storedObject(t, e, id), tc.want, nil)
		})
	}

	// Fixed days keep their dates; only the time of day moves along, in the
	// series' zone (FR-17).
	t.Run("fixed days shift later references by the time of day", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART;TZID=Europe/Berlin:20250310T090000", "RRULE:FREQ=WEEKLY;BYDAY=MO,TH"},
			[]string{"RECURRENCE-ID;TZID=Europe/Berlin:20250313T090000", "STATUS:COMPLETED"})
		moveListed(t, e, id, 26*time.Hour) // Monday 09:00 to Tuesday 11:00
		checkStored(t, "master", storedObject(t, e, id),
			[]string{"DTSTART;TZID=Europe/Berlin:20250311T110000", "RECURRENCE-ID;TZID=Europe/Berlin:20250313T110000"}, nil)
		occs, err := e.svc.ListTodoOccurrences(t.Context(), e.cals["tasks"], date(2025, 3, 10, 0, 0), date(2025, 3, 18, 0, 0))
		mustNoErr(t, err)
		checkTodoOccurrences(t, occs,
			[]time.Time{date(2025, 3, 11, 10, 0), date(2025, 3, 13, 10, 0), date(2025, 3, 17, 10, 0)},
			[]string{domain.OccurrenceCurrent, domain.OccurrenceDone, domain.OccurrenceUpcoming})
	})

	// Probe P9: a move off the rule's days leaves DTSTART off the rule, where
	// readers disagree on what a COUNT counts; the UNTIL of the series' last
	// occurrence, as read, ends it in every reader (FR-17).
	t.Run("a fixed-day move turns COUNT into UNTIL", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY;BYDAY=MO,TH;COUNT=2"})
		moveListed(t, e, id, 24*time.Hour) // Monday to Tuesday
		checkStored(t, "master", storedObject(t, e, id),
			[]string{"DTSTART:20250311T090000Z", "RRULE:FREQ=WEEKLY;BYDAY=MO,TH;UNTIL=20250313T090000Z\r\n"}, []string{"COUNT"})
		occs, err := e.svc.ListTodoOccurrences(t.Context(), e.cals["tasks"], date(2025, 3, 1, 0, 0), date(2025, 4, 1, 0, 0))
		mustNoErr(t, err)
		checkTodoOccurrences(t, occs,
			[]time.Time{date(2025, 3, 11, 9, 0), date(2025, 3, 13, 9, 0)},
			[]string{domain.OccurrenceCurrent, domain.OccurrenceUpcoming})
	})

	// An interval rule recurs from the new DTSTART, which stays on it (FR-17).
	t.Run("an interval move keeps COUNT", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY;COUNT=3"})
		moveListed(t, e, id, 24*time.Hour)
		checkStored(t, "master", storedObject(t, e, id),
			[]string{"DTSTART:20250311T090000Z", "RRULE:FREQ=WEEKLY;COUNT=3\r\n"}, []string{"UNTIL"})
	})

	// In a zone Lucid cannot resolve, an UNTIL would be off by the zone's
	// offset, so the COUNT stays, lowered as for an interval rule; the moved
	// DTSTART counts as its first occurrence (FR-17).
	t.Run("unknown zone, fixed-day move keeps a lowered COUNT", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART;TZID=W. Europe Standard Time:20250310T090000", "RRULE:FREQ=WEEKLY;BYDAY=MO,TH;COUNT=3"})
		moveListed(t, e, id, 24*time.Hour) // Monday to Tuesday
		checkStored(t, "master", storedObject(t, e, id),
			[]string{"DTSTART;TZID=W. Europe Standard Time:20250311T090000", "RRULE:FREQ=WEEKLY;BYDAY=MO,TH;COUNT=3\r\n"}, []string{"UNTIL="})
		occs, err := e.svc.ListTodoOccurrences(t.Context(), e.cals["tasks"], date(2025, 3, 1, 0, 0), date(2025, 4, 1, 0, 0))
		mustNoErr(t, err)
		checkTodoOccurrences(t, occs,
			[]time.Time{date(2025, 3, 11, 9, 0), date(2025, 3, 13, 9, 0), date(2025, 3, 17, 9, 0)},
			[]string{domain.OccurrenceCurrent, domain.OccurrenceUpcoming, domain.OccurrenceUpcoming})
	})

	// Moving a series back after its completion is a move like any other:
	// the later exceptions and the end move back with it (FR-17).
	t.Run("a move back after completion shifts later exceptions and the end", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e,
			[]string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY;UNTIL=20250407T090000Z", "EXDATE:20250331T090000Z"},
			[]string{"RECURRENCE-ID:20250324T090000Z", "DTSTART:20250325T090000Z", "SUMMARY:Moved"})
		f := listedTodo(t, e, id)
		done := completeListed(t, e, id)
		_, _, err := e.svc.UpdateTodo(t.Context(), id, done.ETag, editInput(&f))
		mustNoErr(t, err)
		checkStored(t, "master", storedObject(t, e, id), []string{
			"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY;UNTIL=20250331T090000Z\r\n", "EXDATE:20250324T090000Z",
			"RECURRENCE-ID:20250317T090000Z", "DTSTART:20250318T090000Z",
		}, nil)
	})

	// A completed series reports its stored dates; moving it moves them.
	t.Run("reopen and move a completed series", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{
			"STATUS:COMPLETED", "COMPLETED:20250305T100000Z", "DTSTART:20250310T090000Z", "RRULE:FREQ=DAILY",
		}, []string{"RECURRENCE-ID:20250310T090000Z", "DTSTART:20250310T150000Z"})
		f := listedTodo(t, e, id)
		in := editInput(&f)
		in.Status, in.Start = domain.TodoNeedsAction, ptr(date(2025, 3, 12, 9, 0))
		got, _, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, in)
		mustNoErr(t, err)
		if !sameTime(got.Start, in.Start) || !sameNext(got.Next, &domain.TodoDates{Start: ptr(date(2025, 3, 13, 9, 0))}) {
			t.Errorf("reopened series = %+v", got)
		}
		checkStored(t, "master", storedObject(t, e, id), []string{"DTSTART:20250312T090000Z", "STATUS:NEEDS-ACTION"},
			[]string{"RECURRENCE-ID", "COMPLETED:"})
	})

	// A repeat off the rule is no instance of it: moving it moves only that
	// repeat, as completing it completes only that repeat, and the rule stays
	// where it is (A-10, FR-17).
	t.Run("a move of a repeat off the rule moves only it", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250309T090000Z", "DUE:20250309T100000Z", "RRULE:FREQ=WEEKLY", "EXDATE:20250309T090000Z"},
			[]string{"RECURRENCE-ID:20250310T090000Z", "DTSTART:20250310T150000Z", "DUE:20250310T160000Z"})
		got := moveListed(t, e, id, 2*time.Hour)
		if !sameTime(got.Start, ptr(date(2025, 3, 10, 17, 0))) || !sameTime(got.Due, ptr(date(2025, 3, 10, 18, 0))) ||
			!sameNext(got.Next, &domain.TodoDates{Start: ptr(date(2025, 3, 16, 9, 0)), Due: ptr(date(2025, 3, 16, 10, 0))}) {
			t.Errorf("moved series = %+v; want the repeat off the rule at 17:00, then 16 March", got)
		}
		checkStored(t, "series", storedObject(t, e, id), []string{
			"DTSTART:20250309T090000Z", "DUE:20250309T100000Z", "RRULE:FREQ=WEEKLY\r\n", "EXDATE:20250309T090000Z",
			"RECURRENCE-ID:20250310T090000Z", "DTSTART:20250310T170000Z", "DUE:20250310T180000Z",
		}, nil)
	})

	// The current repeat's override goes with a move also where its
	// RECURRENCE-ID is a date in a timed series: else it would take over
	// the repeat that the moved rule puts on its day (A-11, FR-17).
	t.Run("a move drops the current repeat's date override", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=DAILY"},
			[]string{"RECURRENCE-ID;VALUE=DATE:20250310", "DTSTART:20250310T150000Z", "SUMMARY:Moved"})
		got := moveListed(t, e, id, -24*time.Hour)
		if !sameTime(got.Start, ptr(date(2025, 3, 9, 15, 0))) {
			t.Errorf("moved series = %+v; want 2025-03-09T15:00Z", got)
		}
		checkStored(t, "series", storedObject(t, e, id), []string{"DTSTART:20250309T150000Z"}, []string{"RECURRENCE-ID", "Moved"})
	})

	// An EXDATE with a date in a timed series lies on its date in the
	// series' zone: 18:00 in Los Angeles on 10 March is 11 March in UTC,
	// after the date 11 March's midnight UTC. Moved a day later, the series
	// takes the excluded 11 March along to the 12th, instead of excluding
	// the moved repeat (A-11, FR-17).
	t.Run("a move shifts a later date EXDATE by its date", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{
			"DTSTART;TZID=America/Los_Angeles:20250310T180000", "RRULE:FREQ=DAILY", "EXDATE;VALUE=DATE:20250311",
		})
		got := moveListed(t, e, id, 24*time.Hour)
		if !sameTime(got.Start, ptr(date(2025, 3, 12, 1, 0))) ||
			!sameNext(got.Next, &domain.TodoDates{Start: ptr(date(2025, 3, 14, 1, 0))}) {
			t.Errorf("moved series = %+v; want 11 March 18:00 in Los Angeles, then the 13th", got)
		}
		checkStored(t, "series", storedObject(t, e, id),
			[]string{"DTSTART;TZID=America/Los_Angeles:20250311T180000", "EXDATE;VALUE=DATE:20250312"}, nil)
	})

	t.Run("start null writes DTSTART = DUE", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DUE;VALUE=DATE:20250310", "RRULE:FREQ=DAILY"})
		f := listedTodo(t, e, id)
		in := editInput(&f)
		in.Start, in.Due, in.DueAllDay = nil, ptr(date(2025, 3, 11, 0, 0)), true
		got, _, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, in)
		mustNoErr(t, err)
		if !sameTime(got.Due, in.Due) || got.Next == nil || !sameTime(got.Next.Due, ptr(date(2025, 3, 12, 0, 0))) {
			t.Errorf("moved series = %+v", got)
		}
		checkStored(t, "master", storedObject(t, e, id), []string{"DTSTART;VALUE=DATE:20250311", "DUE;VALUE=DATE:20250311"}, nil)
	})

	// A move past the next repeat of a series on fixed days would drop the
	// repeats in between, and one before its own day would bring that day
	// back as a repeat still to do: the server refuses both, whatever the
	// client (A-13, FR-17).
	for _, tc := range []struct {
		name string
		at   time.Time
		msg  string
	}{
		{"a move past the next repeat is rejected", date(2025, 3, 20, 0, 0), "a repeat on fixed days must stay before its next repeat"},
		{"a move onto the next repeat's day is rejected", date(2025, 3, 13, 0, 0), "a repeat on fixed days must stay before its next repeat"},
		{"a move before its own day is rejected", date(2025, 3, 9, 0, 0), "a repeat on fixed days cannot move before its own day"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			master := []string{"DTSTART;VALUE=DATE:20250310", "DUE;VALUE=DATE:20250310", "RRULE:FREQ=WEEKLY;BYDAY=MO,TH"}
			id := seedSeries(t, e, master)
			f := listedTodo(t, e, id)
			checkMoveWindow(t, f.MoveWindow, ptr(date(2025, 3, 10, 0, 0)), ptr(date(2025, 3, 13, 0, 0)))
			in := editInput(&f)
			in.Start, in.Due = ptr(tc.at), ptr(tc.at)
			e.mock.ResetCounts()
			_, _, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, in)
			mustWindowErr(t, err, tc.msg)
			if n := e.mock.Count(http.MethodPut); n != 0 {
				t.Errorf("PUT count = %d; want 0", n)
			}
			checkStored(t, "master", storedObject(t, e, id), master, nil)
		})
	}

	// The last repeat has no next one to stay before: it moves to any later
	// day, but not before its own (FR-17).
	t.Run("the last repeat may move later", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART;VALUE=DATE:20250310", "RRULE:FREQ=WEEKLY;BYDAY=MO,TH;UNTIL=20250310"})
		f := listedTodo(t, e, id)
		checkMoveWindow(t, f.MoveWindow, ptr(date(2025, 3, 10, 0, 0)), nil)
		in := editInput(&f)
		in.Start = ptr(date(2025, 3, 9, 0, 0))
		_, _, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, in)
		mustWindowErr(t, err, "a repeat on fixed days cannot move before its own day")
		got := moveListed(t, e, id, 5*24*time.Hour)
		if !sameTime(got.Start, ptr(date(2025, 3, 15, 0, 0))) || got.Next != nil {
			t.Errorf("moved series = %+v; want the last repeat on 15 March", got)
		}
		checkStored(t, "master", storedObject(t, e, id), []string{"DTSTART;VALUE=DATE:20250315"}, nil)
	})

	// With several repeats a day, the next one can fall on the current one's
	// day: the window ends at it, so the time can still change (A-15, FR-17).
	t.Run("several repeats a day may change the time", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=DAILY;BYHOUR=9,17"})
		f := listedTodo(t, e, id)
		checkMoveWindow(t, f.MoveWindow, ptr(date(2025, 3, 10, 0, 0)), ptr(date(2025, 3, 10, 17, 0)))
		in := editInput(&f)
		in.Start = ptr(date(2025, 3, 10, 18, 0))
		_, _, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, in)
		mustWindowErr(t, err, "a repeat on fixed days must stay before its next repeat")
		in.Start = ptr(date(2025, 3, 10, 12, 0))
		got, _, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, in)
		mustNoErr(t, err)
		if !sameTime(got.Start, in.Start) || !sameNext(got.Next, &domain.TodoDates{Start: ptr(date(2025, 3, 10, 17, 0))}) {
			t.Errorf("moved series = %+v; want 12:00, then 17:00", got)
		}
	})

	// The window counts days in the series' zone, not in UTC or the
	// browser's: 23:30 in Berlin is 22:30 UTC, and its day ends at 23:00
	// UTC (A-14, FR-17).
	t.Run("the window is in the series zone", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART;TZID=Europe/Berlin:20250310T233000", "RRULE:FREQ=WEEKLY;BYDAY=MO,TH"})
		f := listedTodo(t, e, id)
		checkMoveWindow(t, f.MoveWindow, ptr(date(2025, 3, 9, 23, 0)), ptr(date(2025, 3, 12, 23, 0)))
		in := editInput(&f)
		in.Start = ptr(date(2025, 3, 12, 23, 30)) // Thursday 00:30 in Berlin, Wednesday in UTC
		_, _, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, in)
		mustWindowErr(t, err, "a repeat on fixed days must stay before its next repeat")
		in.Start = ptr(date(2025, 3, 9, 23, 0)) // Monday 00:00 in Berlin, Sunday in UTC
		_, _, err = e.svc.UpdateTodo(t.Context(), id, f.ETag, in)
		mustNoErr(t, err)
		checkStored(t, "master", storedObject(t, e, id), []string{"DTSTART;TZID=Europe/Berlin:20250310T000000"}, nil)
	})

	// A move that removes the time keeps its day in the series' zone, also
	// west of UTC, where that day's midnight UTC lies before the window
	// starts (FR-16, FR-17).
	t.Run("the window takes a date on its day in the series zone", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART;TZID=America/New_York:20250310T090000", "RRULE:FREQ=WEEKLY;BYDAY=MO,TH"})
		f := listedTodo(t, e, id)
		checkMoveWindow(t, f.MoveWindow, ptr(date(2025, 3, 10, 4, 0)), ptr(date(2025, 3, 13, 4, 0)))
		in := editInput(&f)
		in.Start, in.StartAllDay = ptr(date(2025, 3, 13, 0, 0)), true
		_, _, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, in)
		mustWindowErr(t, err, "a repeat on fixed days must stay before its next repeat")
		in.Start = ptr(date(2025, 3, 10, 0, 0))
		_, _, err = e.svc.UpdateTodo(t.Context(), id, f.ETag, in)
		mustNoErr(t, err)
		checkStored(t, "master", storedObject(t, e, id), []string{"DTSTART;VALUE=DATE:20250310"}, nil)
	})

	// A move that adds a time to an all-day series lands on the day it has
	// in the zone it is written in (FR-16, FR-17).
	t.Run("the window takes a time on its day in the zone it is written in", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART;VALUE=DATE:20250310", "RRULE:FREQ=WEEKLY;BYDAY=MO,TH"})
		f := listedTodo(t, e, id)
		in := editInput(&f)
		in.Start, in.StartAllDay, in.Timezone = ptr(date(2025, 3, 12, 23, 30)), false, "Europe/Berlin" // Thursday 00:30
		_, _, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, in)
		mustWindowErr(t, err, "a repeat on fixed days must stay before its next repeat")
		in.Start = ptr(date(2025, 3, 9, 23, 30)) // Monday 00:30
		_, _, err = e.svc.UpdateTodo(t.Context(), id, f.ETag, in)
		mustNoErr(t, err)
		checkStored(t, "master", storedObject(t, e, id), []string{"DTSTART;TZID=Europe/Berlin:20250310T003000"}, nil)
	})

	// A repeat off the rule moves alone (A-10): past the next repeat it would
	// come after it, so it stays before it also in an interval series, which
	// otherwise moves freely. It has no rule day of its own to stay from, so
	// an earlier day is fine: nothing comes back (FR-17).
	t.Run("a repeat off the rule stays before the next one", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250309T090000Z", "DUE:20250309T100000Z", "RRULE:FREQ=WEEKLY", "EXDATE:20250309T090000Z"},
			[]string{"RECURRENCE-ID:20250310T090000Z", "DTSTART:20250310T150000Z", "DUE:20250310T160000Z"})
		f := listedTodo(t, e, id)
		checkMoveWindow(t, f.MoveWindow, nil, ptr(date(2025, 3, 16, 0, 0)))
		in := editInput(&f)
		in.Start, in.Due = ptr(date(2025, 3, 16, 8, 0)), ptr(date(2025, 3, 16, 9, 0))
		_, _, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, in)
		mustWindowErr(t, err, "a repeat on fixed days must stay before its next repeat")
		got := moveListed(t, e, id, -24*time.Hour) // Sunday 9 March, the day before: it moves alone
		if !sameTime(got.Start, ptr(date(2025, 3, 9, 15, 0))) || !sameNext(got.Next, &domain.TodoDates{Start: ptr(date(2025, 3, 16, 9, 0)), Due: ptr(date(2025, 3, 16, 10, 0))}) {
			t.Errorf("moved repeat = %+v; want 9 March 15:00, then the 16th", got)
		}
		checkStored(t, "override", storedObject(t, e, id), []string{"RECURRENCE-ID:20250310T090000Z", "DTSTART:20250309T150000Z", "DTSTART:20250309T090000Z"}, nil)
	})

	// The window is bounded by the rule's days, the RECURRENCE-IDs of the
	// current and the next repeat, not by the dates another client moved them
	// to: within the rule's days a move neither skips a repeat nor brings one
	// back, wherever the repeats are shown (FR-17, A-13). The series recurs
	// on Monday and Thursday at 09:00 from Monday 10 March.
	type move struct {
		at     time.Time
		allDay bool
		msg    string // the refusal; "" for a move that is accepted
	}
	timed := func(at time.Time, msg string) move { return move{at: at, msg: msg} }
	for _, tc := range []struct {
		name       string
		master     []string
		overrides  [][]string
		start      *time.Time // the current repeat as listed
		from       *time.Time
		until      *time.Time
		moves      []move // refusals, then the one accepted
		wantStart  *time.Time
		wantNext   *domain.TodoDates
		stored     []string
		lacks      []string
		wantOccs   []time.Time // 10 to 20 March, if checked
		wantStates []string
	}{
		{
			// Probe B: Monday done, Thursday moved to Wednesday. A move to
			// Wednesday evening would leave the rule's Thursday to come back
			// as a repeat still to do.
			name:      "the current repeat was moved earlier",
			overrides: [][]string{{"RECURRENCE-ID:20250310T090000Z", "STATUS:COMPLETED"}, {"RECURRENCE-ID:20250313T090000Z", "DTSTART:20250312T090000Z"}},
			start:     ptr(date(2025, 3, 12, 9, 0)),
			from:      ptr(date(2025, 3, 13, 0, 0)),
			until:     ptr(date(2025, 3, 17, 0, 0)),
			moves: []move{
				timed(date(2025, 3, 12, 18, 0), "a repeat on fixed days cannot move before its own day"),
				timed(date(2025, 3, 13, 18, 0), ""),
			},
			wantStart:  ptr(date(2025, 3, 13, 18, 0)),
			wantNext:   &domain.TodoDates{Start: ptr(date(2025, 3, 17, 18, 0))},
			stored:     []string{"DTSTART:20250313T180000Z", "RECURRENCE-ID:20250310T090000Z"},
			lacks:      []string{"RECURRENCE-ID:20250313"},
			wantOccs:   []time.Time{date(2025, 3, 10, 9, 0), date(2025, 3, 13, 18, 0), date(2025, 3, 17, 18, 0)},
			wantStates: []string{domain.OccurrenceDone, domain.OccurrenceCurrent, domain.OccurrenceUpcoming},
		},
		{
			// Probe C: Monday moved to Tuesday. Back onto its own Monday is
			// fine; the Sunday before is not.
			name:      "the current repeat was moved later",
			overrides: [][]string{{"RECURRENCE-ID:20250310T090000Z", "DTSTART:20250311T090000Z"}},
			start:     ptr(date(2025, 3, 11, 9, 0)),
			from:      ptr(date(2025, 3, 10, 0, 0)),
			until:     ptr(date(2025, 3, 13, 0, 0)),
			moves: []move{
				timed(date(2025, 3, 9, 9, 0), "a repeat on fixed days cannot move before its own day"),
				timed(date(2025, 3, 10, 9, 0), ""),
			},
			wantStart: ptr(date(2025, 3, 10, 9, 0)),
			wantNext:  &domain.TodoDates{Start: ptr(date(2025, 3, 13, 9, 0))},
			stored:    []string{"DTSTART:20250310T090000Z"},
			lacks:     []string{"RECURRENCE-ID"},
		},
		{
			// Thursday moved to Wednesday: the window still runs to the
			// rule's Thursday, and the moved repeat moves along by the change
			// in time of day.
			name:      "the next repeat was moved earlier",
			overrides: [][]string{{"RECURRENCE-ID:20250313T090000Z", "DTSTART:20250312T090000Z"}},
			start:     ptr(date(2025, 3, 10, 9, 0)),
			from:      ptr(date(2025, 3, 10, 0, 0)),
			until:     ptr(date(2025, 3, 13, 0, 0)),
			moves: []move{
				timed(date(2025, 3, 13, 9, 0), "a repeat on fixed days must stay before its next repeat"),
				timed(date(2025, 3, 12, 18, 0), ""),
			},
			wantStart: ptr(date(2025, 3, 12, 18, 0)),
			wantNext:  &domain.TodoDates{Start: ptr(date(2025, 3, 12, 18, 0))},
			stored:    []string{"DTSTART:20250312T180000Z", "RECURRENCE-ID:20250313T180000Z"},
		},
		{
			// Probe A: Thursday moved to Saturday. Friday would pass the
			// rule's Thursday and orphan the other client's repeat.
			name:      "the next repeat was moved later",
			overrides: [][]string{{"RECURRENCE-ID:20250313T090000Z", "DTSTART:20250315T090000Z"}},
			start:     ptr(date(2025, 3, 10, 9, 0)),
			from:      ptr(date(2025, 3, 10, 0, 0)),
			until:     ptr(date(2025, 3, 13, 0, 0)),
			moves: []move{
				timed(date(2025, 3, 14, 9, 0), "a repeat on fixed days must stay before its next repeat"),
				timed(date(2025, 3, 12, 9, 0), ""),
			},
			wantStart: ptr(date(2025, 3, 12, 9, 0)),
			wantNext:  &domain.TodoDates{Start: ptr(date(2025, 3, 15, 9, 0))},
			stored:    []string{"DTSTART:20250312T090000Z", "RECURRENCE-ID:20250313T090000Z", "DTSTART:20250315T090000Z"},
		},
		{
			// An open repeat off the rule on Tuesday is the next one: the
			// window ends with its day, so that it is not passed and
			// orphaned (A-10).
			name:      "the next repeat is off the rule",
			overrides: [][]string{{"RECURRENCE-ID:20250311T090000Z", "DTSTART:20250311T150000Z"}},
			start:     ptr(date(2025, 3, 10, 9, 0)),
			from:      ptr(date(2025, 3, 10, 0, 0)),
			until:     ptr(date(2025, 3, 11, 0, 0)),
			moves: []move{
				timed(date(2025, 3, 11, 8, 0), "a repeat on fixed days must stay before its next repeat"),
				timed(date(2025, 3, 10, 12, 0), ""),
			},
			wantStart: ptr(date(2025, 3, 10, 12, 0)),
			wantNext:  &domain.TodoDates{Start: ptr(date(2025, 3, 11, 18, 0))},
			stored:    []string{"DTSTART:20250310T120000Z", "RECURRENCE-ID:20250311T120000Z", "DTSTART:20250311T180000Z"},
		},
		{
			// Thursday turned into Friday's date by another client (the
			// other value type, A-11): the window still ends with the rule's
			// Thursday.
			name:      "the next repeat was moved to a date",
			overrides: [][]string{{"RECURRENCE-ID;VALUE=DATE:20250313", "DTSTART;VALUE=DATE:20250314"}},
			start:     ptr(date(2025, 3, 10, 9, 0)),
			from:      ptr(date(2025, 3, 10, 0, 0)),
			until:     ptr(date(2025, 3, 13, 0, 0)),
			moves: []move{
				timed(date(2025, 3, 13, 9, 0), "a repeat on fixed days must stay before its next repeat"),
				timed(date(2025, 3, 12, 9, 0), ""),
			},
			wantStart: ptr(date(2025, 3, 12, 9, 0)),
			wantNext:  &domain.TodoDates{Start: ptr(date(2025, 3, 14, 0, 0)), StartAllDay: true},
			stored:    []string{"DTSTART:20250312T090000Z", "RECURRENCE-ID;VALUE=DATE:20250313", "DTSTART;VALUE=DATE:20250314"},
		},
		{
			// Twice a day, and another client made today's first repeat a
			// date (A-15, A-11): it counts dates, so it stays on its day, and
			// a time it is given stays before the next repeat at 17:00.
			name:      "an all-day repeat with the next one on its day",
			master:    []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=DAILY;BYHOUR=9,17"},
			overrides: [][]string{{"RECURRENCE-ID:20250310T090000Z", "DTSTART;VALUE=DATE:20250310"}},
			start:     ptr(date(2025, 3, 10, 0, 0)),
			from:      ptr(date(2025, 3, 10, 0, 0)),
			until:     ptr(date(2025, 3, 11, 0, 0)),
			moves: []move{
				{at: date(2025, 3, 11, 0, 0), allDay: true, msg: "a repeat on fixed days must stay before its next repeat"},
				timed(date(2025, 3, 10, 18, 0), "a repeat on fixed days must stay before its next repeat"),
				timed(date(2025, 3, 10, 12, 0), ""),
			},
			wantStart: ptr(date(2025, 3, 10, 12, 0)),
			wantNext:  &domain.TodoDates{Start: ptr(date(2025, 3, 10, 17, 0))},
			stored:    []string{"DTSTART:20250310T120000Z"},
			lacks:     []string{"RECURRENCE-ID"},
		},
	} {
		t.Run("the window keeps to the rule days when "+tc.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			master := tc.master
			if master == nil {
				master = []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY;BYDAY=MO,TH"}
			}
			id := seedSeries(t, e, master, tc.overrides...)
			f := listedTodo(t, e, id)
			if !sameTime(f.Start, tc.start) {
				t.Fatalf("listed series = %+v; want its current repeat at %v", f, tc.start)
			}
			checkMoveWindow(t, f.MoveWindow, tc.from, tc.until)
			for _, m := range tc.moves {
				in := editInput(&f)
				in.Start, in.StartAllDay = ptr(m.at), m.allDay
				e.mock.ResetCounts()
				got, _, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, in)
				if m.msg != "" {
					mustWindowErr(t, err, m.msg)
					if n := e.mock.Count(http.MethodPut); n != 0 {
						t.Errorf("PUT count = %d; want 0", n)
					}
					continue
				}
				mustNoErr(t, err)
				if !sameTime(got.Start, tc.wantStart) || !sameNext(got.Next, tc.wantNext) {
					t.Errorf("moved series = %+v; want %v, then %+v", got, tc.wantStart, tc.wantNext)
				}
			}
			checkStored(t, "series", storedObject(t, e, id), tc.stored, tc.lacks)
			if tc.wantOccs != nil {
				occs, err := e.svc.ListTodoOccurrences(t.Context(), e.cals["tasks"], date(2025, 3, 10, 0, 0), date(2025, 3, 20, 0, 0))
				mustNoErr(t, err)
				checkTodoOccurrences(t, occs, tc.wantOccs, tc.wantStates)
			}
		})
	}

	// Only a series on fixed days, and a repeat off the rule with a next one,
	// has a window; a completed series and a rule Lucid cannot evaluate
	// report none (FR-17).
	for _, tc := range []struct {
		name      string
		master    []string
		overrides [][]string
		start     *time.Time // the current occurrence's, if checked
	}{
		{name: "interval series have no window", master: []string{"DTSTART;VALUE=DATE:20250310", "RRULE:FREQ=WEEKLY"}},
		{
			name:   "a completed series has no window",
			master: []string{"DTSTART;VALUE=DATE:20250310", "RRULE:FREQ=WEEKLY;BYDAY=MO,TH", "STATUS:COMPLETED"},
		},
		{name: "an unsupported rule has no window", master: []string{"DTSTART;VALUE=DATE:20250310", "RRULE:FREQ=WEEKLY;BYDAY=XX"}},
		{
			name: "the last repeat off an interval rule has no window",
			master: []string{
				"DTSTART:20250309T090000Z", "RRULE:FREQ=WEEKLY;UNTIL=20250316T090000Z", "EXDATE:20250309T090000Z,20250316T090000Z",
			},
			overrides: [][]string{{"RECURRENCE-ID:20250310T090000Z", "DTSTART:20250310T150000Z"}},
			start:     ptr(date(2025, 3, 10, 15, 0)),
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			id := seedSeries(t, e, tc.master, tc.overrides...)
			f := listedTodo(t, e, id)
			if tc.start != nil && (!sameTime(f.Start, tc.start) || f.Next != nil) {
				t.Fatalf("listed series = %+v; want its last repeat at %v", f, tc.start)
			}
			if f.MoveWindow != nil {
				t.Errorf("moveWindow = %+v; want none", f.MoveWindow)
			}
		})
	}

	t.Run("move to all-day and back", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "DUE:20250310T100000Z", "RRULE:FREQ=WEEKLY"})
		f := listedTodo(t, e, id)
		in := editInput(&f)
		in.Start, in.StartAllDay, in.Due, in.DueAllDay = ptr(date(2025, 3, 12, 0, 0)), true, ptr(date(2025, 3, 12, 0, 0)), true
		allDay, _, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, in)
		mustNoErr(t, err)
		checkStored(t, "master", storedObject(t, e, id), []string{"DTSTART;VALUE=DATE:20250312", "DUE;VALUE=DATE:20250312"}, nil)

		in = editInput(&allDay)
		in.Start, in.StartAllDay, in.Due, in.DueAllDay = ptr(date(2025, 3, 13, 8, 0)), false, ptr(date(2025, 3, 13, 9, 0)), false
		in.Timezone = "Europe/Berlin"
		_, _, err = e.svc.UpdateTodo(t.Context(), id, allDay.ETag, in)
		mustNoErr(t, err)
		checkStored(t, "master", storedObject(t, e, id),
			[]string{"DTSTART;TZID=Europe/Berlin:20250313T090000", "DUE;TZID=Europe/Berlin:20250313T100000", "BEGIN:VTIMEZONE"}, nil)
	})

	// Probe P4: a move that adds or removes the time rewrites what refers to
	// the rule in the new value type, or a DATE UNTIL would end a timed
	// series a repeat early (RFC 5545 3.3.10) and other clients' done
	// repeats and exceptions would match none. A COUNT that a fixed-day move
	// turns into UNTIL takes the new value type too (FR-17).
	for _, tc := range []struct {
		name        string
		master      []string
		overrides   [][]string
		allDay      bool
		at          time.Time // the moved start and due
		want, lacks []string
		dates       []time.Time
		states      []string
	}{
		{
			name: "adding a time keeps done repeats and the end",
			master: []string{
				"DTSTART;VALUE=DATE:20250310", "DUE;VALUE=DATE:20250310",
				"RRULE:FREQ=WEEKLY;BYDAY=MO,TH;UNTIL=20250327", "EXDATE;VALUE=DATE:20250320",
			},
			overrides: [][]string{{"RECURRENCE-ID;VALUE=DATE:20250317", "STATUS:COMPLETED"}},
			at:        date(2025, 3, 10, 8, 0), // 09:00 in Berlin
			want: []string{
				"DTSTART;TZID=Europe/Berlin:20250310T090000", "DUE;TZID=Europe/Berlin:20250310T090000",
				"RRULE:FREQ=WEEKLY;BYDAY=MO,TH;UNTIL=20250327T080000Z\r\n",
				"RECURRENCE-ID;TZID=Europe/Berlin:20250317T090000", "EXDATE;TZID=Europe/Berlin:20250320T090000",
			},
			lacks: []string{"VALUE=DATE"},
			dates: []time.Time{
				date(2025, 3, 10, 8, 0), date(2025, 3, 13, 8, 0), date(2025, 3, 17, 8, 0), date(2025, 3, 24, 8, 0), date(2025, 3, 27, 8, 0),
			},
			states: []string{
				domain.OccurrenceCurrent, domain.OccurrenceUpcoming, domain.OccurrenceDone,
				domain.OccurrenceUpcoming, domain.OccurrenceUpcoming,
			},
		},
		{
			// An override's own dates follow too.
			name: "removing the time converts back to dates",
			master: []string{
				"DTSTART;TZID=Europe/Berlin:20250310T090000", "DUE;TZID=Europe/Berlin:20250310T090000",
				"RRULE:FREQ=WEEKLY;BYDAY=MO,TH;UNTIL=20250327T080000Z", "EXDATE;TZID=Europe/Berlin:20250320T090000",
			},
			overrides: [][]string{{
				"RECURRENCE-ID;TZID=Europe/Berlin:20250317T090000", "DTSTART;TZID=Europe/Berlin:20250317T090000",
				"DUE;TZID=Europe/Berlin:20250317T100000", "STATUS:COMPLETED",
			}},
			allDay: true,
			at:     date(2025, 3, 10, 0, 0),
			want: []string{
				"DTSTART;VALUE=DATE:20250310", "DUE;VALUE=DATE:20250310", "RRULE:FREQ=WEEKLY;BYDAY=MO,TH;UNTIL=20250327\r\n",
				"RECURRENCE-ID;VALUE=DATE:20250317", "DTSTART;VALUE=DATE:20250317", "DUE;VALUE=DATE:20250317",
				"EXDATE;VALUE=DATE:20250320",
			},
			lacks: []string{"TZID=", "UNTIL=20250327T"},
			dates: []time.Time{
				date(2025, 3, 10, 0, 0), date(2025, 3, 13, 0, 0), date(2025, 3, 17, 0, 0), date(2025, 3, 24, 0, 0), date(2025, 3, 27, 0, 0),
			},
			states: []string{
				domain.OccurrenceCurrent, domain.OccurrenceUpcoming, domain.OccurrenceDone,
				domain.OccurrenceUpcoming, domain.OccurrenceUpcoming,
			},
		},
		{
			// Berlin turns to CEST on 30 March: 09:00 is 08:00Z before it
			// and 07:00Z after it, on each reference's own day.
			name: "adding a time across a dst change keeps the wall clock",
			master: []string{
				"DTSTART;VALUE=DATE:20250324", "RRULE:FREQ=WEEKLY;UNTIL=20250414", "EXDATE;VALUE=DATE:20250407",
			},
			overrides: [][]string{{"RECURRENCE-ID;VALUE=DATE:20250331", "STATUS:COMPLETED"}},
			at:        date(2025, 3, 24, 8, 0), // 09:00 CET
			want: []string{
				"DTSTART;TZID=Europe/Berlin:20250324T090000", "RRULE:FREQ=WEEKLY;UNTIL=20250414T070000Z\r\n",
				"RECURRENCE-ID;TZID=Europe/Berlin:20250331T090000", "EXDATE;TZID=Europe/Berlin:20250407T090000",
			},
			lacks:  []string{"VALUE=DATE"},
			dates:  []time.Time{date(2025, 3, 24, 8, 0), date(2025, 3, 31, 7, 0), date(2025, 4, 14, 7, 0)},
			states: []string{domain.OccurrenceCurrent, domain.OccurrenceDone, domain.OccurrenceUpcoming},
		},
		{
			// An interval rule's later references and its end move along
			// by the change in date, then take the new value type.
			name: "adding a time on another day moves later references along",
			master: []string{
				"DTSTART;VALUE=DATE:20250310", "RRULE:FREQ=WEEKLY;UNTIL=20250331", "EXDATE;VALUE=DATE:20250324",
			},
			overrides: [][]string{{"RECURRENCE-ID;VALUE=DATE:20250317", "STATUS:COMPLETED"}},
			at:        date(2025, 3, 12, 8, 0), // Wednesday 09:00 in Berlin
			want: []string{
				"DTSTART;TZID=Europe/Berlin:20250312T090000", "RRULE:FREQ=WEEKLY;UNTIL=20250402T070000Z\r\n",
				"RECURRENCE-ID;TZID=Europe/Berlin:20250319T090000", "EXDATE;TZID=Europe/Berlin:20250326T090000",
			},
			lacks: []string{"VALUE=DATE"},
			dates: []time.Time{date(2025, 3, 12, 8, 0), date(2025, 3, 19, 8, 0), date(2025, 4, 2, 7, 0)},
			states: []string{
				domain.OccurrenceCurrent, domain.OccurrenceDone, domain.OccurrenceUpcoming,
			},
		},
		{
			// A UTC series at 23:00 is on the next day in Berlin: set
			// all-day on that day, it moves a day in its own zone, and so
			// do its references.
			name: "removing the time near midnight moves later references along",
			master: []string{
				"DTSTART:20250310T230000Z", "RRULE:FREQ=WEEKLY;UNTIL=20250324T230000Z", "EXDATE:20250317T230000Z",
			},
			allDay: true,
			at:     date(2025, 3, 11, 0, 0),
			want: []string{
				"DTSTART;VALUE=DATE:20250311", "RRULE:FREQ=WEEKLY;UNTIL=20250325\r\n", "EXDATE;VALUE=DATE:20250318",
			},
			lacks:  []string{"T230000Z"},
			dates:  []time.Time{date(2025, 3, 11, 0, 0), date(2025, 3, 25, 0, 0)},
			states: []string{domain.OccurrenceCurrent, domain.OccurrenceUpcoming},
		},
		{
			name:   "a fixed-day COUNT ends in the new value type, a time added",
			master: []string{"DTSTART;VALUE=DATE:20250310", "RRULE:FREQ=WEEKLY;BYDAY=MO,TH;COUNT=2"},
			at:     date(2025, 3, 11, 8, 0), // Tuesday 09:00 in Berlin
			want: []string{
				"DTSTART;TZID=Europe/Berlin:20250311T090000", "RRULE:FREQ=WEEKLY;BYDAY=MO,TH;UNTIL=20250313T080000Z\r\n",
			},
			lacks:  []string{"COUNT", "VALUE=DATE"},
			dates:  []time.Time{date(2025, 3, 11, 8, 0), date(2025, 3, 13, 8, 0)},
			states: []string{domain.OccurrenceCurrent, domain.OccurrenceUpcoming},
		},
		{
			name:   "a fixed-day COUNT ends in the new value type, the time removed",
			master: []string{"DTSTART;TZID=Europe/Berlin:20250310T090000", "RRULE:FREQ=WEEKLY;BYDAY=MO,TH;COUNT=2"},
			allDay: true,
			at:     date(2025, 3, 11, 0, 0), // Tuesday
			want:   []string{"DTSTART;VALUE=DATE:20250311", "RRULE:FREQ=WEEKLY;BYDAY=MO,TH;UNTIL=20250313\r\n"},
			lacks:  []string{"COUNT", "UNTIL=20250313T"},
			dates:  []time.Time{date(2025, 3, 11, 0, 0), date(2025, 3, 13, 0, 0)},
			states: []string{domain.OccurrenceCurrent, domain.OccurrenceUpcoming},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			id := seedSeries(t, e, tc.master, tc.overrides...)
			f := listedTodo(t, e, id)
			in := editInput(&f)
			in.Start, in.StartAllDay, in.Timezone = ptr(tc.at), tc.allDay, "Europe/Berlin"
			if f.Due != nil {
				in.Due, in.DueAllDay = ptr(tc.at), tc.allDay
			}
			_, _, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, in)
			mustNoErr(t, err)
			checkStored(t, "series", storedObject(t, e, id), tc.want, tc.lacks)
			occs, err := e.svc.ListTodoOccurrences(t.Context(), e.cals["tasks"], date(2025, 3, 1, 0, 0), date(2025, 4, 20, 0, 0))
			mustNoErr(t, err)
			checkTodoOccurrences(t, occs, tc.dates, tc.states)
		})
	}

	// A new rule keeps the done repeats before the current one as history,
	// in the value type of its dates (FR-17).
	t.Run("a new rule with another value type converts earlier done overrides", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART;VALUE=DATE:20250310", "DUE;VALUE=DATE:20250310", "RRULE:FREQ=DAILY"},
			[]string{"RECURRENCE-ID;VALUE=DATE:20250310", "DTSTART;VALUE=DATE:20250310", "STATUS:COMPLETED"})
		f := listedTodo(t, e, id)
		in := withRule(editInput(&f), "FREQ=WEEKLY")
		at := date(2025, 3, 11, 8, 0) // 09:00 in Berlin
		in.Start, in.StartAllDay, in.Due, in.DueAllDay, in.Timezone = &at, false, &at, false, "Europe/Berlin"
		_, _, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, in)
		mustNoErr(t, err)
		checkStored(t, "series", storedObject(t, e, id), []string{
			"RRULE:FREQ=WEEKLY\r\n", "DTSTART;TZID=Europe/Berlin:20250311T090000",
			"RECURRENCE-ID;TZID=Europe/Berlin:20250310T090000", "DTSTART;TZID=Europe/Berlin:20250310T090000",
		}, []string{"VALUE=DATE"})
		occs, err := e.svc.ListTodoOccurrences(t.Context(), e.cals["tasks"], date(2025, 3, 1, 0, 0), date(2025, 3, 20, 0, 0))
		mustNoErr(t, err)
		checkTodoOccurrences(t, occs,
			[]time.Time{date(2025, 3, 10, 8, 0), date(2025, 3, 11, 8, 0), date(2025, 3, 18, 8, 0)},
			[]string{domain.OccurrenceDone, domain.OccurrenceCurrent, domain.OccurrenceUpcoming})
	})

	t.Run("rrule omitted keeps the rule", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY"})
		f := listedTodo(t, e, id)
		in := editInput(&f)
		in.Title = "Renamed"
		got, _, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, in)
		mustNoErr(t, err)
		if !got.Recurring || got.RRule != "FREQ=WEEKLY" {
			t.Errorf("updated series = %+v", got)
		}
		checkStored(t, "master", storedObject(t, e, id), []string{"RRULE:FREQ=WEEKLY", "SUMMARY:Renamed", "DTSTART:20250310T090000Z"}, nil)
	})

	// The task stays at its current occurrence (FR-17).
	t.Run("rrule empty removes", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{
			"DTSTART:20250310T090000Z", "RRULE:FREQ=DAILY", "EXDATE:20250312T090000Z", "X-KDE-LIBKCAL-DTRECURRENCE:20250310T090000Z",
		},
			[]string{"RECURRENCE-ID:20250310T090000Z", "STATUS:COMPLETED"},
			[]string{"RECURRENCE-ID:20250313T090000Z", "DTSTART:20250313T150000Z"},
		)
		f := listedTodo(t, e, id)
		got, _, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, withRule(editInput(&f), ""))
		mustNoErr(t, err)
		if got.Recurring || got.RRule != "" || got.Next != nil || !sameTime(got.Start, ptr(date(2025, 3, 11, 9, 0))) {
			t.Errorf("single task = %+v; want it at 2025-03-11T09:00Z without a rule", got)
		}
		checkStored(t, "master", storedObject(t, e, id), []string{"DTSTART:20250311T090000Z"},
			[]string{"RRULE", "RECURRENCE-ID", "EXDATE", "X-KDE-LIBKCAL-DTRECURRENCE"})
	})

	// A new rule applies from the current occurrence: completed overrides
	// before it stay as history, later ones go (FR-17).
	t.Run("rrule changed drops later overrides", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250309T090000Z", "RRULE:FREQ=DAILY"},
			[]string{"RECURRENCE-ID:20250309T090000Z", "STATUS:COMPLETED"},
			[]string{"RECURRENCE-ID:20250312T090000Z", "DTSTART:20250312T150000Z"},
		)
		f := listedTodo(t, e, id)
		got, _, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, withRule(editInput(&f), "FREQ=WEEKLY"))
		mustNoErr(t, err)
		if got.RRule != "FREQ=WEEKLY" || !sameTime(got.Start, ptr(date(2025, 3, 10, 9, 0))) ||
			!sameNext(got.Next, &domain.TodoDates{Start: ptr(date(2025, 3, 17, 9, 0))}) {
			t.Errorf("updated series = %+v", got)
		}
		checkStored(t, "master", storedObject(t, e, id),
			[]string{"RRULE:FREQ=WEEKLY", "DTSTART:20250310T090000Z", "RECURRENCE-ID:20250309T090000Z"},
			[]string{"FREQ=DAILY", "RECURRENCE-ID:20250312T090000Z", "DTSTART:20250312T150000Z"})
	})

	// A done override with a date in a timed series lies on its date in the
	// series' zone: 18:00 in Los Angeles on 10 March is 11 March in UTC,
	// after the date 11 March's midnight UTC. The one after the current
	// repeat goes with a new rule, the one before stays (A-11, FR-17).
	t.Run("a new rule places later date overrides by their date", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART;TZID=America/Los_Angeles:20250309T180000", "RRULE:FREQ=DAILY"},
			[]string{"RECURRENCE-ID;VALUE=DATE:20250309", "STATUS:COMPLETED"},
			[]string{"RECURRENCE-ID;VALUE=DATE:20250311", "STATUS:COMPLETED"},
		)
		f := listedTodo(t, e, id)
		if !sameTime(f.Start, ptr(date(2025, 3, 11, 1, 0))) {
			t.Fatalf("current occurrence = %+v; want 10 March 18:00 in Los Angeles", f)
		}
		_, _, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, withRule(editInput(&f), "FREQ=WEEKLY"))
		mustNoErr(t, err)
		checkStored(t, "series", storedObject(t, e, id),
			[]string{"RRULE:FREQ=WEEKLY", "RECURRENCE-ID;VALUE=DATE:20250309"}, []string{"RECURRENCE-ID;VALUE=DATE:20250311"})
		// The done override that goes is placed the same way, and kept as
		// an entry of its own (A-18).
		entries := otherObjects(t, e, id)
		if len(entries) != 1 {
			t.Fatalf("entries = %q; want the done repeat of 11 March", entries)
		}
		checkStored(t, "entry", entries[0],
			[]string{"DTSTART;TZID=America/Los_Angeles:20250311T180000", "STATUS:COMPLETED"}, []string{"RECURRENCE-ID"})
		occs, err := e.svc.ListTodoOccurrences(t.Context(), e.cals["tasks"], date(2025, 3, 1, 0, 0), date(2025, 3, 20, 0, 0))
		mustNoErr(t, err)
		checkTodoOccurrences(t, occs,
			[]time.Time{date(2025, 3, 10, 1, 0), date(2025, 3, 11, 1, 0), date(2025, 3, 18, 1, 0)},
			[]string{domain.OccurrenceDone, domain.OccurrenceCurrent, domain.OccurrenceUpcoming})
	})

	t.Run("same rrule keeps overrides", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=DAILY"},
			[]string{"RECURRENCE-ID:20250310T090000Z", "STATUS:COMPLETED"},
			[]string{"RECURRENCE-ID:20250312T090000Z", "DTSTART:20250312T150000Z"},
		)
		f := listedTodo(t, e, id)
		got, _, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, withRule(editInput(&f), "rrule:freq=daily"))
		mustNoErr(t, err)
		if !sameTime(got.Start, ptr(date(2025, 3, 11, 9, 0))) {
			t.Errorf("start = %v; want 2025-03-11T09:00Z", got.Start)
		}
		checkStored(t, "master", storedObject(t, e, id), []string{
			"RRULE:FREQ=DAILY\r\n", "DTSTART:20250310T090000Z", "RECURRENCE-ID:20250310T090000Z",
			"RECURRENCE-ID:20250312T090000Z", "DTSTART:20250312T150000Z",
		}, nil)
	})

	t.Run("rule on a single timed task", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DUE:20250310T080000Z"})
		f := listedTodo(t, e, id)
		in := withRule(editInput(&f), "FREQ=WEEKLY")
		in.Timezone = "Europe/Berlin"
		got, _, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, in)
		mustNoErr(t, err)
		at := date(2025, 3, 10, 8, 0)
		if !got.Recurring || !sameTime(got.Start, &at) || !sameTime(got.Due, &at) ||
			!sameNext(got.Next, &domain.TodoDates{Start: ptr(date(2025, 3, 17, 8, 0)), Due: ptr(date(2025, 3, 17, 8, 0))}) {
			t.Errorf("new series = %+v", got)
		}
		checkStored(t, "master", storedObject(t, e, id), []string{
			"DTSTART;TZID=Europe/Berlin:20250310T090000", "DUE;TZID=Europe/Berlin:20250310T090000",
			"BEGIN:VTIMEZONE", "RRULE:FREQ=WEEKLY\r\n",
		}, nil)
	})

	// The new rule applies from the current occurrence, which is then
	// completed like any other (FR-15, FR-17).
	t.Run("rule changed while completing", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY"})
		f := listedTodo(t, e, id)
		got, _, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, withRule(completeInput(&f), "FREQ=DAILY"))
		mustNoErr(t, err)
		if got.RRule != "FREQ=DAILY" || !sameTime(got.Start, ptr(date(2025, 3, 11, 9, 0))) || got.Status != domain.TodoNeedsAction {
			t.Errorf("rolled series = %+v", got)
		}
		checkStored(t, "copy", storedCopy(t, e, &got), []string{"DTSTART:20250310T090000Z", "STATUS:COMPLETED"}, []string{"RRULE"})
		checkStored(t, "master", storedObject(t, e, id), []string{"DTSTART:20250311T090000Z", "RRULE:FREQ=DAILY"}, nil)
	})

	t.Run("rule removed while completing", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY"})
		f := listedTodo(t, e, id)
		got, _, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, withRule(completeInput(&f), ""))
		mustNoErr(t, err)
		if got.Recurring || got.CompletedCopy != nil || got.Status != domain.TodoCompleted {
			t.Errorf("completed task = %+v", got)
		}
		if n := len(e.mock.ObjectPaths(e.paths["tasks"])); n != 1 {
			t.Errorf("%d objects; want only the task", n)
		}
		checkStored(t, "master", storedObject(t, e, id), []string{"DTSTART:20250310T090000Z", "STATUS:COMPLETED"}, []string{"RRULE"})
	})

	// A rule Lucid cannot evaluate can be kept or removed, but not moved or
	// replaced (FR-17).
	t.Run("unsupported rule stays editable", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=DAILY;BYDAY=XX"})
		f := listedTodo(t, e, id)
		in := withRule(editInput(&f), "FREQ=DAILY;BYDAY=XX")
		in.Title = "Renamed"
		renamed, _, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, in)
		mustNoErr(t, err)
		checkStored(t, "master", storedObject(t, e, id), []string{"SUMMARY:Renamed", "RRULE:FREQ=DAILY;BYDAY=XX"}, nil)

		single, _, err := e.svc.UpdateTodo(t.Context(), id, renamed.ETag, withRule(editInput(&renamed), ""))
		mustNoErr(t, err)
		if single.Recurring || single.RuleUnsupported || !sameTime(single.Start, f.Start) {
			t.Errorf("single task = %+v", single)
		}
		checkStored(t, "master", storedObject(t, e, id), []string{"DTSTART:20250310T090000Z"}, []string{"RRULE"})
	})

	for _, tc := range []struct {
		name   string
		master []string
		edit   func(in *domain.TodoInput)
	}{
		{"rule without a date", nil, func(in *domain.TodoInput) { *in = withRule(*in, "FREQ=DAILY") }},
		{"invalid rrule", []string{"DUE:20250310T080000Z"}, func(in *domain.TodoInput) { *in = withRule(*in, "FREQ=NOPE") }},
		{"rrule with a line break", []string{"DUE:20250310T080000Z"}, func(in *domain.TodoInput) {
			*in = withRule(*in, "FREQ=DAILY\r\nX-EVIL:1")
		}},
		{
			"move unsupported",
			[]string{"DTSTART:20250310T090000Z", "DUE:20250310T100000Z", "RRULE:FREQ=DAILY;BYDAY=XX"},
			func(in *domain.TodoInput) { in.Due = ptr(date(2025, 3, 10, 11, 0)) },
		},
		{
			"move rdate series",
			[]string{"DTSTART:20250310T090000Z", "RRULE:FREQ=MONTHLY", "RDATE:20250320T090000Z"},
			func(in *domain.TodoInput) { in.Start = ptr(date(2025, 3, 11, 9, 0)) },
		},
		{
			"replace unsupported rule",
			[]string{"DTSTART:20250310T090000Z", "RRULE:FREQ=DAILY;BYDAY=XX"},
			func(in *domain.TodoInput) { *in = withRule(*in, "FREQ=DAILY") },
		},
		{
			"move without any date",
			[]string{"DUE;VALUE=DATE:20250310", "RRULE:FREQ=DAILY"},
			func(in *domain.TodoInput) { in.Due = nil },
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			id := seedSeries(t, e, tc.master)
			f := listedTodo(t, e, id)
			in := editInput(&f)
			tc.edit(&in)
			e.mock.ResetCounts()
			_, _, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, in)
			mustErr(t, err, domain.ErrInvalidInput)
			if n := e.mock.Count(http.MethodPut); n != 0 {
				t.Errorf("PUT count = %d; want 0", n)
			}
		})
	}
}

// otherObjects returns the stored data of the objects in the tasks calendar
// other than the todo with the given ID.
func otherObjects(t *testing.T, e *env, id string) []string {
	t.Helper()
	objPath, _, err := decodeObjectID(e.mock.HomePath(), id)
	mustNoErr(t, err)
	var out []string
	for _, p := range e.mock.ObjectPaths(e.paths["tasks"]) {
		if p == objPath {
			continue
		}
		data, ok := e.mock.Object(p)
		if !ok {
			t.Fatalf("no object %s", p)
		}
		out = append(out, data)
	}
	return out
}

// entryWith returns the one object of objs that has the content line line.
func entryWith(t *testing.T, objs []string, line string) string {
	t.Helper()
	var found []string
	for _, data := range objs {
		if strings.Contains(data, "\r\n"+line+"\r\n") {
			found = append(found, data)
		}
	}
	if len(found) != 1 {
		t.Fatalf("%d objects with %q in %q; want 1", len(found), line, objs)
	}
	return found[0]
}

// Removing or changing a rule drops overrides; those another app completed
// become completed entries of their own first, cloned as completing one in
// Lucid clones it, and a new rule drops the old one's EXDATEs (FR-17, A-17,
// A-18).
func TestRuleChangeKeepsCompletions(t *testing.T) {
	t.Parallel()

	// Review Focus 3: the minimal override keeps the series' title and
	// categories. The cancelled and the open override go with the rule.
	t.Run("removing the rule keeps other apps' completions", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := e.put(t, "tasks", "r.ics",
			"BEGIN:VTODO", "UID:r", "DTSTAMP:20240101T000000Z", "SUMMARY:Water", "CATEGORIES:Garden",
			"DTSTART:20250303T090000Z", "RRULE:FREQ=WEEKLY", "EXDATE:20250407T090000Z", "END:VTODO",
			"BEGIN:VTODO", "UID:r", "DTSTAMP:20240101T000000Z",
			"RECURRENCE-ID:20250303T090000Z", "STATUS:COMPLETED", "END:VTODO",
			"BEGIN:VTODO", "UID:r", "DTSTAMP:20240101T000000Z", "RECURRENCE-ID:20250310T090000Z",
			"SUMMARY:Done there", "CATEGORIES:Home", "STATUS:COMPLETED", "COMPLETED:20250311T070000Z", "END:VTODO",
			"BEGIN:VTODO", "UID:r", "DTSTAMP:20240101T000000Z",
			"RECURRENCE-ID:20250324T090000Z", "STATUS:CANCELLED", "END:VTODO",
			"BEGIN:VTODO", "UID:r", "DTSTAMP:20240101T000000Z",
			"RECURRENCE-ID:20250331T090000Z", "DTSTART:20250401T090000Z", "END:VTODO",
		)
		f := listedTodo(t, e, id)
		if !sameTime(f.Start, ptr(date(2025, 3, 17, 9, 0))) {
			t.Fatalf("current occurrence = %+v; want 17 March", f)
		}
		got, snap, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, withRule(editInput(&f), ""))
		mustNoErr(t, err)
		if snap != nil {
			t.Errorf("snapshot for %s; want none", snap.TodoID)
		}
		if got.Recurring || !sameTime(got.Start, ptr(date(2025, 3, 17, 9, 0))) || got.CompletedCopy != nil {
			t.Errorf("single task = %+v; want it at 17 March without a rule", got)
		}
		master := storedObject(t, e, id)
		checkStored(t, "master", master, []string{"SUMMARY:Water", "CATEGORIES:Garden", "DTSTART:20250317T090000Z"},
			[]string{"RRULE", "RECURRENCE-ID", "EXDATE", "CANCELLED", "Done there", "Home", "20250401"})
		if n := strings.Count(master, "BEGIN:VTODO"); n != 1 {
			t.Errorf("master has %d VTODOs; want 1", n)
		}

		entries := otherObjects(t, e, id)
		if len(entries) != 2 {
			t.Fatalf("entries = %q; want the two completed repeats", entries)
		}
		lacks := []string{"RECURRENCE-ID", "RRULE", "EXDATE", "\r\nUID:r\r\n"}
		checkStored(t, "entry of 3 March", entryWith(t, entries, "DTSTART:20250303T090000Z"),
			[]string{"SUMMARY:Water", "CATEGORIES:Garden", "STATUS:COMPLETED", "PERCENT-COMPLETE:100", "\r\nCOMPLETED:"},
			lacks)
		checkStored(t, "entry of 10 March", entryWith(t, entries, "DTSTART:20250310T090000Z"),
			[]string{"SUMMARY:Done there", "CATEGORIES:Home", "STATUS:COMPLETED", "COMPLETED:20250311T070000Z"},
			append(lacks, "SUMMARY:Water", "Garden"))
	})

	// The overrides before the current repeat stay in the series; the open
	// one after it goes (FR-17, A-18).
	t.Run("changing the rule keeps other apps' completions from the current repeat on", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250303T090000Z", "RRULE:FREQ=WEEKLY"},
			[]string{"RECURRENCE-ID:20250303T090000Z", "STATUS:COMPLETED"},
			[]string{"RECURRENCE-ID:20250310T090000Z", "STATUS:COMPLETED"},
			[]string{"RECURRENCE-ID:20250324T090000Z", "SUMMARY:Ahead", "STATUS:COMPLETED"},
			[]string{"RECURRENCE-ID:20250331T090000Z", "DTSTART:20250401T090000Z"},
		)
		f := listedTodo(t, e, id)
		if !sameTime(f.Start, ptr(date(2025, 3, 17, 9, 0))) {
			t.Fatalf("current occurrence = %+v; want 17 March", f)
		}
		got, snap, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, withRule(editInput(&f), "FREQ=DAILY"))
		mustNoErr(t, err)
		if snap != nil {
			t.Errorf("snapshot for %s; want none", snap.TodoID)
		}
		if got.RRule != "FREQ=DAILY" || !sameTime(got.Start, ptr(date(2025, 3, 17, 9, 0))) {
			t.Errorf("updated series = %+v", got)
		}
		checkStored(t, "master", storedObject(t, e, id),
			[]string{
				"RRULE:FREQ=DAILY\r\n", "DTSTART:20250317T090000Z",
				"RECURRENCE-ID:20250303T090000Z", "RECURRENCE-ID:20250310T090000Z",
			},
			[]string{"RECURRENCE-ID:20250324T090000Z", "Ahead", "RECURRENCE-ID:20250331T090000Z", "20250401"})
		entries := otherObjects(t, e, id)
		if len(entries) != 1 {
			t.Fatalf("entries = %q; want the completed repeat of 24 March", entries)
		}
		checkStored(t, "entry", entries[0],
			[]string{"DTSTART:20250324T090000Z", "SUMMARY:Ahead", "STATUS:COMPLETED"},
			[]string{"RECURRENCE-ID", "RRULE", "\r\nUID:r\r\n"})
	})

	// An EXDATE of the old rule would remove a repeat of the new one that
	// falls on it (A-17).
	t.Run("changing the rule drops old exclusions", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250317T090000Z", "RRULE:FREQ=WEEKLY", "EXDATE:20250324T090000Z"})
		f := listedTodo(t, e, id)
		_, _, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, withRule(editInput(&f), "FREQ=DAILY"))
		mustNoErr(t, err)
		checkStored(t, "master", storedObject(t, e, id), []string{"RRULE:FREQ=DAILY\r\n", "DTSTART:20250317T090000Z"}, []string{"EXDATE"})
		occs, err := e.svc.ListTodoOccurrences(t.Context(), e.cals["tasks"], date(2025, 3, 24, 0, 0), date(2025, 3, 25, 0, 0))
		mustNoErr(t, err)
		checkTodoOccurrences(t, occs, []time.Time{date(2025, 3, 24, 9, 0)}, []string{domain.OccurrenceUpcoming})
	})

	// The entries go again when the master cannot be written, or the
	// completions would be there twice: as entries and as overrides (A-18).
	for _, tc := range []struct {
		name    string
		rrule   string
		entries int
	}{
		{"removed", "", 3},
		{"changed", "FREQ=DAILY", 1},
	} {
		t.Run("a failed master write removes the converted entries, rule "+tc.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			id := seedSeries(t, e, []string{"DTSTART:20250303T090000Z", "RRULE:FREQ=WEEKLY"},
				[]string{"RECURRENCE-ID:20250303T090000Z", "STATUS:COMPLETED"},
				[]string{"RECURRENCE-ID:20250310T090000Z", "STATUS:COMPLETED"},
				[]string{"RECURRENCE-ID:20250324T090000Z", "STATUS:COMPLETED"},
			)
			before := storedObject(t, e, id)
			f := listedTodo(t, e, id)
			objPath, _, err := decodeObjectID(e.mock.HomePath(), id)
			mustNoErr(t, err)
			e.mock.SetHook(func(w http.ResponseWriter, r *http.Request) bool {
				if r.Method == http.MethodPut && r.URL.Path == objPath {
					w.WriteHeader(http.StatusInternalServerError)
					return true
				}
				return false
			})
			e.mock.ResetCounts()
			_, _, err = e.svc.UpdateTodo(t.Context(), id, f.ETag, withRule(editInput(&f), tc.rrule))
			mustErr(t, err, domain.ErrUpstream)
			if n := e.mock.Count(http.MethodPut); n != tc.entries+1 {
				t.Errorf("PUT count = %d; want %d entries and the master", n, tc.entries)
			}
			if n := e.mock.Count(http.MethodDelete); n != tc.entries {
				t.Errorf("DELETE count = %d; want %d", n, tc.entries)
			}
			if paths := e.mock.ObjectPaths(e.paths["tasks"]); len(paths) != 1 {
				t.Errorf("objects = %v; want only the series", paths)
			}
			if after := storedObject(t, e, id); after != before {
				t.Errorf("master = %q; want it unchanged: %q", after, before)
			}
		})
	}

	// An entry that cannot be created stops the change before the master is
	// written, and the entries created before it go again (A-18).
	t.Run("a failed entry removes the entries created before it", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250303T090000Z", "RRULE:FREQ=WEEKLY"},
			[]string{"RECURRENCE-ID:20250303T090000Z", "STATUS:COMPLETED"},
			[]string{"RECURRENCE-ID:20250310T090000Z", "STATUS:COMPLETED"},
		)
		before := storedObject(t, e, id)
		f := listedTodo(t, e, id)
		var creates atomic.Int32
		e.mock.SetHook(func(w http.ResponseWriter, r *http.Request) bool {
			if r.Method == http.MethodPut && r.Header.Get("If-None-Match") == "*" && creates.Add(1) == 2 {
				w.WriteHeader(http.StatusForbidden)
				return true
			}
			return false
		})
		e.mock.ResetCounts()
		_, _, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, withRule(editInput(&f), ""))
		mustErr(t, err, domain.ErrReadOnly)
		if n := e.mock.Count(http.MethodPut); n != 2 {
			t.Errorf("PUT count = %d; want the two entries' only", n)
		}
		if n := e.mock.Count(http.MethodDelete); n != 1 {
			t.Errorf("DELETE count = %d; want 1", n)
		}
		if paths := e.mock.ObjectPaths(e.paths["tasks"]); len(paths) != 1 {
			t.Errorf("objects = %v; want only the series", paths)
		}
		if after := storedObject(t, e, id); after != before {
			t.Errorf("master = %q; want it unchanged: %q", after, before)
		}
	})

	// An EXDATE removes the repeat a done override would complete: no app
	// shows that completion, so none is kept (FR-17).
	t.Run("an excluded done override records no completion", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY", "EXDATE:20250317T090000Z"},
			[]string{"RECURRENCE-ID:20250317T090000Z", "STATUS:COMPLETED"})
		f := listedTodo(t, e, id)
		_, snap, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, withRule(editInput(&f), ""))
		mustNoErr(t, err)
		if entries := otherObjects(t, e, id); len(entries) != 0 {
			t.Errorf("entries = %q; want none", entries)
		}
		if snap == nil {
			t.Error("no snapshot; want one, as no entry was created")
		}
	})

	// A change that fails before the master is written leaves nothing
	// behind either: here the new rule's COUNT cannot be walked to its end
	// when the same save completes the current repeat (FR-17).
	t.Run("a change rejected after the conversion removes the converted entries", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY"},
			[]string{"RECURRENCE-ID:20250317T090000Z", "STATUS:COMPLETED"})
		before := storedObject(t, e, id)
		f := listedTodo(t, e, id)
		e.mock.ResetCounts()
		in := withRule(completeInput(&f), fmt.Sprintf("FREQ=DAILY;COUNT=%d", maxRRuleIterations+1))
		_, _, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, in)
		mustErr(t, err, domain.ErrInvalidInput)
		if n := e.mock.Count(http.MethodDelete); n != 1 {
			t.Errorf("DELETE count = %d; want 1", n)
		}
		if paths := e.mock.ObjectPaths(e.paths["tasks"]); len(paths) != 1 {
			t.Errorf("objects = %v; want only the series", paths)
		}
		if after := storedObject(t, e, id); after != before {
			t.Errorf("master = %q; want it unchanged: %q", after, before)
		}
	})

	// Only a failed write takes the entries back: a master that is written
	// but whose new ETag cannot be read keeps them (A-01).
	t.Run("a master written with an unknown etag keeps the converted entries", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY"},
			[]string{"RECURRENCE-ID:20250310T090000Z", "STATUS:COMPLETED"})
		objPath, _, err := decodeObjectID(e.mock.HomePath(), id)
		mustNoErr(t, err)
		answerWithFailingETagReadback(e.mock, objPath)
		f := listedTodo(t, e, id)
		e.mock.ResetCounts()
		got, snap, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, withRule(editInput(&f), ""))
		mustNoErr(t, err)
		if got.ETag != "" || got.Recurring || snap != nil {
			t.Errorf("single task = %+v, snapshot %t; want no ETag and no snapshot", got, snap != nil)
		}
		if n := e.mock.Count(http.MethodDelete); n != 0 {
			t.Errorf("DELETE count = %d; want 0", n)
		}
		entries := otherObjects(t, e, id)
		if len(entries) != 1 {
			t.Fatalf("entries = %q; want the completed repeat of 10 March", entries)
		}
		checkStored(t, "entry", entries[0], []string{"DTSTART:20250310T090000Z", "STATUS:COMPLETED"}, []string{"RECURRENCE-ID"})
		checkStored(t, "master", storedObject(t, e, id), []string{"DTSTART:20250317T090000Z"}, []string{"RRULE", "RECURRENCE-ID"})
	})
}

// Undoing a change of a recurring todo writes back the resource exactly as
// the change read it, whatever other clients recorded in it, and removes the
// completed copy the change left (FR-17).
func TestRestoreTodo(t *testing.T) {
	t.Parallel()
	berlin := []string{
		"BEGIN:VTIMEZONE", "TZID:Europe/Berlin",
		"BEGIN:DAYLIGHT", "DTSTART:19700329T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
		"TZOFFSETFROM:+0100", "TZOFFSETTO:+0200", "END:DAYLIGHT",
		"BEGIN:STANDARD", "DTSTART:19701025T030000", "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
		"TZOFFSETFROM:+0200", "TZOFFSETTO:+0100", "END:STANDARD",
		"END:VTIMEZONE",
	}
	seeds := []struct {
		name string
		// rule is the RRULE of the series; last that of its variant whose
		// current occurrence is the last one.
		rule, last string
		master     []string // the master's other lines
		overrides  [][]string
		components []string // other components of the resource
	}{
		{name: "utc weekly", rule: "FREQ=WEEKLY;COUNT=4", last: "FREQ=WEEKLY;COUNT=1", master: []string{"DTSTART:20250310T090000Z"}},
		{
			name: "tzid with due", rule: "FREQ=WEEKLY", last: "FREQ=WEEKLY;COUNT=1",
			master:     []string{"DTSTART;TZID=Europe/Berlin:20250310T090000", "DUE;TZID=Europe/Berlin:20250310T100000"},
			components: berlin,
		},
		{
			name: "all-day fixed days", rule: "FREQ=WEEKLY;BYDAY=MO,TH;UNTIL=20250327", last: "FREQ=WEEKLY;BYDAY=MO,TH;COUNT=1",
			master: []string{"DTSTART;VALUE=DATE:20250310"},
		},
		{name: "due-only count", rule: "FREQ=DAILY;COUNT=3", last: "FREQ=DAILY;COUNT=1", master: []string{"DUE:20250310T090000Z"}},
		{
			// The current occurrence is the second one: the first is done.
			name: "thunderbird", rule: "FREQ=WEEKLY", last: "FREQ=WEEKLY;COUNT=2",
			master: []string{"DTSTART:20250310T090000Z", "EXDATE:20250331T090000Z"},
			overrides: [][]string{
				{"RECURRENCE-ID:20250310T090000Z", "STATUS:COMPLETED"},
				{"RECURRENCE-ID:20250317T090000Z", "DTSTART:20250318T100000Z"},
			},
		},
		{
			// The current occurrence is the second one, KDE's pending one.
			name: "kde", rule: "FREQ=WEEKLY", last: "FREQ=WEEKLY;COUNT=2",
			master: []string{"DTSTART:20250310T090000Z", "X-KDE-LIBKCAL-DTRECURRENCE:20250317T090000Z"},
		},
	}
	moveByDay := func(f *domain.Todo) domain.TodoInput {
		in := editInput(f)
		if f.Start != nil {
			in.Start = ptr(f.Start.Add(24 * time.Hour))
		}
		if f.Due != nil {
			in.Due = ptr(f.Due.Add(24 * time.Hour))
		}
		return in
	}
	actions := []struct {
		name  string
		last  bool // on the variant whose current occurrence is the last one
		input func(f *domain.Todo) domain.TodoInput
		copy  bool // the change leaves a completed copy
	}{
		{"complete", false, completeInput, true},
		{"move by a day", false, moveByDay, false},
		{"complete the last repeat", true, completeInput, false},
	}
	for _, sd := range seeds {
		for _, a := range actions {
			t.Run(sd.name+", "+a.name, func(t *testing.T) {
				t.Parallel()
				e := newEnv(t, caldavtest.Options{})
				ctx := t.Context()
				rule := sd.rule
				if a.last {
					rule = sd.last
				}
				lines := slices.Concat(sd.components,
					[]string{"BEGIN:VTODO", "UID:r", "DTSTAMP:20240101T000000Z", "SUMMARY:Series", "RRULE:" + rule},
					sd.master, []string{"END:VTODO"})
				for _, o := range sd.overrides {
					lines = slices.Concat(lines, []string{"BEGIN:VTODO", "UID:r", "DTSTAMP:20240101T000000Z"}, o, []string{"END:VTODO"})
				}
				id := e.put(t, "tasks", "r.ics", lines...)
				seeded := storedObject(t, e, id)
				before := listedTodo(t, e, id)
				if (before.Next == nil) != a.last {
					t.Fatalf("listed series = %+v; want its last occurrence: %v", before, a.last)
				}

				changed, snap, err := e.svc.UpdateTodo(ctx, id, before.ETag, a.input(&before))
				mustNoErr(t, err)
				if (changed.CompletedCopy != nil) != a.copy {
					t.Fatalf("changed series = %+v; want a completed copy: %v", changed, a.copy)
				}
				if snap == nil {
					t.Fatal("UpdateTodo returned no snapshot")
				}
				if string(snap.Data) != seeded {
					t.Errorf("snapshot data:\n%s\nwant the seeded resource:\n%s", snap.Data, seeded)
				}

				got, err := e.svc.RestoreTodo(ctx, *snap)
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
		}
	}
}

// An undo writes nothing over a later change of the series, keeps a
// completed copy changed since, and only restores for the account that made
// the change; a change without a known ETag cannot be undone (FR-17).
func TestRestoreTodoFailures(t *testing.T) {
	t.Parallel()
	// complete completes the occurrence of a seeded weekly series and returns
	// the series' ID, its seeded resource, the change and its snapshot.
	complete := func(t *testing.T, e *env) (id, seeded string, done domain.Todo, snap domain.TodoSnapshot) {
		t.Helper()
		id = seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY"})
		seeded = storedObject(t, e, id)
		f := listedTodo(t, e, id)
		done, s, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, completeInput(&f))
		mustNoErr(t, err)
		if done.CompletedCopy == nil || s == nil {
			t.Fatalf("completion = %+v, snapshot %+v; want a copy and a snapshot", done, s)
		}
		return id, seeded, done, *s
	}

	t.Run("the series changed since", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id, _, _, snap := complete(t, e)
		other := strings.Replace(storedObject(t, e, id), "SUMMARY:Series", "SUMMARY:Other", 1)
		if _, err := e.mock.PutObject(e.paths["tasks"], "r.ics", other); err != nil {
			t.Fatalf("PutObject: %v", err)
		}
		_, err := e.svc.RestoreTodo(t.Context(), snap)
		mustErr(t, err, domain.ErrConflict)
		if stored := storedObject(t, e, id); stored != other {
			t.Errorf("series:\n%s\nwant the other change kept:\n%s", stored, other)
		}
		if paths := e.mock.ObjectPaths(e.paths["tasks"]); len(paths) != 2 {
			t.Errorf("objects = %v; want the series and the copy", paths)
		}
	})

	t.Run("the copy is gone already", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		ctx := t.Context()
		id, seeded, done, snap := complete(t, e)
		mustNoErr(t, e.svc.DeleteTodo(ctx, done.CompletedCopy.ID, done.CompletedCopy.ETag))
		got, err := e.svc.RestoreTodo(ctx, snap)
		mustNoErr(t, err)
		if got.CopyKept {
			t.Errorf("restored todo = %+v; want no copy kept", got)
		}
		if stored := storedObject(t, e, id); stored != seeded {
			t.Errorf("restored resource:\n%s\nwant the seeded one:\n%s", stored, seeded)
		}
		if paths := e.mock.ObjectPaths(e.paths["tasks"]); len(paths) != 1 {
			t.Errorf("objects = %v; want the series only", paths)
		}
	})

	t.Run("the copy changed since", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		ctx := t.Context()
		id, seeded, done, snap := complete(t, e)
		in := editInput(done.CompletedCopy)
		in.Title = "Changed"
		_, _, err := e.svc.UpdateTodo(ctx, done.CompletedCopy.ID, done.CompletedCopy.ETag, in)
		mustNoErr(t, err)
		got, err := e.svc.RestoreTodo(ctx, snap)
		mustNoErr(t, err)
		if !got.CopyKept {
			t.Errorf("restored todo = %+v; want the copy kept", got)
		}
		if stored := storedObject(t, e, id); stored != seeded {
			t.Errorf("restored resource:\n%s\nwant the seeded one:\n%s", stored, seeded)
		}
		checkStored(t, "copy", storedObject(t, e, done.CompletedCopy.ID), []string{"SUMMARY:Changed"}, nil)
	})

	t.Run("another account", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		_, _, _, snap := complete(t, e)
		acct := e.acct
		acct.Username = "other"
		e.mock.ResetCounts()
		_, err := e.p.Service(acct).RestoreTodo(t.Context(), snap)
		mustErr(t, err, domain.ErrNotFound)
		if n := e.mock.Count(http.MethodPut) + e.mock.Count(http.MethodDelete); n != 0 {
			t.Errorf("%d writes; want none", n)
		}
	})

	// snapshot never hands out one without an ETag, but RestoreTodo must
	// refuse it anyway rather than send an empty If-Match (review minor).
	t.Run("no etag refused", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id, _, _, snap := complete(t, e)
		rolled := storedObject(t, e, id)
		snap.ETag = ""
		e.mock.ResetCounts()
		_, err := e.svc.RestoreTodo(t.Context(), snap)
		mustErr(t, err, domain.ErrNotFound)
		if n := e.mock.Count(http.MethodPut) + e.mock.Count(http.MethodDelete); n != 0 {
			t.Errorf("%d writes; want none", n)
		}
		if stored := storedObject(t, e, id); stored != rolled {
			t.Errorf("series:\n%s\nwant unchanged:\n%s", stored, rolled)
		}
	})

	// Without the series' new ETag, an undo could not tell another change
	// from its own; a weak one counts the same as none (review minor).
	for _, a := range []struct {
		name        string
		input       func(f *domain.Todo) domain.TodoInput
		hook        func(mock *caldavtest.Server, objPath string)
		wantObjects int // after the change: the series, plus a copy for a completion
	}{
		{"no etag after a completion", completeInput, answerWithoutETag, 2},
		{"no etag after a move", func(f *domain.Todo) domain.TodoInput {
			in := editInput(f)
			in.Start = ptr(f.Start.Add(24 * time.Hour))
			return in
		}, answerWithoutETag, 1},
		{"weak etag after a completion", completeInput, answerWithWeakETag, 2},
	} {
		t.Run(a.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY"})
			objPath, _, err := decodeObjectID(e.mock.HomePath(), id)
			mustNoErr(t, err)
			a.hook(e.mock, objPath)
			f := listedTodo(t, e, id)
			got, snap, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, a.input(&f))
			mustNoErr(t, err)
			if got.ETag != "" || snap != nil {
				t.Errorf("changed series = %+v, snapshot %+v; want no ETag and no snapshot", got, snap)
			}
			if n := len(e.mock.ObjectPaths(e.paths["tasks"])); n != a.wantObjects {
				t.Errorf("%d objects; want %d", n, a.wantObjects)
			}

			// The hook stays installed, yet the next write still works
			// (Review Focus 2): the unknown ETag of the last change does not
			// wedge the series for the one after it.
			next := listedTodo(t, e, id)
			if next.ETag == "" {
				t.Fatalf("re-listed series = %+v; want a real etag", next)
			}
			if _, _, err := e.svc.UpdateTodo(t.Context(), id, next.ETag, editInput(&next)); err != nil {
				t.Errorf("next UpdateTodo failed: %v", err)
			}
		})
	}
}

// answerWithoutETag makes mock answer a PUT of objPath without an ETag, and
// a PROPFIND of it without getetag, as a server that rewrites what it
// stores may.
func answerWithoutETag(mock *caldavtest.Server, objPath string) {
	var inner atomic.Bool // the hook passes the PUT on to mock, which calls it again
	mock.SetHook(func(w http.ResponseWriter, r *http.Request) bool {
		if r.URL.Path != objPath || inner.Load() {
			return false
		}
		switch r.Method {
		case http.MethodPut:
			inner.Store(true)
			defer inner.Store(false)
			mock.ServeHTTP(withoutETag{w}, r)
			return true
		case "PROPFIND":
			w.WriteHeader(http.StatusMultiStatus)
			_, _ = io.WriteString(w, `<d:multistatus xmlns:d="DAV:"><d:response><d:href>`+objPath+`</d:href>`+
				`<d:propstat><d:prop/><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`)
			return true
		}
		return false
	})
}

// answerWithWeakETag makes mock answer a PUT of objPath without an ETag, and
// a PROPFIND of it with a weak one, as a server that only revalidates its
// own representation may: a weak ETag counts as unknown too (review minor).
func answerWithWeakETag(mock *caldavtest.Server, objPath string) {
	var inner atomic.Bool // the hook passes the PUT on to mock, which calls it again
	mock.SetHook(func(w http.ResponseWriter, r *http.Request) bool {
		if r.URL.Path != objPath || inner.Load() {
			return false
		}
		switch r.Method {
		case http.MethodPut:
			inner.Store(true)
			defer inner.Store(false)
			mock.ServeHTTP(withoutETag{w}, r)
			return true
		case "PROPFIND":
			w.WriteHeader(http.StatusMultiStatus)
			_, _ = io.WriteString(w, `<d:multistatus xmlns:d="DAV:"><d:response><d:href>`+objPath+`</d:href>`+
				`<d:propstat><d:prop><d:getetag>W/&quot;stale&quot;</d:getetag></d:prop>`+
				`<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`)
			return true
		}
		return false
	})
}

// answerWithFailingETagReadback makes mock answer a PUT of objPath without an
// ETag, and fail the PROPFIND that would read it back, as a server that
// rewrites what it stores and then errors on revalidation may (A-01): the
// write itself still succeeded upstream.
func answerWithFailingETagReadback(mock *caldavtest.Server, objPath string) {
	var inner atomic.Bool // the hook passes the PUT on to mock, which calls it again
	mock.SetHook(func(w http.ResponseWriter, r *http.Request) bool {
		if r.URL.Path != objPath || inner.Load() {
			return false
		}
		switch r.Method {
		case http.MethodPut:
			inner.Store(true)
			defer inner.Store(false)
			mock.ServeHTTP(withoutETag{w}, r)
			return true
		case "PROPFIND":
			w.WriteHeader(http.StatusInternalServerError)
			return true
		}
		return false
	})
}

// Completing a series still keeps the completed copy that records it when
// the master PUT succeeds but its new ETag cannot be read back afterwards:
// only a genuinely failed write compensates by removing the copy (A-01).
func TestCompleteKeepsCopyWhenETagUnknown(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY"})
	objPath, _, err := decodeObjectID(e.mock.HomePath(), id)
	mustNoErr(t, err)
	answerWithFailingETagReadback(e.mock, objPath)
	f := listedTodo(t, e, id)
	e.mock.ResetCounts()

	got, snap, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, completeInput(&f))
	mustNoErr(t, err)
	if got.ETag != "" || got.CompletedCopy == nil {
		t.Errorf("completed series = %+v; want no ETag and a completed copy", got)
	}
	if snap != nil {
		t.Errorf("snapshot = %+v; want none", snap)
	}
	if n := len(e.mock.ObjectPaths(e.paths["tasks"])); n != 2 {
		t.Errorf("%d objects; want the series and its copy", n)
	}
	if n := e.mock.Count(http.MethodDelete); n != 0 {
		t.Errorf("DELETE count = %d; want 0", n)
	}
	checkStored(t, "master", storedObject(t, e, id), []string{"DTSTART:20250317T090000Z"}, nil)

	// The hook stays installed, yet the next write still works (Review Focus
	// 2): the unknown ETag of the completion does not wedge the series.
	next := listedTodo(t, e, id)
	if next.ETag == "" {
		t.Fatalf("re-listed series = %+v; want a real etag", next)
	}
	if _, _, err := e.svc.UpdateTodo(t.Context(), id, next.ETag, editInput(&next)); err != nil {
		t.Errorf("next UpdateTodo failed: %v", err)
	}
}

// answerCreateWithFailingETagReadback makes mock strip the ETag from any PUT
// of a calendar object under calPath and fail the PROPFIND that would read
// it back, regardless of the object's name: a create's path is only known
// after the write, unlike an update's.
func answerCreateWithFailingETagReadback(mock *caldavtest.Server, calPath string) {
	var inner atomic.Bool // the hook passes the PUT on to mock, which calls it again
	mock.SetHook(func(w http.ResponseWriter, r *http.Request) bool {
		if !strings.HasPrefix(r.URL.Path, calPath) || !strings.HasSuffix(r.URL.Path, ".ics") || inner.Load() {
			return false
		}
		switch r.Method {
		case http.MethodPut:
			inner.Store(true)
			defer inner.Store(false)
			mock.ServeHTTP(withoutETag{w}, r)
			return true
		case "PROPFIND":
			w.WriteHeader(http.StatusInternalServerError)
			return true
		}
		return false
	})
}

// putBytes treats a failed ETag read-back the same for every caller, not
// just completeOccurrence/UpdateTodo: a create whose PUT succeeds is kept,
// not reported as failed (A-01 regression: every other caller must see a
// successful write with an unknown ETag, not an error).
func TestCreateTodoKeepsObjectWhenETagUnknown(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	answerCreateWithFailingETagReadback(e.mock, e.paths["tasks"])

	got, err := e.svc.CreateTodo(t.Context(), e.cals["tasks"], domain.TodoInput{Title: "Buy milk"})
	mustNoErr(t, err)
	if got.ETag != "" {
		t.Errorf("created todo = %+v; want no ETag", got)
	}
	objPath, _, err := decodeObjectID(e.mock.HomePath(), got.ID)
	mustNoErr(t, err)
	if data, ok := e.mock.Object(objPath); !ok || !strings.Contains(data, "SUMMARY:Buy milk") {
		t.Errorf("object %s not stored as created; want the write kept", objPath)
	}
}

// withoutETag drops the ETag header of a response.
type withoutETag struct{ http.ResponseWriter }

func (w withoutETag) WriteHeader(code int) {
	w.Header().Del("ETag")
	w.ResponseWriter.WriteHeader(code)
}

// A todo can be created with a rule; its dates are written like a series'
// (FR-17).
func TestCreateTodoWithRule(t *testing.T) {
	t.Parallel()

	t.Run("all-day due", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		due := date(2025, 3, 10, 0, 0)
		got, err := e.svc.CreateTodo(t.Context(), e.cals["tasks"], domain.TodoInput{
			Title: "Water plants", Due: &due, DueAllDay: true, RRule: "FREQ=DAILY",
		})
		mustNoErr(t, err)
		if !got.Recurring || got.RRule != "FREQ=DAILY" || got.Next == nil || !sameTime(got.Next.Due, ptr(date(2025, 3, 11, 0, 0))) {
			t.Errorf("created series = %+v", got)
		}
		checkStored(t, "series", storedObject(t, e, got.ID),
			[]string{"DTSTART;VALUE=DATE:20250310", "DUE;VALUE=DATE:20250310", "RRULE:FREQ=DAILY"}, nil)
	})

	t.Run("timed in the browser's zone", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		start, due := date(2025, 3, 10, 8, 0), date(2025, 3, 10, 9, 0)
		got, err := e.svc.CreateTodo(t.Context(), e.cals["tasks"], domain.TodoInput{
			Title: "Standup", Start: &start, Due: &due, RRule: "RRULE:FREQ=WEEKLY", Timezone: "Europe/Berlin",
		})
		mustNoErr(t, err)
		if !got.Recurring || !sameTime(got.Start, &start) || !sameTime(got.Due, &due) {
			t.Errorf("created series = %+v", got)
		}
		checkStored(t, "series", storedObject(t, e, got.ID), []string{
			"DTSTART;TZID=Europe/Berlin:20250310T090000", "DUE;TZID=Europe/Berlin:20250310T100000",
			"BEGIN:VTIMEZONE", "RRULE:FREQ=WEEKLY\r\n",
		}, nil)
	})

	for _, tc := range []struct {
		name string
		in   domain.TodoInput
	}{
		{"without a date", domain.TodoInput{Title: "x", RRule: "FREQ=DAILY"}},
		{"invalid rrule", domain.TodoInput{Title: "x", Due: ptr(date(2025, 3, 10, 0, 0)), DueAllDay: true, RRule: "FREQ=NOPE"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			_, err := e.svc.CreateTodo(t.Context(), e.cals["tasks"], tc.in)
			mustErr(t, err, domain.ErrInvalidInput)
			if n := len(e.mock.ObjectPaths(e.paths["tasks"])); n != 0 {
				t.Errorf("%d objects; want none", n)
			}
		})
	}
}

func TestCountToUntil(t *testing.T) {
	t.Parallel()
	berlin, err := time.LoadLocation("Europe/Berlin")
	mustNoErr(t, err)
	last := time.Date(2025, 3, 12, 10, 0, 0, 0, berlin)
	for _, tc := range []struct {
		rrule string
		form  dateForm
		want  string
	}{
		{"FREQ=DAILY;COUNT=3", dateForm{tzid: "Europe/Berlin", param: "Europe/Berlin"}, "FREQ=DAILY;UNTIL=20250312T090000Z"},
		{"FREQ=WEEKLY;count=2;BYDAY=MO", dateForm{}, "FREQ=WEEKLY;UNTIL=20250312T090000Z;BYDAY=MO"},
		{"FREQ=DAILY;UNTIL=20250401T000000Z;COUNT=3", dateForm{}, "FREQ=DAILY;UNTIL=20250312T090000Z"},
		{"FREQ=DAILY;COUNT=3", dateForm{allDay: true}, "FREQ=DAILY;UNTIL=20250312"},
		// RFC 5545 3.3.10: UNTIL of a floating DTSTART is floating too.
		{"FREQ=DAILY;COUNT=3", dateForm{floating: true}, "FREQ=DAILY;UNTIL=20250312T090000"},
		{"FREQ=DAILY;UNTIL=20250401T000000Z", dateForm{}, "FREQ=DAILY;UNTIL=20250401T000000Z"},
		{"FREQ=DAILY", dateForm{}, "FREQ=DAILY"},
	} {
		t.Run(tc.rrule, func(t *testing.T) {
			t.Parallel()
			if got := countToUntil(tc.rrule, last, tc.form); got != tc.want {
				t.Errorf("countToUntil(%q, %+v) = %q; want %q", tc.rrule, tc.form, got, tc.want)
			}
		})
	}
}

// setSeriesDate writes a date in the form given: as read from the series, or
// a zone for a newly set rule (FR-17).
func TestSetSeriesDate(t *testing.T) {
	t.Parallel()
	at := date(2025, 3, 10, 8, 0)
	for _, tc := range []struct {
		name      string
		t         *time.Time
		form      dateForm
		want      string // the property line, "" when removed
		vtimezone string // TZID of the VTIMEZONE added, "" for none
	}{
		{name: "nil removes", form: dateForm{}},
		{name: "date", t: &at, form: dateForm{allDay: true}, want: "DTSTART;VALUE=DATE:20250310"},
		{name: "utc", t: &at, form: dateForm{}, want: "DTSTART:20250310T080000Z"},
		{name: "floating", t: &at, form: dateForm{floating: true}, want: "DTSTART:20250310T080000"},
		{
			name: "zone of a new rule", t: &at, form: dateForm{tzid: "Europe/Berlin"},
			want: "DTSTART;TZID=Europe/Berlin:20250310T090000", vtimezone: "Europe/Berlin",
		},
		{
			name: "prefixed parameter", t: &at, form: dateForm{tzid: "Europe/Berlin", param: "/mozilla.org/20050126_1/Europe/Berlin"},
			want:      "DTSTART;TZID=/mozilla.org/20050126_1/Europe/Berlin:20250310T090000",
			vtimezone: "/mozilla.org/20050126_1/Europe/Berlin",
		},
		{
			// Read as UTC, so its wall clock is the UTC time.
			name: "unknown parameter", t: &at, form: dateForm{param: "W. Europe Standard Time"},
			want: "DTSTART;TZID=W. Europe Standard Time:20250310T080000",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			cal := newCalendar()
			c := newComponent(ical.CompToDo, "x", at)
			c.Props.Set(newDateProp(ical.PropDateTimeStart, at, false, nil))
			cal.Children = append(cal.Children, c)
			setSeriesDate(cal, c, ical.PropDateTimeStart, tc.t, tc.form)

			var buf bytes.Buffer
			mustNoErr(t, ical.NewEncoder(&buf).Encode(cal))
			data := buf.String()
			if tc.want == "" {
				checkStored(t, "calendar", data, nil, []string{"DTSTART"})
			} else {
				checkStored(t, "calendar", data, []string{tc.want + "\r\n"}, nil)
			}
			var zones []string
			for _, x := range cal.Children {
				if x.Name == ical.CompTimezone {
					zones = append(zones, text(x.Props, ical.PropTimezoneID))
				}
			}
			if want := []string{tc.vtimezone}; (tc.vtimezone == "" && len(zones) != 0) || (tc.vtimezone != "" && !slices.Equal(zones, want)) {
				t.Errorf("VTIMEZONEs = %q; want %q", zones, tc.vtimezone)
			}
		})
	}
}
