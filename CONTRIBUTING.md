# Contributing to Lucid

Thanks for your interest in Lucid! Bug reports, feature ideas and pull
requests are welcome.

## Language

**English first.** Code, comments, commit messages, issues, pull requests and
documentation are written in English so everybody can take part. UI strings
are translated through the i18n JSON files in `web/`.

## Getting started

See [Development](README.md#development) in the README. In short:

```sh
make dev     # mock CalDAV server (demo/demo) + backend + Vite dev server
make test    # Go + frontend unit tests
make lint    # golangci-lint, ESLint, tsc
make cover   # Go coverage gate
make e2e     # Playwright
```

Please run `make lint test cover` before opening a pull request; CI runs the
same checks plus `govulncheck`, `pnpm audit`, CodeQL and the E2E suite.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/). The
release changelog is generated from them.

```
<type>(<optional scope>): <summary in imperative mood>

<optional body: what and why>

<optional footer, e.g. "Fixes #42" or "BREAKING CHANGE: ...">
```

Types: `feat`, `fix`, `perf`, `refactor`, `security`, `docs`, `test`,
`build`, `ci`, `chore`, `deps`, `style`. Mark breaking changes with `!`
(`feat(api)!: ...`) and a `BREAKING CHANGE:` footer.

## Code guidelines

### Backend (Go)

- Standard library first (`net/http`, `http.ServeMux`, `log/slog`, ...). New
  dependencies need a good reason and should be discussed in an issue first.
- Dependency injection via small interfaces; no global state.
- Wrap errors with `%w`, compare with `errors.Is`/`errors.As`.
- Pass `context.Context` as the first parameter through every I/O path.
- Structured JSON logging with `log/slog`, snake_case keys. Never log
  credentials, session keys or tokens.
- Code must pass `golangci-lint run` with the repository configuration
  (`.golangci.yml`) and be formatted with `gofumpt`/`goimports`
  (`make fmt`). `//nolint` requires a specific linter and an explanation.

### Frontend (TypeScript/React)

- `pnpm` only; commit `web/pnpm-lock.yaml`, CI installs with
  `--frozen-lockfile`.
- Server state via TanStack Query, UI state via Zustand.
- No `dangerouslySetInnerHTML` without DOMPurify; no secrets or environment
  values in the bundle; no source maps in production builds.
- Every user-facing string goes through i18next.

## Tests

- **Go:** only the standard library `testing` package — no testify, gomega,
  go-cmp or mock generators (enforced by `depguard`). Write small hand-rolled
  fakes behind interfaces.
- Tests call `t.Parallel()` (enforced by `paralleltest`/`tparallel`) and must
  not depend on external services, databases or a real CalDAV server; use
  `internal/caldav/caldavtest` and `net/http/httptest`.
- Helpers call `t.Helper()`.
- Business-logic packages (`internal/...`, excluding test helpers) must keep
  **at least 80 % statement coverage** (`make cover`). New code should come
  with tests; bug fixes with a regression test.
- **Frontend:** Vitest for logic and components, Playwright for critical user
  flows (`web/e2e`), run against `cmd/lucid-mockdav`.

## Pull requests

- Keep pull requests focused; one logical change per PR.
- Describe what changed and why, and how you tested it.
- Update `docs/API.md` when the REST API changes and the README when
  configuration changes.
- CI must be green before merge.

## Security issues

Please do **not** open public issues for vulnerabilities — see
[SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contributions are licensed under the
[GPL-3.0](LICENSE).
