# **Product Requirements Document (PRD): Lucid \- Modern CalDAV Web Client**

| Metadata | Details |
| :---- | :---- |
| **Project Name** | **Lucid** |
| **Version** | 0.0.1 |
| **Status** | Ready for Dev |
| **Date** | 2025-12-28 |

## **1\. Vision & Summary**

The goal is to develop a modern, browser-based client for calendars and tasks, visually and functionally inspired by the usability of Google Calendar. The project will be published as **Open Source Software** on GitHub.
**Lucid** acts as a **Smart Client / Proxy**. It does not store data permanently in its own database (no "Sync Store") but holds data only temporarily in cache. The "Source of Truth" remains the external **CalDAV Server** (Nextcloud, Synology, iCloud, etc.).
The backend is written in **Go** and serves as middleware to resolve CORS issues and abstract CalDAV complexity (XML, WebDAV). The frontend focuses on High-Fidelity UX/UI.

## **2\. Target Audience**

* **Privacy Enthusiasts:** Users who self-host or use independent providers but demand modern UX.
* **Power Users:** People who need calendars and tasks in a single unified view.
* **Developers/Admins:** Simple deployment (Single Binary via Go) is required.

## **3\. Technical Architecture**

### **3.1 Architectural Decision: Smart Proxy**

We use a **Proxy/Middleware Architecture** instead of a Thick Client or Full-Sync solution.

* **Why no Direct Browser Access?** To bypass CORS issues.
* **Why no Full-Sync DB?** To avoid complex conflict resolution and data duplication.

### **3.2 Backend (Go) \- "Stdlib First"**

* **Philosophy:** Minimal external dependencies. Use Go Standard Library wherever possible.
* **Server:** Standard net/http Server (no Gin/Echo/Fiber). Use http.ServeMux (Go 1.22+ Routing).
* **Pattern:** Consistent **Dependency Injection (DI)**. Services defined as interfaces to guarantee testability.
* **Input:** REST/JSON from Frontend.
* **Output:** CalDAV (XML/iCal) to Server.
* **Deployment:** Use Go 1.16+ embed.FS to embed the compiled frontend (Vite dist/ folder) directly into the Go binary. This guarantees the "Single Binary" promise.
* **Libraries:**
  * github.com/emersion/go-webdav (for WebDAV Client logic \- essential).
  * github.com/prometheus/client\_golang (for metrics).
  * No external test assertion libraries (only testing package).
* **State:** Stateless Logic, but with **In-Memory Cache** (Thread-safe via sync.Map or generic LRU implementation).

### **3.3 Frontend (Browser) \- Lightweight SPA**

* **Type:** Single Page Application (SPA). No SSR/Next.js framework overhead.
* **Package Manager:** **pnpm** (Mandatory for strict dependency management and performance).
* **Build Tool:** Vite.
* **Core Stack:**
  * **React 19:** Use modern hooks (useActionState, useOptimistic where appropriate).
  * **Tailwind CSS:** Utility-first styling.
  * **shadcn/ui:** Headless Components (based on Radix UI) for accessible modals, dropdowns, and dialogs.
  * **i18next & react-i18next:** Standard library for internationalization (i18n).
* **State Management & Logic:**
  * **TanStack Query (v5):** Exclusively for **Server State** (Events, Calendar Lists). Caching, Re-Fetching, Optimistic Updates.
  * **Zustand:** Exclusively for **Client UI State** (Sidebar Open/Close, Modals, Current View Filter). No Redux/Context-Hell.
  * **date-fns & date-fns-tz:** Immutable Date Libraries (tree-shakeable) for complex timezone calculations.
  * **dnd-kit:** For accessible Drag & Drop (Grid & Lists).
  * **React Hook Form \+ Zod:** Form management and schema validation (Client-Side Validation before API Call).

## **4\. Functional Requirements (Functional Requirements)**

### **4.1 Authentication & Connection**

* **FR-01:** Login via CalDAV Server URL, Username, and Password.
* **FR-02:** Support for Auto-Discovery (via DNS SRV or .well-known).
* **FR-03:** Secure Session Handling. Credentials held server-side, encrypted within the session (Stateful Session Token).

### **4.2 Calendar Management (VEVENT)**

* **FR-04:** Listing of all available calendars (Collection Discovery).
* **FR-05:** Toggle function (Show/Hide).
* **FR-06:** Color coding.

### **4.3 Event Views & Interaction**

* **FR-07:** Views: Month (Prio 1), Week, Day, Agenda.
* **FR-08:** Navigation (Today, Previous, Next).
* **FR-09:** CRUD (Create, Read, Update, Delete) Events.
* **FR-10:** Drag & Drop (Frontend update immediate, Backend request asynchronous).
* **FR-11:** All-day vs. time-bound events.

### **4.4 Task Management (VTODO)**

* **FR-12:** Sidebar for VTODO Items.
* **FR-13:** Checklist support.
* **FR-14:** Due Date & Priority.
* **FR-15:** Status Update (COMPLETED).

### **4.5 Extended iCal Features**

* **FR-17:** Recurring Events (RRULE).
  * *Implementation:* Backend expands RRULEs for the requested view range.
* **FR-18:** Timezone Support (UTC Storage, Local Display).

### **4.6 Frontend Resilience, UX & i18n**

* **FR-19:** **Global Error Boundaries:** App must not crash on rendering errors of a single event. Faulty events displayed as "Corrupted Event" placeholders.
* **FR-20:** **Offline Indicator:** Visual feedback when backend connection is lost (React Query networkMode).
* **FR-21:** **Internationalization (i18n):** The UI must support multiple languages (English as default). Translations stored in JSON files.
* **FR-22:** **Localization (l10n):** Date and time formats (24h vs AM/PM, Week start Mon vs Sun) must automatically adapt to the browser's navigator.language / locale settings by default, **but must be manually overridable by the user via a settings menu**.

## **5\. Non-Functional Requirements (NFR)**

### **5.1 Performance & Caching**

* **NFR-01:** **Aggressive Caching via CTag (RFC 6578):**
  * Backend checks getctag via PROPFIND.
  * Cache Hit: Response from Go memory (\<10ms).
  * Cache Miss: REPORT Request to CalDAV Server.
* **NFR-02:** Initial Rendering \< 1s (warm cache).
* **NFR-25:** **Virtualization:** Use TanStack Virtual for List Views (Agenda/Tasks) and Month Cells with \>10 events to keep DOM node count low.

### **5.2 Code Quality & Testing**

* **NFR-05:** **Test Coverage:** Minimum 80% Statement Coverage for Business Logic.
* **NFR-06:** **Concurrency Tests:** Use t.Parallel() in tests.
* **NFR-07:** **No External Test Deps:** Tests must not require running database or external CalDAV server.
* **NFR-10:** **Static Analysis:** Use golangci-lint (strict config) and ESLint / Biome for Frontend.
* **NFR-11:** **Vulnerability Scan:** Automated scan via govulncheck (OWASP A06:2021).
* **NFR-28:** **Frontend Testing:**
  * Unit Tests: Vitest for Helper Functions.
  * E2E Tests: Playwright for critical User Flows.
* **NFR-34:** **English First:** All code comments, commit messages, and documentation must be in English to facilitate international contributions.

### **5.3 Observability & Operations**

* **NFR-08:** **Prometheus Metrics:** Expose metrics at /metrics.
* **NFR-09:** **Health Checks:** Liveness/Readiness Probes.
* **NFR-23:** **Security Logging (OWASP A09:2021):** Structured Logging (JSON).

### **5.4 Backend & Network Security (OWASP Top 10\)**

* **NFR-03:** **Session Mgmt:** Session Cookies: HttpOnly, Secure, SameSite=Strict.
* **NFR-04:** **Cryptographic Failures:** TLS Termination mandatory.
* **NFR-17:** **CSRF Protection:** Synchronizer Token Pattern for all State-Changing Requests.
* **NFR-18:** **Rate Limiting:** Token-Bucket Middleware.
* **NFR-19:** **Security Headers:** CSP, HSTS, X-Frame-Options, X-Content-Type-Options.
* **NFR-20:** **Secrets Management:** Keys via ENV-Vars only.
* **NFR-21:** **Container Security:** Non-Root User, Read-Only FS.
* **NFR-22:** **SSRF Protection:** Validation of target URLs against internal networks. SafeTransport must apply to Auto-Discovery (incl. Redirects).
* **NFR-24:** **Injection Prevention:** XML-Entity Protection, Input Validation.

### **5.5 Frontend Security (Client-Side & Supply Chain)**

* **NFR-29:** **XSS Prevention:** Strict prohibition of dangerouslySetInnerHTML without DOMPurify.
* **NFR-30:** **Frontend Supply Chain Security:**
  * Use **pnpm** strictly.
  * CI runs pnpm audit.
  * CI uses pnpm install \--frozen-lockfile.
* **NFR-31:** **Data Leakage Prevention:** No ENV vars in JS bundle, Source Maps disabled in Prod.
* **NFR-32:** **Subresource Integrity (SRI):** For external assets (if any).
* **NFR-33:** **Open Redirect Prevention:** Validate ?redirect= targets.

### **5.6 UX & Accessibility (React Specific)**

* **NFR-26:** **Optimistic UI Updates:** Drag & Drop actions must update DOM immediately via onMutate.
  * *Limitation:* Applies to **Single Events** only. Recurring events show Loading State.
* **NFR-27:** **Keyboard Accessibility (WCAG 2.1 AA):** Full keyboard navigation support.

### **5.7 CI/CD & Release Management**

* **NFR-12:** GitHub Actions Pipeline.
* **NFR-13:** Release via **GoReleaser**.
* **NFR-14:** SemVer Versioning.
* **NFR-15:** **Supply Chain:** SBOM Generation & Artifact Signing (Cosign).
* **NFR-16:** Dependency Management via Renovate.

## **6\. Data Model (Interface Design)**

// Service Definition for Dependency Injection
type CalendarService interface {
    GetEvents(ctx context.Context, start, end time.Time) (\[\]Event, error)
    Sync(ctx context.Context) error
}

// Implementation
type CalDAVClient struct {
    WebDAVClient webdav.Client
    Cache        CacheProvider // Interface for Cache
}

type Event struct {
    ID          string    \`json:"id"\`
    ETag        string    \`json:"etag"\` // Concurrency Control (If-Match)
    Title       string    \`json:"title"\`
    Start       time.Time \`json:"start"\`
    End         time.Time \`json:"end"\`
    // ...
}

## **7\. Risks & Mitigation**

1. **RRULE Expansion:** Computationally expensive for infinite series.
   * *Mitigation:* Backend calculates instances only for requested time window.
2. **SSRF (Server-Side Request Forgery):** Proxy architecture vulnerability.
   * *Mitigation:* Strict SafeTransport Middleware for outgoing HTTP requests.
3. **Operational Risk (In-Memory Sessions):**
   * Sessions stored in RAM (sync.Map) mean logouts on restart. Accepted as **Known Limitation** for MVP.

## **8\. Roadmap (MVP Scope)**

**Phase 1: Backend Core & Security**

* Setup net/http Server & DI.
* **SSRF-Safe HTTP Client** Implementation.
* Security Middleware (CSRF, RateLimit, Headers).
* Auth & Session Handling.

**Phase 2: CalDAV Integration**

* XML Parsing & Caching Logic.
* Integration tests against Mock Server.

**Phase 3: Frontend Implementation**

* UI with React/Tailwind/Shadcn.
* i18n Setup.
* State Management (Zustand/Query) Setup.
* Grid-View Implementation.

**Phase 4: Release Hardening**

* SBOM, Signing, Container Scan.
