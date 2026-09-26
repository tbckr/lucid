# Contributing to Lucid

Thanks for your interest in Lucid! Bug reports, feature ideas and pull
requests are welcome.

## Language

**English first.** Code, comments, commit messages, issues, pull requests and
documentation are written in English so everybody can take part. UI strings
are translated through the i18n JSON files in `web/`.

## Getting started

See [Development](README.md#development) in the README. With Nix and direnv,
`direnv allow` loads a dev shell with every tool. In short:

```sh
just dev     # mock CalDAV server (demo/demo) + backend + Vite dev server
just test    # Go + frontend unit tests
just lint    # golangci-lint, ESLint, tsc
just cover   # Go coverage gate
just e2e     # Playwright
```

Please run `just lint test cover` before opening a pull request; CI runs the
same checks plus `govulncheck`, CodeQL and the E2E suite. Dependency scans run
separately, see [Updating dependencies](#updating-dependencies).

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
  (`just fmt`). `//nolint` requires a specific linter and an explanation.

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
  **at least 80 % statement coverage** (`just cover`). New code should come
  with tests; bug fixes with a regression test.
- **Frontend:** Vitest for logic and components, Playwright for critical user
  flows (`web/e2e`), run against `cmd/lucid-mockdav`.

## Pull requests

- Keep pull requests focused; one logical change per PR.
- Describe what changed and why, and how you tested it.
- Update `docs/API.md` when the REST API changes and the README when
  configuration changes.
- When `go.mod`/`go.sum` or `web/pnpm-lock.yaml` change, update `vendorHash`
  and `pnpmDeps.hash` in `nix/package.nix` with `just nix-hashes` (needs a
  machine that can run `nix build`).
- CI must be green before merge.

## Updating dependencies

There is no update bot for Go and npm dependencies. They are upgraded on the
project's own schedule, typically at the start of a release cycle:

```sh
just outdated     # direct dependencies with newer versions, platform versions
just upgrade      # upgrade direct dependencies and flake.lock
just nix-hashes   # recompute the hashes in nix/package.nix (needs nix build)
just lint test vuln
```

Commit the result as a single `deps:` commit.

**Only direct dependencies are upgraded.** A transitive dependency changes
only where an upgraded direct dependency requires it; keeping its own
dependencies current is that dependency's job. `just upgrade`
(`scripts/deps.sh`) runs `go get <module>@latest` for each direct module and
`pnpm update --depth 0`. Do not use `go get -u`, `pnpm update` without
`--depth 0`, `pnpm dedupe` or lockfile maintenance: they rewrite transitive
versions on their own.

**Major versions** are a manual step: a new module path in Go,
`pnpm --dir web update --latest <package>` in the frontend. They are not
urgent in themselves, but nothing may stay on a line that no longer gets
security fixes. `just outdated` lists what to review on every upgrade:

- the Go release in `go.mod`: only the two newest Go releases get fixes, and
  `latest-deps.yml` fails once ours drops out,
- the nixpkgs branch in `flake.nix` (supported for about seven months),
- Node.js in CI and `web/package.json`,
- the distroless base image in the `Dockerfile`,
- golangci-lint in `ci.yml` (pinned by hand).

**Automation:**

- `vuln.yml`, daily and whenever the dependency manifests change:
  `govulncheck` on `main` and on the latest release binary,
  `pnpm audit --prod` on the packages shipped in the bundle, and a check for
  known malware (CWE-506) in every frontend package, devDependencies
  included.
- The dependency review in `ci.yml`, on every pull request: vulnerabilities
  and licenses of the Go modules, npm packages and GitHub Actions it adds or
  updates. Only OSI-approved licenses pass, devDependencies included
  (`.github/dependency-review-config.yml`).
- `release.yml` runs the tests and the frontend build, the only steps that
  execute dependency code, in a job without write access; the job that
  signs and publishes only consumes the result.
- `latest-deps.yml`, weekly: tests against the newest direct dependencies,
  upgraded exactly like `just upgrade` does, inside a gVisor sandbox. It
  commits nothing; a failure means the next upgrade needs work.
- Dependabot only bumps the SHA-pinned GitHub Actions, monthly in one pull
  request.
- pnpm refuses versions younger than a day and versions whose publish
  provenance got weaker (`web/pnpm-workspace.yaml`).

**When a vulnerability scan fails**, treat the finding like a reported
vulnerability:

1. Assess the impact. `govulncheck` only reports code that is reachable; a
   finding in the release binary means users run vulnerable code. A standard
   library finding there only needs a new release, which picks up the latest
   Go patch release.
2. Fix it by upgrading the direct dependency. If the vulnerable package is
   transitive and no fixed version of the direct dependency exists yet, raise
   only that package, to the fixed version and not to the latest
   (`go get example.org/mod@vX.Y.Z`, or an `overrides` entry in
   `web/pnpm-workspace.yaml`), and report it upstream. This is the only
   exception to the rule above; drop an override once the direct dependency
   ships the fix.
3. If users are affected, cut a patch release and publish a GitHub Security
   Advisory (see [SECURITY.md](SECURITY.md)).
4. Only if the finding does not apply to Lucid: list it under `audit.ignore`
   in `web/pnpm-workspace.yaml`, with a comment explaining why.

**Malware** (the malware check in `vuln.yml` or `just vuln`) is an incident,
not an upgrade. Build and test tools run on developer machines and in CI, so
find out where the package ran before removing it:

1. Find out since when the version is in the lockfile
   (`git log -S '<package>@<version>' -- web/pnpm-lock.yaml`) and which
   machines installed it since. A version that only reached
   `latest-deps.yml` stayed inside its sandbox.
2. Rotate every credential those machines could reach: npm and GitHub
   tokens, SSH keys, cloud credentials.
3. Check the releases built since then. If one may be affected, publish a
   GitHub Security Advisory and cut a clean release.
4. Remove the version: upgrade or downgrade the direct dependency, or pin
   the transitive one to a clean version (the exception above).

**When the license check fails**, the dependency brings in a license that
is not on the list in `.github/dependency-review-config.yml`:

- If it is OSI-approved (the [SPDX license list](https://spdx.org/licenses/)
  marks these), add it to `allow-licenses` in the same pull request.
- If it is not, prefer another dependency. Exempt the package under
  `allow-dependencies-licenses` only for data or disclaimers that do not
  restrict use, with a comment naming the license and why it is fine.

## Security issues

Please do **not** open public issues for vulnerabilities — see
[SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contributions are licensed under the
[GPL-3.0](LICENSE).
