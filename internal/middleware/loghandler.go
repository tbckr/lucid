package middleware

import (
	"context"
	"log/slog"
)

// RequestIDAttr is the log attribute that carries the request ID (NFR-23).
const RequestIDAttr = "request_id"

// contextHandler adds the request ID of the log call's context to every
// record (NFR-23), so that all lines of one request can be found by that ID.
type contextHandler struct {
	inner slog.Handler
}

// NewContextHandler wraps h so that every record logged with a context from
// RequestContext (logger.XxxContext(r.Context(), ...)) gets a request_id
// attribute. A record without a request ID in its context, such as a start-up
// line, gets none.
//
// A record that passes its own request_id attribute to the log call keeps it,
// and the handler adds none, so the key appears once. The handler only sees
// the attributes of the record, though: a request_id attached earlier with
// With is not detected, and the key would then appear twice.
//
// slog nests a record's attributes in the groups opened by WithGroup, which
// includes the added request_id.
func NewContextHandler(h slog.Handler) slog.Handler {
	return &contextHandler{inner: h}
}

func (c *contextHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return c.inner.Enabled(ctx, level)
}

func (c *contextHandler) Handle(ctx context.Context, r slog.Record) error {
	if id := RequestID(ctx); id != "" && !hasAttr(r, RequestIDAttr) {
		// Records share their attribute storage with their copies, so adding
		// to the one slog passed in could change the caller's.
		r = r.Clone()
		r.AddAttrs(slog.String(RequestIDAttr, id))
	}
	return c.inner.Handle(ctx, r)
}

func (c *contextHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return &contextHandler{inner: c.inner.WithAttrs(attrs)}
}

func (c *contextHandler) WithGroup(name string) slog.Handler {
	return &contextHandler{inner: c.inner.WithGroup(name)}
}

// hasAttr reports whether r carries a top-level attribute named key.
func hasAttr(r slog.Record, key string) bool {
	found := false
	r.Attrs(func(a slog.Attr) bool {
		found = a.Key == key
		return !found
	})
	return found
}
