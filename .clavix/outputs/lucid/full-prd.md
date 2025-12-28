# Product Requirements Document: Lucid - Modern CalDAV Web Client

*Imported from docs/PRD.md*
*Generated: 2025-12-28*

## Vision & Summary

Modern, browser-based CalDAV client with Google Calendar UX/UI, published as Open Source.

**Architecture:** Smart Client/Proxy - no permanent storage, CalDAV server is source of truth.
- **Backend:** Go (stdlib-first, single binary with embedded frontend)
- **Frontend:** React 19 + Tailwind + shadcn/ui SPA

## Target Audience

- Privacy enthusiasts (self-hosted calendar users)
- Power users (unified calendar + tasks view)
- Developers/Admins (simple single-binary deployment)

## Technical Architecture

### Backend (Go)
- **Philosophy:** Stdlib-first, minimal external dependencies
- **Server:** Standard net/http with Go 1.22+ routing
- **Pattern:** Dependency Injection, interfaces for testability
- **State:** Stateless + in-memory cache (thread-safe)
- **Deployment:** Single binary with embedded frontend via embed.FS
- **Libraries:**
  - github.com/emersion/go-webdav (CalDAV client)
  - github.com/prometheus/client_golang (metrics)

### Frontend (Browser)
- **Type:** SPA (Vite + React 19)
- **Package Manager:** pnpm (mandatory)
- **Stack:**
  - React 19 (modern hooks: useActionState, useOptimistic)
  - Tailwind CSS
  - shadcn/ui (Radix-based components)
  - i18next (internationalization)
- **State Management:**
  - TanStack Query v5 (server state only)
  - Zustand (UI state only)
- **Libraries:**
  - date-fns + date-fns-tz
  - dnd-kit (drag & drop)
  - React Hook Form + Zod

## Functional Requirements

### Authentication & Connection
- **FR-01:** Login via CalDAV URL, username, password
- **FR-02:** Auto-discovery (DNS SRV, .well-known)
- **FR-03:** Secure session handling (server-side encrypted credentials)

### Calendar Management (VEVENT)
- **FR-04:** List all calendars (collection discovery)
- **FR-05:** Show/hide toggle
- **FR-06:** Color coding

### Event Views & Interaction
- **FR-07:** Views: Month (prio 1), Week, Day, Agenda
- **FR-08:** Navigation (Today, Prev, Next)
- **FR-09:** CRUD events
- **FR-10:** Drag & drop (optimistic UI)
- **FR-11:** All-day vs time-bound events

### Task Management (VTODO)
- **FR-12:** Sidebar for VTODO items
- **FR-13:** Checklist support
- **FR-14:** Due date & priority
- **FR-15:** Status updates (COMPLETED)

### Extended iCal Features
- **FR-17:** Recurring events (RRULE) - backend expands for view range
- **FR-18:** Timezone support (UTC storage, local display)

### Frontend Resilience & i18n
- **FR-19:** Global error boundaries (corrupted event placeholders)
- **FR-20:** Offline indicator
- **FR-21:** Multi-language support (English default)
- **FR-22:** Locale-aware date/time formats (user-overridable)

## Non-Functional Requirements

### Performance & Caching
- **NFR-01:** Aggressive caching via CTag (RFC 6578)
- **NFR-02:** Initial render < 1s (warm cache)
- **NFR-25:** Virtualization for large lists (TanStack Virtual)

### Code Quality & Testing
- **NFR-05:** 80% test coverage for business logic
- **NFR-06:** Concurrent tests (t.Parallel())
- **NFR-07:** No external test dependencies
- **NFR-10:** Static analysis (golangci-lint, ESLint/Biome)
- **NFR-11:** Vulnerability scanning (govulncheck)
- **NFR-28:** Frontend testing (Vitest + Playwright)
- **NFR-34:** English-first documentation

### Observability
- **NFR-08:** Prometheus metrics at /metrics
- **NFR-09:** Health checks (liveness/readiness)
- **NFR-23:** Structured JSON logging

### Security (OWASP Top 10)
- **NFR-03:** Session cookies (HttpOnly, Secure, SameSite=Strict)
- **NFR-04:** TLS mandatory
- **NFR-17:** CSRF protection (synchronizer token)
- **NFR-18:** Rate limiting (token bucket)
- **NFR-19:** Security headers (CSP, HSTS, etc.)
- **NFR-20:** Secrets via ENV only
- **NFR-21:** Container security (non-root, read-only FS)
- **NFR-22:** SSRF protection (URL validation)
- **NFR-24:** Injection prevention
- **NFR-29:** XSS prevention (no dangerouslySetInnerHTML without DOMPurify)
- **NFR-30-33:** Frontend supply chain security (pnpm audit, SRI, etc.)

### UX & Accessibility
- **NFR-26:** Optimistic updates for single events
- **NFR-27:** WCAG 2.1 AA keyboard navigation

### CI/CD
- **NFR-12:** GitHub Actions
- **NFR-13:** GoReleaser
- **NFR-14:** SemVer
- **NFR-15:** SBOM + Cosign signing
- **NFR-16:** Renovate for dependencies

## Data Model

```go
type CalendarService interface {
    GetEvents(ctx context.Context, start, end time.Time) ([]Event, error)
    Sync(ctx context.Context) error
}

type CalDAVClient struct {
    WebDAVClient webdav.Client
    Cache        CacheProvider
}

type Event struct {
    ID          string    `json:"id"`
    ETag        string    `json:"etag"`
    Title       string    `json:"title"`
    Start       time.Time `json:"start"`
    End         time.Time `json:"end"`
    // ...
}
```

## Risks & Mitigation

1. **RRULE Expansion:** Expensive for infinite series
   - *Mitigation:* Calculate only for requested time window

2. **SSRF Vulnerability:** Proxy architecture risk
   - *Mitigation:* SafeTransport middleware with URL validation

3. **In-Memory Sessions:** Lost on restart
   - *Accepted limitation for MVP*

## Roadmap (MVP)

**Phase 1: Backend Core & Security**
- net/http server + DI setup
- SSRF-safe HTTP client
- Security middleware (CSRF, rate limit, headers)
- Auth & session handling

**Phase 2: CalDAV Integration**
- XML parsing & caching
- Integration tests vs mock server

**Phase 3: Frontend Implementation**
- React/Tailwind/shadcn UI
- i18n setup
- State management (Zustand/Query)
- Calendar grid view

**Phase 4: Release Hardening**
- SBOM, signing, container scanning
