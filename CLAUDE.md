# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Lucid is a self-hostable CalDAV web client. It is a single Go binary that embeds a React SPA and acts as a *smart proxy*: the browser speaks JSON to Lucid, and Lucid speaks CalDAV (WebDAV/XML/iCalendar) to the user's server. There is no database. The CalDAV server is the source of truth, and Lucid only keeps in-memory sessions and an in-memory object cache.

## Commands

All tasks go through `just` (run `just` to list them). The frontend lives in `web/` and uses pnpm only.

```sh
just dev            # mockdav (127.0.0.1:5232, demo/demo) + backend (:8080) + Vite (:5173, proxies /api)
just test           # go test -race -shuffle=on ./... + vitest
just RACE= test     # without the race detector (needed when cgo / a C compiler is unavailable)
just lint           # golangci-lint + eslint --max-warnings=0 + tsc
just fmt            # gofumpt + goimports via golangci-lint
just cover          # Go coverage + scripts/coverage-gate.sh (>= 80 % over internal/...)
just e2e            # Playwright
just build          # web/dist + bin/lucid with embedded SPA
```

Before a PR, run `just lint test cover`. CI also runs `go mod tidy -diff`, `govulncheck`, `pnpm audit`, CodeQL, E2E, and a check that fails the build if `web/dist` contains source maps.

Single tests:

```sh
go test -run 'TestLRU$' ./internal/cache/                  # one Go test (add -race if cgo works)
go test -run 'TestName/subtest' ./internal/caldav/
pnpm --dir web test src/lib/dates.test.ts                  # one Vitest file
pnpm --dir web test -t 'test name'                         # Vitest by name
pnpm --dir web e2e e2e/login.spec.ts                       # one Playwright spec
```

Playwright (`web/playwright.config.ts`) starts its own servers: `go run ./cmd/lucid-mockdav`, plus `pnpm run build && go run ./cmd/lucid` on :8080. Outside CI it reuses servers that are already running. Specs run serially because the mock keeps state. On NixOS, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to a system Chromium.

Vitest sets `TZ=Europe/Berlin`, a zone with DST, so date tests are deterministic. `src/lib/**` has its own 80 % coverage threshold (`pnpm --dir web test:coverage`).

## Architecture

### Backend request path

`cmd/lucid/main.go` wires everything: `config.Load(getenv)` → `safehttp` client → `caldav.Provider` → `session.Store` → `httpapi.Server`. The middleware chain is built in `internal/httpapi/server.go`:

RequestContext (must stay outermost) → Observe (logs/metrics) → SecurityHeaders → Recover → BodyLimit → RateLimit (API only) → CSRF → `http.ServeMux` (Go 1.22 method+path patterns).

- **`internal/domain`** holds the shared types, the `Provider` and `CalendarService` interfaces, and the sentinel errors (`ErrNotFound`, `ErrConflict`, `ErrForbiddenTarget`, ...). It depends on neither side, so `httpapi` and `caldav` are tested independently of each other. `httpapi` tests use hand-written fakes (`harness_test.go`), and `caldav` tests use `caldavtest`.
- **`internal/httpapi/errors.go`** (`writeError`) is the single place that maps domain errors to HTTP status codes and API error codes. Implementations should return wrapped sentinels (`fmt.Errorf("%w: ...", domain.ErrX)`) and never write status codes themselves.
- **Per-request service:** a handler resolves the session cookie → `sessions.Account(id)`, which decrypts the stored credentials → `provider.Service(acct)`. Creating a service is cheap because shared state (HTTP client, LRU cache, metrics) lives on the `Provider`. If a request hits `ErrUnauthorized` upstream, the session is destroyed.
- **`internal/caldav`** has its own small WebDAV client on `net/http` + `encoding/xml`; it does *not* use go-webdav's client. Parsing uses `go-ical`, and recurrence uses `rrule-go`. `time/tzdata` is embedded.
  - **IDs** (`ids.go`) are the base64url-encoded resource paths. On decode they are validated to be a direct child of the account's calendar home, which is what blocks path traversal through crafted IDs.
  - **Cache** (`service.go`): the LRU is keyed by origin + username + calendar path + component. Within `CacheFreshness` it serves entries without checking upstream. After that it revalidates via `getctag`, falling back to `sync-token`. Every write invalidates the calendar's entries.
  - **Recurring events** are expanded server-side for the requested window. Expansion is capped per series (`events.go`), and the API window is capped at 366 days. Each occurrence shares `id`/`etag` with its series and is identified by `key`. A `PUT` with `instanceStart` edits the *whole series*, shifted by `start - instanceStart`.
  - **VTODO checklists** are stored as Markdown task lines (`- [ ] ...`) appended to `DESCRIPTION`, so other clients can still read them.
- **`internal/safehttp`** implements SSRF protection at dial time (`net.Dialer.Control`), checking the already-resolved IP. That covers DNS rebinding, SRV targets and redirects. The transport deliberately ignores HTTP proxies. All outgoing CalDAV traffic, including discovery, must go through this client.
- **`internal/session`** keeps sessions in memory only. Credentials are encrypted with AES-GCM, with the session ID as AAD, and the map is keyed by SHA-256(ID). `GET /api/v1/session` creates an anonymous session so the login request can carry a CSRF token. Login rotates the session ID.
- **`internal/caldav/caldavtest`** is an in-memory CalDAV server built on go-webdav's `caldav.Handler`. It supports ctag, sync-token, ETags/preconditions and read-only calendars, and counts requests per method so tests can assert cache behavior. `cmd/lucid-mockdav` seeds it with demo data for `just dev` and E2E. It is excluded from the coverage gate.
- **`web/embed.go`** embeds `web/dist` via `//go:embed all:dist`. `web/dist/.gitkeep` is committed, and a Vite plugin recreates it after each build, so `go build ./...` works without a frontend build and then serves a placeholder page. `httpapi/spa.go` falls back to `index.html` for unknown non-asset paths.

### Frontend (`web/src`)

- The server/client state split is strict. TanStack Query (`hooks/queries.ts`, `queryKeys`) holds server state, and Zustand holds UI state: `stores/ui.ts` is ephemeral, and `stores/settings.ts` is persisted user preferences such as hidden calendars, theme and language.
- `lib/api/client.ts` implements the API conventions. It keeps the CSRF token in memory, sends `If-Match` from the item's `etag`, parses the error envelope, retries once after `csrf_invalid`, and emits an `onUnauthenticated` hook that `App.tsx` uses to redirect to `/login`.
- `lib/api/schemas.ts` validates list responses **item by item** with Zod. Items that fail become `CorruptedItem` placeholders that the UI renders, instead of failing the whole calendar.
- Routing is a tiny `useSyncExternalStore` router (`lib/router.ts`) with only two screens, login and calendar, both lazy-loaded. There is no router library.
- Most logic lives as pure, tested functions in `lib/` (dates, rrule, forms, dnd, layout). Components in `components/ui/` are shadcn/ui (new-york, Radix). Use the `@/` import alias for `src/`.
- Every user-facing string goes through i18next. Add new keys to both `i18n/locales/en.json` and `de.json`.
- Only `LUCID_PUBLIC_*` env vars can reach the bundle, and production builds have no source maps.

## Changes that span several files

- **REST API change:** update `internal/domain/domain.go` (the JSON types), `internal/httpapi`, `docs/API.md` (the contract), and `web/src/lib/api/schemas.ts` + `endpoints.ts`. For a new error code, also update the `ApiErrorCode` union / `KNOWN_CODES` in `client.ts`.
- **New `LUCID_*` setting:** update `internal/config/config.go` and the configuration tables in both `README.md` and `docs/API.md`.

## Conventions

- Stdlib first (`net/http`, `ServeMux`, `log/slog`). New Go dependencies need a good reason. Use dependency injection through small interfaces, with no global state. Pass `context.Context` as the first parameter on every I/O path.
- **Go tests** use only the standard library `testing` package. `depguard` rejects testify, go-cmp, gomock and similar. Use hand-rolled fakes and `net/http/httptest`. Every test and subtest calls `t.Parallel()` (enforced by `paralleltest`/`tparallel`), helpers call `t.Helper()`, and tests never touch external services.
- `//nolint` must name a specific linter and give an explanation (`nolintlint`). Use `slog` with snake_case keys, and never log credentials, tokens or session keys. `math/rand` and `io/ioutil` are banned.
- Code comments cite requirement IDs from `docs/PRD.md` (`FR-xx`, `NFR-xx`). Keep them when touching the related code.
- Everything is written in English. Commits follow Conventional Commits; see `CONTRIBUTING.md` for the allowed types, which include `security` and `deps`. The release changelog is generated from them.
