package middleware

import (
	"context"
	"log/slog"
)

// requestIDKey is the log attribute that carries the request ID.
const requestIDKey = "request_id"

// contextHandler adds the request ID of the log call's context to every
// record (NFR-23), so that all lines of one request can be found by that ID.
type contextHandler struct {
	inner slog.Handler
}

// NewContextHandler wraps h so that every record logged with a context from
// RequestContext (logger.XxxContext(r.Context(), ...)) gets a request_id
// attribute. Records that already carry a request_id attribute keep theirs, so
// it never appears twice, and so do records without a request ID in their
// context, such as the start-up lines.
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
	if id := RequestID(ctx); id != "" && !hasAttr(r, requestIDKey) {
		r.AddAttrs(slog.String(requestIDKey, id))
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
