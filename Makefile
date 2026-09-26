# Lucid developer tasks. Run `make help` for an overview.

SHELL        := bash
.SHELLFLAGS  := -eu -o pipefail -c
.DEFAULT_GOAL := help

BIN          ?= bin/lucid
PNPM         ?= pnpm
GO           ?= go
GOLANGCI_LINT ?= golangci-lint
GORELEASER   ?= goreleaser

VERSION      ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
COMMIT       ?= $(shell git rev-parse HEAD 2>/dev/null || echo none)
DATE         ?= $(shell date -u +%Y-%m-%dT%H:%M:%SZ)
LDFLAGS      := -s -w -X main.version=$(VERSION) -X main.commit=$(COMMIT) -X main.date=$(DATE)

# renovate: datasource=go depName=golang.org/x/vuln
GOVULNCHECK_VERSION ?= v1.1.4

COVERAGE_OUT ?= coverage.out
# The race detector needs cgo and a C compiler; use `make test RACE=` without.
RACE         ?= -race

# Local development (make dev)
LUCID_DEV_ADDR  ?= 127.0.0.1:8080
MOCKDAV_ADDR    ?= 127.0.0.1:5232

.PHONY: help
help: ## Show this help
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z0-9_-]+:.*## / {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

## ---------------------------------------------------------------- build

.PHONY: web-deps
web-deps: ## Install frontend dependencies (frozen lockfile)
	$(PNPM) --dir web install --frozen-lockfile

.PHONY: web
web: web-deps ## Build the frontend into web/dist
	$(PNPM) --dir web build
	@touch web/dist/.gitkeep

.PHONY: build
build: web build-go ## Build the single binary with the embedded frontend (bin/lucid)

.PHONY: build-go
build-go: ## Build only the Go binary (embeds whatever is in web/dist)
	CGO_ENABLED=0 $(GO) build -trimpath -ldflags '$(LDFLAGS)' -o $(BIN) ./cmd/lucid

## ---------------------------------------------------------------- quality

.PHONY: test
test: test-go test-web ## Run all unit tests

.PHONY: test-go
test-go: ## Run Go tests with the race detector
	$(GO) test $(RACE) -shuffle=on ./...

.PHONY: test-web
test-web: web-deps ## Run frontend unit tests (Vitest)
	$(PNPM) --dir web test

.PHONY: cover
cover: ## Go coverage + gate (>= 80% business logic)
	$(GO) test $(RACE) -covermode=atomic -coverprofile=$(COVERAGE_OUT) ./...
	scripts/coverage-gate.sh $(COVERAGE_OUT)

.PHONY: cover-html
cover-html: cover ## Open the Go coverage report in a browser
	$(GO) tool cover -html=$(COVERAGE_OUT)

.PHONY: lint
lint: lint-go lint-web ## Run all linters and the TypeScript type check

.PHONY: lint-go
lint-go: ## Run golangci-lint
	$(GOLANGCI_LINT) run ./...

.PHONY: lint-web
lint-web: web-deps ## Run ESLint and tsc
	$(PNPM) --dir web lint
	$(PNPM) --dir web typecheck

.PHONY: fmt
fmt: ## Format Go code (gofumpt + goimports via golangci-lint)
	$(GOLANGCI_LINT) fmt ./...

.PHONY: vuln
vuln: ## Scan Go dependencies for known vulnerabilities, audit frontend deps
	$(GO) run golang.org/x/vuln/cmd/govulncheck@$(GOVULNCHECK_VERSION) ./...
	$(PNPM) --dir web audit --audit-level=high

.PHONY: e2e
e2e: web-deps ## Run Playwright end-to-end tests
	$(PNPM) --dir web e2e

## ---------------------------------------------------------------- run

.PHONY: mockdav
mockdav: ## Run the mock CalDAV server (login demo/demo)
	LUCID_MOCKDAV_ADDR=$(MOCKDAV_ADDR) $(GO) run ./cmd/lucid-mockdav

.PHONY: dev-backend
dev-backend: ## Run the backend for local HTTP development
	LUCID_ADDR=$(LUCID_DEV_ADDR) \
	LUCID_COOKIE_INSECURE=true \
	LUCID_ALLOW_PRIVATE_NETWORKS=true \
	LUCID_LOG_LEVEL=debug \
	$(GO) run ./cmd/lucid

.PHONY: dev-web
dev-web: web-deps ## Run the Vite dev server (proxies /api to the backend)
	$(PNPM) --dir web dev

.PHONY: dev
dev: ## Run mockdav + backend + Vite dev server together (Ctrl-C stops all)
	@echo "Open http://localhost:5173 and log in with server http://$(MOCKDAV_ADDR), user demo, password demo."
	$(MAKE) --no-print-directory -j3 mockdav dev-backend dev-web

## ---------------------------------------------------------------- release

.PHONY: snapshot
snapshot: ## Local GoReleaser snapshot (binaries + images, no publish/sign)
	$(GORELEASER) release --snapshot --clean --skip=sign,sbom

.PHONY: release-check
release-check: ## Validate the GoReleaser configuration
	$(GORELEASER) check

.PHONY: clean
clean: ## Remove build output (keeps web/dist/.gitkeep)
	rm -rf bin dist $(COVERAGE_OUT) web/coverage web/playwright-report web/test-results
	find web/dist -mindepth 1 ! -name .gitkeep -delete 2>/dev/null || true
	@mkdir -p web/dist && touch web/dist/.gitkeep
