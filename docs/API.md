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
  | 400    | `series_move_unsupported` | This series can't move like this, only this one can |
  | 400    | `series_split_unsupported` | This series can't be split, only this one or all can change |
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

`first` is `true` on the occurrence that is the first one of its series
that the server shows, whatever range was asked for: a range that starts
after it has no event with `first`. The series' first one is the earliest
`recurrenceId` among the rule's instances (`DTSTART` included), the `RDATE`s
and the overrides, none of them an `EXDATE` or a cancelled override. A rule
the server cannot read counts as `DTSTART` only. `hasAttendees` is `true` on
every event of a resource where the series or any override has an `ORGANIZER`
or an `ATTENDEE`; it is the same test the server splits a series by, so a
client that offers "this and following events" only without it never offers
what the server refuses. Both are omitted (`false`) otherwise.

`undoToken` is a response-only field, never part of `EventInput` and never
seen in the list: it appears on the response of the changes below that can be
undone (`POST /api/v1/events/{eventId}/undo`, below). The change of a series
whose resource is larger than 1 MiB, such as one with years of overrides, or
that has an `ORGANIZER` or an `ATTENDEE` on any of its events, succeeds without
it.

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
`Event` (new `etag`), and an `undoToken` if the change can be undone: the
series was recurring before the change (a save that removes its rule
included), the CalDAV server tells its new `etag`, and the series has no
attendees. A single event gets none.

- **Distance:** measured from the occurrence's *shown* start (an exception's
  own start, if the edited occurrence is one), not from `instanceStart`
  itself, to `start`: the series moves by the same change of date and the
  same change of clock time, both in the series' own time zone, so it keeps
  its clock time across a daylight-saving change. The change of date is
  counted in calendar days, or for a `MONTHLY` or `YEARLY` rule without
  `BY` parts in calendar months and then days of the month, from
  `instanceStart` to that date moved by the days the occurrence moved, so
  its events keep their day of the month. A save that turns the series
  all-day or timed moves its start by the change of date only, a timed
  event's date read in the series' zone and an all-day date as sent; a
  series made timed starts at the clock time of `start` in `timezone`.
- **Edited exception:** with the rule and `allDay` unchanged, the edited
  exception, if there is one, takes `start` and `end`. A save that changes
  the rule or `allDay` leaves it at its own start and end (only its
  `RECURRENCE-ID` shifts along with the series).
- **Fields:** only fields changed against the shown occurrence are written
  into the series and into the edited exception, also where the rule or
  `allDay` changes, so an exception's own title does not replace the
  series'; other exceptions keep their own times and fields, only their
  `RECURRENCE-ID` shifts along with the series.
- `UNTIL`, `EXDATE` and `RDATE` shift along with the series in the same
  way (a date-only value by the change of date only).
- The weekdays of a weekly rule with plain `BYDAY` weekdays (no ordinal, no
  other `BY` part) rotate with the shift.
- `400 series_move_unsupported`, and nothing is written, where the series
  can't follow the move ("Only this event" can still move the occurrence
  there; see [RECURRING-EVENTS.md](RECURRING-EVENTS.md#limits)):
  - with the rule and `allDay` unchanged, a rule with fixed days would
    have to move to another day. The frontend does not offer this; the
    check is the server-side safeguard.
  - a `MONTHLY` or `YEARLY` rule without `BY` parts, edited from an
    occurrence on another day of the month than the series' first event
    (an `RDATE`, or an exception left there), would change the date; a
    change of the clock time alone is allowed.
  - for such a rule, the change in months and days would put the series'
    first event or a reference (`EXDATE`, `RDATE`, `RECURRENCE-ID`, and,
    with the rule and `allDay` unchanged, `UNTIL` and the rule's events)
    on a day its month lacks: the 29th to 31st, or February 29 in a
    common year. A monthly series from the 15th can't move to the 31st,
    since February has none. A value on another day of the month than
    the series' first event, such as an `UNTIL` at the end of a month or
    year, or an `RDATE` on the 31st, that a move within the month carries
    past its month's end moves on by calendar days instead, as the events
    do: a series on the 15th with `UNTIL=20261231T225959Z` moved to the
    16th gets `UNTIL=20270101T225959Z`. With a change of month, it is
    refused too.
- **Time zone:** "Only this event" above, and this endpoint when the rule
  and the `allDay` flag are unchanged, keep the series' own time zone; the
  request's `timezone` applies to single (non-recurring) events and to a
  series save that changes the rule or `allDay`.
- `409 conflict`, and nothing is written, where `instanceStart` is no longer
  an occurrence of the series: neither an event of its rule nor one with an
  override, as in a view not reloaded since the series changed, such as
  since it ended or was split before it (`…/following/…` below). Saved, the
  view's rule would replace the series' new end, bringing the deleted events
  back or listing the new series' events twice. The client reloads the
  series, as after an ETag mismatch.

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

`200` with the changed `Event` (new `etag`), and an `undoToken` if the CalDAV
server tells the new `etag` and the series has no attendees. Its `modified` is
`true` when the override visibly changes the occurrence (as defined for the
event list above), and omitted when the saved values are the ones the series
gives there anyway. The override is written as a full copy of the series, not
a diff, so other CalDAV clients still show a title and the other properties.

Errors:
- `400 invalid_input`: `recurrenceId` is not a valid RFC 3339 timestamp with
  whole seconds, the fields are invalid, or `allDay` does not match the series.
- `404 not_found`: the event does not exist, is not a recurring series, or
  `recurrenceId` is not an occurrence of it.
- `409 conflict`/`428 precondition_required`: as for `PUT /events/{id}` above.

### `DELETE /api/v1/events/{eventId}/occurrences/{recurrenceId}` (header `If-Match`)

Excludes only this occurrence ("Only this event"): writes an `EXDATE` and, in
the same write, removes an existing override at the same instant. If no
occurrence of the series is left afterwards, the resource itself is deleted;
a series whose rule the backend cannot read (such as one with the RFC 7529
parts `RSCALE` or `SKIP`) is always kept.

While the series is kept and the CalDAV server tells its new `etag`: `200`
with the new `etag` in the body and in an `ETag` header, to send with the
series' next write, and, if the change can be undone (the series has no
attendees, see `undoToken` above), an `undoToken`:

```json
{ "etag": "\"def\"", "undoToken": "..." }
```

Once the resource is deleted: `204` without a body, an `ETag` header or an
`undoToken`; there is nothing to restore it from. A kept series whose new
`etag` the server does not tell answers `204` as well. Errors: as for the
`PUT` above.

### `PUT /api/v1/events/{eventId}/following/{recurrenceId}` (header `If-Match`)

Changes this occurrence and the following ones as a series of their own
("This and following events"). The series ends before `recurrenceId`, as the
`DELETE` below ends it, and a new series, a resource with a UID of its own,
goes on from it: a copy of the series with `DTSTART` at `recurrenceId` (for
an `RDATE`, which it keeps, at the rule's next event if there is one), the
rule's `COUNT` lowered by the events before it (an `UNTIL` stays), and the
`EXDATE` and `RDATE` values and the overrides from `recurrenceId` on, by the
`RECURRENCE-ID` of an override, never by its own date. Neither refers to the
other; [RECURRING-EVENTS.md](RECURRING-EVENTS.md#this-and-following-events)
has the details. `recurrenceId` is the occurrence's `recurrenceId`: RFC 3339,
UTC, whole seconds, URL-encoded.

Body: `EventInput`; `instanceStart` is ignored, `recurrenceId` is the edited
occurrence. The change applies to the new series as
`PUT /api/v1/events/{eventId}` with `instanceStart` applies it to all events
(distance, edited exception, fields, time zone, see there). `rrule` is the
new series' rule: sent as the series has it (`rrule` of the event in the
list), the new series keeps the rule it inherits, with its lowered `COUNT`,
so a move does not count as a new rule; `""` makes the new series a single
event at `start`; any other rule is the new series' own.

At the series' first event (`first` in the event list above) there is nothing
before it, so this is "all events": it is `PUT /api/v1/events/{eventId}` with
`instanceStart` set to `recurrenceId`, and no new series is created.

Response `200`:

```json
{ "event": { "id": "...", "etag": "\"abc\"", "first": true, "...": "..." },
  "etag": "\"def\"", "undoToken": "..." }
```

- `event`: the edited occurrence in the new series, as the event list shows
  it, with the new series' `id` and `etag`. At the series' first event it is
  the occurrence in the series itself (`event.id` is `eventId`).
- `etag`: the series' new ETag, to send with its next write, `""` when the
  CalDAV server tells none. At the first event it is `event.etag`.
- `undoToken`: as for `PUT /events/{id}` above. The undo writes the series
  back as it was and deletes the new series; once the new series has
  changed, it is refused and writes nothing (see the undo below). There is
  none unless the CalDAV server tells the new `etag` of both series: without
  the series', an undo could not tell its own change from another client's,
  and without the new series', it could not delete the new series, which
  would then stand next to the restored series with every event from
  `recurrenceId` on twice.

The new series is written first, with `If-None-Match: *`, and then the
series, with `If-Match`. If the new series' write fails, the series is not
written. Where the server did not refuse that write (a timeout, a `5xx` of a
proxy), it may have stored the new series all the same: the backend reads
its ETag and deletes it with `If-Match` if it is there. One whose ETag
cannot be read, or is weak, stays (logged), and so does one the server
stores only after that check. If the series' write fails, the new series is
deleted again where that write is known not to have landed: the server
refused it, or the series still has its ETag. A new series whose `etag` the
server did not tell is read again, as after a failed write, and deleted with
the `etag` read; one whose ETag cannot be read, or is weak, stays (logged).
Where its ETag changed, the split counts as saved: `200` with `etag` `""`
and no `undoToken`. Where the ETag cannot be read, the new series stays and
the error is answered.

Errors, with nothing written:
- `400 invalid_input`: `recurrenceId` is not a valid RFC 3339 timestamp with
  whole seconds, or the fields or the `rrule` are invalid. Unlike
  `PUT …/occurrences/…`, the body may change `allDay`, as for
  `PUT /events/{id}`.
- `400 series_split_unsupported`: as for the `DELETE` below, and where the new
  series would be a single event (`recurrenceId` is the last `RDATE`, with no
  event of the rule after it) while the series shows an override off the rule
  after `recurrenceId`, which a single event can't show. A save that removes
  the rule (`rrule` `""` on a series that has one) isn't refused for it: it
  makes the new series the single event entered anyway, and the override
  goes, as do the other events after `recurrenceId`.
- `400 series_move_unsupported`: the new series can't follow the move, as for
  `PUT /events/{id}` above.
- `404 not_found`, `409 conflict`, `428 precondition_required`: as for the
  `DELETE` below.

### `DELETE /api/v1/events/{eventId}/following/{recurrenceId}` (header `If-Match`)

Ends the series before this occurrence ("This and following events"): the
rule gets an `UNTIL` just before `recurrenceId` (the day before for a date,
one second before it otherwise; a `COUNT` of the events before it for a time
zone the backend cannot resolve), and the `EXDATE` and `RDATE`
values and the overrides from `recurrenceId` on are removed, by the
`RECURRENCE-ID` of an override, never by its own date. Earlier events stay as
they are. `recurrenceId` is the occurrence's `recurrenceId`: RFC 3339, UTC,
whole seconds, URL-encoded.

At the series' first event (`first` in the event list above) there is nothing
before it, so this is "all events": the resource is deleted, as by
`DELETE /api/v1/events/{eventId}`. At any later event, the events before it
stay, and so does the resource.

The answer is that of the `DELETE` above for one occurrence: `200` with
`{ "etag": "...", "undoToken": "..." }` and an `ETag` header while the series
is kept and the CalDAV server tells its new `etag`, to send with the series'
next write (`undoToken` as for that `DELETE`), and `204` without a body, an
`ETag` header or an `undoToken` once the resource is deleted or when the new
`etag` is unknown.

Errors:
- `400 invalid_input`: `recurrenceId` is not a valid RFC 3339 timestamp with
  whole seconds.
- `400 series_split_unsupported`, and nothing is written or deleted, where the
  series cannot be split. The first four hold at its first event too, which
  is not deleted then:
  - some event of the resource has an `ORGANIZER` or an `ATTENDEE`
    (`hasAttendees`), as a server that schedules implicitly would tell them;
  - the series has an `EXRULE`, which a new series would count from its own
    start;
  - the series has more than one `RRULE`: the backend reads and ends only the
    first;
  - its rule can't be read by the backend (such as one with the RFC 7529
    parts `RSCALE` or `SKIP`);
  - its rule does not reach `recurrenceId` within the backend's iteration cap;
  - `recurrenceId` is at or before `DTSTART` without being the first event,
    which only an `RDATE` or an override before `DTSTART` leaves possible.
- `404 not_found`: the event does not exist, is not a recurring series, or
  `recurrenceId` is not an event the list shows: no occurrence of the series,
  an `EXDATE`, or an override with `STATUS:CANCELLED`.
- `409 conflict`/`428 precondition_required`: as for `PUT /events/{id}` above.

### `POST /api/v1/events/{eventId}/undo` → `200` `{etag, copyKept}`

Body: `{ "token": "..." }`, strictly decoded; no `If-Match` (the token itself,
single-use and short-lived, is the concurrency control).

Undoes the change that returned `undoToken`, which is one of the changes
above, by writing the series' resource back exactly as that change had read
it. Response `200`:

```json
{ "etag": "\"ghi\"" }
```

`etag` is the resource's new ETag, for the client's next write of the series.
The undo of "this and following events" (`PUT …/following/…`) also deletes
the new series, with `If-Match` of the ETag the split gave it. It reads the
new series' ETag first: if the new series changed since, in Lucid or in
another app, or its ETag is unknown or weak, the undo answers `409 conflict`
and writes nothing, as the restored series would list every event from
`recurrenceId` on a second time next to it; if it was deleted since, the
series is restored and there is nothing to delete. Only a change of the new
series between that read and its delete leaves it next to the restored
series, and the answer has `copyKept: true`. No other change of an event
creates a resource, so it is omitted there.

If the write that restores the series fails without the server's refusal (a
`5xx`, no answer), the undo reads the series back. Only if it is the restored
one does the restore count as applied: its `LAST-MODIFIED`, `DTSTAMP` and
`SEQUENCE` are those of the snapshot, in every component. The undo then
answers `200` without `etag`, and a split's new series is deleted as above.
In any other case (the series is still as the change left it, another client
wrote it since, or it cannot be read) the answer is `502`, nothing is removed,
and the token is kept. A refusal (`4xx`) is answered as above.

| Status | code             | Meaning                                                                      |
|--------|------------------|-------------------------------------------------------------------------------|
| 400    | `invalid_input`  | Malformed body or token                                                     |
| 401    | `unauthenticated`| No/expired session, as elsewhere                                            |
| 403    | `csrf_invalid`   | Missing/wrong CSRF token                                                    |
| 403    | `read_only`      | Calendar is read-only                                                       |
| 404    | `not_found`      | Token unknown, expired, already used, or belongs to another event or to a todo ("nothing to undo") |
| 409    | `conflict`       | The series changed or was deleted since (`If-Match` would have failed), or, for a split, the new series changed since or its ETag is unknown or weak; nothing is written, and the token is used up |
| 429    | `rate_limited`   | Too many requests                                                           |
| 502    | `upstream_error` | CalDAV server error/unreachable, also when the new series of a split cannot be read; the snapshot is kept so the client can retry |

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
  "recurrenceId": "2025-01-07T00:00:00Z" } ] }
```

`priority`: `0` = none, `1` = highest … `9` = lowest (RFC 5545). `status`:
`NEEDS-ACTION | IN-PROCESS | COMPLETED | CANCELLED`.

`undoToken` and `copyKept` are response-only fields, never part of `TodoInput`
and never seen here: `undoToken` appears on the responses of the writes below
(`PUT /todos/{todoId}`, detaching or skipping a repeat, and changing or ending
a series from a repeat on) when the change can be undone, and `copyKept` on
the undo endpoint's response when the completed copy it had created could not
be removed.

`start` is the todo's `DTSTART`. A todo with `DTSTART` and `DURATION` but no
`DUE` reports `start + duration` as `due`. When both `start` and `due` are
set, they must both be dates or both have a time, and `start` must not be
after `due`; otherwise `400 invalid_input`. An update that keeps the stored
`start` and `due` skips this check, so todos from other clients can still be
completed. Writing a todo stores `due` as
`DUE` and drops `DURATION`; a `start` or `due` equal to the stored value keeps
the original property, including its `TZID`.

`rrule`, `recurring`, `fixedDays`, `ruleUnsupported`, `next` and
`recurrenceId` describe a recurring series (VTODO with `RRULE` or `RDATE`,
FR-17):

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
- `recurrenceId` is the `RECURRENCE-ID` of the current occurrence of an open
  series (RFC 3339, UTC), the `recurrenceId` it has in
  `GET .../todos/occurrences`: the writes to one repeat below name it so.
  It is the occurrence's original start, not the dates an override moved it
  to, and is omitted for a todo that does not recur, a completed or
  cancelled series, a `ruleUnsupported` one, and one without an open
  occurrence left.

For an open recurring todo, `start` and `due` are not the series' stored
`DTSTART`/`DUE`: they are those of its **current occurrence**, the oldest one
that is still open (`NEEDS-ACTION`/`IN-PROCESS`). Completing or moving the
todo (see `PUT` below) changes which occurrence that is.

`hasAttendees`, `detachedFrom` and `detachedCopy` are omitted (`false`, empty,
absent) unless they apply:

- `hasAttendees` is `true` when any `VTODO` of the todo's resource, the series
  or an override, has an `ORGANIZER` or an `ATTENDEE`; a server that schedules
  implicitly may then have told others of a change. A change of such a resource
  succeeds without an `undoToken` (see `PUT` below), as an event's does.
- `detachedFrom` is the `UID` of the series the todo was detached from, as the
  property `X-LUCID-DETACHED-FROM` stores it. Every write keeps it but one
  that sets or changes the todo's `rrule`, which drops it, as the todo is then
  a series of its own.
- `detachedCopy` is the todo a detach just made of a series' current repeat (a
  `Todo`, with `detachedFrom`), returned only by
  `PUT /todos/{todoId}/occurrences/{recurrenceId}` (below), like
  `completedCopy` by the `PUT` that completes a repeat; never in a list.

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
  already-written copy is deleted again and the error is returned (a copy
  whose `etag` the server did not tell is read again for that, and stays,
  logged, where its ETag can't be read or is weak). After a failure
  without the server's clear answer (`5xx`, none at all), the backend
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
  (a series without `start` recurs on `due`), and the override of the
  current occurrence goes (but see one another client moved, below). The
  rule follows as far as it can, counted from
  the current occurrence's `RECURRENCE-ID` to the new start in the series'
  zone: an interval rule stays as it is; a weekly rule whose only other part
  is `BYDAY` with plain weekdays rotates its days by the move (`BYDAY=MO,TH`
  moved from a Monday to a Tuesday becomes `BYDAY=TU,FR`; with an `INTERVAL`
  above 1, only where the start and every day stay in one week); any other
  rule on fixed days moves only within the day, and to another time of day
  only without `BYHOUR`, `BYMINUTE` or `BYSECOND`. A move the rule cannot
  follow is `400 series_move_unsupported`, and nothing is written. What
  refers to later occurrences moves with them: their overrides, `EXDATE`s
  and an `UNTIL` from the current occurrence on move by the same amount,
  whole periods of the rule included, in the wall clock of the series
  (counted in calendar months, then days, for a `MONTHLY` or `YEARLY` rule).
  Earlier ones, such as other clients' completions, stay, except an
  `EXDATE` from the new start on: it excluded an occurrence the series left
  behind, and goes. A move that would put an occurrence of the series on one
  another client already marked done or changed, an override that stays, is
  `400 series_move_unsupported` as well, and nothing is written. A change
  between all-day and timed dates converts every override (`RECURRENCE-ID`,
  `DTSTART`, `DUE`), `EXDATE` and the `UNTIL` to the new value type: a date
  gets the new time of day in the series' zone (an `UNTIL` in UTC), a
  date-time becomes its date in the series' zone; the later ones first move
  by the change in date. A `COUNT` no longer counts the rule's instances
  before the moved occurrence, and an `UNTIL` that would end before the new
  dates moves onto them.
  The **last repeat** (a current occurrence with `next: null`) moves to any
  date, also off a rule on fixed days: the rule then ends at it, with an
  `UNTIL` at the new start in the form RFC 5545 wants with `DTSTART`'s (a
  date, floating, or UTC) in place of a `COUNT` or an `UNTIL`; in a `TZID`
  Lucid cannot resolve, with `COUNT=1` instead. An `EXDATE` from the new
  start on goes, and an override another client left there refuses the move
  as above. Completing the last repeat with new dates moves it the same way;
  an earlier one leaves them on its completed copy, which is no move. A
  current occurrence **another client moved**, whose override shows it at
  another start (else due) than its `RECURRENCE-ID`, or which lies **off the
  rule**, moves the series by the distance it moves from where it is shown,
  as an event series moves from an exception. The rule moves by that
  distance from the occurrence's `RECURRENCE-ID`, as above, so a change of
  its time alone keeps the rule's days (`BYDAY=MO` with Monday's repeat
  shown on Wednesday, moved from 09:00 to 10:00 there, recurs on Mondays at
  10:00). From an occurrence off the rule it moves from the rule's last
  instance before it; that instance, done or excluded as the occurrence is
  current, stays out at its new place by its `EXDATE`, which moves along, or
  a new one. The occurrence's override moves along and takes the new dates.
  A change of its `due` alone changes only the occurrence; the last repeat
  moves to any date as above, wherever it is shown. A move together
  with a new `rrule` starts the series over, and the undo below restores the
  resource: neither is such a move.
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
another client has since changed it (`copyKept: true`), and the todo a detach
made (see below). A change of a todo
whose resource has attendees (`hasAttendees`, wherever in the series they
are, also in an override the change drops) succeeds without an `undoToken`:
the server may have sent them the change with the `SEQUENCE` it carries, and a
restore would write an older one back (RFC 5545 section 3.8.7.4).

### `PUT /api/v1/todos/{todoId}/occurrences/{recurrenceId}` (header `If-Match`) → `200` `Todo`

Detaches the current repeat of a recurring todo ("Only this one"): the repeat
becomes a todo of its own, changed by the body, and the series rolls on to its
next repeat. `recurrenceId` is the repeat's `recurrenceId` from
`GET .../todos/occurrences`: RFC 3339, UTC, whole seconds, URL-encoded.

Body (`TodoInput`), as for `PUT /todos/{todoId}`, with two exceptions: its
`rrule` is ignored, as the rule belongs to the series, and its `status` must
leave the repeat open (`NEEDS-ACTION`, `IN-PROCESS`, or absent). `COMPLETED`
or `CANCELLED` is `400 invalid_input`, before anything is read: a repeat is
completed through `PUT /todos/{todoId}`. `start` is handled as there: a body
without it, or without any date, takes the repeat's `start`.

- **The detached todo** is a clone of the repeat as stored, as for a
  completed copy (see `PUT /todos/{todoId}` above), with a new `id`/`uid`.
  It takes the body's dates and the fields the body changes (title, notes,
  checklist with its state, priority), over an override's own. It keeps the
  repeat's alarms: an override's own where it has any, else the series'. It
  is open (`STATUS:NEEDS-ACTION`, without `COMPLETED` or `PERCENT-COMPLETE`),
  and its `X-LUCID-DETACHED-FROM` is the series' `UID` (`detachedFrom`).
- **The series** rolls on as after a completion, to its next repeat, also
  from a repeat off the rule, whose override goes. Its title, notes and
  priority stay as stored, whatever the body says, as only the detached
  repeat changes. It is `NEEDS-ACTION` again, without `PERCENT-COMPLETE`, and
  its own checklist is unchecked, as it belongs to the next repeat now.

The detached todo is written first (`If-None-Match: *`), then the series
(`If-Match`). If the series can't be written, the detached todo is deleted
again, as a completed copy is, and the error is returned. `200` with the
rolled series, the detached todo as `detachedCopy`, and an `undoToken` if the
change can be undone: as for `PUT /todos/{todoId}`, and only where the server
tells the new `etag` of both. The undo restores the series and deletes the
detached todo, unless that changed since (see the undo below).

At the series' **last repeat** (`next: null`) there is no next one to roll
to: the request is `PUT /todos/{todoId}` with the body (without its `rrule`),
which changes the task itself, and answers as that does, without
`detachedCopy`.

Errors:
- `400 invalid_input`: `recurrenceId` is not a valid RFC 3339 timestamp with
  whole seconds; the body is invalid or completes or cancels the repeat;
  `recurrenceId` is a later open repeat than the current one; or Lucid can't
  evaluate the series' rule (*"the repeat rule cannot be evaluated"*).
- `400 series_split_unsupported`: the todo's resource has attendees
  (`hasAttendees`), at any repeat, the last one too. The repeat, still open,
  would leave them: the detached todo is written without `ORGANIZER` and
  `ATTENDEE`, as a completed copy is, and a server that schedules implicitly
  would tell them only that the series rolled on.
- `403 read_only`: the calendar is read-only.
- `404 not_found`: the todo does not exist.
- `409 conflict`: `If-Match` mismatch, or `recurrenceId` is no open
  repeat of the series any more, as in a view not reloaded since the series
  changed elsewhere: it is done, the series rolled past it, it is excluded,
  cancelled or none of the series, or the todo is completed, cancelled, or no
  longer recurs. Reload and retry.
- `428 precondition_required`: `If-Match` missing.

Nothing is written for any of these.

### `DELETE /api/v1/todos/{todoId}/occurrences/{recurrenceId}` (header `If-Match`) → `200` `Todo`

Skips the current repeat of a recurring todo: the series rolls on to its next
repeat as after a completion, without a copy, also from a repeat off the
rule, whose override goes. No field changes but those of the roll: the series
is `NEEDS-ACTION` again, without `PERCENT-COMPLETE`, and its checklist is
unchecked. `200` with the rolled series (new `etag`) and an `undoToken` if the
change can be undone, as for `PUT /todos/{todoId}`.

The series' **last repeat** (`next: null`) is not skipped (`400
invalid_input`): it would leave a series without a repeat; the client deletes
the task instead. Errors otherwise as for the `PUT` above, except that a
resource with attendees is skipped, without an `undoToken`, as nothing new is
written for it.

### `PUT /api/v1/todos/{todoId}/following/{recurrenceId}` (header `If-Match`) → `200` `{todo, series, undoToken}`

Changes this repeat of a recurring todo and the following ones as a series of
their own ("This and following"), as for events (see
`PUT /events/{eventId}/following/{recurrenceId}`). The series ends before
`recurrenceId`, as the `DELETE` below ends it, and a new series, a todo with
an `id` and `uid` of its own, goes on from it, changed by the body.
`recurrenceId` is the repeat's `recurrenceId` from `GET .../todos/occurrences`
(or the todo's own `recurrenceId` for its current repeat): RFC 3339, UTC,
whole seconds, URL-encoded.

The new series is a copy of the series with all its properties, alarms
included, and its `VTIMEZONE`s, with a new `uid`, `SEQUENCE:0`, and `DTSTART`
and `DUE` at the repeat's place in the rule, in the form they are written in
(a series without `start` gets one equal to its `due`, as on a completion).
Its rule's `COUNT` is lowered by the repeats before it; an `UNTIL` stays. The
`EXDATE`s and the overrides from `recurrenceId` on go to it, by the
`RECURRENCE-ID` of an override, never by its own dates, and leave the series.
It is open (`NEEDS-ACTION`, without `COMPLETED` or `PERCENT-COMPLETE`), its
checklist unchecked: the series' progress belongs to its current repeat.
It drops `X-LUCID-DETACHED-FROM`, KDE's pending occurrence and the links to
the series' subtasks (`RELATED-TO;RELTYPE=CHILD`), which stay with the series;
other relations stay. Neither series refers to the other.
[RECURRING-TASKS.md](RECURRING-TASKS.md#writing) has the details.

Body: `TodoInput`, as for `PUT /todos/{todoId}`, whose status must leave the
repeat open (`NEEDS-ACTION`, `IN-PROCESS`, or absent): `COMPLETED` or
`CANCELLED` is `400 invalid_input`, before anything is read. The body changes
the new series as `PUT /todos/{todoId}` changes a series from its current
repeat, which the repeat is in the new series: new dates move it, the rule
following as far as it can (see "Moving the series" there), and the fields
replace its own. Its status and its checklist's state are those of a series
that rolls on, though: `NEEDS-ACTION`, every item unchecked, whatever the body
says. `start` is handled as there: a body without it, or without any date,
takes the repeat's `start`. `rrule` is the new series' rule: absent, or sent
as the series has it (`rrule` of the todo, compared case-insensitively), the
new series keeps the rule it inherits, with its lowered `COUNT`, so a move
does not count as a new rule; `""` makes the new series a single todo at the
body's dates; any other rule is the new series' own, from the repeat on, which
drops the overrides it took along.

Completions another client recorded from `recurrenceId` on, overrides with
`STATUS:COMPLETED`, become completed todos of their own first, as when a
changed rule drops them (see "Completions from other clients" under
`PUT /todos/{todoId}`), and leave both series: the new series excludes such a
repeat of its rule with an `EXDATE`, so that it shows once, done, as its own
todo, and not open again. A change that creates any returns no `undoToken`.

At the series' **current repeat** nothing comes before it: the request is
`PUT /todos/{todoId}` with the body, also at its last repeat, no new series is
created, and both `todo` and `series` are the series as written.

Response `200`:

```json
{ "todo": { "id": "...", "etag": "\"abc\"", "recurrenceId": "...", "...": "..." },
  "series": { "id": "...", "etag": "\"def\"", "...": "..." }, "undoToken": "..." }
```

- `todo`: the new series, as the todo list shows it, with its `id` and `etag`.
- `series`: the series as written, ending before `recurrenceId`, with its new
  `etag` to send with its next write, `""` when the CalDAV server tells none.
- `undoToken`: as for `PUT /todos/{todoId}`; it undoes the change at the
  series' route, `POST /todos/{todoId}/undo` with the series' `id`. The undo
  writes the series back as it was and deletes the new series; once the new
  series has changed, it is refused and writes nothing (see the undo below).
  There is none unless the CalDAV server tells the new `etag` of both series,
  as for events.

The completed todos of other clients' completions are written first, then
the new series (`If-None-Match: *`), then the series (`If-Match`). The writes
fail as for events: if the new series cannot be written, the series is not
written; if the series cannot be written, the new series is deleted again
where that write is known not to have landed, the server refused it or the
series still has its ETag, and so are the completed todos. Where the series'
ETag changed, the change counts as saved: `200` with `series.etag` `""` and
no `undoToken`. Where it cannot be read, the new series and the completed
todos stay, and the error is answered.

Errors, with nothing written:
- `400 invalid_input`: `recurrenceId` is not a valid RFC 3339 timestamp with
  whole seconds; the body is invalid, or completes or cancels the repeat.
- `400 series_split_unsupported`: as for the `DELETE` below.
- `400 series_move_unsupported`: the new series can't follow the move, as for
  `PUT /todos/{todoId}`.
- `403 read_only`, `404 not_found`, `409 conflict`, `428
  precondition_required`: as for `PUT /todos/{todoId}/occurrences/…` above;
  a `recurrenceId` that is no open repeat of the series any more, as in a view
  not reloaded since, is `409`.

### `DELETE /api/v1/todos/{todoId}/following/{recurrenceId}` (header `If-Match`) → `200` `Todo`

Ends the series of a recurring todo before this repeat ("This and following",
as for events): the rule gets an `UNTIL` just before `recurrenceId` (the day
before for a date, one second before it otherwise, in UTC unless floating; a
`COUNT` of the repeats before it in a time zone the backend cannot resolve),
and the `EXDATE`s and the overrides from `recurrenceId` on are removed, by the
`RECURRENCE-ID` of an override, never by its own dates. Earlier repeats stay
as they are, the current one among them, so the series always keeps an open
repeat. Completions another client recorded from `recurrenceId` on become
completed todos of their own first, as for the `PUT` above, and then there is
no `undoToken`; they are deleted again if the series cannot be written, as
there. `recurrenceId` as for the `PUT` above.

`200` with the series as written (new `etag`, `""` when the CalDAV server
tells none) and an `undoToken` if the change can be undone, as for
`PUT /todos/{todoId}`.

At the series' **current repeat** nothing comes before it: the todo is
deleted, as by `DELETE /api/v1/todos/{todoId}`, also at its last repeat, and
the answer is `204` without a body or an `undoToken`.

Errors, with nothing written or deleted:
- `400 invalid_input`: `recurrenceId` is not a valid RFC 3339 timestamp with
  whole seconds.
- `400 series_split_unsupported`, where the series cannot be split. The first
  four hold at its current repeat too, which is not deleted then:
  - some `VTODO` of the resource has an `ORGANIZER` or an `ATTENDEE`
    (`hasAttendees`), as a server that schedules implicitly would tell them of
    a series that ends and of another with a `uid` of its own;
  - the series has an `EXRULE`, which the backend does not read and a new
    series would count from its own start;
  - the series has more than one `RRULE`: the backend reads and ends only the
    first;
  - its rule can't be evaluated by the backend (`ruleUnsupported`, any
    `RDATE` included);
  - its rule does not reach `recurrenceId` within the backend's iteration cap;
  - `recurrenceId` is a repeat off the rule, an override whose
    `RECURRENCE-ID` lies on none of the rule's occurrences, from which no new
    series can recur.
- `403 read_only`, `404 not_found`, `409 conflict`, `428
  precondition_required`: as for the `PUT` above.

### `POST /api/v1/todos/{todoId}/undo` → `200` `Todo`

Body: `{ "token": "..." }`, strictly decoded; no `If-Match` (the token itself,
single-use and short-lived, is the concurrency control).

Undoes the change that returned `undoToken`. Response `200` with the restored
`Todo` (new `etag`, no `completedCopy`); `copyKept: true` when the completed
copy the change had created could not be removed and still exists.

The undo of a detach also deletes the detached todo, and the undo of a change
of a repeat and the following ones (`PUT …/following/…`) the new series, each
with `If-Match` of the ETag the change gave it. It reads that ETag first: if
the todo changed since, in Lucid or in another client, or its ETag is unknown
or weak, the undo is refused with `409` and writes nothing, as the series
restored next to it would show that repeat, or every repeat from
`recurrenceId` on, twice, and deleting it would lose the change. If it was
deleted since, the series is restored and there is nothing to delete. A
completed copy is a record of its own instead: it may stay (`copyKept`).

If the write that restores the series fails without the server's refusal (a
`5xx`, no answer), the undo reads the series back, as the undo of an event
does. Only if it is the restored one does the restore count as applied: the
answer is `200` without `etag`, and the completed copy is removed as above.
In any other case the answer is `502`, the copy stays, and the token is kept.

| Status | code             | Meaning                                                                      |
|--------|------------------|-------------------------------------------------------------------------------|
| 400    | `invalid_input`  | Malformed body or token                                                     |
| 401    | `unauthenticated`| No/expired session, as elsewhere                                            |
| 403    | `csrf_invalid`   | Missing/wrong CSRF token                                                    |
| 403    | `read_only`      | Calendar is read-only                                                       |
| 404    | `not_found`      | Token unknown, expired, already used, or belongs to another todo ("nothing to undo") |
| 409    | `conflict`       | Todo changed or was deleted since (`If-Match` would have failed), or the todo a detach made or the new series of a split changed since; nothing is written |
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
