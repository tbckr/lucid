package middleware

import (
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

func newContextLogger(t *testing.T, level slog.Level) (*slog.Logger, *syncBuffer) {
	t.Helper()
	buf := &syncBuffer{}
	inner := slog.NewJSONHandler(buf, &slog.HandlerOptions{Level: level})
	return slog.New(NewContextHandler(inner)), buf
}

// requestCtx returns a context carrying the request ID that RequestContext
// stores, together with that ID.
func requestCtx(t *testing.T) (context.Context, string) {
	t.Helper()
	var seen *http.Request
	h := RequestContext(false)(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) { seen = r }))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/", http.NoBody))
	if seen == nil || RequestID(seen.Context()) == "" {
		t.Fatal("RequestContext stored no request ID")
	}
	return seen.Context(), RequestID(seen.Context())
}

func TestContextHandlerAddsRequestID(t *testing.T) {
	t.Parallel()
	logger, buf := newContextLogger(t, slog.LevelDebug)
	ctx, id := requestCtx(t)

	logger.InfoContext(ctx, "something happened", "key", "value")

	lines := buf.lines(t)
	if len(lines) != 1 {
		t.Fatalf("got %d log lines, want 1", len(lines))
	}
	if lines[0]["request_id"] != id || lines[0]["key"] != "value" || lines[0]["msg"] != "something happened" {
		t.Errorf("log line = %v, want request_id %q next to the record's own attrs", lines[0], id)
	}
}

func TestContextHandlerKeepsExplicitRequestID(t *testing.T) {
	t.Parallel()
	logger, buf := newContextLogger(t, slog.LevelDebug)
	ctx, _ := requestCtx(t)

	logger.LogAttrs(ctx, slog.LevelInfo, "explicit", slog.String("key", "value"), slog.String("request_id", "explicit-id"))

	if n := strings.Count(buf.String(), `"request_id"`); n != 1 {
		t.Errorf("request_id appears %d times, want exactly once: %s", n, buf.String())
	}
	if got := buf.lines(t)[0]["request_id"]; got != "explicit-id" {
		t.Errorf("request_id = %v, want the explicit value", got)
	}
}

func TestContextHandlerNoRequestID(t *testing.T) {
	t.Parallel()
	logger, buf := newContextLogger(t, slog.LevelDebug)

	logger.InfoContext(context.Background(), "startup")

	lines := buf.lines(t)
	if len(lines) != 1 {
		t.Fatalf("got %d log lines, want 1", len(lines))
	}
	if _, ok := lines[0]["request_id"]; ok {
		t.Errorf("log line = %v, want no request_id without one in the context", lines[0])
	}
}

func TestContextHandlerWithAttrs(t *testing.T) {
	t.Parallel()
	logger, buf := newContextLogger(t, slog.LevelDebug)
	ctx, id := requestCtx(t)

	derived := logger.With("component", "caldav")
	derived.InfoContext(ctx, "derived")

	line := buf.lines(t)[0]
	if line["component"] != "caldav" || line["request_id"] != id {
		t.Errorf("log line = %v, want component and request_id %q", line, id)
	}
	if _, ok := derived.Handler().(*contextHandler); !ok {
		t.Errorf("With returned %T, want the context handler to stay in place", derived.Handler())
	}
}

// A group nests every attr that follows it, so the request ID of a record
// logged through WithGroup sits inside that group.
func TestContextHandlerWithGroup(t *testing.T) {
	t.Parallel()
	logger, buf := newContextLogger(t, slog.LevelDebug)
	ctx, id := requestCtx(t)

	grouped := logger.WithGroup("req")
	grouped.InfoContext(ctx, "grouped", "key", "value")

	group, ok := buf.lines(t)[0]["req"].(map[string]any)
	if !ok {
		t.Fatalf("log line = %s, want a req group", buf.String())
	}
	if group["request_id"] != id || group["key"] != "value" {
		t.Errorf("group = %v, want request_id %q and key", group, id)
	}
	if _, ok := grouped.Handler().(*contextHandler); !ok {
		t.Errorf("WithGroup returned %T, want the context handler to stay in place", grouped.Handler())
	}
}

func TestContextHandlerEnabled(t *testing.T) {
	t.Parallel()
	logger, buf := newContextLogger(t, slog.LevelInfo)
	ctx, _ := requestCtx(t)

	if logger.Enabled(ctx, slog.LevelDebug) {
		t.Error("debug is enabled although the wrapped handler is at info")
	}
	if !logger.Enabled(ctx, slog.LevelWarn) {
		t.Error("warn is disabled although the wrapped handler is at info")
	}
	logger.DebugContext(ctx, "hidden")
	if buf.String() != "" {
		t.Errorf("debug line written at info: %s", buf.String())
	}
}

// recordingHandler keeps the records it handles.
type recordingHandler struct {
	records []slog.Record
}

func (h *recordingHandler) Enabled(context.Context, slog.Level) bool { return true }
func (h *recordingHandler) WithAttrs([]slog.Attr) slog.Handler       { return h }
func (h *recordingHandler) WithGroup(string) slog.Handler            { return h }

func (h *recordingHandler) Handle(_ context.Context, r slog.Record) error {
	h.records = append(h.records, r)
	return nil
}

func requestIDOf(t *testing.T, r slog.Record) string {
	t.Helper()
	id := ""
	r.Attrs(func(a slog.Attr) bool {
		if a.Key == "request_id" {
			id = a.Value.String()
		}
		return true
	})
	return id
}

// A record has room for a few attributes inline and appends the rest to a
// slice that its copies share. Adding the request ID to a copy must not write
// into that slice, or the next handler of the same record finds it taken.
func TestContextHandlerLeavesTheCallersRecordAlone(t *testing.T) {
	t.Parallel()
	ctxA, idA := requestCtx(t)
	ctxB, idB := requestCtx(t)

	// Slice growth rounds capacities up, so whether the shared slice has room
	// left depends on the count: cover a range of counts beyond the inline ones.
	for n := 5; n <= 20; n++ {
		t.Run(strconv.Itoa(n)+" attrs", func(t *testing.T) {
			t.Parallel()
			rec := &recordingHandler{}
			h := NewContextHandler(rec)
			r := slog.NewRecord(time.Now(), slog.LevelInfo, "shared", 0)
			for i := range n {
				r.AddAttrs(slog.Int("n"+strconv.Itoa(i), i))
			}
			if err := h.Handle(ctxA, r); err != nil {
				t.Fatal(err)
			}
			if err := h.Handle(ctxB, r); err != nil {
				t.Fatal(err)
			}

			// slog marks a record that was modified through a copy with a "!BUG"
			// attribute, so the attribute count shows it.
			for i, got := range rec.records {
				if got.NumAttrs() != n+1 {
					t.Errorf("record %d has %d attrs, want %d: the caller's record was modified", i, got.NumAttrs(), n+1)
				}
			}
			if got := requestIDOf(t, rec.records[0]); got != idA {
				t.Errorf("first record request_id = %q, want %q", got, idA)
			}
			if got := requestIDOf(t, rec.records[1]); got != idB {
				t.Errorf("second record request_id = %q, want %q", got, idB)
			}
			if got := requestIDOf(t, r); got != "" {
				t.Errorf("caller's record request_id = %q, want none", got)
			}
		})
	}
}
