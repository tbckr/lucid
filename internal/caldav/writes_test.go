package caldav

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"path"
	"strings"
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

// restoreAnswer is how answerRestore makes the mock answer the PUT that
// restores a series, and the GET that reads it back.
type restoreAnswer struct {
	status int // the PUT's answer in place of the mock's
	// stored is the data the server holds after the PUT, from the data sent
	// and the data it held before; nil: the PUT is not applied.
	stored    func(sent, held string) string
	getStatus int // a GET of the series fails with it, if set
}

// answerRestore makes mock answer a PUT of the series at objPath as a says:
// the server applies it as it likes, then answers with status, as a reverse
// proxy whose read timeout fired after the server committed does. A write that
// lands is stored without an HTTP request, so the mock counts one PUT.
func answerRestore(t *testing.T, mock *caldavtest.Server, objPath string, a restoreAnswer) {
	t.Helper()
	calPath, name := path.Split(objPath)
	mock.SetHook(func(w http.ResponseWriter, r *http.Request) bool {
		if r.URL.Path != objPath {
			return false
		}
		switch r.Method {
		case http.MethodPut:
			if a.stored != nil {
				sent, err := io.ReadAll(r.Body)
				if err != nil {
					t.Errorf("reading the PUT: %v", err)
				}
				held, _ := mock.Object(objPath)
				if _, err := mock.PutObject(calPath, name, a.stored(string(sent), held)); err != nil {
					t.Errorf("PutObject: %v", err)
				}
			}
			w.WriteHeader(a.status)
			return true
		case http.MethodGet:
			if a.getStatus != 0 {
				w.WriteHeader(a.getStatus)
				return true
			}
		}
		return false
	})
}

// A restore whose PUT of the series fails without the server's refusal, as
// behind a reverse proxy whose read timeout fired, counts as applied only if
// the series read back is the restored one: it has the data of the snapshot,
// or the stamps of its components, as a server that stores them in its own
// form keeps them. Then it removes what the change created and answers
// without an ETag. In any other case it answers the error, 502, with nothing
// removed and the token kept, whether the change created anything or not: the
// series may have been written by another client, with the restore not
// applied (a changed ETag says no more), and then removing what the change
// created would lose its repeats, and an answer of 200 would consume the
// token. A definite refusal is its error, too (FR-17, A-01, see
// settleRestore).
func TestRestoreAfterAmbiguousWrite(t *testing.T) {
	t.Parallel()
	// The kinds of change: each returns the calendar and ID of the series it
	// changed and its snapshot, and says whether it created a resource.
	kinds := []struct {
		name    string
		created bool
		change  func(t *testing.T, e *env) (calendar, id string, snap domain.Snapshot)
		restore func(t *testing.T, e *env, snap domain.Snapshot) (etag string, kept bool, err error)
	}{
		{
			name: "a completion", created: true,
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
			name: "a move of a task",
			change: func(t *testing.T, e *env) (string, string, domain.Snapshot) {
				t.Helper()
				id := seedSeries(t, e, []string{"DTSTART:20250310T090000Z", "RRULE:FREQ=WEEKLY"})
				f := listedTodo(t, e, id)
				in := editInput(&f)
				in.Start = ptr(f.Start.Add(24 * time.Hour))
				_, snap, err := e.svc.UpdateTodo(t.Context(), id, f.ETag, in)
				mustNoErr(t, err)
				if snap == nil {
					t.Fatal("UpdateTodo returned no snapshot")
				}
				return "tasks", id, *snap
			},
			restore: func(t *testing.T, e *env, snap domain.Snapshot) (string, bool, error) {
				t.Helper()
				got, err := e.svc.RestoreTodo(t.Context(), snap)
				return got.ETag, got.CopyKept, err
			},
		},
		{
			name: "a split", created: true,
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
		{
			// It bumps the stamps of the new override only: the master of the
			// series is the same before and after.
			name: "an occurrence",
			change: func(t *testing.T, e *env) (string, string, domain.Snapshot) {
				t.Helper()
				seed := eventSeeds()[0]
				id := e.put(t, "work", "series.ics", seed.lines...)
				ev := shownEvent(t, e, "work", seed.rid)
				_, snap, err := e.svc.UpdateOccurrence(t.Context(), id, ev.ETag, *ev.RecurrenceID, occurrenceInputOf(ev, time.Hour))
				mustNoErr(t, err)
				if snap == nil {
					t.Fatal("UpdateOccurrence returned no snapshot")
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
	sent := func(sent, _ string) string { return sent }
	// reserialized is what a server stores that writes the data in its own
	// form: with a property of its own, in the first component.
	reserialized := func(sent, _ string) string {
		return strings.Replace(sent, "\r\nEND:V", "\r\nX-SERVER:1\r\nEND:V", 1)
	}
	// otherClient is another client's write of the series, which lands in
	// place of the restore.
	otherClient := func(_, held string) string {
		return strings.Replace(held, "SUMMARY:", "SUMMARY:Other ", 1)
	}
	rows := []struct {
		name string
		restoreAnswer
		restored    bool  // the series is the restored one afterwards
		other       bool  // the series is another client's afterwards
		wantErr     error // nil: the undo succeeded
		unverified  bool  // wantErr says that the restore could not be confirmed
		wantRemoved bool  // what the change created is removed
	}{
		{
			name: "applied, then 502", restoreAnswer: restoreAnswer{status: http.StatusBadGateway, stored: sent},
			restored: true, wantRemoved: true,
		},
		{
			name: "applied in the server's own form, then 502", restoreAnswer: restoreAnswer{status: http.StatusBadGateway, stored: reserialized},
			restored: true, wantRemoved: true,
		},
		{
			name: "not applied, 502", restoreAnswer: restoreAnswer{status: http.StatusBadGateway},
			wantErr: domain.ErrUpstream, unverified: true,
		},
		{
			name: "another client's write lands, not the restore, 502", restoreAnswer: restoreAnswer{status: http.StatusBadGateway, stored: otherClient},
			other: true, wantErr: domain.ErrUpstream, unverified: true,
		},
		{
			name: "refused with 412", restoreAnswer: restoreAnswer{status: http.StatusPreconditionFailed},
			wantErr: domain.ErrConflict,
		},
		{
			name: "applied, then 502, unreadable", restoreAnswer: restoreAnswer{status: http.StatusBadGateway, stored: sent, getStatus: http.StatusInternalServerError},
			restored: true, wantErr: domain.ErrUpstream, unverified: true,
		},
		{
			name: "not applied, 502, unreadable", restoreAnswer: restoreAnswer{status: http.StatusBadGateway, getStatus: http.StatusInternalServerError},
			wantErr: domain.ErrUpstream, unverified: true,
		},
	}
	for _, k := range kinds {
		for _, row := range rows {
			t.Run(k.name+", "+row.name, func(t *testing.T) {
				t.Parallel()
				e := newEnv(t, caldavtest.Options{})
				calendar, id, snap := k.change(t, e)
				left := storedObject(t, e, id)
				answerRestore(t, e.mock, mustDecode(t, e, id), row.restoreAnswer)
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
				if n := e.mock.Count(http.MethodPut); n != 1 {
					t.Errorf("PUT count = %d; want 1", n)
				}
				wantDeletes, wantObjects := 0, 1
				switch {
				case k.created && row.wantRemoved:
					wantDeletes = 1
				case k.created:
					wantObjects = 2
				}
				if n := e.mock.Count(http.MethodDelete); n != wantDeletes {
					t.Errorf("DELETE count = %d; want %d", n, wantDeletes)
				}
				if paths := e.mock.ObjectPaths(e.paths[calendar]); len(paths) != wantObjects {
					t.Errorf("objects = %v; want %d", paths, wantObjects)
				}
				switch got := storedObject(t, e, id); {
				case row.restored:
					if want := string(snap.Data); strings.ReplaceAll(got, "X-SERVER:1\r\n", "") != want {
						t.Errorf("series:\n%s\nwant the restored one:\n%s", got, want)
					}
				case row.other:
					if got != otherClient("", left) {
						t.Errorf("series:\n%s\nwant the other client's write left alone", got)
					}
				default:
					if got != left {
						t.Errorf("series:\n%s\nwant it as the change left it:\n%s", got, left)
					}
				}
			})
		}
	}
}
