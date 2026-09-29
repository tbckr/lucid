package caldav

import (
	"reflect"
	"slices"
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
// DTSTART with TZID anchors the recurrence across DST changes.
func TestUpdateTodoKeepsUnchangedDates(t *testing.T) {
	t.Parallel()
	e := newEnv(t, caldavtest.Options{})
	ctx := t.Context()
	id := e.put(t, "tasks", "r.ics", "BEGIN:VTODO", "UID:r", "DTSTAMP:20240101T000000Z", "SUMMARY:Report",
		"DTSTART;TZID=Europe/Berlin:20250310T090000", "DUE;TZID=Europe/Berlin:20250310T110000", "RRULE:FREQ=WEEKLY", "END:VTODO")
	todos, err := e.svc.ListTodos(ctx, e.cals["tasks"])
	mustNoErr(t, err)
	r := todos[0]
	_, err = e.svc.UpdateTodo(ctx, id, r.ETag, domain.TodoInput{
		Title: r.Title, Checklist: r.Checklist, Start: r.Start, StartAllDay: r.StartAllDay,
		Due: r.Due, DueAllDay: r.DueAllDay, Status: domain.TodoCompleted,
	})
	mustNoErr(t, err)
	objPath, _, _ := decodeObjectID(e.mock.HomePath(), id)
	data, _ := e.mock.Object(objPath)
	for _, want := range []string{"DTSTART;TZID=Europe/Berlin:20250310T090000", "DUE;TZID=Europe/Berlin:20250310T110000", "STATUS:COMPLETED"} {
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
				return domain.TodoInput{Title: f.Title}
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
			name:      "rdate only",
			lines:     []string{"DTSTART:20250310T090000Z", "RDATE:20250315T090000Z"},
			start:     ptr(date(2025, 3, 10, 9, 0)),
			next:      &domain.TodoDates{Start: ptr(date(2025, 3, 15, 9, 0))},
			fixedDays: true,
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
				Due: f.Due, DueAllDay: f.DueAllDay,
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
