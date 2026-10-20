package diag

import "context"

// Scope is what a request carries for diagnostics: the Buffer of the session
// it belongs to and the ID that ties its log lines, exchanges and problems
// together (FR-36). Buffer is nil for a request without a session.
type Scope struct {
	Buffer    *Buffer
	RequestID string
}

type scopeKey struct{}

// WithScope returns a context that carries s.
func WithScope(ctx context.Context, s Scope) context.Context {
	return context.WithValue(ctx, scopeKey{}, s)
}

// ScopeFrom returns the Scope that WithScope put into ctx, and false if there
// is none.
func ScopeFrom(ctx context.Context) (Scope, bool) {
	s, ok := ctx.Value(scopeKey{}).(Scope)
	return s, ok
}
