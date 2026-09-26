# Lucid developer tasks. Run `just` for an overview.

set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

BIN := env('BIN', 'bin/lucid')
PNPM := env('PNPM', 'pnpm')
GO := env('GO', 'go')
GOLANGCI_LINT := env('GOLANGCI_LINT', 'golangci-lint')
GORELEASER := env('GORELEASER', 'goreleaser')

VERSION := env('VERSION', `git describe --tags --always --dirty 2>/dev/null || echo dev`)
COMMIT := env('COMMIT', `git rev-parse HEAD 2>/dev/null || echo none`)
DATE := env('DATE', datetime_utc('%Y-%m-%dT%H:%M:%SZ'))
LDFLAGS := '-s -w -X main.version=' + VERSION + ' -X main.commit=' + COMMIT + ' -X main.date=' + DATE

COVERAGE_OUT := env('COVERAGE_OUT', 'coverage.out')
# The race detector needs cgo and a C compiler; use `just RACE= test` without.
RACE := env('RACE', '-race')

# Local development (just dev)
LUCID_DEV_ADDR := env('LUCID_DEV_ADDR', '127.0.0.1:8080')
MOCKDAV_ADDR := env('MOCKDAV_ADDR', '127.0.0.1:5232')

# Show this help
help:
    @{{ just_executable() }} --justfile {{ justfile() }} --list --unsorted

# Install frontend dependencies (frozen lockfile)
[group('build')]
web-deps:
    {{ PNPM }} --dir web install --frozen-lockfile

# Build the frontend into web/dist
[group('build')]
web: web-deps
    {{ PNPM }} --dir web build
    @touch web/dist/.gitkeep

# Build the single binary with the embedded frontend (bin/lucid)
[group('build')]
build: web build-go

# Build only the Go binary (embeds whatever is in web/dist)
[group('build')]
build-go:
    CGO_ENABLED=0 {{ GO }} build -trimpath -ldflags '{{ LDFLAGS }}' -o {{ BIN }} ./cmd/lucid

# Run all unit tests
[group('quality')]
test: test-go test-web

# Run Go tests with the race detector
[group('quality')]
test-go:
    {{ GO }} test {{ RACE }} -shuffle=on ./...

# Run frontend unit tests (Vitest)
[group('quality')]
test-web: web-deps
    {{ PNPM }} --dir web test

# Go coverage + gate (>= 80% business logic)
[group('quality')]
cover:
    {{ GO }} test {{ RACE }} -covermode=atomic -coverprofile={{ COVERAGE_OUT }} ./...
    scripts/coverage-gate.sh {{ COVERAGE_OUT }}

# Open the Go coverage report in a browser
[group('quality')]
cover-html: cover
    {{ GO }} tool cover -html={{ COVERAGE_OUT }}

# Run all linters and the TypeScript type check
[group('quality')]
lint: lint-go lint-web

# Run golangci-lint
[group('quality')]
lint-go:
    {{ GOLANGCI_LINT }} run ./...

# Run ESLint and tsc
[group('quality')]
lint-web: web-deps
    {{ PNPM }} --dir web lint
    {{ PNPM }} --dir web typecheck

# Format Go code (gofumpt + goimports via golangci-lint)
[group('quality')]
fmt:
    {{ GOLANGCI_LINT }} fmt ./...

# Scan for known vulnerabilities (reachable Go code, shipped frontend packages) and malware
[group('quality')]
vuln:
    {{ GO }} run golang.org/x/vuln/cmd/govulncheck@latest ./...
    {{ PNPM }} --dir web audit --prod
    scripts/deps.sh malware

# Run Playwright end-to-end tests
[group('quality')]
e2e: web-deps
    {{ PNPM }} --dir web e2e

# Show direct dependencies with newer versions (majors too) and platform versions
[group('deps')]
outdated:
    scripts/deps.sh outdated

# Upgrade direct dependencies and flake.lock; transitive ones move only where required
[group('deps')]
upgrade:
    scripts/deps.sh upgrade
    @echo "Next: just nix-hashes (needs nix build), then just lint test vuln."

# Recompute vendorHash and pnpmDeps.hash in nix/package.nix (needs nix build)
[group('deps')]
nix-hashes:
    scripts/deps.sh nix-hashes

# Run the mock CalDAV server (login demo/demo)
[group('run')]
mockdav:
    LUCID_MOCKDAV_ADDR={{ MOCKDAV_ADDR }} {{ GO }} run ./cmd/lucid-mockdav

# Run the backend for local HTTP development
[group('run')]
dev-backend:
    LUCID_ADDR={{ LUCID_DEV_ADDR }} \
    LUCID_COOKIE_INSECURE=true \
    LUCID_ALLOW_PRIVATE_NETWORKS=true \
    LUCID_LOG_LEVEL=debug \
    {{ GO }} run ./cmd/lucid

# Run the Vite dev server (proxies /api to the backend)
[group('run')]
dev-web: web-deps
    {{ PNPM }} --dir web dev

# Run mockdav + backend + Vite dev server together (Ctrl-C stops all)
[group('run')]
[parallel]
dev: _dev-hint mockdav dev-backend dev-web

_dev-hint:
    @echo "Open http://localhost:5173 and log in with server http://{{ MOCKDAV_ADDR }}, user demo, password demo."

# Local GoReleaser snapshot (binaries + images, no publish/sign)
[group('release')]
snapshot:
    {{ GORELEASER }} release --snapshot --clean --skip=sign,sbom

# Validate the GoReleaser configuration
[group('release')]
release-check:
    {{ GORELEASER }} check

# Remove build output (keeps web/dist/.gitkeep)
[group('release')]
clean:
    rm -rf bin dist {{ COVERAGE_OUT }} web/coverage web/playwright-report web/test-results
    find web/dist -mindepth 1 ! -name .gitkeep -delete 2>/dev/null || true
    @mkdir -p web/dist && touch web/dist/.gitkeep
