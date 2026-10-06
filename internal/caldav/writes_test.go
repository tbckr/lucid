package caldav

import (
	"testing"

	"github.com/tbckr/lucid/internal/caldav/caldavtest"
	"github.com/tbckr/lucid/internal/domain"
)

// removeCreated deletes every resource of a change that still has the ETag
// the change left, and reports that one stays when any is kept (FR-17).
func TestRemoveCreated(t *testing.T) {
	t.Parallel()
	// twoCopies completes a seeded weekly series twice and returns the
	// service with the two copies as refs.
	twoCopies := func(t *testing.T, e *env) (*service, []domain.CreatedRef) {
		t.Helper()
		id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY"})
		first := completeListed(t, e, id)
		second := completeListed(t, e, id)
		if first.CompletedCopy == nil || second.CompletedCopy == nil {
			t.Fatalf("completions = %+v, %+v; want two copies", first, second)
		}
		refs := []domain.CreatedRef{
			{ID: first.CompletedCopy.ID, ETag: first.CompletedCopy.ETag},
			{ID: second.CompletedCopy.ID, ETag: second.CompletedCopy.ETag},
		}
		return e.svc.(*service), refs
	}

	t.Run("none", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		if kept := e.svc.(*service).removeCreated(t.Context(), nil); kept {
			t.Error("removeCreated(nil) = kept; want nothing kept")
		}
	})

	t.Run("all unchanged", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		svc, refs := twoCopies(t, e)
		if kept := svc.removeCreated(t.Context(), refs); kept {
			t.Error("removeCreated() = kept; want both gone")
		}
		if paths := e.mock.ObjectPaths(e.paths["tasks"]); len(paths) != 1 {
			t.Errorf("objects = %v; want the series only", paths)
		}
	})

	// One changed since stays, and the others still go.
	t.Run("one changed since", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, caldavtest.Options{})
		svc, refs := twoCopies(t, e)
		todos, err := e.svc.ListTodos(t.Context(), e.cals["tasks"])
		mustNoErr(t, err)
		for i := range todos {
			if todos[i].ID != refs[0].ID {
				continue
			}
			in := editInput(&todos[i])
			in.Title = "Changed"
			_, _, err := e.svc.UpdateTodo(t.Context(), todos[i].ID, todos[i].ETag, in)
			mustNoErr(t, err)
		}
		if !svc.removeCreated(t.Context(), refs) {
			t.Error("removeCreated() = nothing kept; want the changed copy kept")
		}
		checkStored(t, "first copy", storedObject(t, e, refs[0].ID), []string{"SUMMARY:Changed"}, nil)
		if paths := e.mock.ObjectPaths(e.paths["tasks"]); len(paths) != 2 {
			t.Errorf("objects = %v; want the series and the changed copy", paths)
		}
	})
}
