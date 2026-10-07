package caldav

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

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

// A restore whose PUT of the series fails without the server's refusal, as
// behind a reverse proxy whose read timeout fired, is settled by the series'
// ETag, as the master write of a change that wrote before it is (FR-17,
// A-01, see settleWrite):
//   - changed since: the restore was applied. It answers without an ETag, and
//     removes what the change created, as after a restore that was not in
//     doubt;
//   - unchanged, or the server refused the write: it was not applied, and
//     nothing is removed;
//   - not readable: the restore may have been applied, so what the change
//     created stays, and the error says that it could not be verified, which
//     keeps the undo token.
//
// What stands next to the series then is a duplicate the user can see and
// delete; deleted on doubt, the new series of a split would be a loss.
func TestRestoreAfterAmbiguousWrite(t *testing.T) {
	t.Parallel()
	// The kinds of change: each leaves a resource it created, and returns the
	// calendar and ID of the series it changed and its snapshot.
	kinds := []struct {
		name    string
		change  func(t *testing.T, e *env) (calendar, id string, snap domain.Snapshot)
		restore func(t *testing.T, e *env, snap domain.Snapshot) (etag string, kept bool, err error)
	}{
		{
			name: "a completion",
			change: func(t *testing.T, e *env) (string, string, domain.Snapshot) {
				t.Helper()
				id, _, _, snap := completeSeeded(t, e)
				return "tasks", id, snap
			},
			restore: func(t *testing.T, e *env, snap domain.Snapshot) (string, bool, error) {
				t.Helper()
				got, err := e.svc.RestoreTodo(t.Context(), snap)
				return got.ETag, got.CopyKept, err
			},
		},
		{
			name: "a split",
			change: func(t *testing.T, e *env) (string, string, domain.Snapshot) {
				t.Helper()
				id := e.put(t, "work", "series.ics", weeklyStandup()...)
				ev := shownEvent(t, e, "work", date(2025, 3, 24, 8, 0))
				in := eventInputOf(ev)
				in.Start, in.End = ev.Start.Add(time.Hour), ev.End.Add(time.Hour)
				_, snap, err := e.svc.UpdateFollowing(t.Context(), id, ev.ETag, *ev.RecurrenceID, in)
				mustNoErr(t, err)
				if snap == nil {
					t.Fatal("UpdateFollowing returned no snapshot")
				}
				return "work", id, *snap
			},
			restore: func(t *testing.T, e *env, snap domain.Snapshot) (string, bool, error) {
				t.Helper()
				got, err := e.svc.RestoreEvent(t.Context(), snap)
				return got.ETag, got.CopyKept, err
			},
		},
	}
	rows := []struct {
		name           string
		apply          bool // the server applies the write before it answers
		status         int
		propfindStatus int   // the PROPFIND of the series fails with it, if set
		wantErr        error // nil: the undo succeeded
		unverified     bool  // wantErr says that the write could not be verified
		wantObjects    int   // the series, and what the change created if it stays
		wantDeletes    int
	}{
		{name: "applied, then 502", apply: true, status: http.StatusBadGateway, wantObjects: 1, wantDeletes: 1},
		{name: "not applied, 502", status: http.StatusBadGateway, wantErr: domain.ErrUpstream, wantObjects: 2},
		{name: "refused with 412", status: http.StatusPreconditionFailed, wantErr: domain.ErrConflict, wantObjects: 2},
		{
			name: "applied, then 502, unverifiable", apply: true, status: http.StatusBadGateway, propfindStatus: http.StatusInternalServerError,
			wantErr: domain.ErrUpstream, unverified: true, wantObjects: 2,
		},
		{
			name: "not applied, 502, unverifiable", status: http.StatusBadGateway, propfindStatus: http.StatusInternalServerError,
			wantErr: domain.ErrUpstream, unverified: true, wantObjects: 2,
		},
	}
	for _, k := range kinds {
		for _, row := range rows {
			t.Run(k.name+", "+row.name, func(t *testing.T) {
				t.Parallel()
				e := newEnv(t, caldavtest.Options{})
				calendar, id, snap := k.change(t, e)
				left := storedObject(t, e, id)
				answerPutWith(e.mock, mustDecode(t, e, id), row.apply, row.status, row.propfindStatus)
				e.mock.ResetCounts()

				etag, kept, err := k.restore(t, e, snap)
				if row.wantErr != nil {
					mustErr(t, err, row.wantErr)
					if got := errors.Is(err, errWriteUnverified); got != row.unverified {
						t.Errorf("error = %v; want it unverified: %v", err, row.unverified)
					}
				} else {
					mustNoErr(t, err)
				}
				if etag != "" || kept {
					t.Errorf("restore = ETag %q, kept %v; want no ETag, as the one of an applied write is unknown, and nothing kept", etag, kept)
				}
				// The mock counts the PUT the hook applies too.
				wantPuts := 1
				if row.apply {
					wantPuts++
				}
				if n := e.mock.Count(http.MethodPut); n != wantPuts {
					t.Errorf("PUT count = %d; want %d", n, wantPuts)
				}
				if n := e.mock.Count(http.MethodDelete); n != row.wantDeletes {
					t.Errorf("DELETE count = %d; want %d", n, row.wantDeletes)
				}
				if paths := e.mock.ObjectPaths(e.paths[calendar]); len(paths) != row.wantObjects {
					t.Errorf("objects = %v; want %d", paths, row.wantObjects)
				}
				// The restore is stored where the server applied it, whatever it
				// answered.
				want := left
				if row.apply {
					want = string(snap.Data)
				}
				if got := storedObject(t, e, id); got != want {
					t.Errorf("series:\n%s\nwant:\n%s", got, want)
				}
			})
		}
	}
}
