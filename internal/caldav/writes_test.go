package caldav

import (
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/tbckr/lucid/internal/caldav/caldavtest"
	"github.com/tbckr/lucid/internal/domain"
)

// createAnswer is how answerCreate makes the mock answer the PUT that creates
// a resource (If-None-Match: *), and a PROPFIND of the resource it created.
type createAnswer struct {
	status int  // the PUT's answer in place of the mock's; 0: the mock's
	stored bool // with status: the mock stores the resource first, as a server behind a reverse proxy whose read timeout fires after it committed
	noETag bool // without status: the mock's answer without an ETag
	// propfind is the status a PROPFIND of the created resource fails with;
	// 0: the mock answers it.
	propfind int
	// propfindOnce: only the first PROPFIND of the created resource fails
	// with propfind, the one that reads its ETag back after the create, and
	// the mock answers the later ones, as after a passing failure.
	propfindOnce bool
	weakETag     bool // a PROPFIND of the created resource tells a weak ETag
	master       int  // the status the PUT of the master fails with; 0: the mock's answer
}

// answerCreate makes mock answer as a says, and counts in toMaster the PUTs
// of the resource masterPath.
func answerCreate(mock *caldavtest.Server, masterPath string, a createAnswer, toMaster *atomic.Int32) {
	var inner atomic.Bool      // the hook passes requests on to mock, which calls it again
	var created sync.Map       // the paths of the PUTs that created a resource
	var propfinds atomic.Int32 // the PROPFINDs of a created resource
	mock.SetHook(func(w http.ResponseWriter, r *http.Request) bool {
		if inner.Load() {
			return false
		}
		switch {
		case r.Method == http.MethodPut && r.URL.Path == masterPath:
			toMaster.Add(1)
			if a.master != 0 {
				w.WriteHeader(a.master)
				return true
			}
		case r.Method == http.MethodPut && r.Header.Get("If-None-Match") == "*":
			created.Store(r.URL.Path, true)
			inner.Store(true)
			defer inner.Store(false)
			switch {
			case a.status != 0 && a.stored:
				mock.ServeHTTP(httptest.NewRecorder(), r)
				w.WriteHeader(a.status)
			case a.status != 0:
				w.WriteHeader(a.status)
			case a.noETag:
				mock.ServeHTTP(withoutETag{w}, r)
			default:
				mock.ServeHTTP(w, r)
			}
			return true
		case r.Method == "PROPFIND":
			if _, ok := created.Load(r.URL.Path); !ok {
				return false
			}
			switch n := propfinds.Add(1); {
			case a.propfind != 0 && (!a.propfindOnce || n == 1):
				w.WriteHeader(a.propfind)
				return true
			case a.weakETag:
				w.WriteHeader(http.StatusMultiStatus)
				_, _ = io.WriteString(w, `<d:multistatus xmlns:d="DAV:"><d:response><d:href>`+r.URL.Path+`</d:href>`+
					`<d:propstat><d:prop><d:getetag>W/&quot;weak&quot;</d:getetag></d:prop>`+
					`<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`)
				return true
			}
		}
		return false
	})
}

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
