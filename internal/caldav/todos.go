package caldav

import (
	"cmp"
	"context"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/emersion/go-ical"

	"github.com/tbckr/lucid/internal/domain"
)

// ListTodos implements domain.CalendarService. Recurring todos are not
// expanded; the master component is returned.
func (s *service) ListTodos(ctx context.Context, calendarID string) ([]domain.Todo, error) {
	if s.err != nil {
		return nil, s.err
	}
	calPath, err := decodeCalendarID(s.homePath, calendarID)
	if err != nil {
		return nil, err
	}
	objs, err := s.objects(ctx, calPath, ical.CompToDo)
	if err != nil {
		return nil, err
	}
	todos := []domain.Todo{}
	for _, o := range objs {
		if c := mainComponent(o.cal, ical.CompToDo); c != nil {
			todos = append(todos, todoFromComponent(o, calendarID, c))
		}
	}
	slices.SortStableFunc(todos, func(a, b domain.Todo) int {
		return cmp.Or(cmp.Compare(strings.ToLower(a.Title), strings.ToLower(b.Title)), cmp.Compare(a.ID, b.ID))
	})
	return todos, nil
}

func todoFromComponent(o calObject, calendarID string, c *ical.Component) domain.Todo {
	desc, checklist := splitChecklist(text(c.Props, ical.PropDescription))
	t := domain.Todo{
		ID:          encodeID(o.path),
		CalendarID:  calendarID,
		UID:         text(c.Props, ical.PropUID),
		ETag:        o.etag,
		Title:       text(c.Props, ical.PropSummary),
		Description: desc,
		Checklist:   checklist,
		Status:      strings.ToUpper(cmp.Or(text(c.Props, ical.PropStatus), domain.TodoNeedsAction)),
	}
	if d, err := parseDateProp(c.Props.Get(ical.PropDue)); err == nil {
		due := d.t.UTC()
		t.Due, t.DueAllDay = &due, d.allDay
	}
	if p := c.Props.Get(ical.PropPriority); p != nil {
		if n, err := strconv.Atoi(strings.TrimSpace(p.Value)); err == nil && n >= 0 && n <= 9 {
			t.Priority = n
		}
	}
	if d, err := parseDateProp(c.Props.Get(ical.PropCompleted)); err == nil {
		completed := d.t.UTC()
		t.Completed = &completed
	}
	return t
}

// CreateTodo implements domain.CalendarService.
func (s *service) CreateTodo(ctx context.Context, calendarID string, in domain.TodoInput) (domain.Todo, error) {
	if s.err != nil {
		return domain.Todo{}, s.err
	}
	calPath, err := decodeCalendarID(s.homePath, calendarID)
	if err != nil {
		return domain.Todo{}, err
	}
	if err := in.Validate(); err != nil {
		return domain.Todo{}, err
	}
	if err := s.checkWritable(ctx, calPath); err != nil {
		return domain.Todo{}, err
	}
	now := s.p.now().UTC()
	uid := newUID()
	cal := newCalendar()
	c := newComponent(ical.CompToDo, uid, now)
	cal.Children = append(cal.Children, c)
	applyTodoFields(c, in, now)

	o := calObject{path: objectPath(calPath, uid+".ics"), cal: cal}
	o.etag, err = s.putObject(ctx, o.path, cal, "", true)
	s.invalidate(calPath)
	if err != nil {
		return domain.Todo{}, err
	}
	return todoFromComponent(o, calendarID, c), nil
}

// UpdateTodo implements domain.CalendarService. Unknown properties and
// components are preserved.
func (s *service) UpdateTodo(ctx context.Context, todoID, etag string, in domain.TodoInput) (domain.Todo, error) {
	if s.err != nil {
		return domain.Todo{}, s.err
	}
	objPath, calPath, err := decodeObjectID(s.homePath, todoID)
	if err != nil {
		return domain.Todo{}, err
	}
	if err := requireETag(etag); err != nil {
		return domain.Todo{}, err
	}
	if err := in.Validate(); err != nil {
		return domain.Todo{}, err
	}
	if err := s.checkWritable(ctx, calPath); err != nil {
		return domain.Todo{}, err
	}
	cal, current, err := s.getObject(ctx, objPath)
	if err != nil {
		return domain.Todo{}, err
	}
	if current != "" && current != etag {
		return domain.Todo{}, fmt.Errorf("%w: etag mismatch", domain.ErrConflict)
	}
	c := mainComponent(cal, ical.CompToDo)
	if c == nil {
		return domain.Todo{}, fmt.Errorf("%w: %w", domain.ErrNotFound, errWrongComponent)
	}
	now := s.p.now().UTC()
	applyTodoFields(c, in, now)
	bumpChangeProps(c, now)

	o := calObject{path: objPath, cal: cal}
	o.etag, err = s.putObject(ctx, objPath, cal, etag, false)
	s.invalidate(calPath)
	if err != nil {
		return domain.Todo{}, err
	}
	return todoFromComponent(o, encodeID(calPath), c), nil
}

// DeleteTodo implements domain.CalendarService.
func (s *service) DeleteTodo(ctx context.Context, todoID, etag string) error {
	return s.deleteByID(ctx, todoID, etag)
}

func applyTodoFields(c *ical.Component, in domain.TodoInput, now time.Time) {
	setText(c.Props, ical.PropSummary, in.Title)
	setText(c.Props, ical.PropDescription, joinChecklist(in.Description, in.Checklist))

	if in.Due == nil {
		c.Props.Del(ical.PropDue)
	} else {
		c.Props.Set(newDateProp(ical.PropDue, *in.Due, in.DueAllDay, nil))
	}
	if in.Priority == 0 {
		c.Props.Del(ical.PropPriority)
	} else {
		c.Props.Set(rawProp(ical.PropPriority, strconv.Itoa(in.Priority)))
	}

	status := cmp.Or(in.Status, domain.TodoNeedsAction)
	wasCompleted := strings.EqualFold(text(c.Props, ical.PropStatus), domain.TodoCompleted)
	c.Props.Set(rawProp(ical.PropStatus, status))
	if status == domain.TodoCompleted {
		if !wasCompleted || c.Props.Get(ical.PropCompleted) == nil {
			setUTCNow(c.Props, ical.PropCompleted, now)
		}
		c.Props.Set(rawProp(ical.PropPercentComplete, "100"))
		return
	}
	c.Props.Del(ical.PropCompleted)
	if p := c.Props.Get(ical.PropPercentComplete); p != nil && strings.TrimSpace(p.Value) == "100" {
		c.Props.Del(ical.PropPercentComplete)
	}
}

// checklistLine matches a Markdown task list item.
var checklistLine = regexp.MustCompile(`^\s*[-*+]\s+\[([ xX])\]\s?(.*)$`)

// splitChecklist separates the free-text description from the trailing block
// of Markdown task lines.
func splitChecklist(desc string) (string, []domain.ChecklistItem) {
	desc = strings.ReplaceAll(desc, "\r\n", "\n")
	lines := strings.Split(strings.TrimRight(desc, " \t\n"), "\n")
	i := len(lines)
	for i > 0 && checklistLine.MatchString(lines[i-1]) {
		i--
	}
	items := []domain.ChecklistItem{}
	for _, l := range lines[i:] {
		m := checklistLine.FindStringSubmatch(l)
		txt := strings.TrimSpace(m[2])
		if txt == "" {
			continue
		}
		items = append(items, domain.ChecklistItem{Text: txt, Done: m[1] != " "})
	}
	return strings.TrimRight(strings.Join(lines[:i], "\n"), " \t\n"), items
}

// joinChecklist appends the checklist as Markdown task lines to desc.
func joinChecklist(desc string, items []domain.ChecklistItem) string {
	desc = strings.TrimRight(strings.ReplaceAll(desc, "\r\n", "\n"), " \t\n")
	if len(items) == 0 {
		return desc
	}
	var b strings.Builder
	b.WriteString(desc)
	if desc != "" {
		b.WriteString("\n\n")
	}
	for i, it := range items {
		if i > 0 {
			b.WriteByte('\n')
		}
		mark := " "
		if it.Done {
			mark = "x"
		}
		// Newlines inside an item would break the list structure.
		b.WriteString("- [" + mark + "] " + strings.Join(strings.Fields(it.Text), " "))
	}
	return b.String()
}
