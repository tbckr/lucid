# Lucid REST API (v1)

This is the contract between the frontend (`web/`) and the Go backend
(`internal/httpapi`). JSON types mirror `internal/domain/domain.go`.

## Conventions

- Base path: `/api/v1`. Request and response bodies are `application/json`
  (UTF-8). Request bodies are limited to 1 MiB.
- All timestamps are RFC 3339 strings. The backend returns UTC (`...Z`).
  All-day events use midnight UTC of the date, `end` is exclusive.
- IDs (`calendarId`, `eventId`, `todoId`) are opaque URL-safe strings. Use them
  verbatim in paths.
- Authentication: session cookie `lucid_session` (HttpOnly, Secure,
  SameSite=Strict). The frontend never sees credentials after login.
- **CSRF**: every `POST`, `PUT`, `PATCH`, `DELETE` must send the header
  `X-CSRF-Token: <token>`. The token comes from `GET /api/v1/session` or from
  the login response and is rotated on login. Missing/invalid token → `403`
  with code `csrf_invalid`; the frontend should refetch `/session` and retry once.
- **Concurrency**: `PUT`/`DELETE` of events and todos must send
  `If-Match: <etag>` (the `etag` field, verbatim). Mismatch → `409 conflict`.
- Errors always have this shape:

  ```json
  { "error": { "code": "conflict", "message": "human readable text" } }
  ```

  | Status | code                  | Meaning                                        |
  |--------|-----------------------|------------------------------------------------|
  | 400    | `invalid_input`       | Validation failed (`message` says why)         |
  | 400    | `forbidden_target`    | Server URL points to a blocked (internal) net  |
  | 401    | `unauthenticated`     | No/expired session → show login                |
  | 401    | `invalid_credentials` | Login rejected by the CalDAV server            |
  | 403    | `csrf_invalid`        | Missing/wrong CSRF token                       |
  | 403    | `read_only`           | Calendar is read-only                          |
  | 404    | `not_found`           | Calendar/event/todo does not exist             |
  | 409    | `conflict`            | ETag mismatch, reload and retry                |
  | 422    | `discovery_failed`    | No CalDAV service found at the given URL       |
  | 422    | `unsupported_component` | Calendar does not accept this type (event/todo) |
  | 428    | `precondition_required` | `If-Match` header missing                    |
  | 429    | `rate_limited`        | Too many requests (`Retry-After` header set)   |
  | 502    | `upstream_error`      | CalDAV server error / unreachable              |
  | 500    | `internal`            | Unexpected server error                        |

## Session & Auth

### `GET /api/v1/session`

Always `200`. Creates an anonymous session (and cookie) if none exists so the
login request can carry a CSRF token.

```json
{ "authenticated": true, "username": "tim", "serverUrl": "https://dav.example.com", "csrfToken": "...", "version": "1.2.0" }
```

When not logged in: `{ "authenticated": false, "csrfToken": "...", "version": "1.2.0" }`.

`version` is the version of the running binary, as printed by `lucid --version`
(`dev` for builds without version information). The SPA shows it on the login
page and in the settings.

### `POST /api/v1/auth/login`

Body: `{ "serverUrl": "https://cloud.example.com", "username": "tim", "password": "..." }`

`serverUrl` may be a bare domain (`example.com`); the backend then tries
`https://`, `/.well-known/caldav`, and DNS SRV (`_caldavs._tcp`).
The session ID is rotated. Response `200`: same shape as `GET /session`
(with the new `csrfToken`). Errors: `invalid_input`, `invalid_credentials`,
`discovery_failed`, `forbidden_target`, `upstream_error`, `rate_limited`
(login has a stricter rate limit).

### `POST /api/v1/auth/logout`

`204`. Destroys the session and clears the cookie.

## Calendars

### `GET /api/v1/calendars`

```json
{ "calendars": [ { "id": "...", "name": "Personal", "description": "", "color": "#3b82f6",
                   "readOnly": false, "supportsEvents": true, "supportsTodos": false } ] }
```

`supportsEvents`/`supportsTodos` come from the calendar's
`supported-calendar-component-set`; without it, both are `true`. Some servers
create calendars that hold only events or only todos.

## Events

### `GET /api/v1/calendars/{calendarId}/events?start=<RFC3339>&end=<RFC3339>`

Returns all occurrences overlapping `[start, end)`; recurring series are
expanded server-side. The range may span at most 366 days.

```json
{ "events": [ {
  "id": "...", "key": "...@2025-01-06T09:00:00Z", "calendarId": "...", "uid": "...",
  "etag": "\"abc\"", "title": "Standup", "description": "", "location": "",
  "start": "2025-01-06T09:00:00Z", "end": "2025-01-06T09:15:00Z", "allDay": false,
  "timezone": "Europe/Berlin", "rrule": "FREQ=WEEKLY;BYDAY=MO", "recurring": true,
  "recurrenceId": "2025-01-06T09:00:00Z" } ] }
```

Use `key` as the React key / occurrence identity; `id` identifies the
resource for updates/deletes.

### `POST /api/v1/calendars/{calendarId}/events`

Body (`EventInput`):

```json
{ "title": "Lunch", "description": "", "location": "", "start": "...", "end": "...",
  "allDay": false, "timezone": "Europe/Berlin", "rrule": "" }
```

`201` with the created `Event` (not expanded; for recurring events the
first occurrence).
`422 unsupported_component` if the calendar does not accept events
(`supportsEvents: false`).

### `PUT /api/v1/events/{eventId}` (header `If-Match`)

Body: `EventInput`. For an occurrence of a recurring series additionally send
`"instanceStart": <recurrenceId of the edited occurrence>`: the change is
applied to the **whole series** (shifted by `start - instanceStart`).
`200` with the updated `Event` (new `etag`).

### `DELETE /api/v1/events/{eventId}` (header `If-Match`)

`204`. Deletes the resource (for recurring events: the whole series).

## Todos

### `GET /api/v1/calendars/{calendarId}/todos`

```json
{ "todos": [ { "id": "...", "calendarId": "...", "uid": "...", "etag": "...",
  "title": "Water plants", "description": "", "checklist": [],
  "start": null, "startAllDay": false,
  "due": "2025-01-07T00:00:00Z", "dueAllDay": true, "priority": 1,
  "status": "NEEDS-ACTION", "completed": null,
  "rrule": "FREQ=WEEKLY", "recurring": true, "fixedDays": false, "ruleUnsupported": false,
  "next": { "start": null, "due": "2025-01-14T00:00:00Z" } } ] }
```

`priority`: `0` = none, `1` = highest … `9` = lowest (RFC 5545). `status`:
`NEEDS-ACTION | IN-PROCESS | COMPLETED | CANCELLED`.

`start` is the todo's `DTSTART`. A todo with `DTSTART` and `DURATION` but no
`DUE` reports `start + duration` as `due`. When both `start` and `due` are
set, they must both be dates or both have a time, and `start` must not be
after `due`; otherwise `400 invalid_input`. An update that keeps the stored
`start` and `due` skips this check, so todos from other clients can still be
completed. Writing a todo stores `due` as
`DUE` and drops `DURATION`; a `start` or `due` equal to the stored value keeps
the original property, including its `TZID`.

`rrule`, `recurring`, `fixedDays`, `ruleUnsupported` and `next` describe a
recurring series (VTODO with `RRULE` or `RDATE`, FR-17):

- `rrule` is the stored `RRULE` (RFC 5545), empty for a non-recurring todo.
- `recurring` is `true` for any such series, evaluable or not.
- `fixedDays` is `true` when the series recurs on fixed calendar days rather
  than at a fixed interval from its anchor: an `RRULE` part other than
  `FREQ`/`INTERVAL`/`COUNT`/`UNTIL`/`WKST`, or any `RDATE`.
- `ruleUnsupported` is `true` for a series Lucid cannot evaluate: an
  unparsable `RRULE`, neither `start` nor `due` at all, or any `RDATE`. Such a
  series is reported once, with its stored dates, and does **not** appear in
  `GET .../todos/occurrences`.
- `next` is the earliest open occurrence after the current one (`{ "start",
  "due" }`), or `null` if this is the last (or the series is not recurring,
  or `ruleUnsupported`).

For an open recurring todo, `start` and `due` are not the series' stored
`DTSTART`/`DUE`: they are those of its **current occurrence**, the oldest one
that is still open (`NEEDS-ACTION`/`IN-PROCESS`). Completing or moving the
todo (see `PUT` below) changes which occurrence that is.

### `GET /api/v1/calendars/{calendarId}/todos/occurrences?start=<RFC3339>&end=<RFC3339>`

Returns the occurrences of open, evaluable recurring todos (`recurring: true`,
`ruleUnsupported: false`, not `COMPLETED`/`CANCELLED`) overlapping `[start,
end)`. Same range limit as events: at most 366 days.

```json
{ "occurrences": [ {
  "key": "...@2025-01-14T00:00:00Z", "todoId": "...", "calendarId": "...",
  "recurrenceId": "2025-01-14T00:00:00Z", "title": "Water plants",
  "start": null, "startAllDay": false,
  "due": "2025-01-14T00:00:00Z", "dueAllDay": true, "state": "upcoming" } ] }
```

`state` is `current` (the occurrence the todo's own `start`/`due` describe,
and that `PUT` acts on), `upcoming`, or `done` (completed out of order by
another CalDAV client, kept in the list as history). Use `key` as the React
key / occurrence identity; `todoId` identifies the underlying resource, like
a todo's `id`.

### `POST /api/v1/calendars/{calendarId}/todos`

Body (`TodoInput`): `{ "title", "description", "checklist", "start", "startAllDay", "due", "dueAllDay", "priority", "status", "rrule", "timezone" }` → `201` `Todo`.
`422 unsupported_component` if the calendar does not accept todos
(`supportsTodos: false`). `timezone` is the IANA zone timed `start`/`due`
recur in; without it, a series uses UTC.

### `PUT /api/v1/todos/{todoId}` (header `If-Match`) → `200` `Todo`

The body replaces the todo's fields, with one exception for `start`: a body
without `start` keeps the stored `DTSTART` (clients that predate the field),
and `null` removes it unless the todo recurs (`RRULE`), which keeps its
`DTSTART` as RFC 5545 requires.

`rrule` follows the same absent/empty/value convention as `TodoInput`:
absent keeps the stored rule, `""` removes it (the todo becomes a single,
non-recurring task at the current occurrence's dates), any other value sets
it. Setting `status` to `COMPLETED` sets `completed`; any other status clears
it.

For a recurring todo, these three edits are handled specially:

- **Completing the current occurrence** (`status: COMPLETED` on an open
  series): the backend creates a completed copy of the occurrence — a new
  todo, its own `id`/`uid`, no rule, the occurrence's dates — and rolls the
  master to its next open occurrence (`NEEDS-ACTION`, checklist reset, a
  `COUNT` rule converted to an equivalent `UNTIL` once so the remaining
  occurrence count survives the rewrite). The response is the **rolled
  master**, with the copy attached as `completedCopy`. On the series' last
  occurrence there is no next one: the master itself becomes `COMPLETED` and
  `completedCopy` is absent. If writing the rolled master fails, the
  already-written copy is deleted again and the error is returned.
- **Moving the series** (`start`/`due` different from the stored ones): the
  master's `DTSTART`/`DUE` become the new dates, keeping their written form
  (a series without `start` recurs on `due`). Exceptions later than the
  current occurrence shift by the same offset. The backend does not enforce
  the move window the UI shows; that is a client-side hint only.
- **Changing `rrule`**: the new rule applies from the current occurrence on;
  earlier occurrences and completed copies are untouched. It needs a `start`
  or `due` to recur from, otherwise `400 invalid_input`, message *"a
  repeating task needs a start or due date"*.

A series with `ruleUnsupported: true` cannot be completed, moved, or given a
new `rrule`: any of those is `400 invalid_input`, message *"the repeat rule
cannot be evaluated"*. Removing its rule (`rrule: ""`) and other field edits
(title, description, checklist, priority, status other than completing it)
still work.

There is no dedicated undo endpoint. Undoing a move or a completion replays
the previous state: `PUT` the master with its previous `start`/`due`/
`status`/`checklist`, then, for a completion, `DELETE` the `completedCopy`
it created.

### `DELETE /api/v1/todos/{todoId}` (header `If-Match`) → `204`

## Operations (outside `/api`)

- `GET /healthz` – liveness, `200 {"status":"ok"}`
- `GET /readyz` – readiness, `200 {"status":"ok"}` or `503` while shutting down
- `GET /metrics` – Prometheus metrics (optionally on a separate listener, see config)
- Everything else serves the SPA (`index.html` fallback for unknown non-asset paths).

## Configuration (environment variables only)

| Variable                      | Default   | Description |
|-------------------------------|-----------|-------------|
| `LUCID_ADDR`                  | `:8080`   | Listen address |
| `LUCID_METRICS_ADDR`          | (empty)   | If set, `/metrics` is served only on this address instead of `LUCID_ADDR` |
| `LUCID_TLS_CERT`, `LUCID_TLS_KEY` | (empty) | Serve HTTPS directly. Otherwise TLS must be terminated by a reverse proxy |
| `LUCID_SESSION_KEY`           | random    | 32-byte key (base64 or hex) encrypting credentials in sessions. Random per start if unset (sessions are in-memory anyway) |
| `LUCID_SESSION_TTL`           | `12h`     | Absolute session lifetime |
| `LUCID_SESSION_IDLE_TIMEOUT`  | `2h`      | Idle timeout |
| `LUCID_COOKIE_INSECURE`       | `false`   | Drop the `Secure` cookie flag (local HTTP development only) |
| `LUCID_ALLOW_PRIVATE_NETWORKS`| `false`   | Allow CalDAV servers on private/loopback addresses (self-hosting on a LAN) |
| `LUCID_ALLOWED_CIDRS`         | (empty)   | Comma-separated CIDRs exempted from SSRF blocking, e.g. `192.168.1.10/32` |
| `LUCID_RATE_LIMIT_RPS`        | `20`      | Token bucket refill per client IP (API) |
| `LUCID_RATE_LIMIT_BURST`      | `60`      | Token bucket size |
| `LUCID_LOGIN_RATE_LIMIT_PER_MIN` | `10`   | Login attempts per client IP per minute |
| `LUCID_TRUST_PROXY_HEADERS`   | `false`   | Use `X-Forwarded-For` for client IP (only behind a trusted proxy) |
| `LUCID_CACHE_SIZE`            | `256`     | Cached calendars (LRU) |
| `LUCID_CACHE_FRESHNESS`       | `10s`     | Serve cache without CTag check for this long |
| `LUCID_UPSTREAM_TIMEOUT`      | `20s`     | Timeout for requests to CalDAV servers |
| `LUCID_LOG_LEVEL`             | `info`    | `debug`, `info`, `warn`, `error` (JSON logs to stdout) |
