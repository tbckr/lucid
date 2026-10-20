package middleware

import (
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
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
