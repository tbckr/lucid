package caldav

import (
	"reflect"
	"strings"
	"testing"
	"time"

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
	_, err = e.svc.CreateTodo(ctx, "bad", domain.TodoInput{Title: "x"})
	mustErr(t, err, domain.ErrNotFound)
	_, err = e.svc.ListTodos(ctx, "bad")
	mustErr(t, err, domain.ErrNotFound)
	_, err = e.svc.UpdateTodo(ctx, "bad", "x", domain.TodoInput{Title: "x"})
	mustErr(t, err, domain.ErrNotFound)
	_, err = e.svc.UpdateTodo(ctx, reopened.ID, "", domain.TodoInput{Title: "x"})
	mustErr(t, err, domain.ErrInvalidInput)

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
