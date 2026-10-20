package caldav

import (
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/tbckr/lucid/internal/domain"
)

func TestObjectData(t *testing.T) {
	t.Parallel()

	t.Run("well-formed data as stored", func(t *testing.T) {
		t.Parallel()
		r := newProblemRun(t)
		objPath := r.putCanaryEvent(t, "personal", "a.ics")
		want, ok := r.mock.Object(objPath)
		if !ok {
			t.Fatal("the mock lost the object")
		}

		got, err := r.svc.ObjectData(r.ctx, r.p.ids.encode(objPath))

		mustNoErr(t, err)
		if string(got) != want {
			t.Errorf("data = %q; want the data as stored, %q", got, want)
		}
	})

	t.Run("malformed data comes back unchanged", func(t *testing.T) {
		t.Parallel()
		r := newProblemRun(t)
		objPath := r.putCanaryEvent(t, "personal", "a.ics")
		r.hook(func(w http.ResponseWriter, req *http.Request) bool {
			if req.Method != http.MethodGet || req.URL.Path != objPath {
				return false
			}
			w.Header().Set("Content-Type", "text/calendar")
			_, _ = io.WriteString(w, brokenObject)
			return true
		})

		got, err := r.svc.ObjectData(r.ctx, r.p.ids.encode(objPath))

		mustNoErr(t, err)
		if string(got) != brokenObject {
			t.Errorf("data = %q; want what the server sent, %q", got, brokenObject)
		}
		// It is not parsed, so it makes no problem: this is the content the user
		// asks for after a problem was recorded (FR-36).
		if got := r.problems(); len(got) != 0 {
			t.Errorf("problems = %+v; want none", got)
		}
		noCanary(t, "log", r.logs.String())
	})

	t.Run("the read is traced", func(t *testing.T) {
		t.Parallel()
		r := newProblemRun(t)
		objPath := r.putCanaryEvent(t, "personal", canary+"-name.ics")

		_, err := r.svc.ObjectData(r.ctx, r.p.ids.encode(objPath))

		mustNoErr(t, err)
		exs := r.buf.Snapshot().Exchanges
		if len(exs) != 1 {
			t.Fatalf("exchanges = %+v; want the one GET", exs)
		}
		if ex := exs[0]; ex.Method != http.MethodGet || ex.Status != http.StatusOK || ex.RequestID != "req-1" || !objectPseudonym.MatchString(ex.Path) {
			t.Errorf("exchange = %+v; want GET 200 of req-1 at a pseudonymised object path", ex)
		}
	})

	t.Run("bad and foreign IDs are not found, and not asked for", func(t *testing.T) {
		t.Parallel()
		r := newProblemRun(t)
		r.putCanaryEvent(t, "personal", "a.ics")
		home := r.mock.HomePath()
		for name, id := range map[string]string{
			"outside the home":         r.p.ids.encode("/elsewhere/cal/a.ics"),
			"a calendar":               r.p.ids.encode(home + "personal/"),
			"the home itself":          r.p.ids.encode(home),
			"deeper than an object":    r.p.ids.encode(home + "personal/x/a.ics"),
			"a traversal":              r.p.ids.encode(home + "personal/../../a.ics"),
			"a query":                  r.p.ids.encode(home + "personal/a.ics?x=1"),
			"not an ID":                "not-an-id",
			"empty":                    "",
			"a tampered ID":            r.p.ids.encode(home + "personal/a.ics")[:30] + "AAAA",
			"too long":                 strings.Repeat("A", maxIDLength+1),
			"an ID of another codec":   newTestCodec(t).encode(home + "personal/a.ics"),
			"an ID with a bad padding": r.p.ids.encode(home+"personal/a.ics") + "=",
		} {
			_, err := r.svc.ObjectData(r.ctx, id)
			if !errors.Is(err, domain.ErrNotFound) {
				t.Errorf("%s: error = %v; want ErrNotFound", name, err)
			}
		}
		if n := r.mock.Count(http.MethodGet); n != 0 {
			t.Errorf("%d GET requests; want none", n)
		}
		if exs := r.buf.Snapshot().Exchanges; len(exs) != 0 {
			t.Errorf("exchanges = %+v; want none", exs)
		}
	})

	t.Run("an object that is gone", func(t *testing.T) {
		t.Parallel()
		r := newProblemRun(t)

		_, err := r.svc.ObjectData(r.ctx, r.p.ids.encode(r.calPath("personal")+"missing.ics"))

		mustErr(t, err, domain.ErrNotFound)
	})

	t.Run("credentials the server rejects", func(t *testing.T) {
		t.Parallel()
		r := newProblemRun(t)
		objPath := r.putCanaryEvent(t, "personal", "a.ics")
		r.hook(func(w http.ResponseWriter, req *http.Request) bool {
			if req.Method != http.MethodGet || req.URL.Path != objPath {
				return false
			}
			http.Error(w, "no", http.StatusUnauthorized)
			return true
		})

		_, err := r.svc.ObjectData(r.ctx, r.p.ids.encode(objPath))

		mustErr(t, err, domain.ErrUnauthorized)
	})

	t.Run("a server that fails", func(t *testing.T) {
		t.Parallel()
		r := newProblemRun(t)
		objPath := r.putCanaryEvent(t, "personal", "a.ics")
		r.hook(func(w http.ResponseWriter, req *http.Request) bool {
			if req.Method != http.MethodGet || req.URL.Path != objPath {
				return false
			}
			http.Error(w, canary, http.StatusInternalServerError)
			return true
		})

		_, err := r.svc.ObjectData(r.ctx, r.p.ids.encode(objPath))

		mustErr(t, err, domain.ErrUpstream)
		noCanary(t, "error", err.Error())
	})

	t.Run("an unusable account", func(t *testing.T) {
		t.Parallel()
		r := newProblemRun(t)
		svc := r.p.Service(domain.Account{Username: traceUser, CalendarHomeURL: "::"})

		_, err := svc.ObjectData(r.ctx, r.p.ids.encode(r.calPath("personal")+"a.ics"))

		mustErr(t, err, domain.ErrUpstream)
	})

	t.Run("no scope, nothing recorded", func(t *testing.T) {
		t.Parallel()
		r := newProblemRun(t)
		objPath := r.putCanaryEvent(t, "personal", "a.ics")

		if _, err := r.svc.ObjectData(t.Context(), r.p.ids.encode(objPath)); err != nil {
			t.Fatalf("ObjectData: %v", err)
		}

		if exs := r.buf.Snapshot().Exchanges; len(exs) != 0 {
			t.Errorf("exchanges = %+v; the buffer of another request must stay empty", exs)
		}
	})
}

func TestObjectDataOfAnotherAccount(t *testing.T) {
	t.Parallel()
	// An ID is bound to the calendar home it was issued for: one from another
	// account is not found, even though it decodes (the codec's key is the
	// process's, not the account's).
	r := newProblemRun(t)
	other := r.p.Service(domain.Account{
		Username: traceUser, Password: tracePass,
		CalendarHomeURL: r.ts.URL + "/another/home/",
	})
	objPath := r.putCanaryEvent(t, "personal", "a.ics")

	_, err := other.ObjectData(r.ctx, r.p.ids.encode(objPath))

	mustErr(t, err, domain.ErrNotFound)
	if n := r.mock.Count(http.MethodGet); n != 0 {
		t.Errorf("%d GET requests; want none", n)
	}
}
