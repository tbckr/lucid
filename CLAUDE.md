# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Lucid is a modern CalDAV web client acting as a Smart Proxy. It does not store data permanently—the CalDAV server remains the source of truth. The backend (Go) resolves CORS and abstracts CalDAV complexity; the frontend (React) provides high-fidelity UX.

## Architecture

**Backend (Go)**: Stdlib-first approach using `net/http` with Go 1.22+ routing. Stateless logic with in-memory cache (thread-safe). Single binary deployment embedding frontend via `embed.FS`.

**Frontend (React 19 SPA)**: Vite + pnpm, Tailwind CSS, shadcn/ui, TanStack Query (server state), Zustand (UI state), i18next for i18n.

**Allowed Go dependencies**: `github.com/emersion/go-webdav`, `github.com/prometheus/client_golang`, `github.com/stretchr/testify` (testing).

## Development Commands

```bash
# Backend
go build -o bin/lucid ./cmd/lucid
go test -race -cover ./...
go test -race -coverprofile=coverage.out -covermode=atomic ./...
golangci-lint run

# Frontend
pnpm install --frozen-lockfile
pnpm dev
pnpm build
pnpm test
pnpm lint

# Single test file/function
go test -v -run TestFunctionName ./path/to/package
```

## Code Standards

### Go Patterns (Mandatory)

**The run function pattern**: `main()` must be ultra-simple—context, logging, call `run()`, exit. All deps injected into `run()`.

```go
func run(ctx context.Context, args []string, getenv func(string) string,
    stdin io.Reader, stdout, stderr io.Writer,
    logger *slog.Logger, levelVar *slog.LevelVar) error
```

**No globals**: No package-level variables, no `init()` for flags. Use constructors like `NewRootCmd(logger, levelVar)`.

**HTTP services**: Mat Ryer pattern—server struct with router, handlers return `http.HandlerFunc` closures, one-time setup outside closure, per-request logic inside.

**Interfaces**: Accept interfaces, return structs. Define small interfaces (1-3 methods) where used, not with implementation.

**Error handling**: Wrap with `fmt.Errorf("context: %w", err)`. Use guard clauses, never nested else blocks.

**Modern Go (1.21+)**: Use `any`, `slices`/`maps` packages, `min`/`max`, `log/slog`.

### Testing Requirements

- **Black-box testing**: Tests in `package foo_test`, not `package foo`
- **Table-driven tests**: Standard pattern with named test cases
- **80% coverage mandatory**: `go tool cover -func=coverage.out | grep total`
- **Use `t.Parallel()`** for concurrency tests
- No external CalDAV server required for tests

### Commits

Conventional Commits strictly: `fix:`, `feat:`, `build:`, `chore:`, `ci:`, `docs:`, `style:`, `refactor:`, `perf:`, `test:`

## Agent Persona

- Simplicity over cleverness. Readability is the most important metric.
- YAGNI: Don't implement features "just in case".
- First principles over bandaids. Find root causes.
- No breadcrumbs: Don't leave `// moved to X` comments. Delete dead code.
- Concise communication. Don't explain basic syntax. Explain *why*, not *what*.
- English for all code comments, commits, and documentation.
