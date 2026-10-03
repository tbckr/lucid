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
  "recurrenceId": "2025-01-06T09:00:00Z", "modified": false } ] }
```

Use `key` as the React key / occurrence identity; `id` identifies the
resource for updates/deletes. `modified` is `true` for an occurrence of a
series whose override visibly changed it (start, duration, all-day, title,
location or description); it is omitted (`false`) otherwise.

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
applied to the **whole series** ("All events"). `200` with the updated
`Event` (new `etag`).

- **Distance:** measured from the occurrence's *shown* start (an exception's
  own start, if the edited occurrence is one), not from `instanceStart`
  itself, to `start`: the series moves by the same change of date and the
  same change of clock time, both in the series' own time zone, so it keeps
  its clock time across a daylight-saving change. The change of date is
  counted in calendar days, or for a `MONTHLY` or `YEARLY` rule without
  `BY` parts in calendar months and then days of the month, from
  `instanceStart` to that date moved by the days the occurrence moved, so
  its events keep their day of the month. A move onto a day that the month
  of the series' first event lacks (the 29th to 31st, or February 29) does
  not keep that day (see [RECURRING-EVENTS.md](RECURRING-EVENTS.md#limits)).
  A save that turns the series all-day or timed moves its start by the
  change of date only, a timed event's date read in the series' zone and an
  all-day date as sent; a series made timed starts at the clock time of
  `start` in `timezone`. The edited exception, if there is one, takes
  `start` and `end`.
- **Fields:** only fields changed against the shown occurrence are written
  into the series and into the edited exception; other exceptions keep their
  own times and fields, only their `RECURRENCE-ID` shifts along with the
  series.
- `UNTIL`, `EXDATE` and `RDATE` shift along with the series in the same
  way (a date-only value by the change of date only).
- The weekdays of a weekly rule with plain `BYDAY` weekdays (no ordinal, no
  other `BY` part) rotate with the shift.
- `400 invalid_input` if a rule with fixed days would have to move to
  another day. The frontend does not offer this; the check is the
  server-side safeguard, and there is no new error code for it.
- **Time zone:** "Only this event" above, and this endpoint when the rule
  and the `allDay` flag are unchanged, keep the series' own time zone; the
  request's `timezone` applies to single (non-recurring) events and to a
  series save that changes the rule or `allDay`.

### `DELETE /api/v1/events/{eventId}` (header `If-Match`)

`204`. Deletes the resource (for recurring events: the whole series).

### `PUT /api/v1/events/{eventId}/occurrences/{recurrenceId}` (header `If-Match`)

Changes only one occurrence of a recurring series ("Only this event"),
writing or editing an override that lives in the same resource. `recurrenceId`
is the occurrence's `recurrenceId`: RFC 3339, UTC, whole seconds, URL-encoded.

Body (`OccurrenceInput`): like `EventInput`, but without `rrule` (the rule
belongs to the series, not the occurrence) and without `instanceStart`:

```json
{ "title": "Lunch", "description": "", "location": "", "start": "...", "end": "...",
  "allDay": false, "timezone": "Europe/Berlin" }
```

`200` with the changed `Event` (new `etag`). Its `modified` is `true` when the
override visibly changes the occurrence (as defined for the event list
above), and omitted when the saved values are the ones the series gives
there anyway. The override
is written as a full copy of the series, not a diff, so other CalDAV clients
still show a title and the other properties.

Errors:
- `400 invalid_input`: `recurrenceId` is not a valid RFC 3339 timestamp with
  whole seconds, the fields are invalid, or `allDay` does not match the series.
- `404 not_found`: the event does not exist, is not a recurring series, or
  `recurrenceId` is not an occurrence of it.
- `409 conflict`/`428 precondition_required`: as for `PUT /events/{id}` above.

### `DELETE /api/v1/events/{eventId}/occurrences/{recurrenceId}` (header `If-Match`)

Excludes only this occurrence ("Only this event"): writes an `EXDATE` and, in
the same write, removes an existing override at the same instant. `204`. If
no occurrence of the series is left afterwards, the resource itself is
deleted; a series whose rule the backend cannot read (such as one with the
RFC 7529 parts `RSCALE` or `SKIP`) is always kept. While the series is kept,
the `204` carries its new `etag` in an `ETag` header (unless the CalDAV
server tells none), to send with the series' next write; once the resource
is deleted, it carries none. Errors: as for the `PUT` above.

## Todos

### `GET /api/v1/calendars/{calendarId}/todos`

```json
{ "todos": [ { "id": "...", "calendarId": "...", "uid": "...", "etag": "...",
  "title": "Water plants", "description": "", "checklist": [],
  "start": null, "startAllDay": false,
  "due": "2025-01-07T00:00:00Z", "dueAllDay": true, "priority": 1,
  "status": "NEEDS-ACTION", "completed": null,
  "rrule": "FREQ=WEEKLY", "recurring": true, "fixedDays": false, "ruleUnsupported": false,
  "next": { "start": null, "startAllDay": false, "due": "2025-01-14T00:00:00Z", "dueAllDay": true },
  "moveWindow": null } ] }
```

`priority`: `0` = none, `1` = highest … `9` = lowest (RFC 5545). `status`:
`NEEDS-ACTION | IN-PROCESS | COMPLETED | CANCELLED`.

`undoToken` and `copyKept` are response-only fields, never part of `TodoInput`
and never seen here: `undoToken` appears on the `PUT` response below when the
change can be undone, and `copyKept` on the undo endpoint's response when the
completed copy it had created could not be removed.

`start` is the todo's `DTSTART`. A todo with `DTSTART` and `DURATION` but no
`DUE` reports `start + duration` as `due`. When both `start` and `due` are
set, they must both be dates or both have a time, and `start` must not be
after `due`; otherwise `400 invalid_input`. An update that keeps the stored
`start` and `due` skips this check, so todos from other clients can still be
completed. Writing a todo stores `due` as
`DUE` and drops `DURATION`; a `start` or `due` equal to the stored value keeps
the original property, including its `TZID`.

`rrule`, `recurring`, `fixedDays`, `ruleUnsupported`, `next` and `moveWindow`
describe a recurring series (VTODO with `RRULE` or `RDATE`, FR-17):

- `rrule` is the stored `RRULE` (RFC 5545), empty for a non-recurring todo.
- `recurring` is `true` for any such series, evaluable or not.
- `fixedDays` is `true` when the series recurs on fixed calendar days rather
  than at a fixed interval from its anchor: an `RRULE` part other than
  `FREQ`/`INTERVAL`/`COUNT`/`UNTIL`/`WKST`, or any `RDATE`.
- `ruleUnsupported` is `true` for a series Lucid cannot evaluate: an
  unparsable `RRULE`, one that cannot be evaluated within 100,000 iterations,
  neither `start` nor `due` at all, or any `RDATE`. Such a series is reported
  once, with its stored dates, and does **not** appear in
  `GET .../todos/occurrences`.
- `next` is the earliest open occurrence after the current one (`{ "start",
  "startAllDay", "due", "dueAllDay" }`), or `null` if this is the last (or the
  series is not recurring, or `ruleUnsupported`). Its value types are its own:
  an override can change `start`/`due` between a date and a time independently
  of the current occurrence's or the master's.
- `moveWindow` (`{ "from", "until" }`) is where a move of the current
  occurrence must keep its anchor (`start`, else `due`): from `from` on and
  before `until`, see `PUT` below. Its bounds are the **rule's days**, the
  days of the current and the next occurrence's `RECURRENCE-ID` in the
  series' zone; they differ from `start`/`due` and `next` when another
  client moved those occurrences to other dates. A series on fixed days has
  one: `from` is the start of the current occurrence's rule day and `until`
  the start of `next`'s rule day, or `next`'s own `RECURRENCE-ID` instant
  when it falls on the current occurrence's rule day (several repeats a
  day, such as `BYHOUR=9,17`); `until` is `null` for the last repeat. A
  current occurrence off the rule (see `PUT`) moves on its own, so with a
  `next` it has the same `until` in any series, and `from` is `null`: it has
  no rule day of its own to stay from; without a `next`, its move is free.
  `moveWindow` is `null` where a move is free, and for a series that is
  completed, cancelled or `ruleUnsupported`. When the current occurrence is
  all-day, `from` and `until` are dates, written as midnight UTC like `start`
  and `due`; a `next` on the current occurrence's own rule day then ends the
  window with that day, and the server still holds a time of day before `next`
  (see `PUT`). Otherwise they are instants. The series' zone need not be the
  client's, so a day of the client's can lie partly inside the window. A timed
  current occurrence of an all-day series, one another client gave a time,
  gets the rule's dates at midnight UTC as instants, while the server checks a
  time by its date in the zone it is written in (see `PUT`): near midnight in
  a zone other than UTC, a client that checks the instants can refuse a move
  the server accepts, or send one the server refuses with `400`. Nothing wrong
  is stored either way.

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

For a recurring todo, these edits are handled specially:

- **Completing the current occurrence** (`status: COMPLETED` on an open
  series): the backend creates a completed copy — a clone of the occurrence
  as stored, so it can carry an override's own title and notes, under its
  own `id`/`uid`, with no rule and the occurrence's dates; alarms and
  scheduling properties (`ORGANIZER`, `ATTENDEE`) are removed — and rolls the
  master to its next open occurrence (`NEEDS-ACTION`, checklist reset, a
  `COUNT` rule converted to an equivalent `UNTIL` once so the remaining
  occurrence count survives the rewrite). The response is the **rolled
  master**, with the copy attached as `completedCopy`. On the series' last
  occurrence there is no next one: the master itself becomes `COMPLETED` and
  `completedCopy` is absent. If writing the rolled master fails, the
  already-written copy is deleted again and the error is returned. After a
  failure without the server's clear answer (`5xx`, none at all), the backend
  reads the master's ETag back first: unchanged, the copy goes; changed, the
  completion succeeds without `etag` and without `undoToken`; unreadable, the
  copy stays and the error is returned. An occurrence **off the rule** (an
  override whose `RECURRENCE-ID` lies on none of the rule's occurrences, such
  as a move to an earlier day leaves behind) is not one the master can roll
  onto. When it is the next occurrence, the master's dates stay: completing an
  occurrence of the rule excludes it with an `EXDATE` instead of rolling, and
  completing one off the rule drops its override. Otherwise the master rolls
  as usual, also from an occurrence off the rule.
- **Moving the series** (`start`/`due` different from the stored ones): the
  master's `DTSTART`/`DUE` become the new dates, keeping their written form
  (a series without `start` recurs on `due`). What refers to later
  occurrences stays with them: with an interval rule, their overrides,
  `EXDATE`s and an `UNTIL` from the current occurrence on move by the same
  amount, whole periods of the rule included, in the wall clock of the
  series (counted in calendar months, then days, for a `MONTHLY` or
  `YEARLY` rule); with fixed days by the change in time of day only,
  because the rule's days stay. A change between all-day and timed dates
  converts every override (`RECURRENCE-ID`, `DTSTART`, `DUE`), `EXDATE` and
  the `UNTIL` to the new value type: a date gets the new time of day in the
  series' zone (an `UNTIL` in UTC), a date-time becomes its date in the
  series' zone. With an interval rule, the later ones also move by the
  change in date; with fixed days they stay on their days. The override of
  the current occurrence goes. A `COUNT` no longer counts the rule's
  instances before the moved occurrence, and an `UNTIL` that would end
  before the new dates moves onto them. A current occurrence off the rule
  moves on its own: its override takes the new dates, and the series stays.
  A move whose anchor (`start`, else `due`) leaves `moveWindow` is
  `400 invalid_input`, and nothing is written: before `from`, message *"a
  repeat on fixed days cannot move before its own day"*; from `until` on, *"a
  repeat on fixed days must stay before its next repeat"*. The check counts
  the rule's days in the series' own value type, so a time given to an all-day
  current occurrence of a timed series must still stay before a `next` on the
  same day. An anchor of the other value type than the series counts on its
  day: a date as that day in the series' zone, a time on its date in the zone
  it is written in (the series' own, or `timezone` for an all-day series that
  gains a time). The last repeat completed with new dates moves the master and
  is checked the same way; an earlier one leaves them on its completed copy,
  which is no move. A move together with a new `rrule` starts the series over
  and is not checked, nor is the undo below, which restores the resource.
- **Changing `rrule`**: the new rule applies from the current occurrence on;
  earlier occurrences and completed copies are untouched, except that the
  overrides that stay and an `UNTIL` take the new value type when the dates
  change between all-day and timed, as for a move. The overrides from the
  current occurrence on go, and so do the old rule's `EXDATE`s. It needs a
  `start` or `due` to recur from, otherwise `400 invalid_input`, message
  *"a repeating task needs a start or due date"*.
- **Removing `rrule`** (`""`): the todo keeps the current occurrence's dates
  and loses its overrides and `EXDATE`s.
- **Completions from other clients**: when changing or removing `rrule`
  drops an override with `STATUS:COMPLETED`, the backend first creates a
  completed todo of its own for it (`If-None-Match: *`), a clone of the
  occurrence like a completed copy that keeps the `COMPLETED` time the other
  client recorded; the response does not report it. If writing the master
  fails, these todos are deleted again and the error is returned, after a
  failure without a clear answer only as for a completed copy. A change
  that created any returns no `undoToken`.

A series with `ruleUnsupported: true` cannot be completed, moved, or given a
new `rrule`: any of those is `400 invalid_input`, message *"the repeat rule
cannot be evaluated"*. Removing its rule (`rrule: ""`) and other field edits
(title, description, checklist, priority, status other than completing it)
still work.

Undo is its own endpoint (`POST /api/v1/todos/{todoId}/undo`, below) rather
than another `PUT`: it restores the todo's resource exactly as the change
that returned `undoToken` had read it, instead of replaying that edit in
reverse. It also removes the completed copy that change left, if any, unless
another client has since changed it (`copyKept: true`).

### `POST /api/v1/todos/{todoId}/undo` → `200` `Todo`

Body: `{ "token": "..." }`, strictly decoded; no `If-Match` (the token itself,
single-use and short-lived, is the concurrency control).

Undoes the change that returned `undoToken`. Response `200` with the restored
`Todo` (new `etag`, no `completedCopy`); `copyKept: true` when the completed
copy the change had created could not be removed and still exists.

| Status | code             | Meaning                                                                      |
|--------|------------------|-------------------------------------------------------------------------------|
| 400    | `invalid_input`  | Malformed body or token                                                     |
| 401    | `unauthenticated`| No/expired session, as elsewhere                                            |
| 403    | `csrf_invalid`   | Missing/wrong CSRF token                                                    |
| 403    | `read_only`      | Calendar is read-only                                                       |
| 404    | `not_found`      | Token unknown, expired, already used, or belongs to another todo ("nothing to undo") |
| 409    | `conflict`       | Todo changed or was deleted since (`If-Match` would have failed)            |
| 429    | `rate_limited`   | Too many requests                                                           |
| 502    | `upstream_error` | CalDAV server error/unreachable; the snapshot is kept so the client can retry |

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
