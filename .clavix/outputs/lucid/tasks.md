# Implementation Plan: Lucid - Modern CalDAV Web Client

**Project**: lucid
**Generated**: 2025-12-28T21:18:00Z

## Technical Context & Standards

*Detected Stack & Patterns*
- **Architecture**: Smart Proxy/Middleware (no persistent storage)
- **Backend**: Go (stdlib-first with Go 1.22+ routing, single binary via embed.FS)
- **Frontend**: React 19 + Vite + Tailwind + shadcn/ui (SPA)
- **State Management**: TanStack Query v5 (server state), Zustand (UI state)
- **Package Manager**: pnpm (mandatory)
- **Security**: OWASP Top 10 compliance, SSRF protection, session security
- **Conventions**: DI pattern, interfaces for testability, English-first comments

---

## Phase 1: Backend Core & Security

**Overview**: Establish Go backend foundation with security-first architecture

- [x] **Set up Go project structure** (ref: PRD §3.2, §8)
  Task ID: phase-1-setup-01
  > **Implementation**: Create project structure with proper Go modules.
  > **Details**: 
  > - Initialize `go.mod` with Go 1.22+
  > - Create directory structure: `cmd/lucid/`, `internal/server/`, `internal/caldav/`, `internal/auth/`, `internal/middleware/`, `internal/cache/`
  > - Add `.gitignore` for Go, Node.js, IDE files
  > - Create `Makefile` with common commands (build, test, lint)

- [x] **Implement SSRF-safe HTTP client** (ref: PRD §7, NFR-22)
  Task ID: phase-1-security-01
  > **Implementation**: Create `internal/transport/safe_transport.go`
  > **Details**:
  > - Create SafeTransport type wrapping http.RoundTripper
  > - Validate URLs against private IP ranges (RFC 1918, localhost)
  > - Block redirects to internal networks
  > - Add tests with private IP ranges, redirects, DNS rebinding scenarios
  > - Use stdlib `net/http` and `net` package only

- [x] **Set up net/http server with Go 1.22+ routing** (ref: PRD §3.2, §8)
  Task ID: phase-1-server-01
  > **Implementation**: Create `internal/server/server.go` and `cmd/lucid/main.go`
  > **Details**:
  > - Use `http.ServeMux` with method-based routing (Go 1.22+)
  > - Implement graceful shutdown (context cancellation)
  > - Add request ID middleware for tracing
  > - Configure timeouts (ReadTimeout, WriteTimeout, IdleTimeout)
  > - Return Server as interface for DI

- [x] **Implement session management** (ref: FR-03, NFR-03)
  Task ID: phase-1-auth-01
  > **Implementation**: Create `internal/auth/session.go`
  > **Details**:
  > - Use `sync.Map` for in-memory session storage
  > - Generate cryptographically secure session tokens (crypto/rand)
  > - Store encrypted CalDAV credentials (use `crypto/aes` GCM mode)
  > - Set cookies: HttpOnly, Secure, SameSite=Strict
  > - Implement session expiry (configurable TTL)

- [x] **CSRF protection middleware** (ref: NFR-17)
  Task ID: phase-1-security-02
  > **Implementation**: Create `internal/middleware/csrf.go`
  > **Details**:
  > - Implement synchronizer token pattern
  > - Generate per-session CSRF tokens
  > - Validate tokens on state-changing requests (POST, PUT, DELETE, PATCH)
  > - Return 403 on CSRF validation failure
  > - Use double-submit cookie pattern for stateless option

- [x] **Rate limiting middleware** (ref: NFR-18)
  Task ID: phase-1-security-03
  > **Implementation**: Create `internal/middleware/ratelimit.go`
  > **Details**:
  > - Implement token bucket algorithm (stdlib only)
  > - Rate limit per IP address (use `X-Forwarded-For` with validation)
  > - Configurable limits via ENV vars
  > - Return 429 Too Many Requests with Retry-After header
  > - Use `sync.Map` for per-IP bucket storage

- [x] **Security headers middleware** (ref: NFR-19)
  Task ID: phase-1-security-04
  > **Implementation**: Create `internal/middleware/headers.go`
  > **Details**:
  > - Set Content-Security-Policy (restrict script-src, connect-src)
  > - Add HSTS (Strict-Transport-Security)
  > - Add X-Frame-Options: DENY
  > - Add X-Content-Type-Options: nosniff
  > - Add Referrer-Policy: strict-origin-when-cross-origin

- [x] **Structured logging** (ref: NFR-23, NFR-34)
  Task ID: phase-1-observability-01
  > **Implementation**: Create `internal/log/logger.go`
  > **Details**:
  > - Use `encoding/json` for structured output
  > - Define log levels (DEBUG, INFO, WARN, ERROR)
  > - Add context.Context support for request tracing
  > - Include timestamps, request IDs, user IDs (if authenticated)
  > - Never log sensitive data (passwords, tokens)

- [x] **Health check endpoints** (ref: NFR-09)
  Task ID: phase-1-observability-02
  > **Implementation**: Create `internal/server/health.go`
  > **Details**:
  > - Implement `/healthz` (liveness probe - always returns 200)
  > - Implement `/readyz` (readiness probe - checks dependencies)
  > - Use stdlib only, return JSON status
  > - Readiness checks: session store availability

- [x] **Prometheus metrics** (ref: NFR-08)
  Task ID: phase-1-observability-03
  > **Implementation**: Create `internal/metrics/metrics.go`
  > **Details**:
  > - Use `github.com/prometheus/client_golang`
  > - Export metrics at `/metrics`
  > - Track: HTTP request duration, request count by endpoint, active sessions
  > - Track: Cache hits/misses, CalDAV request latency
  > - Use histogram for latencies, counter for totals

---

## Phase 2: CalDAV Integration

**Overview**: Implement CalDAV client with caching and XML parsing

- [x] **Define CalDAV service interfaces** (ref: PRD §6)
  Task ID: phase-2-caldav-01
  > **Implementation**: Create `internal/caldav/interfaces.go`
  > **Details**:
  > - Define CalendarService interface (GetEvents, CreateEvent, UpdateEvent, DeleteEvent, Sync)
  > - Define CacheProvider interface (Get, Set, Invalidate)
  > - Define Event, Calendar, Task structs with JSON tags
  > - Include ETag fields for concurrency control

- [x] **Implement CalDAV client** (ref: PRD §3.2)
  Task ID: phase-2-caldav-02
  > **Implementation**: Create `internal/caldav/client.go`
  > **Details**:
  > - Use `github.com/emersion/go-webdav` for WebDAV operations
  > - Inject SafeTransport for SSRF protection
  > - Implement auto-discovery (.well-known, DNS SRV per FR-02)
  > - Parse PROPFIND responses for calendar collections
  > - Handle authentication (Basic Auth initially)

- [x] **Implement CTag-based caching** (ref: NFR-01)
  Task ID: phase-2-cache-01
  > **Implementation**: Create `internal/cache/ctag_cache.go`
  > **Details**:
  > - Use `sync.Map` for thread-safe in-memory cache
  > - Implement GetCTag via PROPFIND with <getctag> property
  > - Cache structure: calendar URL -> (CTag, []Event, Expiry)
  > - Cache hit returns events in <10ms
  > - Cache miss triggers REPORT request to CalDAV server

- [x] **RRULE expansion logic** (ref: FR-17, §7)
  Task ID: phase-2-caldav-03
  > **Implementation**: Create `internal/caldav/rrule.go`
  > **Details**:
  > - Parse RRULE from iCal (FREQ, INTERVAL, UNTIL, COUNT, BYDAY)
  > - Expand recurring events for requested time window only
  > - Limit expansion to prevent infinite loops (max 2 years ahead)
  > - Return instances with original event ID + occurrence date
  > - Handle exceptions (EXDATE)

- [ ] **iCal (VEVENT) parsing** (ref: FR-09, FR-11)
  Task ID: phase-2-caldav-04
  > **Implementation**: Create `internal/caldav/ical_parser.go`
  > **Details**:
  > - Parse iCal format using `github.com/emersion/go-ical` or stdlib
  > - Extract: SUMMARY, DTSTART, DTEND, RRULE, EXDATE, LOCATION, DESCRIPTION
  > - Handle all-day events (VALUE=DATE)
  > - Parse timezone info (VTIMEZONE, TZID)
  > - Convert to UTC for storage, local for display

- [ ] **VTODO parsing** (ref: FR-12-15)
  Task ID: phase-2-caldav-05
  > **Implementation**: Create `internal/caldav/vtodo_parser.go`
  > **Details**:
  > - Parse VTODO components
  > - Extract: SUMMARY, DUE, PRIORITY, STATUS, PERCENT-COMPLETE
  > - Support checklist format (multiple VTODO with RELATED-TO)
  > - Map status (NEEDS-ACTION, IN-PROCESS, COMPLETED, CANCELLED)

- [ ] **CalDAV CRUD operations** (ref: FR-09)
  Task ID: phase-2-caldav-06
  > **Implementation**: Add methods to `internal/caldav/client.go`
  > **Details**:
  > - CreateEvent: PUT with new UID, return ETag
  > - UpdateEvent: PUT with If-Match header (ETag), handle 412 conflict
  > - DeleteEvent: DELETE request
  > - GetEvents: REPORT with calendar-query, filter by time range
  > - Use stdlib `encoding/xml` for building REPORT bodies

- [ ] **Integration tests with mock CalDAV server** (ref: NFR-07, §8)
  Task ID: phase-2-test-01
  > **Implementation**: Create `internal/caldav/client_test.go`
  > **Details**:
  > - Use `httptest.Server` to mock CalDAV responses
  > - Test: Auto-discovery, collection listing, CRUD operations
  > - Test: CTag caching (hit/miss), RRULE expansion
  > - Test: Concurrent requests (use t.Parallel())
  > - Verify no external CalDAV server required (NFR-07)

---

## Phase 3: Frontend Implementation

**Overview**: Build React SPA with calendar UI and state management

- [ ] **Initialize frontend project with Vite + pnpm** (ref: PRD §3.3)
  Task ID: phase-3-setup-01
  > **Implementation**: Create `web/` directory
  > **Details**:
  > - Run `pnpm create vite web --template react-ts`
  > - Configure `vite.config.ts` for proxy to backend (dev mode)
  > - Add `.npmrc` to enforce pnpm: `engine-strict=true`
  > - Set `package.json` engines: `"pnpm": ">=9.0.0"`
  > - Configure build output to `web/dist/`

- [ ] **Install and configure dependencies** (ref: PRD §3.3)
  Task ID: phase-3-setup-02
  > **Implementation**: Update `web/package.json`
  > **Details**:
  > - Install: react@19, react-dom@19
  > - Install: @tanstack/react-query@5, zustand
  > - Install: tailwindcss, @tailwindcss/forms
  > - Install: shadcn/ui init (npx shadcn-ui@latest init)
  > - Install: i18next, react-i18next
  > - Install: date-fns, date-fns-tz
  > - Install: @dnd-kit/core, @dnd-kit/sortable
  > - Install: react-hook-form, zod, @hookform/resolvers
  > - Install dev: vitest, @testing-library/react, @playwright/test

- [ ] **Configure Tailwind CSS** (ref: PRD §3.3)
  Task ID: phase-3-setup-03
  > **Implementation**: Create `web/tailwind.config.js`
  > **Details**:
  > - Configure content paths for all component files
  > - Add shadcn/ui theme variables
  > - Configure dark mode support
  > - Add custom colors for calendar view

- [ ] **Set up i18n** (ref: FR-21, NFR-34)
  Task ID: phase-3-i18n-01
  > **Implementation**: Create `web/src/i18n/` directory
  > **Details**:
  > - Create `i18n.ts` config file
  > - Create translation files: `locales/en/translation.json`
  > - Configure language detection (navigator.language)
  > - Add language switcher component
  > - Wrap App in `I18nextProvider`

- [ ] **Set up TanStack Query** (ref: PRD §3.3)
  Task ID: phase-3-state-01
  > **Implementation**: Create `web/src/lib/query-client.ts`
  > **Details**:
  > - Create QueryClient with default options
  > - Configure staleTime, cacheTime for calendar data
  > - Configure retry logic, error handling
  > - Set up devtools in development mode
  > - Wrap App in `QueryClientProvider`

- [ ] **Set up Zustand stores** (ref: PRD §3.3)
  Task ID: phase-3-state-02
  > **Implementation**: Create `web/src/stores/`
  > **Details**:
  > - Create `ui-store.ts` for sidebar, modal state
  > - Create `calendar-store.ts` for selected calendars, view type
  > - Create `settings-store.ts` for user preferences (locale override per FR-22)
  > - Use zustand persist middleware for localStorage

- [ ] **Implement auth flow UI** (ref: FR-01, FR-03)
  Task ID: phase-3-auth-01
  > **Implementation**: Create `web/src/pages/Login.tsx`
  > **Details**:
  > - Form with: CalDAV URL, username, password fields
  > - Use React Hook Form + Zod validation
  > - POST to `/api/auth/login` with CSRF token
  > - Handle errors (invalid credentials, connection failed)
  > - Redirect to calendar view on success

- [ ] **API client with CSRF handling** (ref: NFR-17)
  Task ID: phase-3-api-01
  > **Implementation**: Create `web/src/lib/api-client.ts`
  > **Details**:
  > - Fetch wrapper with automatic CSRF token inclusion
  > - Extract CSRF token from cookie or meta tag
  > - Add CSRF token to headers for state-changing requests
  > - Handle 403 CSRF errors with token refresh
  > - Type-safe request/response interfaces

- [ ] **Calendar list sidebar** (ref: FR-04, FR-05, FR-06)
  Task ID: phase-3-calendar-ui-01
  > **Implementation**: Create `web/src/components/CalendarSidebar.tsx`
  > **Details**:
  > - Fetch calendars via TanStack Query
  > - Display calendar names with color indicators
  > - Toggle visibility (checkbox) - update Zustand store
  > - Color picker for calendar customization
  > - Use shadcn/ui Checkbox, Popover components

- [ ] **Month view grid** (ref: FR-07, priority 1)
  Task ID: phase-3-calendar-ui-02
  > **Implementation**: Create `web/src/components/MonthView.tsx`
  > **Details**:
  > - 7x6 grid (weeks x days)
  > - Calculate week starts (respect locale via settings store)
  > - Render events as colored blocks
  > - Handle overflow (show "+N more" with popover)
  > - Use @tanstack/react-virtual for cells with >10 events (NFR-25)

- [ ] **Week view** (ref: FR-07)
  Task ID: phase-3-calendar-ui-03
  > **Implementation**: Create `web/src/components/WeekView.tsx`
  > **Details**:
  > - Time grid (00:00-23:59) with 7 columns
  > - Position events based on start/end time
  > - Handle overlapping events (side-by-side layout)
  > - Show all-day events in separate row
  > - Scrollable time axis

- [ ] **Day view** (ref: FR-07)
  Task ID: phase-3-calendar-ui-04
  > **Implementation**: Create `web/src/components/DayView.tsx`
  > **Details**:
  > - Single column time grid
  > - Similar to week view but single day
  > - Wider event blocks for better readability
  > - Scroll to current time on load

- [ ] **Agenda view** (ref: FR-07)
  Task ID: phase-3-calendar-ui-05
  > **Implementation**: Create `web/src/components/AgendaView.tsx`
  > **Details**:
  > - List view grouped by date
  > - Show events in chronological order
  > - Filter by date range (configurable)
  > - Use @tanstack/react-virtual for large lists (NFR-25)
  > - Export to CSV option

- [ ] **View navigation** (ref: FR-08)
  Task ID: phase-3-calendar-ui-06
  > **Implementation**: Create `web/src/components/CalendarNav.tsx`
  > **Details**:
  > - Today button (jump to current date)
  > - Previous/Next buttons (navigate by view period)
  > - Date picker for arbitrary date selection
  > - View switcher (Month/Week/Day/Agenda tabs)
  > - Current date display

- [ ] **Event creation modal** (ref: FR-09)
  Task ID: phase-3-event-ui-01
  > **Implementation**: Create `web/src/components/EventForm.tsx`
  > **Details**:
  > - Form: title, start date/time, end date/time, all-day toggle
  > - Form: calendar selection, location, description
  > - Use React Hook Form + Zod validation
  > - shadcn/ui Dialog, Input, Textarea components
  > - POST to `/api/events` with optimistic update

- [ ] **Event editing modal** (ref: FR-09)
  Task ID: phase-3-event-ui-02
  > **Implementation**: Extend `web/src/components/EventForm.tsx`
  > **Details**:
  > - Pre-populate form with existing event data
  > - PUT to `/api/events/:id` with If-Match header (ETag)
  > - Handle 412 conflict (show merge UI or reload)
  > - Delete button with confirmation dialog

- [ ] **Drag and drop for events** (ref: FR-10, NFR-26)
  Task ID: phase-3-event-ui-03
  > **Implementation**: Integrate dnd-kit in month/week views
  > **Details**:
  > - Use @dnd-kit/core DndContext
  > - Make event blocks draggable
  > - Update start/end time based on drop position
  > - Optimistic UI update via TanStack Query onMutate
  > - Limitation: Show loading state for recurring events (NFR-26)

- [ ] **Task sidebar** (ref: FR-12-15)
  Task ID: phase-3-task-ui-01
  > **Implementation**: Create `web/src/components/TaskSidebar.tsx`
  > **Details**:
  > - Fetch VTODOs via TanStack Query
  > - Display as checklist (shadcn/ui Checkbox)
  > - Show due date, priority indicators
  > - Mark complete (PUT with STATUS=COMPLETED)
  > - Group by status or due date

- [ ] **Error boundaries** (ref: FR-19)
  Task ID: phase-3-error-01
  > **Implementation**: Create `web/src/components/ErrorBoundary.tsx`
  > **Details**:
  > - React error boundary wrapping calendar views
  > - Catch rendering errors per event
  > - Display "Corrupted Event" placeholder
  > - Log error to console/monitoring
  > - Provide "Reload" button

- [ ] **Offline indicator** (ref: FR-20)
  Task ID: phase-3-error-02
  > **Implementation**: Create `web/src/components/OfflineIndicator.tsx`
  > **Details**:
  > - Listen to TanStack Query networkMode
  > - Show banner when backend unreachable
  > - Use window.navigator.onLine for initial state
  > - Auto-dismiss when connection restored

- [ ] **Locale settings** (ref: FR-22)
  Task ID: phase-3-i18n-02
  > **Implementation**: Create `web/src/components/SettingsModal.tsx`
  > **Details**:
  > - Setting: Language override (dropdown with available languages)
  > - Setting: Date format override (24h vs AM/PM)
  > - Setting: Week start day override (Mon vs Sun)
  > - Save to Zustand settings store (persisted)
  > - Apply immediately without reload

- [ ] **Frontend unit tests** (ref: NFR-28)
  Task ID: phase-3-test-01
  > **Implementation**: Create tests in `web/src/**/*.test.tsx`
  > **Details**:
  > - Use Vitest for helper functions (date formatting, RRULE parsing)
  > - Use @testing-library/react for component tests
  > - Test: Form validation, date calculations, state updates
  > - Test: Error boundary fallback rendering
  > - Aim for >80% coverage on critical paths

- [ ] **E2E tests** (ref: NFR-28)
  Task ID: phase-3-test-02
  > **Implementation**: Create `web/e2e/` directory
  > **Details**:
  > - Use @playwright/test
  > - Test: Login flow, create event, edit event, delete event
  > - Test: Calendar toggle, view switching, drag-drop
  > - Test: Task creation and completion
  > - Mock backend responses for consistent tests

- [ ] **Accessibility audit** (ref: NFR-27)
  Task ID: phase-3-a11y-01
  > **Implementation**: Review all components
  > **Details**:
  > - Test keyboard navigation (Tab, Enter, Esc, Arrow keys)
  > - Ensure focus indicators visible
  > - Add ARIA labels for screen readers
  > - Test with NVDA/JAWS screen reader
  > - Run axe-core automated checks

- [ ] **Embed frontend in Go binary** (ref: PRD §3.2)
  Task ID: phase-3-build-01
  > **Implementation**: Update `cmd/lucid/main.go`
  > **Details**:
  > - Add `//go:embed web/dist` directive
  > - Use `embed.FS` to serve static files
  > - Create http.FileServer handler
  > - Serve index.html for SPA routing (catch-all)
  > - Ensure production build disables source maps (NFR-31)

---

## Phase 4: Release Hardening

**Overview**: CI/CD, security scanning, and release automation

- [ ] **GitHub Actions CI pipeline** (ref: NFR-12)
  Task ID: phase-4-ci-01
  > **Implementation**: Create `.github/workflows/ci.yml`
  > **Details**:
  > - Jobs: lint, test (backend + frontend), build
  > - Backend: Run go test, golangci-lint, govulncheck
  > - Frontend: Run pnpm test, pnpm lint, pnpm build
  > - Use pnpm install --frozen-lockfile (NFR-30)
  > - Run on push and pull_request events

- [ ] **golangci-lint configuration** (ref: NFR-10)
  Task ID: phase-4-ci-02
  > **Implementation**: Create `.golangci.yml`
  > **Details**:
  > - Enable: errcheck, gosec, govet, staticcheck, unused
  > - Enable: gocyclo (complexity), gomnd (magic numbers)
  > - Strict mode for security linters
  > - Exclude generated code, vendor/

- [ ] **ESLint/Biome configuration** (ref: NFR-10)
  Task ID: phase-4-ci-03
  > **Implementation**: Create `web/.eslintrc.js` or `web/biome.json`
  > **Details**:
  > - Use @typescript-eslint recommended config
  > - Enable react-hooks rules
  > - Enable accessibility rules (eslint-plugin-jsx-a11y)
  > - Check for dangerouslySetInnerHTML usage (NFR-29)

- [ ] **Dependency vulnerability scanning** (ref: NFR-11, NFR-30)
  Task ID: phase-4-security-01
  > **Implementation**: Add to `.github/workflows/ci.yml`
  > **Details**:
  > - Backend: Run `govulncheck ./...`
  > - Frontend: Run `pnpm audit --audit-level=moderate`
  > - Fail CI on high/critical vulnerabilities
  > - Weekly scheduled run for continuous monitoring

- [ ] **SBOM generation** (ref: NFR-15)
  Task ID: phase-4-release-01
  > **Implementation**: Create `.github/workflows/release.yml`
  > **Details**:
  > - Use syft to generate SBOM (Go modules + npm packages)
  > - Generate SPDX or CycloneDX format
  > - Attach SBOM to GitHub release
  > - Include both backend and frontend dependencies

- [ ] **Configure GoReleaser** (ref: NFR-13, NFR-14)
  Task ID: phase-4-release-02
  > **Implementation**: Create `.goreleaser.yml`
  > **Details**:
  > - Build for: linux/amd64, linux/arm64, darwin/amd64, darwin/arm64
  > - Generate: tar.gz archives, checksums.txt
  > - Create GitHub release with changelog
  > - Use semantic versioning (SemVer)
  > - Sign artifacts with GPG or cosign

- [ ] **Artifact signing with Cosign** (ref: NFR-15)
  Task ID: phase-4-release-03
  > **Implementation**: Add to `.github/workflows/release.yml`
  > **Details**:
  > - Install cosign CLI in workflow
  > - Sign binaries using keyless signing (OIDC)
  > - Upload .sig files to release
  > - Document verification process in README

- [ ] **Container image build** (ref: NFR-21)
  Task ID: phase-4-container-01
  > **Implementation**: Create `Dockerfile`
  > **Details**:
  > - Multi-stage build: builder + runtime
  > - Runtime: Use distroless or alpine
  > - Run as non-root user (USER 1000)
  > - Read-only filesystem (VOLUME for cache only)
  > - Expose port 8080
  > - ENTRYPOINT with HEALTHCHECK

- [ ] **Container security scanning** (ref: NFR-21, §8)
  Task ID: phase-4-container-02
  > **Implementation**: Add to `.github/workflows/ci.yml`
  > **Details**:
  > - Use trivy or grype to scan image
  > - Check for: OS vulnerabilities, misconfigurations
  > - Fail on high/critical CVEs
  > - Publish scan results to GitHub Security

- [ ] **Renovate configuration** (ref: NFR-16)
  Task ID: phase-4-deps-01
  > **Implementation**: Create `renovate.json`
  > **Details**:
  > - Auto-update Go modules (patch/minor weekly)
  > - Auto-update npm packages (grouped by type)
  > - Auto-merge patch updates after CI passes
  > - Create PRs for major updates (manual review)
  > - Pin GitHub Actions to specific SHA

- [ ] **Documentation** (ref: NFR-34)
  Task ID: phase-4-docs-01
  > **Implementation**: Create `README.md`, `CONTRIBUTING.md`
  > **Details**:
  > - README: Project description, installation, usage, configuration
  > - Document ENV vars for configuration (NFR-20)
  > - Document CalDAV server compatibility
  > - CONTRIBUTING: Setup guide, code style, PR process
  > - All documentation in English (NFR-34)

---

*Generated by Clavix /clavix-plan*
