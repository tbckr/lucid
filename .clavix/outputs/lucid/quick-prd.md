# Lucid - Quick PRD

**Goal:** Build a modern CalDAV web client (like Google Calendar UX) as open-source. Smart proxy architecture - no persistent storage, CalDAV server is source of truth.

**Core Features:** Calendar views (Month/Week/Day/Agenda), CRUD events with drag-drop, VTODO task sidebar, recurring events (RRULE), timezone support, i18n/l10n.

**Tech Stack:**
- **Backend:** Go (stdlib-first) - single binary with embedded frontend, in-memory cache, DI pattern
- **Frontend:** React 19 + Vite + Tailwind + shadcn/ui, TanStack Query v5 (server state), Zustand (UI state), pnpm mandatory
- **Security:** OWASP Top 10 compliance, CSRF, rate limiting, SSRF protection, session security
- **Ops:** Prometheus metrics, health checks, GoReleaser, SBOM + signing

**Key Constraints:**
- Stdlib-first (minimal external deps)
- 80% test coverage
- <1s initial render (warm cache)
- WCAG 2.1 AA accessibility
- English-first docs

**MVP Phases:** Backend Core & Security → CalDAV Integration → Frontend Implementation → Release Hardening

---
*Generated: 2025-12-28*
