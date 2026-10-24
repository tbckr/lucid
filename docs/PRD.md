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
* **Individuals without admin skills:** People with a CalDAV account (a provider, a Nextcloud, a Radicale on a NAS) who want a good web client without running a server: download, double-click, done (FR-35).

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
* **FR-35:** **Local Mode:** Without `LUCID_ADDR`, Lucid runs in local mode and needs no configuration, so that a double-click on the downloaded binary is enough. It listens on `127.0.0.1:<LUCID_LOCAL_PORT>` only (default 3456), serves plain HTTP with a session cookie without `Secure`, accepts only `localhost` and `127.0.0.1` as `Host` (DNS rebinding protection), allows internal networks by default (`LUCID_PRIVATE_NETWORKS=all`), logs text instead of JSON, and opens the default browser at `http://127.0.0.1:<port>/` unless `LUCID_OPEN_BROWSER=false`. It prints where it runs and that closing its window stops it (closing the browser tab does not). The port is fixed: if it is taken, Lucid exits with a message; it neither picks another port nor hands off to a running instance. Setting `LUCID_ADDR` selects server mode instead. Every `LUCID_*` variable belongs to local mode, server mode or both, and a variable set for the other mode, or one that earlier versions had and no longer exists, is a startup error.

### **4.2 Calendar Management (VEVENT)**

* **FR-04:** Listing of all available calendars (Collection Discovery).
* **FR-05:** Toggle function (Show/Hide).
* **FR-06:** Color coding.

### **4.3 Event Views & Interaction**

* **FR-07:** Views: Month (Prio 1), Week, Day, Agenda.
* **FR-08:** Navigation (Today, Previous, Next). In the month view, a scroll gesture steps one month; a month taller than its window scrolls first.
* **FR-09:** CRUD (Create, Read, Update, Delete) Events. A save the CalDAV server refuses because the event or task changed elsewhere since the editor opened keeps the editor open with what was entered, says so, and offers to save anyway, which replaces the other change; where the reloaded calendar no longer holds the item, it says to close the editor to see the current version.
* **FR-10:** Drag & Drop (Frontend update immediate, Backend request asynchronous).
* **FR-11:** All-day vs. time-bound events.

### **4.4 Task Management (VTODO)**

* **FR-12:** Sidebar for VTODO Items.
* **FR-13:** Checklist support.
* **FR-14:** Due Date & Priority.
* **FR-15:** Status Update (COMPLETED).
* **FR-16:** Tasks with a date are shown in the calendar views, can be completed there and created from a click in them. Recurring tasks show every repeat. Repeats are completed in order; the current one can be changed or deleted on its own, which detaches it as a task of its own or skips it, and any repeat can be changed together with the series (FR-17).

### **4.5 Extended iCal Features**

* **FR-17:** Recurring Events (RRULE).
  * *Implementation:* Backend expands RRULEs for the requested view range. Recurring tasks (VTODO) are expanded like events; see [docs/RECURRING-TASKS.md](RECURRING-TASKS.md). Single-occurrence overrides, series moves and series splits for events are documented in [docs/RECURRING-EVENTS.md](RECURRING-EVENTS.md).
  * **Only this event:** a single occurrence can be changed or deleted independently of the series, via an RFC 5545 override (an EXDATE on delete).
  * **All events:** a change to the series shifts by the distance from the edited occurrence's shown start and carries along only the fields that changed.
  * **This and following events:** a change, move or delete can reach an occurrence and the later ones: the series ends before it, and a change goes on from it as a series of its own, with a new UID (a split, never `RANGE=THISANDFUTURE`). Not offered at the series' first event, where it would be all events, nor for a series with attendees.
  * **Recurring tasks** behave the same, with the same question, worded for repeats: "Only this repeat", "This and following repeats", "All repeats". Under the rolling model (see [docs/RECURRING-TASKS.md](RECURRING-TASKS.md)) only the current repeat can be changed on its own: it becomes a task of its own, detached from the series, or, deleted, is skipped, and the series goes on at its next repeat. From a later repeat on, a change, move or delete splits or ends the series as for events. A series on fixed days, of events or tasks, moves only as far as its rule can follow; the last repeat of a task moves to any day.
  * **Ask only with a choice:** a change with one possible scope is not asked about; the dragged event or task, the editor or the task list's date picker says beforehand which events or repeats it reaches.
  * Events changed individually by an override, and tasks detached from their series, are marked.
  * **Repeat editor:** besides the presets, a dialog builds the repeat of an event or a task: every n days, weeks, months or years; weekdays; days of the month, the last one included, or the first to fifth or last weekday, weekday (Monday to Friday) or weekend day; for yearly repeats, a month with a day or such an nth day; an end by date or by count. It shows the repeat as a sentence and the next dates, which count the start as the server does, and says where months or years are skipped or where the repeat doesn't fall on the start: a new series or a task counts it as the first date, an event of an existing series moves to the repeat's next date, which the editor names, and an exception, an extra date or a start set off the old repeat stays. Done on an untouched rule hands it back verbatim. A rule the editor can't show in full, or a series of dates without a rule, opens as the closest repeat it can show, with a warning that Done replaces it; a task's rule Lucid can't read is not offered to the editor, as it can only be kept or removed. For an existing series, the editor writes every day part, since a changed rule applies from the series' own start. Repeats are only ever shown in words, never as RRULE text; a series of dates without a rule reads "Repeats on set dates".
  * **Undo:** for 8 seconds after a change to a series that keeps it, the series can be restored exactly as it was read before the change, unless the series has attendees. Undoing a split also removes the new series, and undoing a detach the detached task; if that changed since, the undo is refused and nothing is written.
* **FR-18:** Timezone Support (UTC Storage, Local Display): times are shown in the browser's time zone. A single timed event or task is stored in UTC; a series Lucid gives a zone takes the browser's IANA zone as `TZID` with a `VTIMEZONE`, so it keeps its wall-clock time across DST. A time a daylight-saving change skips shows an hour later that night, and one it repeats is the first of the two, as RFC 5545 reads them; the series keeps its time on every other day. A time entered in an editor that such a change skips is saved where RFC 5545 reads it, an hour later, and the editor says so before saving, so a series entered there repeats at that later time. A browser that reports UTC (Firefox's `privacy.resistFingerprinting`) gets series in UTC without either, as Thunderbird writes them with its zone set to UTC. A series from another zone shows its repeat, and the editors build it, on the days it falls on in the browser's zone: an event that changes its repeat moves to the browser's zone by date, as the editor showed it there, with its exceptions and deleted events, while a task keeps its own and gets the changed repeat translated back to it. A repeat that can't be said in the browser's zone is named with its own and can be kept, replaced by a preset or removed, but not customized; a changed task repeat that can't be said in the task's zone is refused.

### **4.6 Frontend Resilience, UX & i18n**

* **FR-19:** **Global Error Boundaries:** App must not crash on rendering errors of a single event. Faulty events displayed as "Corrupted Event" placeholders; the placeholder of an event or task that failed to render adds it to the problem report (FR-36). An error that breaks the whole page shows a crash screen whose folded error details (Lucid's version, the browser's time zone, locale and user agent, the error and its frames without the host) can be copied into the bug form; nothing is kept or sent.
* **FR-20:** **Offline Indicator:** Visual feedback when backend connection is lost (React Query networkMode).
* **FR-21:** **Internationalization (i18n):** The UI must support multiple languages (English as default). Translations stored in JSON files.
* **FR-22:** **Localization (l10n):** Date and time formats (24h vs AM/PM, Week start Mon vs Sun) must automatically adapt to the browser's navigator.language / locale settings by default, **but must be manually overridable by the user via a settings menu**.
* **FR-23:** **Manual Refresh:** A button in the top bar (in the account menu on screens too narrow for it) and the `r` shortcut reload the calendars, events and tasks on screen from the CalDAV server, past the backend's cache freshness (`X-Lucid-Revalidate`, NFR-01), so a change made in another app shows at once. The button says when it is busy and when it is done, its tooltip tells when the data on screen was loaded, and a failure says which state is still shown.
* **FR-36:** **Problem Report:** a user can download a report about their own session from the account menu, an error message with a reference (also on the login screen), the login screen after a session ended without the user signing out, a corrupted-item placeholder, and any event or task ("Add to problem report"). By default it holds no calendar contents: Lucid version and mode, the server product, the pseudonymised trace of the session's recent CalDAV calls, recorded problems with skeletons, calendar capabilities, the frontend's corrupted-item placeholders (field names only), and the browser's time zone, locale, user agent and window size with the display settings (language, time format, week start, hiding done tasks in the calendar, the number of hidden calendars). An object's raw data is added only after the user has viewed it and ticked an unticked box for that object. The dialog says the report is only downloaded, that GitHub issues are public, and that security findings go to private advisories. Lucid sends nothing itself and keeps no contents for it.

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

* **NFR-08:** **Prometheus Metrics:** Expose metrics at /metrics, only on a separate listener (`LUCID_METRICS_ADDR`), never on the main listener. Without that address there are no metrics.
* **NFR-09:** **Health Checks:** Liveness/Readiness Probes.
* **NFR-23:** **Security Logging (OWASP A09:2021):** Structured Logging (JSON) in server mode; human-readable text in local mode (FR-35), where a person reads the window. Every line logged while serving a request carries its request ID (`request_id`). The line per request is at `debug` level in both modes, so neither mode writes one per request by default (a click in a Windows console window blocks its writes).
* **NFR-36:** **Log Data Minimisation:** no log line, at any level and in either mode, contains calendar contents or credentials. CalDAV paths are pseudonymised (`{home}`, `{principal}`, `{user}`, keyed placeholders below the home), parser errors are reduced to their reason, and documents Lucid cannot read are logged as skeletons (structure without values). API IDs are encrypted resource paths under a key held in RAM only (NFR-20), so URLs in Lucid's and a reverse proxy's logs carry only pseudonyms, with one exception: the routes of one occurrence of a series (`…/occurrences/{recurrenceId}`, `…/following/{recurrenceId}`) carry the occurrence's start time in the URL, so those logs show that time, though not the event's or task's name or content. Security events (NFR-23) keep the username for abuse detection.

### **5.4 Backend & Network Security (OWASP Top 10\)**

* **NFR-03:** **Session Mgmt:** Session Cookies: HttpOnly, Secure, SameSite=Strict. `Secure` is dropped only in local mode (FR-35), which serves plain HTTP on the loopback interface.
* **NFR-04:** **Cryptographic Failures:** TLS Termination mandatory in server mode. Local mode (FR-35) serves plain HTTP on the loopback interface only, where traffic never leaves the machine.
* **NFR-17:** **CSRF Protection:** Synchronizer Token Pattern for all State-Changing Requests.
* **NFR-18:** **Rate Limiting:** Token-Bucket Middleware.
* **NFR-19:** **Security Headers:** CSP, HSTS, X-Frame-Options, X-Content-Type-Options.
* **NFR-20:** **Secrets Management:** No secrets in the configuration. The session key is random per start and only in RAM; the TLS key is read from a file.
* **NFR-21:** **Container Security:** Non-Root User, Read-Only FS.
* **NFR-22:** **SSRF Protection:** Validation of target URLs against internal networks. SafeTransport must apply to Auto-Discovery (incl. Redirects). Server mode allows no internal network by default (`LUCID_PRIVATE_NETWORKS=none`); local mode (FR-35) allows internal networks by default (`LUCID_PRIVATE_NETWORKS=all`), because its one user can reach their own network anyway.
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
  * *Limitation:* Applies to single events and to one event of a series. A change to all events of a series shows the loading state.
* **NFR-27:** **Keyboard Accessibility (WCAG 2.1 AA):** Full keyboard navigation support.

### **5.7 CI/CD & Release Management**

* **NFR-12:** GitHub Actions Pipeline.
* **NFR-13:** Release via **GoReleaser**.
* **NFR-14:** SemVer Versioning.
* **NFR-15:** **Supply Chain:** SBOM Generation & Artifact Signing (Cosign).
* **NFR-16:** **Dependency Management:** Direct dependencies are upgraded on the project's own schedule (`just upgrade`); transitive ones change only where a direct dependency requires it, except to fix a vulnerability that affects Lucid. Daily vulnerability scans (govulncheck and `pnpm audit` of shipped packages on `main` and the latest release, Grype on the base image of the latest release image and on the current base image, a malware check of all frontend packages) and weekly CI against the newest direct dependencies replace update bots; Dependabot only bumps the SHA-pinned GitHub Actions.
* **NFR-35:** **Platforms:** Releases ship binaries for Linux, macOS and Windows, each for amd64 and arm64, and container images for linux/amd64 and linux/arm64; other systems and 32-bit builds are not released. For linux/amd64 and linux/arm64 they also ship deb, rpm and Arch packages, as release assets only, with no package repository. Both modes run on all three systems. Local mode (FR-35) is how Lucid runs on a desktop, and service setups exist for Linux (container, NixOS, Home Manager, the packages' systemd unit) and macOS (Home Manager). CI runs the Go tests on Linux, macOS (arm64) and Windows (amd64). The frontend and E2E tests run on Linux only: the SPA depends on the browser, not on the OS. govulncheck (NFR-11) scans the source once per OS and every release binary, because the vulnerability database marks some entries for one OS or architecture only.

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
