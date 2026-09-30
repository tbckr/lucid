package caldav

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"reflect"
	"regexp"
	"slices"
	"strings"
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
	done, err := e.svc.UpdateTodo(ctx, created.ID, created.ETag, domain.TodoInput{
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
	again, err := e.svc.UpdateTodo(ctx, done.ID, done.ETag, domain.TodoInput{Title: "Buy milk!", Status: domain.TodoCompleted})
	mustNoErr(t, err)
	if again.Completed == nil || !again.Completed.Equal(*done.Completed) || again.Due != nil {
		t.Fatalf("completion time changed: %+v", again)
	}

	// Reopening clears it.
	reopened, err := e.svc.UpdateTodo(ctx, again.ID, again.ETag, domain.TodoInput{Title: "Buy milk", Status: domain.TodoInProcess})
	mustNoErr(t, err)
	if reopened.Completed != nil || reopened.Status != domain.TodoInProcess {
		t.Fatalf("unexpected reopened todo %+v", reopened)
	}
	data, _ = e.mock.Object(objPath)
	if strings.Contains(data, "COMPLETED:") || strings.Contains(data, "PERCENT-COMPLETE") {
		t.Errorf("reopened todo still completed:\n%s", data)
	}

	// Errors.
	_, err = e.svc.UpdateTodo(ctx, reopened.ID, created.ETag, domain.TodoInput{Title: "x"})
	mustErr(t, err, domain.ErrConflict)
	_, err = e.svc.UpdateTodo(ctx, reopened.ID, reopened.ETag, domain.TodoInput{})
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
	_, err = e.svc.UpdateTodo(ctx, "bad", "x", domain.TodoInput{Title: "x"})
	mustErr(t, err, domain.ErrNotFound)
	_, err = e.svc.UpdateTodo(ctx, reopened.ID, "", domain.TodoInput{Title: "x"})
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
	_, err = e.svc.UpdateTodo(ctx, ev.ID, ev.ETag, domain.TodoInput{Title: "x"})
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
	_, err = e.svc.UpdateTodo(ctx, id, r.ETag, domain.TodoInput{
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

	cleared, err := e.svc.UpdateTodo(ctx, created.ID, created.ETag, domain.TodoInput{Title: "Slides", Due: &due})
	mustNoErr(t, err)
	if data := stored(created.ID); cleared.Start != nil || strings.Contains(data, "DTSTART") {
		t.Errorf("start not cleared: %+v\n%s", cleared, data)
	}

	allDay := date(2025, 3, 10, 0, 0)
	_, err = e.svc.UpdateTodo(ctx, created.ID, cleared.ETag, domain.TodoInput{Title: "Slides", Start: &allDay, StartAllDay: true})
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
	_, err = e.svc.UpdateTodo(ctx, id, d.ETag, domain.TodoInput{Title: d.Title, Start: d.Start, Due: d.Due})
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
			done, err := e.svc.UpdateTodo(ctx, id, f.ETag, domain.TodoInput{
				Title: f.Title, Checklist: f.Checklist, Start: f.Start, StartAllDay: f.StartAllDay,
				Due: f.Due, DueAllDay: f.DueAllDay, Status: domain.TodoCompleted,
			})
			mustNoErr(t, err)
			if done.Status != domain.TodoCompleted || !sameTime(done.Start, f.Start) {
				t.Fatalf("unexpected todo %+v", done)
			}

			// Changing the dates still has to produce a valid pair.
			later := f.Start.Add(24 * time.Hour)
			_, err = e.svc.UpdateTodo(ctx, id, done.ETag, domain.TodoInput{
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
			got, err := e.svc.UpdateTodo(ctx, id, f.ETag, tc.in(f))
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

// sameNext reports whether a and b are both nil or carry the same dates.
func sameNext(a, b *domain.TodoDates) bool {
	if a == nil || b == nil {
		return a == b
	}
	return sameTime(a.Start, b.Start) && sameTime(a.Due, b.Due)
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
			next:  &domain.TodoDates{Due: ptr(date(2025, 3, 11, 0, 0))},
			rrule: "FREQ=DAILY",
		},
		{
			name:  "fixed days",
			lines: []string{"DTSTART;VALUE=DATE:20250310", "DUE;VALUE=DATE:20250310", "RRULE:FREQ=WEEKLY;BYDAY=MO,TH"},
			start: ptr(date(2025, 3, 10, 0, 0)), startAllDay: true, due: ptr(date(2025, 3, 10, 0, 0)), dueAllDay: true,
			next:  &domain.TodoDates{Start: ptr(date(2025, 3, 13, 0, 0)), Due: ptr(date(2025, 3, 13, 0, 0))},
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
			got, err := e.svc.UpdateTodo(ctx, id, f.ETag, domain.TodoInput{
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
	got, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, completeInput(&f))
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
			!sameNext(got.Next, &domain.TodoDates{Start: ptr(date(2025, 3, 12, 0, 0)), Due: ptr(date(2025, 3, 12, 0, 0))}) {
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

		second, err := e.svc.UpdateTodo(ctx, id, first.ETag, completeInput(&first))
		mustNoErr(t, err)
		checkStored(t, "master", storedObject(t, e, id), []string{"DTSTART:20250312T090000Z"}, nil)
		if second.CompletedCopy == nil || second.Next != nil {
			t.Fatalf("after the 2nd completion: %+v", second)
		}

		third, err := e.svc.UpdateTodo(ctx, id, second.ETag, completeInput(&second))
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

	t.Run("duration stays", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "DURATION:PT2H", "RRULE:FREQ=DAILY"})
		got := completeListed(t, e, id)
		if !sameTime(got.Due, ptr(date(2025, 3, 11, 11, 0))) {
			t.Errorf("due = %v; want 2025-03-11T11:00Z", got.Due)
		}
		checkStored(t, "master", storedObject(t, e, id), []string{"DTSTART:20250311T090000Z", "DURATION:PT2H"}, []string{"DUE"})
		checkStored(t, "copy", storedCopy(t, e, &got), []string{"DTSTART:20250310T090000Z", "DUE:20250310T110000Z"}, nil)
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
		_, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, completeInput(&f))
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
		checkStored(t, "copy", storedCopy(t, e, &got), []string{"DTSTART:20250314T090000Z"}, nil)
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
		got, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, in)
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
		_, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, completeInput(&f))
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
		_, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, completeInput(&f))
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
		if _, err := e.svc.UpdateTodo(ctx, id, f.ETag, completeInput(&f)); err == nil {
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
		_, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, completeInput(&f))
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
		_, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, completeInput(&f))
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
		_, err := e.svc.UpdateTodo(t.Context(), id, "bogus", completeInput(&f))
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
		_, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, completeInput(&f))
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
		got, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, in)
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
	got, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, in)
	mustNoErr(t, err)
	return got
}

// undoInput is what the frontend sends to take back the completion of f's
// occurrence: f's fields as reported, marked as that undo.
func undoInput(f *domain.Todo) domain.TodoInput {
	in := editInput(f)
	in.UndoCompletion = true
	return in
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
		got, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, in)
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
		got, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, in)
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
	// stays, as on fixed days (FR-17).
	t.Run("move beyond until extends it", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20250331T090000Z"})
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
	// end the series at the new anchor (FR-17).
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
			[]time.Time{date(2025, 3, 4, 9, 0), date(2025, 3, 11, 9, 0), date(2025, 3, 18, 9, 0)},
			[]string{domain.OccurrenceCurrent, domain.OccurrenceUpcoming, domain.OccurrenceUpcoming})
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

	// The undo of a completion says so, and moves the series back onto its
	// own rule: every occurrence stays where it is, and so do the exceptions
	// and the end. Without the mark, the same request is a move like any
	// other, and they move back with the series (FR-17).
	for _, tc := range []struct {
		name string
		undo bool
		want []string
	}{
		{"undo after completion keeps later exceptions and the end", true, []string{
			"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY;UNTIL=20250407T090000Z\r\n", "EXDATE:20250331T090000Z",
			"RECURRENCE-ID:20250324T090000Z", "DTSTART:20250325T090000Z",
		}},
		{"the same move without the undo mark shifts them", false, []string{
			"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY;UNTIL=20250331T090000Z\r\n", "EXDATE:20250324T090000Z",
			"RECURRENCE-ID:20250317T090000Z", "DTSTART:20250318T090000Z",
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, caldavtest.Options{})
			id := seedSeries(t, e,
				[]string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY;UNTIL=20250407T090000Z", "EXDATE:20250331T090000Z"},
				[]string{"RECURRENCE-ID:20250324T090000Z", "DTSTART:20250325T090000Z", "SUMMARY:Moved"})
			f := listedTodo(t, e, id)
			done := completeListed(t, e, id)
			in := editInput(&f)
			in.UndoCompletion = tc.undo
			_, err := e.svc.UpdateTodo(t.Context(), id, done.ETag, in)
			mustNoErr(t, err)
			checkStored(t, "master", storedObject(t, e, id), tc.want, nil)
		})
	}

	// The series rolled onto an occurrence another client had moved, and
	// kept its override; the undo keeps it too (FR-17).
	t.Run("undo after completion keeps the next occurrence's override", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		ctx := t.Context()
		from, to := date(2025, 3, 1, 0, 0), date(2025, 4, 1, 0, 0)
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY"},
			[]string{"RECURRENCE-ID:20250317T090000Z", "DTSTART:20250318T090000Z", "SUMMARY:Moved"})
		occs, err := e.svc.ListTodoOccurrences(ctx, e.cals["tasks"], from, to)
		mustNoErr(t, err)
		f := listedTodo(t, e, id)
		done := completeListed(t, e, id)
		_, err = e.svc.UpdateTodo(ctx, id, done.ETag, undoInput(&f))
		mustNoErr(t, err)
		checkStored(t, "master", storedObject(t, e, id),
			[]string{"DTSTART:20250310T090000Z", "RECURRENCE-ID:20250317T090000Z", "DTSTART:20250318T090000Z"}, nil)
		after, err := e.svc.ListTodoOccurrences(ctx, e.cals["tasks"], from, to)
		mustNoErr(t, err)
		dates, states := occurrenceDates(occs)
		checkTodoOccurrences(t, after, dates, states)
	})

	// Completing the last occurrence completes the master, whose DTSTART
	// another client's completion left behind; its undo moves the series
	// onto that occurrence, and keeps the end and the other client's
	// completion (FR-17).
	t.Run("undo after completing the last occurrence keeps the end", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		ctx := t.Context()
		from, to := date(2025, 3, 1, 0, 0), date(2025, 4, 1, 0, 0)
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY;UNTIL=20250317T090000Z"},
			[]string{"RECURRENCE-ID:20250310T090000Z", "STATUS:COMPLETED"})
		occs, err := e.svc.ListTodoOccurrences(ctx, e.cals["tasks"], from, to)
		mustNoErr(t, err)
		f := listedTodo(t, e, id)
		done := completeListed(t, e, id)
		if done.CompletedCopy != nil || done.Status != domain.TodoCompleted {
			t.Fatalf("completed series = %+v; want the master completed, without a copy", done)
		}
		_, err = e.svc.UpdateTodo(ctx, id, done.ETag, undoInput(&f))
		mustNoErr(t, err)
		checkStored(t, "master", storedObject(t, e, id), []string{
			"DTSTART:20250317T090000Z", "RRULE:FREQ=WEEKLY;UNTIL=20250317T090000Z\r\n", "RECURRENCE-ID:20250310T090000Z",
		}, nil)
		after, err := e.svc.ListTodoOccurrences(ctx, e.cals["tasks"], from, to)
		mustNoErr(t, err)
		dates, states := occurrenceDates(occs)
		checkTodoOccurrences(t, after, dates, states)
	})

	t.Run("undo after completion", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, berlinWeekly)
		f := listedTodo(t, e, id)
		done := completeListed(t, e, id)
		got, err := e.svc.UpdateTodo(t.Context(), id, done.ETag, undoInput(&f))
		mustNoErr(t, err)
		if !sameTime(got.Start, f.Start) || !sameTime(got.Due, f.Due) || got.Status != domain.TodoNeedsAction {
			t.Errorf("undone series = %+v; want it back at %v", got, f.Start)
		}
		checkStored(t, "master", storedObject(t, e, id), []string{
			"DTSTART;TZID=Europe/Berlin:20250310T090000", "DUE;TZID=Europe/Berlin:20250310T110000", "STATUS:NEEDS-ACTION",
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
		got, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, in)
		mustNoErr(t, err)
		if !sameTime(got.Start, in.Start) || !sameNext(got.Next, &domain.TodoDates{Start: ptr(date(2025, 3, 13, 9, 0))}) {
			t.Errorf("reopened series = %+v", got)
		}
		checkStored(t, "master", storedObject(t, e, id), []string{"DTSTART:20250312T090000Z", "STATUS:NEEDS-ACTION"},
			[]string{"RECURRENCE-ID", "COMPLETED:"})
	})

	t.Run("start null writes DTSTART = DUE", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DUE;VALUE=DATE:20250310", "RRULE:FREQ=DAILY"})
		f := listedTodo(t, e, id)
		in := editInput(&f)
		in.Start, in.Due, in.DueAllDay = nil, ptr(date(2025, 3, 11, 0, 0)), true
		got, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, in)
		mustNoErr(t, err)
		if !sameTime(got.Due, in.Due) || got.Next == nil || !sameTime(got.Next.Due, ptr(date(2025, 3, 12, 0, 0))) {
			t.Errorf("moved series = %+v", got)
		}
		checkStored(t, "master", storedObject(t, e, id), []string{"DTSTART;VALUE=DATE:20250311", "DUE;VALUE=DATE:20250311"}, nil)
	})

	// Fixed days limit a move in the UI only: other clients write any date,
	// and undo must be able to go back (FR-17).
	t.Run("move window is not checked", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART;VALUE=DATE:20250310", "DUE;VALUE=DATE:20250310", "RRULE:FREQ=WEEKLY;BYDAY=MO,TH"})
		f := listedTodo(t, e, id)
		in := editInput(&f)
		in.Start, in.Due = ptr(date(2025, 3, 20, 0, 0)), ptr(date(2025, 3, 20, 0, 0))
		_, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, in)
		mustNoErr(t, err)
		checkStored(t, "master", storedObject(t, e, id), []string{"DTSTART;VALUE=DATE:20250320", "DUE;VALUE=DATE:20250320"}, nil)
	})

	t.Run("move to all-day and back", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "DUE:20250310T100000Z", "RRULE:FREQ=WEEKLY"})
		f := listedTodo(t, e, id)
		in := editInput(&f)
		in.Start, in.StartAllDay, in.Due, in.DueAllDay = ptr(date(2025, 3, 12, 0, 0)), true, ptr(date(2025, 3, 12, 0, 0)), true
		allDay, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, in)
		mustNoErr(t, err)
		checkStored(t, "master", storedObject(t, e, id), []string{"DTSTART;VALUE=DATE:20250312", "DUE;VALUE=DATE:20250312"}, nil)

		in = editInput(&allDay)
		in.Start, in.StartAllDay, in.Due, in.DueAllDay = ptr(date(2025, 3, 13, 8, 0)), false, ptr(date(2025, 3, 13, 9, 0)), false
		in.Timezone = "Europe/Berlin"
		_, err = e.svc.UpdateTodo(t.Context(), id, allDay.ETag, in)
		mustNoErr(t, err)
		checkStored(t, "master", storedObject(t, e, id),
			[]string{"DTSTART;TZID=Europe/Berlin:20250313T090000", "DUE;TZID=Europe/Berlin:20250313T100000", "BEGIN:VTIMEZONE"}, nil)
	})

	t.Run("rrule omitted keeps the rule", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY"})
		f := listedTodo(t, e, id)
		in := editInput(&f)
		in.Title = "Renamed"
		got, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, in)
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
		got, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, withRule(editInput(&f), ""))
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
		got, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, withRule(editInput(&f), "FREQ=WEEKLY"))
		mustNoErr(t, err)
		if got.RRule != "FREQ=WEEKLY" || !sameTime(got.Start, ptr(date(2025, 3, 10, 9, 0))) ||
			!sameNext(got.Next, &domain.TodoDates{Start: ptr(date(2025, 3, 17, 9, 0))}) {
			t.Errorf("updated series = %+v", got)
		}
		checkStored(t, "master", storedObject(t, e, id),
			[]string{"RRULE:FREQ=WEEKLY", "DTSTART:20250310T090000Z", "RECURRENCE-ID:20250309T090000Z"},
			[]string{"FREQ=DAILY", "RECURRENCE-ID:20250312T090000Z", "DTSTART:20250312T150000Z"})
	})

	t.Run("same rrule keeps overrides", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=DAILY"},
			[]string{"RECURRENCE-ID:20250310T090000Z", "STATUS:COMPLETED"},
			[]string{"RECURRENCE-ID:20250312T090000Z", "DTSTART:20250312T150000Z"},
		)
		f := listedTodo(t, e, id)
		got, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, withRule(editInput(&f), "rrule:freq=daily"))
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
		got, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, in)
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
		got, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, withRule(completeInput(&f), "FREQ=DAILY"))
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
		got, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, withRule(completeInput(&f), ""))
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
		renamed, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, in)
		mustNoErr(t, err)
		checkStored(t, "master", storedObject(t, e, id), []string{"SUMMARY:Renamed", "RRULE:FREQ=DAILY;BYDAY=XX"}, nil)

		single, err := e.svc.UpdateTodo(t.Context(), id, renamed.ETag, withRule(editInput(&renamed), ""))
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
			_, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, in)
			mustErr(t, err, domain.ErrInvalidInput)
			if n := e.mock.Count(http.MethodPut); n != 0 {
				t.Errorf("PUT count = %d; want 0", n)
			}
		})
	}
}

// Undoing a completion moves the series back to the completed occurrence's
// dates, marked as that undo: it gives the series back as it was, whatever
// ends its rule, with only a COUNT turned into the UNTIL of the same last
// occurrence (FR-17).
func TestUndoCompletionRestoresSeries(t *testing.T) {
	t.Parallel()
	// The series starts on Monday 10 March 2025 at 09:00 (Berlin: 08:00Z), in
	// three forms; an "@YYYYMMDD" in a rule stands for the UNTIL of that day's
	// occurrence in the form's own writing.
	type form struct {
		name, dtstart string
		until         func(day string) string
	}
	forms := []form{
		{"utc", "DTSTART:20250310T090000Z", func(day string) string { return day + "T090000Z" }},
		{"tzid", "DTSTART;TZID=Europe/Berlin:20250310T090000", func(day string) string { return day + "T080000Z" }},
		{"all-day", "DTSTART;VALUE=DATE:20250310", func(day string) string { return day }},
	}
	untilDay := regexp.MustCompile(`@(\d{8})`)
	inForm := func(rule string, f form) string {
		return untilDay.ReplaceAllStringFunc(rule, func(m string) string { return f.until(m[1:]) })
	}
	rules := []struct {
		name, rule, want string // want: the rule stored after the completion and its undo
	}{
		{"infinite", "FREQ=WEEKLY", "FREQ=WEEKLY"},
		{"count 2", "FREQ=WEEKLY;COUNT=2", "FREQ=WEEKLY;UNTIL=@20250317"},
		{"count 3", "FREQ=WEEKLY;COUNT=3", "FREQ=WEEKLY;UNTIL=@20250324"},
		{"until", "FREQ=WEEKLY;UNTIL=@20250317", "FREQ=WEEKLY;UNTIL=@20250317"},
		{"fixed days until", "FREQ=WEEKLY;BYDAY=MO,TH;UNTIL=@20250313", "FREQ=WEEKLY;BYDAY=MO,TH;UNTIL=@20250313"},
	}
	for _, r := range rules {
		for _, f := range forms {
			t.Run(r.name+", "+f.name, func(t *testing.T) {
				t.Parallel()
				e := newEnv(t, caldavtest.Options{})
				ctx := t.Context()
				from, to := date(2025, 3, 1, 0, 0), date(2025, 5, 1, 0, 0)
				id := seedSeries(t, e, []string{f.dtstart, "RRULE:" + inForm(r.rule, f)})
				before := listedTodo(t, e, id)
				occs, err := e.svc.ListTodoOccurrences(ctx, e.cals["tasks"], from, to)
				mustNoErr(t, err)
				if len(occs) < 2 {
					t.Fatalf("ListTodoOccurrences = %+v; want at least two occurrences to complete and undo", occs)
				}

				done := completeListed(t, e, id)
				if done.CompletedCopy == nil {
					t.Fatalf("completion left no copy: %+v", done)
				}
				// Undo as the frontend does: the previous dates back onto the master, marked as the
				// undo of a completion, then the copy goes.
				got, err := e.svc.UpdateTodo(ctx, id, done.ETag, undoInput(&before))
				mustNoErr(t, err)
				mustNoErr(t, e.svc.DeleteTodo(ctx, done.CompletedCopy.ID, done.CompletedCopy.ETag))

				if !sameTime(got.Start, before.Start) || !sameTime(got.Due, before.Due) || !sameNext(got.Next, before.Next) {
					t.Errorf("undone series = %+v; want it back at start %v, due %v, next %+v", got, before.Start, before.Due, before.Next)
				}
				checkStored(t, "master", storedObject(t, e, id), []string{f.dtstart, "RRULE:" + inForm(r.want, f) + "\r\n"}, nil)
				after, err := e.svc.ListTodoOccurrences(ctx, e.cals["tasks"], from, to)
				mustNoErr(t, err)
				dates, states := occurrenceDates(occs)
				checkTodoOccurrences(t, after, dates, states)
			})
		}
	}
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
