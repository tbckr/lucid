# Lucid

[![CI](https://github.com/tbckr/lucid/actions/workflows/ci.yml/badge.svg)](https://github.com/tbckr/lucid/actions/workflows/ci.yml)
[![CodeQL](https://github.com/tbckr/lucid/actions/workflows/codeql.yml/badge.svg)](https://github.com/tbckr/lucid/actions/workflows/codeql.yml)
[![License: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-blue.svg)](LICENSE)

**Lucid is a modern, self-hostable web client for your CalDAV calendars and
tasks** — Google-Calendar-like usability on top of the server you already
have (Nextcloud, Synology, Radicale, Baïkal, iCloud, ...).

Lucid is a *smart proxy*: a single Go binary with the React frontend embedded.
It talks CalDAV to your server and JSON to your browser. It has no database —
your CalDAV server stays the single source of truth, Lucid only keeps a
short-lived in-memory cache.

<!-- TODO: replace with a real screenshot -->
![Lucid screenshot](docs/screenshot.png)

## Features

- **Calendars (VEVENT):** month, week, day and agenda views; create, edit,
  delete; drag & drop with optimistic updates; all-day and timed events;
  per-calendar colors and show/hide toggles.
- **Tasks (VTODO):** task sidebar with checklists, due dates, priorities and
  completion.
- **Recurring events:** RRULEs are expanded server-side for the visible range.
- **Time zones:** stored in UTC, displayed in your local time zone.
- **Auto-discovery:** enter a bare domain; Lucid tries `/.well-known/caldav`
  and DNS SRV records.
- **Fast:** CTag-based caching answers repeated requests from memory.
- **i18n & l10n:** English by default; date/time formats follow your browser
  locale and can be overridden in the settings.
- **Accessible:** full keyboard navigation (WCAG 2.1 AA target).
- **Operations-friendly:** single static binary or distroless container,
  JSON logs, Prometheus metrics, liveness/readiness endpoints.

## Quick start

> **TLS is mandatory in production.** Lucid sets `Secure` session cookies and
> handles your CalDAV credentials. Run it behind a TLS-terminating reverse
> proxy (Caddy, Traefik, nginx, ...) or let it serve HTTPS itself via
> `LUCID_TLS_CERT` / `LUCID_TLS_KEY`.

### Docker Compose (recommended)

The repository contains a hardened example [`compose.yaml`](compose.yaml)
(read-only root filesystem, all capabilities dropped, non-root user,
`no-new-privileges`), bound to `127.0.0.1:8080` for your reverse proxy:

```sh
curl -fsSLO https://raw.githubusercontent.com/tbckr/lucid/main/compose.yaml
echo "LUCID_SESSION_KEY=$(openssl rand -base64 32)" > lucid.env
chmod 600 lucid.env
docker compose up -d
```

Minimal Caddy configuration:

```caddyfile
calendar.example.com {
	reverse_proxy 127.0.0.1:8080
}
```

### Docker

```sh
docker run -d --name lucid \
  -p 127.0.0.1:8080:8080 \
  --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  -e LUCID_SESSION_KEY="$(openssl rand -base64 32)" \
  ghcr.io/tbckr/lucid:latest
```

Images are published for `linux/amd64` and `linux/arm64`, based on
`gcr.io/distroless/static` and running as UID/GID `65532`.

### Binary

Download the archive for your platform from the
[releases page](https://github.com/tbckr/lucid/releases)
(Linux, macOS, Windows; amd64 and arm64), verify it (see
[Verifying releases](#verifying-releases)) and run:

```sh
LUCID_SESSION_KEY="$(openssl rand -base64 32)" ./lucid
./lucid --version
```

Health endpoints: `GET /healthz` (liveness), `GET /readyz` (readiness).
`lucid healthcheck` probes the local instance and exits non-zero on failure
(used by the container `HEALTHCHECK`, since distroless has no shell or curl).

### NixOS

The repository is a Nix flake with the package, an overlay and a NixOS module.
`services.lucid` runs Lucid as a hardened systemd service with a dynamic user,
listening on `127.0.0.1:8080` for your reverse proxy:

```nix
{
  inputs.lucid.url = "github:tbckr/lucid";

  outputs =
    { nixpkgs, lucid, ... }:
    {
      nixosConfigurations.myhost = nixpkgs.lib.nixosSystem {
        system = "x86_64-linux";
        modules = [
          lucid.nixosModules.default
          {
            services.lucid = {
              enable = true;
              settings.LUCID_TRUST_PROXY_HEADERS = true;
              # Contains LUCID_SESSION_KEY=..., readable by root only.
              environmentFile = "/run/secrets/lucid.env";
            };
          }
        ];
      };
    };
}
```

`settings` takes any variable from [Configuration](#configuration). Its values
end up in the world-readable Nix store, so secrets belong in `environmentFile`.
To try Lucid without installing it: `nix run github:tbckr/lucid`.

## Configuration

Lucid is configured exclusively through environment variables (secrets never
live in files or flags).

| Variable | Default | Description |
|----------|---------|-------------|
| `LUCID_ADDR` | `:8080` | Listen address |
| `LUCID_METRICS_ADDR` | (empty) | If set, `/metrics` is served only on this address instead of `LUCID_ADDR` |
| `LUCID_TLS_CERT`, `LUCID_TLS_KEY` | (empty) | Serve HTTPS directly. Otherwise TLS must be terminated by a reverse proxy |
| `LUCID_SESSION_KEY` | random | 32-byte key (base64 or hex) encrypting credentials in sessions. Random per start if unset (sessions are in-memory anyway) |
| `LUCID_SESSION_TTL` | `12h` | Absolute session lifetime |
| `LUCID_SESSION_IDLE_TIMEOUT` | `2h` | Idle timeout |
| `LUCID_COOKIE_INSECURE` | `false` | Drop the `Secure` cookie flag (local HTTP development only) |
| `LUCID_ALLOW_PRIVATE_NETWORKS` | `false` | Allow CalDAV servers on private/loopback addresses (self-hosting on a LAN) |
| `LUCID_ALLOWED_CIDRS` | (empty) | Comma-separated CIDRs exempted from SSRF blocking, e.g. `192.168.1.10/32` |
| `LUCID_RATE_LIMIT_RPS` | `20` | Token bucket refill per client IP (API) |
| `LUCID_RATE_LIMIT_BURST` | `60` | Token bucket size |
| `LUCID_LOGIN_RATE_LIMIT_PER_MIN` | `10` | Login attempts per client IP per minute |
| `LUCID_TRUST_PROXY_HEADERS` | `false` | Use `X-Forwarded-For` for client IP (only behind a trusted proxy) |
| `LUCID_CACHE_SIZE` | `256` | Cached calendars (LRU) |
| `LUCID_CACHE_FRESHNESS` | `10s` | Serve cache without CTag check for this long |
| `LUCID_UPSTREAM_TIMEOUT` | `20s` | Timeout for requests to CalDAV servers |
| `LUCID_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` (JSON logs to stdout) |

Durations use Go syntax (`90s`, `15m`, `12h`). The REST API is documented in
[docs/API.md](docs/API.md).

### Reverse proxy notes

- Terminate TLS at the proxy and forward plain HTTP to Lucid on a private
  interface (e.g. `127.0.0.1:8080`). Never expose the plain-HTTP port publicly.
- Set `LUCID_TRUST_PROXY_HEADERS=true` **only** if Lucid is reachable
  exclusively through the proxy; otherwise clients can spoof
  `X-Forwarded-For` and evade rate limiting.
- If your CalDAV server runs on your LAN, allow it narrowly with
  `LUCID_ALLOWED_CIDRS` rather than `LUCID_ALLOW_PRIVATE_NETWORKS`.
- Expose `/metrics` on a separate, internal address via `LUCID_METRICS_ADDR`.

## Security model

- **Proxy architecture.** The browser only talks to Lucid; Lucid talks to the
  CalDAV server. This avoids CORS problems and keeps CalDAV credentials out of
  the browser: after login the frontend only holds an opaque session cookie
  (`HttpOnly`, `Secure`, `SameSite=Strict`).
- **Encrypted in-memory sessions.** Credentials are stored server-side,
  encrypted with AES-256-GCM using `LUCID_SESSION_KEY`, and only in RAM.
  Nothing is written to disk.
- **SSRF protection.** Because users choose the server URL, every outgoing
  request (including auto-discovery and redirects) goes through a safe
  transport that refuses loopback, private, link-local and other internal
  address ranges unless explicitly allowed.
- **Web hardening.** CSRF synchronizer tokens on all state-changing requests,
  token-bucket rate limiting (stricter for login), strict security headers
  (CSP, HSTS, `X-Frame-Options`, `X-Content-Type-Options`), XML entity
  protection, input validation, open-redirect protection, no source maps in
  production builds.
- **Supply chain.** Signed releases and images (cosign keyless), SBOMs,
  CI actions pinned to commit SHAs, daily `govulncheck` (also against the
  latest release binary) and `pnpm audit` of the shipped packages, weekly CI
  against the newest direct dependencies, CodeQL and container scanning.

**Known limitation:** sessions live only in memory, so restarting Lucid logs
everybody out. Setting a fixed `LUCID_SESSION_KEY` does not change that; it is
recommended anyway so the key is managed like any other secret.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Development

Requirements: Go (version from [`go.mod`](go.mod)), Node.js 22+ and
[pnpm](https://pnpm.io/) (version pinned in `web/package.json`,
`corepack enable` picks it up), [just](https://just.systems/) 1.42+, optionally
[golangci-lint v2](https://golangci-lint.run/) and
[GoReleaser v2](https://goreleaser.com/).

With [Nix](https://nixos.org/), `nix develop` provides all of these (plus
Chromium for Playwright on Linux). With [direnv](https://direnv.net/) (ideally
[nix-direnv](https://github.com/nix-community/nix-direnv)), `direnv allow`
loads the dev shell whenever you enter the repository.

```sh
just dev
```

starts three processes:

1. `cmd/lucid-mockdav` — an in-memory CalDAV server with demo data on
   `http://127.0.0.1:5232` (username `demo`, password `demo`),
2. the Lucid backend on `127.0.0.1:8080` in development mode
   (`LUCID_COOKIE_INSECURE=true`, `LUCID_ALLOW_PRIVATE_NETWORKS=true`),
3. the Vite dev server with hot reload on `http://localhost:5173`, proxying
   `/api` to the backend.

Open <http://localhost:5173> and log in with server URL
`http://127.0.0.1:5232`, user `demo` and password `demo`. The recipes can also be run separately:
`just mockdav`, `just dev-backend`, `just dev-web`.

Other useful recipes (`just` lists all):

| Recipe | Description |
|--------|-------------|
| `just build` | Frontend + single binary with embedded frontend in `bin/lucid` |
| `just build-go` | Go binary only (embeds whatever is in `web/dist`) |
| `just test` | Go tests (race detector) and Vitest unit tests |
| `just cover` | Go coverage with the 80 % business-logic gate |
| `just lint` | golangci-lint, ESLint and TypeScript type check |
| `just vuln` | `govulncheck` and `pnpm audit` of the shipped packages |
| `just outdated` | Direct dependencies with newer versions, platform versions to review |
| `just upgrade` | Upgrade direct dependencies (see [CONTRIBUTING.md](CONTRIBUTING.md#updating-dependencies)) |
| `just e2e` | Playwright end-to-end tests against the mock server |
| `just snapshot` | Local GoReleaser build of all binaries and images |
| `just clean` | Remove build output |

`web/dist/.gitkeep` is committed so that `go build ./...` works without a
frontend build; the binary then serves a placeholder page.

### Testing

- Go tests use only the standard library `testing` package, run in parallel
  (`t.Parallel()`) and need no external services — the CalDAV server is faked
  with `internal/caldav/caldavtest`.
- Business-logic packages (`internal/...`) must keep **≥ 80 % statement
  coverage**; CI enforces this with
  [`scripts/coverage-gate.sh`](scripts/coverage-gate.sh).
- Frontend unit tests use Vitest, end-to-end tests use Playwright.

See [CONTRIBUTING.md](CONTRIBUTING.md) for conventions.

## Releases

Releases follow [Semantic Versioning](https://semver.org/). Pushing a tag
`vX.Y.Z` runs [GoReleaser](https://goreleaser.com/) in GitHub Actions, which
publishes:

- archives for Linux, macOS and Windows (amd64/arm64) with SPDX SBOMs,
- `checksums.txt` signed with [cosign](https://github.com/sigstore/cosign)
  (keyless, GitHub OIDC) — bundle `checksums.txt.sigstore.json`,
- multi-arch images `ghcr.io/tbckr/lucid:X.Y.Z` (plus `X.Y`, `X`, `latest`),
  signed with cosign and carrying an SBOM attestation,
- GitHub build-provenance attestations for archives and images.

### Verifying releases

```sh
VERSION=1.2.3   # without the leading "v"
IDENTITY='^https://github\.com/tbckr/lucid/\.github/workflows/release\.yml@refs/tags/v'
ISSUER=https://token.actions.githubusercontent.com

# 1. Verify the signed checksum file, then the archive against it
cosign verify-blob \
  --bundle checksums.txt.sigstore.json \
  --certificate-identity-regexp "$IDENTITY" \
  --certificate-oidc-issuer "$ISSUER" \
  checksums.txt
sha256sum --ignore-missing -c checksums.txt

# 2. Verify the container image signature
cosign verify "ghcr.io/tbckr/lucid:${VERSION}" \
  --certificate-identity-regexp "$IDENTITY" \
  --certificate-oidc-issuer "$ISSUER"

# 3. Optional: verify GitHub build provenance
gh attestation verify "lucid_${VERSION}_linux_amd64.tar.gz" --repo tbckr/lucid
gh attestation verify "oci://ghcr.io/tbckr/lucid:${VERSION}" --repo tbckr/lucid
```

## License

Lucid is free software licensed under the
[GNU General Public License v3.0](LICENSE).
