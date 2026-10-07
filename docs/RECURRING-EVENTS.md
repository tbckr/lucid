# Recurring events: changing, moving and deleting one occurrence

This document records how CalDAV clients and servers handle overrides of
recurring events (a `VEVENT` with `RRULE`, plus a second `VEVENT` sharing its
`UID` and carrying a `RECURRENCE-ID`) and deleted occurrences (`EXDATE`). It is
the basis for Lucid's "Only this event", "This and following events" and "All
events" writes (FR-17), which [Lucid's behavior](#lucids-behavior) describes.
The API is in [API.md](API.md#events).

The survey was done on 2026-10-02, in two reports: part A covers DAVx⁵ with
the Android calendar provider and the Etar and Fossify Calendar apps,
Thunderbird, GNOME Evolution, KDE (KCalendarCore, the Akonadi DAV resource,
KOrganizer, Merkuro) and Outlook CalDAV Synchronizer; part B covers Apple
Calendar, Google Calendar, Nextcloud Calendar, SOGo, Roundcube (Kolab
plugin), InfCloud and eM Client as clients, and iCloud, Google, Nextcloud/
SabreDAV, Baïkal, Radicale and SOGo as servers. Every section below names the
commit or release that was read, and every claim carries one of these labels,
as in [RECURRING-TASKS.md](RECURRING-TASKS.md):

- **code**: read in the client's or server's source at the linked commit.
  Survey B marks a few findings "(run)" where the code was also executed
  (Nextcloud Calendar, under Node 24 with ical.js 2.2.1).
- **issue**: from an issue tracker, documentation, a forum post, or
  iCalendar data captured by others. "Search preview" means a host was
  blocked by the sandbox proxy and only the search-result snippet was read.
- **inferred**: a deduction from code or reports, not observed directly.
- **unknown**: searched for, not found.

KDE Bugzilla, GNOME GitLab, SourceForge and rfc-editor.org could not be
reached for part A, so issue evidence for KDE and GNOME comes only from other
projects' trackers. Apple, iCloud, Google and eM Client are closed source;
none of their claims is **code** about the product itself.

## Summary

- **Writing a full-copy override plus an `EXDATE` for a deletion is safe to
  read across every surveyed client and server**, provided the format
  matches what the majority already writes. Apple, Google, Nextcloud
  Calendar, SOGo, Roundcube, InfCloud, Thunderbird, the Android apps (via
  DAVx⁵), Evolution, KDE and Outlook CalDAV Synchronizer all write this
  shape; every surveyed server (Radicale, SabreDAV, Nextcloud, Baïkal,
  iCloud, Google) stores it. eM Client is unknown. Outside the survey's
  scope, Open-Xchange, Bedework and Zoho are reported to handle overrides
  badly.
- The conditions that make an override round-trip correctly: a full copy of
  the occurrence (no partial override, no `RRULE`/`RDATE`/`EXDATE` inside
  it), `RECURRENCE-ID` written in exactly the series' `DTSTART` form, the
  series as the first `VEVENT`, an `EXDATE` in that same form for a deleted
  occurrence with any override at that instant removed in the same write,
  never a `STATUS:CANCELLED` override, no duplicate `EXDATE`, and the
  resource deleted once no occurrence is left. See the per-client sections
  below for which client breaks on which deviation.
- **"All occurrences" after an override exists has no shared behavior.**
  Apple, SOGo, Roundcube, InfCloud, Thunderbird and Nextcloud (from the
  first occurrence only) shift existing overrides' `RECURRENCE-ID` by the
  series' time delta, leaving the overrides' own time untouched. `EXDATE` is
  shifted the same way only by Thunderbird, SOGo and InfCloud; elsewhere
  deleted occurrences come back after the series moves. No surveyed client
  copies a changed title into existing overrides (Apple copied a newly added
  `LOCATION` once); attendee changes are propagated by SOGo and Roundcube.
  `BYDAY` follows a weekday move only in KDE (weekly rules), Fossify (a
  single weekday) and Outlook (its day mask); everyone else leaves it, and
  some clients drop overrides outright on a big move (SOGo's editor, eM
  Client and Apple Calendar 8.0 in 2014).
- **"This and following" is a split in every writer surveyed**, old series
  `UNTIL`'d, new series a new UID, never `RANGE=THISANDFUTURE` for their own
  edits (SabreDAV, Radicale and Apple ignore `RANGE` on read too). The one
  exception is KDE, which writes a `RANGE=THISANDFUTURE` override for "also
  future" edits and is also the only client that reads `RANGE` fully.
  Evolution reads it partially. Later overrides are carried into the new
  series only by Apple (and seemingly Google); Nextcloud deletes them,
  InfCloud and Roundcube orphan or drop them, and Etar and Fossify leave
  them as orphans next to the shifted series too.

## What the standards say

- `RECURRENCE-ID` *"MUST have the same value type as the "DTSTART" property
  contained within the recurring component. Furthermore, this property MUST
  be specified as a date with local time if and only if the "DTSTART"
  property contained within the recurring component is specified as a date
  with local time."* Its value *"is the original value of the "DTSTART"
  property of the recurrence instance"*, so a moved occurrence keeps its old
  `RECURRENCE-ID`.
  ([RFC 5545 §3.8.4.4](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.4.4))
- `EXDATE` values are removed from the set generated by `RRULE` and `RDATE`
  ([§3.8.5.1](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.5.1)).
  Unlike `RECURRENCE-ID`, no rule requires `EXDATE` to share `DTSTART`'s
  value type.
- `RANGE=THISANDFUTURE` lets an override apply to *"the given recurrence
  instance and all subsequent instances"*, rescheduled together
  ([§3.8.4.4](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.4.4)), but
  the RFC itself suggests the alternative for rules with several days:
  *"the calendar application could simply truncate the unbounded recurring
  calendar component (i.e., with the "COUNT" or "UNTIL" rule parts), and
  create two new unbounded recurring calendar components for the future
  instances."* `RANGE` is poorly supported in practice (see the per-client
  sections), which is why Lucid does not write it.
- CalDAV puts all components with one `UID` into one resource. A resource
  *"can … just contain components that represent "overridden" instances …
  without also including the "master" recurring component"*
  ([RFC 4791 §4.1](https://www.rfc-editor.org/rfc/rfc4791#section-4.1)).
  Readers must therefore expect orphan overrides, and a single `UID` cannot
  span two resources — an occurrence cannot move to another calendar.

## Overview

| Client / server | Reads overrides (match); orphans | Keeps others' overrides & `EXDATE` | Writes "only this" | Delete one | "All" + time change: existing overrides | This and following |
|---|---|---|---|---|---|---|
| Thunderbird | by instant; shown as an extra event | yes, with `If-Match` | full copy | `EXDATE` | `RECURRENCE-ID`/`EXDATE`/`RDATE`/`UNTIL` shifted, override's own time kept | not implemented |
| DAVx⁵ + Android provider | exact instant; shown as an extra event | yes, rebuilt from provider rows, `If-Match`; `CANCELLED` → `EXDATE` | full copy (per calendar app) | cancelled row → `EXDATE` | not shifted | apps split: `UNTIL` + new UID |
| Etar | as Android provider | yes | full copy | cancelled row → `EXDATE` | not shifted; `BYDAY` start snaps back | split (`UNTIL`/`COUNT`) |
| Fossify Calendar | by local day; hides that day | yes | full copy | cancelled row → `EXDATE` | not shifted | split |
| GNOME Evolution | by instant | yes, but PUT without `If-Match` | full copy, `RECURRENCE-ID` in UTC | `EXDATE` in UTC | not shifted; `BYDAY` not adjusted | split, new UID |
| KDE | by instant; orphan hidden | yes, `If-Match`; `CANCELLED` → `EXDATE` | full copy | `EXDATE` (Merkuro: wrong value type on timed series) | not shifted server-side; weekly `BYDAY` adjusted | edit: `RANGE=THISANDFUTURE`; delete: `UNTIL` |
| Outlook CalDAV Synchronizer | by date + master's time; orphan skipped, then deleted | no, resource regenerated from Outlook | full copy, no `RRULE` | `EXDATE` in UTC; skipped if an override exists | overrides/`EXDATE` recomputed from Outlook, often lost | no split, no `RANGE` |
| Apple Calendar | match unknown | yes (captures); 2014 data-loss report | full copy, `RECURRENCE-ID` in `DTSTART`'s form | `EXDATE` (+ drops the override, iPhone) | `RECURRENCE-ID` shifted, own time kept; a new `LOCATION` copied in once | split: `UNTIL` + new UID, `RELATED-TO` |
| Google (CalDAV) | serves full copies in master form; orphans | unknown for CalDAV writes | (accepts overrides) | `EXDATE` in exports | unknown; third-party sources contradict | split: `UNTIL` + `_R<start>`, no link |
| Nextcloud Calendar | by instant; drops `VALUE=DATE`/floating mismatches | yes, whole tree re-serialized | full clone, `SEQUENCE` reset | `EXDATE` + override removed | from the first occurrence: `RECURRENCE-ID` shifted, `EXDATE`/`UNTIL` not; from later ones: time change discarded | split: `UNTIL`, new UUID, `RELATED-TO;RELTYPE=SIBLING`; later overrides/`EXDATE` deleted |
| SOGo | by instant; master must be `VEVENT` #1 | yes | full copy, `RECURRENCE-ID` in UTC | `EXDATE` + override removed | `RECURRENCE-ID` & `EXDATE` shifted; editor deletes overrides the new rule no longer covers | not offered |
| Roundcube (Kolab) | by date only | yes, drops unknown non-`X-` properties | full copy | `EXDATE` + override removed | `RECURRENCE-ID` shifted, `EXDATE` not; single-day `BYDAY` removed | split: `UNTIL`, new UID; a time change loses the master's `EXDATE`s |
| InfCloud | string compare, `TZID` ignored | yes (other `VEVENT`s verbatim) | full copy, master `TZID` | `EXDATE` (UTC) + override removed | `RECURRENCE-ID` & `EXDATE` shifted | split: `COUNT`, new UID; later overrides orphaned |
| eM Client | unknown | series edit "resets all events" (2014) | unknown | unknown | reset (2014) | trims the rule; split or `RANGE` unknown |
| iCloud (server) | stores overrides; adds a 2nd `DTSTAMP` on read | – | – | – | – | `recurrence-split` POST in CalendarServer; iCloud itself unknown |
| Nextcloud server / SabreDAV | `EventIterator`: by timestamp, `RANGE` ignored | – | – | – | – | – |
| Baïkal | as SabreDAV | – | – | – | – | – |
| Radicale | time-range by instant; `expand` strict | – | – | – | – | `RANGE` ignored |

## Clients and servers

### Thunderbird

Read at [`c08a88e`](https://github.com/mozilla/releases-comm-central/tree/c08a88ed5eef9a5ffb99a9947fe6b302bfb020f1/calendar)
(comm-central mirror, 2026-10-02).

- Overrides are keyed by `RECURRENCE-ID` converted to UTC, so UTC and `TZID`
  forms of the same instant match; a floating value or a `DATE` does not
  match a zoned instance. **code + inferred**
  ([CalRecurrenceInfo.sys.mjs#L20-L29](https://github.com/mozilla/releases-comm-central/blob/c08a88ed5eef9a5ffb99a9947fe6b302bfb020f1/calendar/base/src/CalRecurrenceInfo.sys.mjs#L20-L29))
- Every override, including one matching no instance, is shown at its own
  `DTSTART` as an extra event. **code**
  ([CalRecurrenceInfo.sys.mjs#L477-L496](https://github.com/mozilla/releases-comm-central/blob/c08a88ed5eef9a5ffb99a9947fe6b302bfb020f1/calendar/base/src/CalRecurrenceInfo.sys.mjs#L477-L496))
- Overrides are standalone items and do not inherit missing properties from
  the master, so one without `SUMMARY` shows untitled. **code + inferred**
  ([CalItemBase.sys.mjs#L159-L164, L481-L487](https://github.com/mozilla/releases-comm-central/blob/c08a88ed5eef9a5ffb99a9947fe6b302bfb020f1/calendar/base/src/CalItemBase.sys.mjs#L159-L487))
- Dragging an occurrence always changes only that occurrence, with no
  prompt (bug 352862); opening one asks "this occurrence / all occurrences".
  **code**
  ([calendar-views-utils.js#L65-L104](https://github.com/mozilla/releases-comm-central/blob/c08a88ed5eef9a5ffb99a9947fe6b302bfb020f1/calendar/base/content/calendar-views-utils.js#L65-L104),
  [calendar-item-editing.js#L635-L682](https://github.com/mozilla/releases-comm-central/blob/c08a88ed5eef9a5ffb99a9947fe6b302bfb020f1/calendar/base/content/item-editing/calendar-item-editing.js#L635-L682))
- Deleting one occurrence removes its override, if any, and adds an
  `EXDATE`; it never writes a `CANCELLED` override. **code**
  ([calendar-views-utils.js#L187-L209](https://github.com/mozilla/releases-comm-central/blob/c08a88ed5eef9a5ffb99a9947fe6b302bfb020f1/calendar/base/content/calendar-views-utils.js#L187-L209))
- Setting the master's start date shifts every exception's `RECURRENCE-ID`,
  every `EXDATE`, `RDATE` and a non-`COUNT` `UNTIL` by the same delta. The
  overrides' own `DTSTART`/`DTEND` are left alone (bug 1890975) unless the
  master itself is dragged. **code**
  ([CalEvent.sys.mjs#L183-L197](https://github.com/mozilla/releases-comm-central/blob/c08a88ed5eef9a5ffb99a9947fe6b302bfb020f1/calendar/base/src/CalEvent.sys.mjs#L183-L197),
  [CalRecurrenceInfo.sys.mjs#L753-L819](https://github.com/mozilla/releases-comm-central/blob/c08a88ed5eef9a5ffb99a9947fe6b302bfb020f1/calendar/base/src/CalRecurrenceInfo.sys.mjs#L753-L819))
- A title or other field change on the master is not propagated to
  overrides, and `BYDAY` is never adjusted on a weekday move. **code +
  inferred**
  ([calendar-item-iframe.js#L2849-L2877](https://github.com/mozilla/releases-comm-central/blob/c08a88ed5eef9a5ffb99a9947fe6b302bfb020f1/calendar/base/content/item-editing/calendar-item-iframe.js#L2849-L2877))
- "This and following" is not implemented: the button is hidden and the
  code path throws `NS_ERROR_NOT_IMPLEMENTED`. **code**
  ([calendar-occurrence-prompt.xhtml#L46-L52](https://github.com/mozilla/releases-comm-central/blob/c08a88ed5eef9a5ffb99a9947fe6b302bfb020f1/calendar/base/content/dialogs/calendar-occurrence-prompt.xhtml#L46-L52))
- No GitHub report of Thunderbird dropping or duplicating overrides was
  found; Bugzilla was not reachable. **unknown**

### DAVx⁵ with the Android calendar provider

DAVx⁵ only syncs; the user sees events through an app on Android's
`CalendarContract` provider. Read at
[`v4.5.20-ose`](https://github.com/bitfireAT/davx5-ose/tree/76e443f6634aaf608044ed0ecc5c5906fa1a6926)
(`76e443f`, 2026-09-27) and AOSP CalendarProvider
[`38e4d45`](https://github.com/aosp-mirror/platform_packages_providers_calendarprovider/tree/38e4d4533220e6e18d314dfb1d777b34c4d45797).

- A resource is split by `UID`; each override becomes its own provider row,
  matched to an instance by its begin time **as an instant**. An override
  matching no instance shows as its own event; a `STATUS:CANCELLED`
  override hides its instance and itself. **code**
  ([CalendarInstancesHelper.java#L441-L521](https://github.com/aosp-mirror/platform_packages_providers_calendarprovider/blob/38e4d4533220e6e18d314dfb1d777b34c4d45797/src/com/android/providers/calendar/CalendarInstancesHelper.java#L441-L521))
- Overrides do not inherit from the main event, so one without `SUMMARY`
  shows untitled. **code + inferred**
  ([TitleBuilder.kt#L14-L16](https://github.com/bitfireAT/davx5-ose/blob/76e443f6634aaf608044ed0ecc5c5906fa1a6926/synctools/src/main/kotlin/at/bitfire/synctools/mapping/calendar/builder/TitleBuilder.kt#L14-L16))
- An upload regenerates the whole resource from the provider rows; a
  cancelled exception row is written as an `EXDATE`, not as an override,
  which the maintainer calls intended. **code**
  ([AndroidEventHandler.kt#L112-L159](https://github.com/bitfireAT/davx5-ose/blob/76e443f6634aaf608044ed0ecc5c5906fa1a6926/synctools/src/main/kotlin/at/bitfire/synctools/mapping/calendar/AndroidEventHandler.kt#L112-L159);
  [davx5-ose discussion #1132](https://github.com/bitfireAT/davx5-ose/discussions/1132), 2024-11-17). **issue**
- `RECURRENCE-ID` is written in the main event's time zone (or UTC), as
  `VALUE=DATE` for all-day series. Before 2026-04 it used the exception's
  own zone, which made a server compare strings and show a duplicate.
  **code**
  ([OriginalInstanceTimeHandler.kt#L22-L43](https://github.com/bitfireAT/davx5-ose/blob/76e443f6634aaf608044ed0ecc5c5906fa1a6926/synctools/src/main/kotlin/at/bitfire/synctools/mapping/calendar/handler/OriginalInstanceTimeHandler.kt#L22-L43);
  [synctools#80](https://github.com/bitfireAT/synctools/issues/80)). **issue**
- An override that itself carried an `RRULE` was once shown as a duplicate
  occurrence; DAVx⁵ now strips recurrence properties from exceptions.
  **issue**
  ([discussion #558](https://github.com/bitfireAT/davx5-ose/discussions/558), 2024-02)
- DAVx⁵ 4.5.12 wrote an all-day `EXDATE` without `VALUE=DATE`; Nextcloud
  rejected the PUT with 415 and the event failed every sync (fixed
  2026-05-26). **issue**
  ([synctools#406](https://github.com/bitfireAT/synctools/issues/406))
- **Etar** (read at [`89b5c64`](https://github.com/Etar-Group/Etar-Calendar/tree/89b5c64d9ce1c79d765624211a164370f6f020fe),
  2026-10-01): shows the provider's instances (exact-instant matching,
  orphans as extra events). "Only this occurrence" inserts a full-copy row;
  the copy once also took the main event's `EXDATE`, which Radicale
  rejected with 400 until DAVx⁵ started stripping it. **code + issue**
  ([Radicale#1635](https://github.com/Kozea/Radicale/issues/1635)). Deleting
  one writes a cancelled row, not an `EXDATE`. **code**
  ([DeleteEventHelper.java#L374-L406](https://github.com/Etar-Group/Etar-Calendar/blob/89b5c64d9ce1c79d765624211a164370f6f020fe/app/src/main/java/com/android/calendar/DeleteEventHelper.java#L374-L406))
  "All occurrences" shifts only the master's `DTSTART`; neither
  `ORIGINAL_INSTANCE_TIME` nor `EXDATE` move, so overrides become orphans
  and deleted occurrences return, and `BYDAY` is not adjusted (the start
  snaps back to the rule's weekday). **code**
  ([EditEventHelper.java#L840-L858, L1448-L1516](https://github.com/Etar-Group/Etar-Calendar/blob/89b5c64d9ce1c79d765624211a164370f6f020fe/app/src/main/java/com/android/calendar/event/EditEventHelper.java#L840-L1516))
- **Fossify Calendar** (read at
  [`5e8f7c8`](https://github.com/FossifyOrg/Calendar/tree/5e8f7c80b1f4015a9b12a6da20e2e4e8285e005a),
  2026-10-02): an exception hides the parent's instance by **local calendar
  day**, not by instant, so stale day codes can hide valid occurrences.
  **code + issue**
  ([Fossify#641](https://github.com/FossifyOrg/Calendar/issues/641), 2026-02)
  "Only this occurrence" inserts a full-copy row; until October 2025 its
  `RECURRENCE-ID` was the new time instead of the original one, which gave
  DAVx⁵ 404s. **issue**
  ([Fossify#460](https://github.com/FossifyOrg/Calendar/issues/460))
  "All occurrences" shifts only the master's `DTSTART`; exception rows and
  `ORIGINAL_INSTANCE_TIME` are not shifted. **code**
  ([EventsHelper.kt#L307-L322](https://github.com/FossifyOrg/Calendar/blob/5e8f7c80b1f4015a9b12a6da20e2e4e8285e005a/app/src/main/kotlin/org/fossify/calendar/helpers/EventsHelper.kt#L307-L322))

### GNOME Evolution

Read at evolution-data-server
[`c4f57c6`](https://github.com/GNOME/evolution-data-server/tree/c4f57c61c00505ce778e0bee175501675d591298)
and evolution
[`5ada137`](https://github.com/GNOME/evolution/tree/5ada1374457b80db985059368062b7180695e259)
(both 2026-09-29).

- Matching is by instant (`time_t`); `DATE`, floating values and
  unresolvable `TZID`s are read in the user's display zone, so a
  `VALUE=DATE` `RECURRENCE-ID` on a timed series matches nothing and both
  the occurrence and the override show. **code + inferred**
  ([e-cal-client.c#L2221-L2247](https://github.com/GNOME/evolution-data-server/blob/c4f57c61c00505ce778e0bee175501675d591298/src/calendar/libecal/e-cal-client.c#L2221-L2247))
- An override matching no occurrence shows as a standalone event. **code**
  ([e-cal-client.c#L2348-L2366](https://github.com/GNOME/evolution-data-server/blob/c4f57c61c00505ce778e0bee175501675d591298/src/calendar/libecal/e-cal-client.c#L2348-L2366))
- Every change PUTs the whole resource rebuilt from all cached components,
  but **Evolution sends no `If-Match`**: the default is `KEEP_LOCAL`, which
  PUTs with an empty ETag and overwrites any concurrent change silently.
  **code + inferred**
  ([e-cal-util.c#L3401-L3413](https://github.com/GNOME/evolution-data-server/blob/c4f57c61c00505ce778e0bee175501675d591298/src/calendar/libecal/e-cal-util.c#L3401-L3413))
- "Only this occurrence" is a full copy with `RRULE`/`RDATE`/`EXDATE`/
  `EXRULE` removed. For a `TZID` series, `RECURRENCE-ID` is written **in
  UTC** ("to have RECURRENCE-ID in a fixed timezone"), which round-trips as
  a second override if another client compares `RECURRENCE-ID` strings.
  **code + inferred**
  ([e-cal-client.c#L2150-L2184](https://github.com/GNOME/evolution-data-server/blob/c4f57c61c00505ce778e0bee175501675d591298/src/calendar/libecal/e-cal-client.c#L2150-L2184))
- Delete one writes an `EXDATE` (UTC for `TZID` series) and drops the
  matching override; it deletes the whole resource if no occurrence would
  remain, and never writes `CANCELLED`. **code**
  ([e-cal-meta-backend.c#L2218-L2267](https://github.com/GNOME/evolution-data-server/blob/c4f57c61c00505ce778e0bee175501675d591298/src/calendar/libedata-cal/e-cal-meta-backend.c#L2218-L2267))
- `MOD_ALL` replaces only the master: no `RECURRENCE-ID`/`EXDATE` shift and
  no field propagation, so old overrides become extra events and deleted
  occurrences return after a time change. `BYDAY` is never adjusted.
  **code + inferred**
  ([e-cal-meta-backend.c#L1922-L1938](https://github.com/GNOME/evolution-data-server/blob/c4f57c61c00505ce778e0bee175501675d591298/src/calendar/libedata-cal/e-cal-meta-backend.c#L1922-L1938))
- "This and following" splits the series: the old master gets `UNTIL`, the
  new one a new UID, no `RELATED-TO`; `RANGE=THISANDFUTURE` is used only in
  outgoing iTIP CANCELs. Later overrides stay behind as orphans. **code**
  ([e-cal-util.c#L1767-L1822](https://github.com/GNOME/evolution-data-server/blob/c4f57c61c00505ce778e0bee175501675d591298/src/calendar/libecal/e-cal-util.c#L1767-L1822))
- No report of Evolution dropping other clients' overrides was found on
  GitHub; the lost-update risk above comes from the code only. **unknown**

### KDE (KCalendarCore, Akonadi DAV resource, KOrganizer, Merkuro)

Read at kcalendarcore
[`230e6e9`](https://github.com/KDE/kcalendarcore/tree/230e6e92ac0713d99bac0d0bdb4401540deb6621),
kdepim-runtime
[`b1ef934`](https://github.com/KDE/kdepim-runtime/tree/b1ef934e5b43f61772c83a9353bba1c95e705f02),
korganizer
[`3c4491f`](https://github.com/KDE/korganizer/tree/3c4491fa3347e4e363a5a8b7417f04758b47e7f0)
and merkuro
[`a4c72ba`](https://github.com/KDE/merkuro/tree/a4c72ba5e944eac3724ea6fa7773fa0181b21d08)
(2026-09-28 to 2026-10-02).

- Each override becomes its own Akonadi item; a `STATUS:CANCELLED` override
  is **not kept**, it becomes an `EXDATE` on the master. **code**
  ([utils.cpp#L354-L386](https://github.com/KDE/kdepim-runtime/blob/b1ef934e5b43f61772c83a9353bba1c95e705f02/resources/dav/resource/utils.cpp#L354-L386))
- An override matching no occurrence is **not shown** while the master
  exists — the opposite of Thunderbird, Evolution and the Android apps.
  **code**
  ([occurrenceiterator.cpp#L107-L109](https://github.com/KDE/kcalendarcore/blob/230e6e92ac0713d99bac0d0bdb4401540deb6621/src/occurrenceiterator.cpp#L107-L109))
- `RANGE=THISANDFUTURE` is read fully: such an override's fields and offset
  apply to every later occurrence until the next override. **code**
  ([icalformat_p.cpp#L1751-L1770](https://github.com/KDE/kcalendarcore/blob/230e6e92ac0713d99bac0d0bdb4401540deb6621/src/icalformat_p.cpp#L1751-L1770))
- Every "only this" path makes a full clone via `Calendar::createException`,
  PUTs master + all overrides with `If-Match`. **code**
  ([calendar.cpp#L370-L403](https://github.com/KDE/kcalendarcore/blob/230e6e92ac0713d99bac0d0bdb4401540deb6621/src/calendar.cpp#L370-L403))
- Dragging "all occurrences" moves the master only and adjusts **weekly
  `BYDAY`**, swapping the old weekday for the new one; other rule types are
  not adjusted. **code**
  ([incidencechanger.cpp#L1256-L1294](https://github.com/KDE/akonadi-calendar/blob/7f6c9dc2b6ab30a944c79dc0517d6e97da726e63/src/incidencechanger.cpp#L1256-L1294))
- Overrides are **not shifted on the server**: KCalendarCore shifts
  `RECURRENCE-ID`s in memory only (since 2025-07) and nothing writes that
  back, so they become orphans for every other client. **code + inferred**
  ([memorycalendar.cpp#L518-L524](https://github.com/KDE/kcalendarcore/blob/230e6e92ac0713d99bac0d0bdb4401540deb6621/src/memorycalendar.cpp#L518-L524))
- "Also future items" writes a **`RANGE=THISANDFUTURE`** override into the
  same resource, no split; "delete also future" sets `UNTIL`, leaving later
  overrides as orphans. **code**
  ([calendarview.cpp#L1688-L1695, L2497-L2500](https://github.com/KDE/korganizer/blob/3c4491fa3347e4e363a5a8b7417f04758b47e7f0/src/calendarview.cpp#L1688-L2500))
- KDE identifies overrides by the `RECURRENCE-ID` **string**, but renders
  them by instant, so an override another client wrote in UTC for a `TZID`
  series can be duplicated rather than replaced. **code + inferred**
  ([incidence.cpp#L256-L262](https://github.com/KDE/kcalendarcore/blob/230e6e92ac0713d99bac0d0bdb4401540deb6621/src/incidence.cpp#L256-L262))

### Outlook CalDAV Synchronizer

Read at [`c7bb231`](https://github.com/aluxnimm/outlookcaldavsynchronizer/tree/c7bb23187c6b3a409fcb1c9f2d9cb1160f759a69)
(v4.7.1, 2026-08-17). It is a bridge: "read" means server → Outlook, "write"
Outlook → server.

- Overrides replace their occurrence matched **by date only** (converted to
  the series' zone) plus the master's time of day; `EXDATE` is matched the
  same way and applied **before** overrides, so an instance with both loses
  the override. **code + inferred**
  ([EventEntityMapper.cs#L1259-L1390](https://github.com/aluxnimm/outlookcaldavsynchronizer/blob/c7bb23187c6b3a409fcb1c9f2d9cb1160f759a69/CalDavSynchronizer/Implementation/Events/EventEntityMapper.cs#L1259-L1390))
- An override matching no occurrence, or one Outlook refuses (a move past a
  neighbor, two occurrences on one day), is skipped with a warning. **code**
  ([EventEntityMapper.cs#L1384-L1388](https://github.com/aluxnimm/outlookcaldavsynchronizer/blob/c7bb23187c6b3a409fcb1c9f2d9cb1160f759a69/CalDavSynchronizer/Implementation/Events/EventEntityMapper.cs#L1384-L1388))
- Every upload builds a **new** iCalendar from Outlook, keeping only the UID
  and highest `SEQUENCE` from the server copy: other clients' overrides and
  `EXDATE`s that Outlook could not apply are lost on the next upload.
  **code + inferred**
  ([EventEntityMapper.cs#L100-L205](https://github.com/aluxnimm/outlookcaldavsynchronizer/blob/c7bb23187c6b3a409fcb1c9f2d9cb1160f759a69/CalDavSynchronizer/Implementation/Events/EventEntityMapper.cs#L100-L205))
- "Delete one" writes an `EXDATE` **always in UTC**, even when `DTSTART` has
  a `TZID`, and writes none for a date that also has an override (the
  override wins). **code + issue**
  ([EventEntityMapper.cs#L972-L1006](https://github.com/aluxnimm/outlookcaldavsynchronizer/blob/c7bb23187c6b3a409fcb1c9f2d9cb1160f759a69/CalDavSynchronizer/Implementation/Events/EventEntityMapper.cs#L972-L1006);
  [#253](https://github.com/aluxnimm/outlookcaldavsynchronizer/issues/253))
- "All occurrences": no code shifts anything; overrides and `EXDATE`s are
  recomputed from Outlook's exceptions on each upload. **code** Outlook
  itself discards exceptions when the pattern or series time changes, so
  the upload then removes every override from the server, including other
  clients'. **inferred** (known Outlook behavior, not verified here)
- "This and following" does not exist; a series the user ends by hand is
  written with `COUNT`, never `UNTIL`. **code**
  ([EventEntityMapper.cs#L780-L787](https://github.com/aluxnimm/outlookcaldavsynchronizer/blob/c7bb23187c6b3a409fcb1c9f2d9cb1160f759a69/CalDavSynchronizer/Implementation/Events/EventEntityMapper.cs#L780-L787))
- Changes to single occurrences sometimes silently fail to sync at all
  ([#296](https://github.com/aluxnimm/outlookcaldavsynchronizer/issues/296), open). **issue**

### Apple Calendar (macOS, iOS)

Closed source. Evidence: CalDAV PUT bodies from macOS 10.12.6 (2017) kept by
Tine and ProjectForge as test fixtures, iOS 26.5 PUT observations
(2026-07-10) written up by a third party, Calendar.app exports from several
macOS versions, and Apple's archived open-source CalendarServer
([`13c706b`](https://github.com/apple/ccs-calendarserver/tree/13c706b985fb728b9aab42dc0fef85aae21921c3)).

- The override is a full copy (`SUMMARY`, `DTEND`, `TRANSP`, `X-APPLE-*`,
  alarms), with `RECURRENCE-ID` in `DTSTART`'s exact form (`TZID`,
  `VALUE=DATE` for all-day series). **issue**
  ([add_exception](https://github.com/micromata/projectforge/blob/89ae87c7ff7a19f5cb0b02e38587d339d47ea3b8/projectforge-business/src/test/resources/ical/apple_calendar_recurring_add_exception.ics),
  [recurring_changed.ics](https://github.com/nerdinand/chorbasel-app/blob/91754e38d9ccaf59aa840e588d05c660147cc209/spec/fixtures/files/icalendar/recurring_changed.ics))
- Deleting one occurrence adds an `EXDATE;TZID=…` per date; no capture shows
  a `STATUS:CANCELLED` override. Deleting an occurrence that already has an
  override: the iPhone adds the `EXDATE` and drops the override (a test
  comment, not a capture). **issue**
  ([PullStrategyTest.kt#L4645-L4651](https://github.com/KashCal/KashCal/blob/438a268642ed061337c89b87cda2bf45fda9916f/app/src/test/kotlin/org/onekash/kashcal/sync/strategy/PullStrategyTest.kt#L4645-L4651))
- **"All Future Events" shifts `RECURRENCE-ID`s but keeps overrides' own
  times.** A daily 01:15 series moved to 02:15 left overrides' `DTSTART`,
  `DTEND` and `SUMMARY` untouched while their `RECURRENCE-ID` moved by the
  same +1 h; an override that had changed only its title stayed at 01:15
  while its neighbours moved. **issue**
  ([EventTest.php#L801-L855](https://github.com/tine-groupware/tine/blob/eb8394ddce0148ab068a67df87906e9d307674b8/tests/tine20/Calendar/Frontend/WebDAV/EventTest.php#L801-L855))
- A newly set field does reach overrides once: adding a `LOCATION` with
  "All Future Events" also wrote it into an existing override, which kept
  its moved time. **issue**
  ([edit_futur_1](https://github.com/micromata/projectforge/blob/89ae87c7ff7a19f5cb0b02e38587d339d47ea3b8/projectforge-business/src/test/resources/ical/apple_calendar_recurring_edit_futur_1.ics))
- **Apple splits for "this and following", never writes `RANGE`.** In
  macOS 10.12.6 the future part keeps the UID and the past part gets a new
  one, with `UNTIL` on the old half at the split instant minus 1 s; overrides
  and `EXDATE`s go to the matching half. **issue**
  ([EventTest.php#L801-L855](https://github.com/tine-groupware/tine/blob/eb8394ddce0148ab068a67df87906e9d307674b8/tests/tine20/Calendar/Frontend/WebDAV/EventTest.php#L801-L855))
  Since at least macOS 14.5, every part carries the same
  `RELATED-TO;RELTYPE=X-CALENDARSERVER-RECURRENCE-SET`, and the past half
  probably keeps the UID now instead. **issue**
- Historic data loss in Calendar 8.0 (Yosemite, 2014): a Mac edit *"reverts
  all occurrences of the repeating event back to the original title erasing
  all 'event only' occurrences"*, synced through iCloud. **issue**
  ([discussions.apple.com/thread/6665745](https://discussions.apple.com/thread/6665745), search preview)

### Google Calendar (CalDAV)

Google's own documentation is blocked by the proxy, so the evidence is
third-party: about 45 Google-generated `.ics` files on GitHub (2006–2024,
largest a 2024-09-06 export with 186 overrides), and the issue trackers of
vdirsyncer, evolution-data-server, Thunderbird and DAVx⁵.

- Overrides are full copies; `RECURRENCE-ID` always takes the master's
  `DTSTART` form (`TZID` for timed, `VALUE=DATE` for all-day) — no UTC or
  floating form appears in the capture. **issue**
  ([762.ics#L3114-L3127](https://github.com/stalwartlabs/calcard/blob/f525f10f399a9a9e5d20f56ebf408c98e5e22200/resources/ical/762.ics#L3114-L3127))
- Deleted occurrences are an `EXDATE` on the master in the master's form;
  none of the captures has a `STATUS:CANCELLED` override, though Google's
  REST API represents a deleted instance as `status: cancelled`. **issue**
  ([762.ics#L5423-L5436](https://github.com/stalwartlabs/calcard/blob/f525f10f399a9a9e5d20f56ebf408c98e5e22200/resources/ical/762.ics#L5423-L5436))
- Google serves orphan overrides, for example for an invitation to a single
  occurrence; these have broken khal and Home Assistant's ics_calendar.
  **issue**
  ([python-recurring-ical-events#173](https://github.com/niccokunzmann/python-recurring-ical-events/issues/173), 2024-09)
- **What "All events" does to existing exceptions is contradictory and
  undocumented by Google.** Christopher Newport University's knowledge base
  says "following" and "all events" *"will overwrite any exceptions that
  you've made with the 'only this event' choice"*. **issue**
  ([confluence.cnu.edu](https://confluence.cnu.edu/pages/viewpage.action?pageId=45089249), search preview)
  The Nylas cookbook says the opposite: *"Google keeps existing overrides
  that still fit the new rule"*, whereas Microsoft removes them. **issue**
  ([Nylas cookbook](https://developer.nylas.com/docs/cookbook/calendar/google-calendar-recurring-events/), search preview)
  No capture of a before/after state was found, so whether `RECURRENCE-ID`s
  shift or titles propagate is **unknown**.
- "This and following" splits: the original gets `UNTIL` at 23:59:59 local
  time the day before, the rest becomes `<uid>_R<start>@google.com`, no
  `RELATED-TO`; all overrides in the capture stayed inside their part's
  range, which fits Google moving or dropping them at the split. **issue +
  inferred**
  ([762.ics#L120-L145](https://github.com/stalwartlabs/calcard/blob/f525f10f399a9a9e5d20f56ebf408c98e5e22200/resources/ical/762.ics#L120-L145))

### Nextcloud Calendar

Read at nextcloud/calendar
[`2ae3019`](https://github.com/nextcloud/calendar/tree/2ae3019ffd3eae3f1733ee19dca5de2795733dbc)
(main, 6.7.0-dev, 2026-10-02; identical save/delete code in v6.6.2) with
calendar-js
[`ae8d16f`](https://github.com/nextcloud/calendar-js/tree/ae8d16f43d143c77253fafebcc22dc71eedbfd99)
and ical.js [v2.2.1](https://github.com/kewisch/ical.js/tree/v2.2.1).

- `RECURRENCE-ID` is matched by `unixTime`, so a `…Z` value matches a
  `TZID` series, but a `VALUE=DATE` on a DATE-TIME series or a floating
  value on a `TZID` series is silently dropped and the original occurrence
  shows instead. **code** (run)
  ([recurrenceManager.js#L126-L293](https://github.com/nextcloud/calendar-js/blob/ae8d16f43d143c77253fafebcc22dc71eedbfd99/src/recurrence/recurrenceManager.js#L126-L293))
- **A duplicate `EXDATE` breaks every later one**: ical.js advances its
  `EXDATE` pointer by at most one per instance, so even the same instant in
  another form counts as a duplicate.
  ([#8304](https://github.com/nextcloud/calendar/issues/8304), open, 2026-05). **code (run) + issue**
- Every save re-serializes the whole parsed tree and PUTs with `If-Match`;
  a 412 is not handled (`// TODO - catch conflicts`). **code**
  ([calendarObjects.js#L102-L110](https://github.com/nextcloud/calendar/blob/2ae3019ffd3eae3f1733ee19dca5de2795733dbc/src/store/calendarObjects.js#L102-L110))
- "Only this occurrence" is a full clone with `RRULE`/`RDATE`/`EXDATE`
  removed; **its `SEQUENCE` is reset to 0 and becomes 1 on save**, whatever
  the master has (reported and closed as not reproducible). **code (run) +
  issue**
  ([#4727](https://github.com/nextcloud/calendar/issues/4727))
- Deleting one occurrence adds an `EXDATE`, removes the matching override
  reusing its `RECURRENCE-ID` value even in UTC, and DELETEs the resource
  when no instance remains; `STATUS:CANCELLED` is never written. **code
  (run)**
  ([calendarObjectInstance.js#L1632-L1660](https://github.com/nextcloud/calendar/blob/2ae3019ffd3eae3f1733ee19dca5de2795733dbc/src/store/calendarObjectInstance.js#L1632-L1660))
- **From an occurrence other than the first, "update entire series"
  discards date/time changes** with a warning to edit the first occurrence
  instead; series edits never reach existing overrides, which keep their
  old title, location and attendees. **code**
  ([calendarObjectInstance.js#L1454-L1518](https://github.com/nextcloud/calendar/blob/2ae3019ffd3eae3f1733ee19dca5de2795733dbc/src/store/calendarObjectInstance.js#L1454-L1518);
  [#8450](https://github.com/nextcloud/calendar/issues/8450))
- A time change from the first occurrence shifts override `RECURRENCE-ID`s,
  `EXDATE`s and `UNTIL`, but the store then puts back the editor's
  unshifted `RRULE`/`EXDATE`: net effect, overrides still match but deleted
  occurrences return and a DATE-TIME `UNTIL` can cut off the last
  occurrence. **BYDAY is never adjusted** on a weekday move, which then
  orphans the shifted overrides too. **inferred** (store steps replayed
  against calendar-js;
  [#8957](https://github.com/nextcloud/calendar/issues/8957), open)
- "This and following" splits: `UNTIL` on the old series (occurrence minus
  1 s, UTC), a random UUID and `RELATED-TO;RELTYPE=SIBLING` for the new
  one, but its overrides, `EXDATE`s and `RDATE`s on or after the split are
  **deleted**. **code (run)**
  ([abstractRecurringComponent.js#L461-L599](https://github.com/nextcloud/calendar-js/blob/ae8d16f43d143c77253fafebcc22dc71eedbfd99/src/components/root/abstractRecurringComponent.js#L461-L599))

### SOGo

Read at Alinto/sogo
[`6c93d6b`](https://github.com/Alinto/sogo/tree/6c93d6b66cd2e53d66b9f921ef9223b9598b040d)
(master, 2026-09-21, after 5.12.11).

- An override replaces the instance whose start equals its `RECURRENCE-ID`
  **as an instant**, so UTC and `TZID` forms both match. **code**
  ([SOGoAppointmentFolder.m#L982-L1001](https://github.com/Alinto/sogo/blob/6c93d6b66cd2e53d66b9f921ef9223b9598b040d/SoObjects/Appointments/SOGoAppointmentFolder.m#L982-L1001))
- **An override matching no instance is shown as an extra event** —
  deliberate since 5.12.0 (2025-03), *"identical to G Agenda"*; before that
  it was dropped with an error. **code**
  ([5bab727](https://github.com/Alinto/sogo/commit/5bab72726aa8b08baaa189310ede27cf9747be5e))
- **The master must be the first `VEVENT`**: rules come from index 0, later
  indexes are treated as overrides. **code + inferred**
  ([SOGoAppointmentFolder.m#L1222-L1340](https://github.com/Alinto/sogo/blob/6c93d6b66cd2e53d66b9f921ef9223b9598b040d/SoObjects/Appointments/SOGoAppointmentFolder.m#L1222-L1340))
- A new override is a full copy without `RRULE`/`EXDATE`/`RDATE`, appended
  after the master, `RECURRENCE-ID` in **UTC** (or `VALUE=DATE` for
  all-day). **code + inferred**
  ([SOGoCalendarComponent.m#L317-L353](https://github.com/Alinto/sogo/blob/6c93d6b66cd2e53d66b9f921ef9223b9598b040d/SoObjects/Appointments/SOGoCalendarComponent.m#L317-L353))
- Deleting one occurrence removes the matching override, adds an `EXDATE`
  (UTC, or `VALUE=DATE`), and never writes `STATUS:CANCELLED`. **code**
  ([SOGoComponentOccurence.m#L146-L200](https://github.com/Alinto/sogo/blob/6c93d6b66cd2e53d66b9f921ef9223b9598b040d/SoObjects/Appointments/SOGoComponentOccurence.m#L146-L200))
- When the master's `DTSTART` changes, **every override's `RECURRENCE-ID`
  and every `EXDATE` shift by the same delta**, overrides' own times
  untouched — but the editor first **deletes every override whose old
  `RECURRENCE-ID` no longer falls on an occurrence of the edited rule**: a
  move larger than the event's duration, or to another day, drops them.
  **code**
  ([SOGoCalendarComponent.m#L611-L679](https://github.com/Alinto/sogo/blob/6c93d6b66cd2e53d66b9f921ef9223b9598b040d/SoObjects/Appointments/SOGoCalendarComponent.m#L611-L679),
  [UIxAppointmentEditor.m#L194-L265](https://github.com/Alinto/sogo/blob/6c93d6b66cd2e53d66b9f921ef9223b9598b040d/UI/Scheduler/UIxAppointmentEditor.m#L194-L265))
- Title and description changes don't reach overrides; added/removed
  attendees do. `BYDAY` is not adjusted to a new weekday. **code**
  ([SOGoAppointmentObject.m#L1049-L1115](https://github.com/Alinto/sogo/blob/6c93d6b66cd2e53d66b9f921ef9223b9598b040d/SoObjects/Appointments/SOGoAppointmentObject.m#L1049-L1115))
- "This and following" is **not offered**. **code**

### Roundcube (Kolab calendar plugin)

Read at the GitHub mirror mmonterroca/roundcubemail-plugins-kolab
[`5b69b52`](https://github.com/mmonterroca/roundcubemail-plugins-kolab/tree/5b69b522334fa94b1af15a077d80f0c527bc8002)
(synced 2026-08-10; latest tag 3.6.1). The CalDAV driver shares the Kolab
driver's save logic.

- **Overrides are matched to instances by calendar date only (`Ymd`)**,
  each value formatted in its own time zone (`// Timezone???` in the
  source): a UTC `RECURRENCE-ID` whose UTC date differs from the local date
  lands on the wrong day. **code + inferred**
  ([libcalendaring_vcalendar.php#L320-L370](https://github.com/mmonterroca/roundcubemail-plugins-kolab/blob/5b69b522334fa94b1af15a077d80f0c527bc8002/plugins/libcalendaring/lib/libcalendaring_vcalendar.php#L320-L370))
- Every save re-serializes from the internal model; overrides, `EXDATE`s
  and `X-` properties survive, but **unknown properties without the `X-`
  prefix are dropped**, and **all `EXDATE`s are cleared whenever the event
  has an `RDATE`**. **code**
  ([libcalendaring_vcalendar.php#L607-L611](https://github.com/mmonterroca/roundcubemail-plugins-kolab/blob/5b69b522334fa94b1af15a077d80f0c527bc8002/plugins/libcalendaring/lib/libcalendaring_vcalendar.php#L607-L611),
  [caldav_calendar.php#L790-L793](https://github.com/mmonterroca/roundcubemail-plugins-kolab/blob/5b69b522334fa94b1af15a077d80f0c527bc8002/plugins/calendar/drivers/caldav/caldav_calendar.php#L790-L793))
- Deleting one occurrence removes its override and adds an `EXDATE`. **code**
  ([kolab_driver.php#L866-L902](https://github.com/mmonterroca/roundcubemail-plugins-kolab/blob/5b69b522334fa94b1af15a077d80f0c527bc8002/plugins/calendar/drivers/kolab/kolab_driver.php#L866-L902))
- When the start changes, **every override's `RECURRENCE-ID` is shifted by
  the same delta**, but **`EXDATE`s are not shifted** (copied unchanged
  from the master), so a deleted occurrence comes back after a time
  change. A single-day `BYDAY` is removed on a date change; multi-day
  `BYDAY` stays. **code + inferred**
  ([kolab_driver.php#L1262-L1352](https://github.com/mmonterroca/roundcubemail-plugins-kolab/blob/5b69b522334fa94b1af15a077d80f0c527bc8002/plugins/calendar/drivers/kolab/kolab_driver.php#L1262-L1352))
- "Future" splits the series (`UNTIL` on the master, new UID, no
  `RELATED-TO`); if start, end or location changed, the new series gets no
  overrides **and the master loses all its `EXDATE`s**. **code + inferred**
  ([kolab_driver.php#L1124-L1214](https://github.com/mmonterroca/roundcubemail-plugins-kolab/blob/5b69b522334fa94b1af15a077d80f0c527bc8002/plugins/calendar/drivers/kolab/kolab_driver.php#L1124-L1214))

### InfCloud (CalDavZAP)

Read at Unrud/RadicaleInfCloud
[`53d3a95`](https://github.com/Unrud/RadicaleInfCloud/tree/53d3a95af5b58cfa3242cef645f8d40c731a7d95)
(0.13.2rc1, 2022-04-18). No captures or issues were found; this is code
only.

- Matching compares the **string forms** of JavaScript dates; a UTC value
  is converted into the event's zone, but any other value is read as
  wall-clock time, **ignoring its `TZID`**, so a `RECURRENCE-ID` in another
  `TZID` than `DTSTART` shows as a duplicate. **code + inferred**
  ([data_process.js#L186-L222](https://github.com/Unrud/RadicaleInfCloud/blob/53d3a95af5b58cfa3242cef645f8d40c731a7d95/radicale_infcloud/web/data_process.js#L186-L222))
- The override is a full copy, `RECURRENCE-ID` in the master's `TZID`, UTC
  for UTC events, or `VALUE=DATE` for all-day events. **code + inferred**
  ([forms.js#L2209-L2228](https://github.com/Unrud/RadicaleInfCloud/blob/53d3a95af5b58cfa3242cef645f8d40c731a7d95/radicale_infcloud/web/forms.js#L2209-L2228))
- Deleting one occurrence appends an `EXDATE` and removes an existing
  override. **code + inferred**
  ([data_process.js#L1185-L1231](https://github.com/Unrud/RadicaleInfCloud/blob/53d3a95af5b58cfa3242cef645f8d40c731a7d95/radicale_infcloud/web/data_process.js#L1185-L1231))
- When the master's start changes, **every override's `RECURRENCE-ID` and
  every `EXDATE` is shifted by the delta**; the overrides' own times and
  fields stay. `BYDAY` is not adjusted automatically. **code**
  ([data_process.js#L2303-L2400](https://github.com/Unrud/RadicaleInfCloud/blob/53d3a95af5b58cfa3242cef645f8d40c731a7d95/radicale_infcloud/web/data_process.js#L2303-L2400))
- "This and following" splits with a `COUNT` on the old rule and a new UID
  for the rest; overrides stay in the original resource, so those after the
  cut become orphans. **code + inferred**
  ([data_process.js#L459-L486](https://github.com/Unrud/RadicaleInfCloud/blob/53d3a95af5b58cfa3242cef645f8d40c731a7d95/radicale_infcloud/web/data_process.js#L459-L486))

### eM Client

Closed source; the vendor forum was unreachable, so all evidence comes from
search previews. No captured override written by eM Client was found.

- How it reads, preserves, and whether it writes overrides or `EXDATE` at
  all: **unknown**.
- **Series edits reset all modifications**: editing a series *"will reset
  all events in the series, including the past events, so you will lose any
  past modifications of individual events"* (support called this intended,
  around 2014, v6; a later reply says non-rule fields can be edited without
  a reset). Current behavior is **unknown**. **issue**
  ([forum thread 41598](https://forum.emclient.com/t/be-warned-if-you-make-any-changes-in-a-recurring-event-all-past-modifications-will-be-lost/41598))
- Whether it splits or writes `RANGE` for "this and following": **unknown**.

### iCloud (server)

Closed source. Evidence: KashCal's live probes against `caldav.icloud.com`
(2026-06), logs in Home Assistant and python-caldav issues, and Apple's
CalendarServer as a proxy for likely behavior.

- **iCloud accepts a master with an override in one PUT**, on create and
  modify, and keeps it (Zoho, by contrast, discards it). **issue**
  ([ExceptionAttendeePutShapeSpikeTest.kt#L36-L41](https://github.com/KashCal/KashCal/blob/438a268642ed061337c89b87cda2bf45fda9916f/app/src/test/kotlin/org/onekash/kashcal/sync/integration/multiserver/ExceptionAttendeePutShapeSpikeTest.kt#L36-L41))
- On read, iCloud adds a second `DTSTAMP` to every component, overrides
  included, which breaks strict parsers. **issue**
  ([python-caldav vcal.py#L79-L81](https://github.com/python-caldav/caldav/blob/eb1cf35d0b116bb65908abd49641d7a229fadcab/caldav/lib/vcal.py#L79-L81))
- *"iCloud represents deleted occurrences as CANCELLED exceptions"*, per one
  source — this conflicts with the iPhone `EXDATE` captures above and
  probably refers to attendee copies after an organizer cancels an
  occurrence. **issue + inferred**
  ([KashCal CriticalPatternMigrationTest.kt#L530](https://github.com/KashCal/KashCal/blob/438a268642ed061337c89b87cda2bf45fda9916f/app/src/test/kotlin/org/onekash/kashcal/sync/parser/migration/CriticalPatternMigrationTest.kt#L530))
- CalendarServer (a proxy only; iCloud itself is unknown here) rejects mixed
  UIDs, two masters and duplicate `RECURRENCE-ID`s, compares them as UTC
  instants, and expands `RANGE=THISANDFUTURE`. **code**
  ([ical.py#L1926-L2025](https://github.com/apple/ccs-calendarserver/blob/13c706b985fb728b9aab42dc0fef85aae21921c3/twistedcaldav/ical.py#L1926-L2025))
- CalendarServer also rejects with 403 `valid-calendar-data` an override
  whose `RECURRENCE-ID` is not an instance of the master (cancelled
  overrides exempt); for iCloud itself this is unknown. **code**
  ([instance.py#L380-L423](https://github.com/apple/ccs-calendarserver/blob/13c706b985fb728b9aab42dc0fef85aae21921c3/twistedcaldav/instance.py#L380-L423))

### Nextcloud server / SabreDAV / Baïkal

Read at nextcloud/server
[`cf65b57`](https://github.com/nextcloud/server/tree/cf65b5756bea77f29b8f368c0079c6c76395e6f2)
(master, 2026-10-02), sabre/vobject
[`fd867f0`](https://github.com/sabre-io/vobject/tree/fd867f0f82fbf17fc743edf9b598022f2e99426e),
sabre/dav
[`efe77fa`](https://github.com/sabre-io/dav/tree/efe77fa57ff71404722df5105261dbe11125c2f7)
(4.7.1, which Baïkal and Nextcloud 35 both bundle), and sabre-io/Baikal
[`4f767cb`](https://github.com/sabre-io/Baikal/tree/4f767cbcafe0c1db3ae9e5e52a8b3da5ea5a094d)
(0.12.1).

- **A date without `VALUE=DATE` (`EXDATE:20250930`) gets 415**, reported for
  both iOS and DAVx⁵; orphan overrides, duplicate `RECURRENCE-ID`s and a
  `RECURRENCE-ID` of another value type than `DTSTART` are **not**
  validated. **code + issue**
  ([Plugin.php#L806-L855](https://github.com/sabre-io/dav/blob/efe77fa57ff71404722df5105261dbe11125c2f7/lib/CalDAV/Plugin.php#L806-L855);
  [nextcloud/calendar#8396](https://github.com/nextcloud/calendar/issues/8396))
- **vobject's Broker takes `STATUS` from the last `VEVENT`: a cancelled
  override therefore cancels the whole event for attendees** on Baïkal and
  Nextcloud ≤ 33 (Nextcloud 34+ has its own TipBroker that sends a CANCEL
  for one instance only when the override itself has
  `STATUS:CANCELLED`). **code + issue**
  ([Broker.php#L901-L903](https://github.com/sabre-io/vobject/blob/fd867f0f82fbf17fc743edf9b598022f2e99426e/lib/ITip/Broker.php#L901-L903);
  [nextcloud/server#59695](https://github.com/nextcloud/server/issues/59695))
- `EventIterator` matches `RECURRENCE-ID`/`EXDATE` by timestamp, ignores
  `RANGE`, and emits **every** override at its own `DTSTART` even if it
  matches no instance or an excluded one — Nextcloud Calendar hides those,
  so server and web client disagree. **code**
  ([EventIterator.php#L114-L389](https://github.com/sabre-io/vobject/blob/fd867f0f82fbf17fc743edf9b598022f2e99426e/lib/Recur/EventIterator.php#L114-L389))
- In Nextcloud, `firstoccurence`/`lastoccurence` come from the **master
  alone**; overrides are ignored, so a time-range REPORT can miss a first
  occurrence moved before `DTSTART` or a last occurrence moved past a
  bounded series' end. Baïkal computes `firstoccurence` from the **first
  `VEVENT`** in the resource, so an override placed before the master would
  skew the range too. **code + inferred**
  ([CalDavBackend.php#L3406-L3509](https://github.com/nextcloud/server/blob/cf65b5756bea77f29b8f368c0079c6c76395e6f2/apps/dav/lib/CalDAV/CalDavBackend.php#L3406-L3509),
  [PDO.php#L617-L687](https://github.com/sabre-io/dav/blob/efe77fa57ff71404722df5105261dbe11125c2f7/lib/CalDAV/Backend/PDO.php#L617-L687))
- **A PUT whose `EXDATE`s leave no instance gets 500 on Baïkal** (an
  uncaught `NoInstancesException`, so DAVx⁵ retries forever) and **403 on
  Nextcloud ≤ 34** (fixed implicitly in Nextcloud 35, which no longer
  checks there). **code + issue**
  ([sabre-io/Baikal#1053](https://github.com/sabre-io/Baikal/issues/1053))
- Neither Nextcloud nor sabre splits series or handles `RANGE`. **code**

### Radicale

Read at Kozea/Radicale
[`64be0ef`](https://github.com/Kozea/Radicale/tree/64be0ef8885d4085a6b77499b62a465eddb84bc6)
(master 3.8.2.dev, 2026-10-01; latest release v3.8.1).

- **400 for more than one master, or for two or more overrides without a
  master** ("Main component missing"); a single orphan override is
  accepted. **code + issue**
  ([filter.py#L326-L350](https://github.com/Kozea/Radicale/blob/64be0ef8885d4085a6b77499b62a465eddb84bc6/radicale/item/filter.py#L326-L350);
  [#1758](https://github.com/Kozea/Radicale/issues/1758))
- The time-range filter skips an instance equal to a `RECURRENCE-ID` by
  Python equality: naive against aware, or `DATE` against `DATE-TIME`,
  never matches; `RANGE` is explicitly not respected (`HACK`). **code**
  ([filter.py#L283-L350](https://github.com/Kozea/Radicale/blob/64be0ef8885d4085a6b77499b62a465eddb84bc6/radicale/item/filter.py#L283-L350))
- **In `expand`, any `RECURRENCE-ID` value-type mismatch or missing master
  fails the whole REPORT with 400**, not just that item. **code**
  ([report.py#L391-L733](https://github.com/Kozea/Radicale/blob/64be0ef8885d4085a6b77499b62a465eddb84bc6/radicale/app/report.py#L391-L733))
- An override carrying its own `RRULE`/`EXDATE` used to be rejected; since
  3.3.2 this is only logged. **issue + inferred**
  ([#1264](https://github.com/Kozea/Radicale/issues/1264))

### Noted in passing (outside the survey's scope)

- **Open-Xchange** rejects with 409 a PUT that reschedules a series and
  shifts its overrides' `RECURRENCE-ID`s, even with a matching `If-Match`.
  **issue**
  ([python-caldav compatibility_hints.py#L401](https://github.com/python-caldav/caldav/blob/eb1cf35d0b116bb65908abd49641d7a229fadcab/caldav/compatibility_hints.py#L401))
- **Bedework** splits override `VEVENT`s into separate resources. **issue**
  ([compatibility_hints.py#L1592](https://github.com/python-caldav/caldav/blob/eb1cf35d0b116bb65908abd49641d7a229fadcab/caldav/compatibility_hints.py#L1592))
- **Zoho** discards an override PUT together with its master (KashCal, see
  iCloud above). **issue**
  ([ExceptionAttendeePutShapeSpikeTest.kt#L36-L41](https://github.com/KashCal/KashCal/blob/438a268642ed061337c89b87cda2bf45fda9916f/app/src/test/kotlin/org/onekash/kashcal/sync/integration/multiserver/ExceptionAttendeePutShapeSpikeTest.kt#L36-L41))

## Lucid's behavior

Lucid lets the user change, move or delete only one event of a recurring
series ("Only this event"), that event and the later ones ("This and
following events"), or the whole series from that event on ("All events"),
on dragging, resizing, editing or deleting (FR-17). The API is in
[API.md](API.md#events); the implementation is
`internal/caldav/occurrences.go` (only this event),
`internal/caldav/following.go` (this and following events), the series
path of `UpdateEvent` in `internal/caldav/events.go` (all events), and
`internal/caldav/seriesshift.go` (which moves are allowed).

**Decision: write RFC 5545 overrides and `EXDATE`s**, the shape every
surveyed client and server round-trips (see [Summary](#summary)).

**Lucid asks only when there is a choice** (`scopeOptions` in
`web/src/lib/scope.ts`). Deleting an event of a series always asks, since at
least "Only this event" and "All events" are possible. A save that changes
or removes the rule, or turns the series all-day or timed, never applies to
only this event: at a later event it asks between "This and following
events" and "All events", but at the series' first event, or in a series
with attendees, it can only apply to "All events". A move that `seriesShift`
says the series can't follow (see "Which moves are refused" below) can only
apply to "Only this event". With one option left, Lucid doesn't ask.
Instead, the editor's footer or a pill under the dragged event says
beforehand which events the change reaches, for example "Applies to every
event in the series.", or "The series becomes this one event. All others are
deleted." when the rule is removed. The question, these hints and the toast
after the change show that reach as five dots, the middle one the edited
event, and while an option of the question has the pointer or the focus, a
ring marks the events in view that it reaches. Some moves only the server
refuses, as the browser can't tell beforehand that a monthly or yearly
series would leave its days (see "Which moves are refused"): there the
question offers "All events", and "This and following events" at a later
event, and the refusal comes as a toast.

### "Only this event"

- The override is a **full copy** of the series (all properties and
  sub-components such as `VALARM`/`ATTENDEE`), minus `RRULE`, `RDATE` and
  `EXDATE`, built by `newOverride`. A partial copy leaves the event
  untitled in Thunderbird and DAVx⁵, and keeping `RRULE`/`RDATE`/`EXDATE` in
  it gets 400 from Radicale or duplicates in older DAVx⁵.
- `RECURRENCE-ID`, `DTSTART` and `DTEND` are written in exactly the series'
  `DTSTART` form (the same `TZID`, `VALUE=DATE` for all-day series), via
  `seriesDateProp`. Other forms are dropped silently by Nextcloud Calendar,
  duplicated by InfCloud, misdated by Roundcube, or rejected by Radicale's
  `expand` (400) and SabreDAV (415).
- **The series keeps its own time zone.** An "Only this event" write, and
  an "All events" write whose rule and `allDay` flag are unchanged, use the
  series' stored `TZID`; the request's `timezone` field only applies to a
  single (non-recurring) event or to a series save that changes the rule or
  `allDay`.
- A `recurrenceId` is matched by **instant**, never by text (`findOverride`,
  `isInstance`): this also finds an existing orphaned override, which Lucid
  already shows.
- The series is written as the **first `VEVENT`** of the resource
  (`masterFirst`), because SOGo reads the first one as the series.
  `DTSTAMP`, `LAST-MODIFIED` and `SEQUENCE` follow the same rules as any
  other change (`bumpChangeProps`).
- A deliberately cleared field is written as an existing, empty property
  (`setTextKept`), not omitted: the reader only falls back to the series'
  value when the override has **no** such property at all, so a cleared
  description does not resurface.
- A `recurrenceId` with fractional seconds is refused with `400
  invalid_input`: the API only ever emits whole seconds
  (`internal/httpapi/calendar.go`'s `pathTime`).
- **Deleting one occurrence** adds an `EXDATE` in the series' form, unless
  one already excludes the same instant in any form — otherwise Nextcloud
  Calendar ignores every later `EXDATE`. Any override at that instant is
  removed in the **same write**, never left with an `EXDATE` of its own (the
  Outlook CalDAV Synchronizer drops such an override, which would otherwise
  bring the occurrence back on its next upload). Lucid never writes
  `STATUS:CANCELLED`: Baïkal and Nextcloud ≤ 33 cancel the whole meeting for
  attendees with it. Once no occurrence is left, the resource itself is
  deleted (Baïkal answers 500, Nextcloud ≤ 34 403 to a series-less PUT).
- **A series whose rule Lucid cannot parse is never deleted by deleting one
  of its events**: Lucid shows only the `DTSTART` event of such a rule
  (`expandSeries`), for example one with the RFC 7529 parts `RSCALE` or
  `SKIP`, but clients that read the rule show all of its events.
  `hasEventsLeft` cannot tell which of them are left, so `DeleteOccurrence`
  writes the `EXDATE` and keeps the resource, also when the deleted event is
  that `DTSTART` event. Lucid then shows nothing of the series any more,
  while the resource, with all of its other events, stays on the server for
  the clients that read the rule.

### "All events"

- `instanceStart` stays the edited occurrence's `recurrenceId`, so the
  server can find it together with its override, if any. The distance is
  measured from that occurrence's **shown** start — an exception's own
  `DTSTART`, not `instanceStart` itself — fixing a pre-existing bug where
  dragging an exception moved the series by the exception's own offset
  instead of the drag distance.
- Only the fields that changed from the shown occurrence (title,
  description, location, duration) are written into the series, and into
  the edited exception if there is one; other exceptions keep their own
  times and fields, only their `RECURRENCE-ID` shifts with the series
  (`shiftRecurrenceRefs`) — the majority behavior (Apple, SOGo, InfCloud,
  Thunderbird). No surveyed client propagates a new title to an existing
  override.
- **How far everything moves**: the series moves by the same change of
  date and the same change of clock time as the edited event, both
  measured in the series' own time zone (`wallShift`), because its rule
  repeats on that wall clock. The change of date is counted in calendar
  days, except for a `MONTHLY` or `YEARLY` rule without `BY` parts, whose
  events keep `DTSTART`'s day of the month: there it is counted in calendar
  months and then days of the month (`dateShift`, as `todoSeries.refShift`
  does for tasks), from the edited event's `RECURRENCE-ID` to that date
  moved by the calendar days the event moved, since an exception can be
  shown on another day than its `RECURRENCE-ID`. A move from the 30th to
  the 2nd thus puts every event, exception and deleted event on the 2nd,
  also across months of 30 and 31 days. Where this count can't keep every
  value on its day, the move is refused (see "Which moves are refused").
  `DTSTART`, `UNTIL`, every `EXDATE`, `RDATE` and `RECURRENCE-ID`, and the
  recurrence ID the response is looked up by all move this way: a
  date-only value by the change of date only, a UTC or `TZID` value as an
  instant on the series' wall clock (written back in its own form), a
  floating value, or one with a `TZID` Lucid cannot resolve, on its own
  wall clock. `DTEND` moves as `DTSTART` did, so the series keeps its
  duration. An absolute duration would put them an hour off whenever a
  daylight-saving change lies between them and the edited event — a
  deleted occurrence would come back and an override would be orphaned
  next to the occurrence it replaces — and a drag from winter into summer
  time would move the whole series an hour. A save that changes the rule
  moves the same way, counted by the rule the series had; one that changes
  the `allDay` flag moves the references this way too, but `DTSTART` by
  dates (next item).
- **Turning a series all-day, or an all-day series timed**, moves `DTSTART`
  by dates instead (`toggledStart`), each read where the user saw or
  entered it, so a daylight-saving change between `DTSTART` and the edited
  event changes nothing: made all-day, from the edited event's date in the
  series' zone to the date entered, `DTSTART`'s own date read in the
  series' zone too; made timed, from the date shown to the date entered in
  the request's `timezone`, at the clock time entered there, so every event
  shows that time. A Berlin series from 2026-09-04 09:00 made all-day from
  its 11-06 event gets `DTSTART;VALUE=DATE:20260904`; a weekly all-day
  series from 2026-01-02 made timed from its 04-03 event at 09:00 Berlin
  time gets `DTSTART;TZID=Europe/Berlin:20260102T090000`.
- `EXDATE` and `RDATE` shift along with `RECURRENCE-ID`
  (`shiftRecurrenceRefs`), again like Thunderbird, SOGo and InfCloud, rather
  than leaving them behind as Nextcloud, Roundcube, Evolution, KDE, Etar and
  Fossify do (which lets deleted occurrences return after a move).
- `UNTIL` now shifts along too — a fix: previously it stayed in place, so a
  series moved later could lose its last occurrence.
- A changed `RRULE` or `allDay` flag applies to the whole series as entered,
  with the request's own `timezone` (see "Only this event" above for the
  unchanged-rule case). It takes only the changed title, description and
  location into the series too (`applyChangedEventFields`), so an
  exception's own title stays out of it.
- **Which moves are refused**: `seriesShift(rule, from, to)` is a pure
  function shared, case for case, between the server (Go,
  `internal/caldav/seriesshift.go`) and the browser (TypeScript,
  `web/src/lib/seriesShift.ts`), tested against the same table
  (`internal/caldav/testdata/series-shift.json`). A rule with no `BY` parts
  may move freely; `FREQ=WEEKLY` with plain `BYDAY` weekdays (no ordinal, no
  other `BY` part) rotates its weekdays with the move, and with
  `INTERVAL` > 1 only if every weekday lands in the same relative week; any
  other rule with a `BY` part (`BYMONTHDAY`, an ordinal `BYDAY`,
  `BYSETPOS`, `BYMONTH`, `BYYEARDAY`, `BYWEEKNO`, or a weekly rule with more
  `BY` parts) allows only a same-day move, and no clock change at all if
  the rule fixes the hour, minute or second itself. The server answers
  `400 series_move_unsupported` when `seriesShift` says no, but the
  frontend doesn't send such a move: there "Only this event" is the one
  option left, so a drop or a save moves only that event without
  asking. Before it does, the pill under the dragged event, the editor's
  footer and the drag announcements say why, from `moveAllRefusal`
  (`web/src/lib/seriesShift.ts`): "Only this event. The series keeps its
  times." when the rule fixes the clock (`BYHOUR`, `BYMINUTE` or
  `BYSECOND`) and the move changes it, and "Only this event. The series
  stays on its days." otherwise. The server check is the safety net, not
  the primary guard.
- **A `MONTHLY` or `YEARLY` rule without `BY` parts** is refused too, with
  the same `400 series_move_unsupported` and nothing written, where months
  and days can't keep every value on its day (see Limits). The server
  alone decides this, on every path that counts in months and days: "All
  events" with the rule and `allDay` unchanged (`moveSeries`), a save that
  changes the rule, and one that turns the series all-day or timed
  (`toggledStart`), and on "This and following events", for the new
  series (see below). The frontend can't foresee these refusals, so it
  asks as for any other move, with "All events" and, at a later event,
  "This and following events" among the options, and shows the refusal as
  a toast: "This series can't move like this. Move only this event
  instead."
  - From an event on another day of the month than `DTSTART`'s (an
    `RDATE`, or an exception left on another day), a change of date is
    refused (`dateShift`): counted in months and days from there, the
    rule's events would move by another number of days than the edited
    one, and counted in days, they would leave their day of the month. A
    change of the clock time alone moves every value as usual.
  - A move whose months and days would put `DTSTART`, a reference
    (`EXDATE`, `RDATE`, `RECURRENCE-ID`, `UNTIL`) or one of the rule's
    events on a day its month lacks, the 29th to 31st or February 29 in a
    common year, is refused (`dateMove.date`, `seriesMove.at`): such a
    value would overflow into the next month, where the rule's events
    don't follow. That holds for values on `DTSTART`'s day of the month,
    and for any value when the move changes the month. A value on another
    day, such as an `UNTIL` at the end of a month or year, or an `RDATE`
    on the 31st, that a move within the month carries past its month's
    end moves on exactly as by calendar days, which keeps it with the
    events: a monthly series on the 15th with `UNTIL=20261231T225959Z`
    moved to the 16th gets `UNTIL=20270101T225959Z`, while one on the 1st
    with `UNTIL` on 12-31, moved from its 03-01 event to 02-28 (a month
    back and 27 days on), is refused, since `UNTIL` would land on
    December 28 and add an event. The rule's events count on "All events"
    with the rule and `allDay` unchanged (its first 48: while every fourth
    year is a leap year, their months repeat within them, so only a
    century year such as 2100 beyond them goes unchecked); a save that
    changes the rule or `allDay` writes the series as entered and checks
    `DTSTART` and the references only.
- **What is marked as changed**: `modified` is computed per occurrence in
  `expandObject` (`overrideModified`). It is `true` when an override
  visibly changes the occurrence's start, duration, all-day flag, title,
  location or description from what the series would otherwise give at
  that `recurrenceId`; invisible differences such as `PARTSTAT` or an added
  `VALARM` do not count. An orphaned override (one whose `recurrenceId`
  matches no instance of the rule) is `modified` whenever its start differs
  from its `RECURRENCE-ID` or any of those fields differs from the series,
  since it is shown as a changed occurrence of its own.

### "This and following events"

Lucid never writes `RANGE=THISANDFUTURE` for it: like every surveyed writer
but KDE (see [Summary](#summary)), it **splits** the series at the event
acted on, whose `RECURRENCE-ID` is R. A delete only ends the series before R
(`DeleteFollowing`). A move, a resize or a save ends it there too and goes on
from R with a **new series**, a resource of its own with a new `UID`, changed
as entered (`UpdateFollowing`).

- **Partitioned by `RECURRENCE-ID`.** Everything from R on goes to the new
  series, and everything before it stays: the rule's events, the `EXDATE`
  and `RDATE` values, compared as instants, not as text, and the overrides,
  by the instant of their `RECURRENCE-ID`, never by their own date. An event
  before R that an override moved past R stays in the old series and is
  still listed once; an override at R or later goes to the new series and
  takes its `UID`. So the later events keep their changes and deletions, as
  with Apple, and unlike Nextcloud Calendar, which deletes later overrides
  and `EXDATE`s, or InfCloud and Roundcube, which orphan or drop them.
- **The old series ends** with an `UNTIL` just before R (`endBefore`), in the
  form RFC 5545 section 3.3.10 asks for with its `DTSTART`: for a date, the
  day before R; for a date-time with a `TZID` or in UTC, R − 1 s in UTC, an
  instant no change of summer time can move (a Berlin series at 09:00 split
  at its 2026-06-04 event gets `UNTIL=20260604T065959Z`); for a floating
  date-time, R − 1 s floating. A `COUNT` becomes that `UNTIL`, and it
  replaces a later `UNTIL`; a `COUNT` or an `UNTIL` that already ends the
  series before R stays. In a `TZID` Lucid can't resolve, R's instant is its
  wall clock read as UTC, and an `UNTIL` would be off by the zone's offset:
  such a series ends with a `COUNT` of its events before R instead, whether
  it had a `COUNT`, an `UNTIL` or no end. Its `SEQUENCE`, `DTSTAMP` and
  `LAST-MODIFIED` change as on any other write (`bumpChangeProps`).
- **The new series** (`splitOff`) is a copy of the series with all of its
  properties and components, alarms included, and the `VTIMEZONE`s, with a
  new `UID`, `SEQUENCE:0`, a new `DTSTAMP`, `CREATED` and `LAST-MODIFIED`,
  and `DTSTART` at R in the series' form (`seriesDateProp`), keeping the
  series' duration; it is the first `VEVENT` (`masterFirst`). Its rule keeps
  an `UNTIL`, and a `COUNT` is lowered by the rule's events before its
  `DTSTART`, counted as RFC 5545 section 3.3.10 counts them: `DTSTART` is
  the first, an event an `EXDATE` deleted still counts, and an `RDATE`
  doesn't. Both series together then have the events the one had: a
  `FREQ=WEEKLY;COUNT=10` series split at its fourth event keeps three, and
  the new one gets `COUNT=7`, also where an `EXDATE` deleted the second.
- **An R off the rule**, an `RDATE`, stays an `RDATE` of the new series,
  which starts at the rule's first event after R. Without an event of the
  rule after R, the new series has no `RRULE`, starts at R and keeps the
  later `RDATE`s. Without those either, it is a single event, as R was
  shown: an override at R is laid over it, with its own dates, properties
  and alarms (`layOver`), and the `EXDATE`s and the other overrides go, as a
  single event shows none.
- **The change** applies to the new series as "All events" applies it from
  R (`applySeriesEdit`, shared with `UpdateEvent`): the same distance,
  fields and time zone, and the same refusals (see "Which moves are
  refused" above). A save that sends the series' rule as it is stored,
  compared case-insensitively (RFC 5545 section 3.1), keeps the rule the
  new series inherited, with its lowered `COUNT`, so that a move doesn't
  count as a new rule; any other rule is the new series' own, and no rule
  makes it the single event entered.
- **No link between the two.** Like most surveyed writers (Apple and
  Nextcloud Calendar add a `RELATED-TO`), Lucid writes neither a
  `RELATED-TO` nor a `RANGE`: the two series are independent resources,
  which every client reads as two series.
- **Refused** with `400 series_split_unsupported`, and nothing written,
  where Lucid can't split the series (`loadFollowing`). The first three
  hold at the series' first event too:
  - an `ORGANIZER` or an `ATTENDEE` on any `VEVENT` of the resource: a
    server that schedules implicitly would tell the attendees of a series
    that ends and of another with a new `UID`. The event list says so with
    `hasAttendees`, the same test, so the frontend doesn't offer the split;
  - an `EXRULE`: copied into the new series, it would count from the new
    `DTSTART` and exclude other events;
  - a rule Lucid can't read, such as one with the RFC 7529 parts `RSCALE`
    or `SKIP`;
  - a rule Lucid can't walk to R within its iteration cap
    (`maxRRuleIterations`);
  - an R at or before `DTSTART` that isn't the first event, which only an
    `RDATE` or an override before `DTSTART` leaves possible: no rule can end
    before its `DTSTART`.

  An R that is an `EXDATE` or a `STATUS:CANCELLED` override is no event
  Lucid shows: `404 not_found`.
- **At the series' first event**, nothing comes before it, so "This and
  following events" is "All events". The frontend doesn't offer it there,
  but a view not reloaded since another app deleted the earlier events
  still can: the server then changes all events, as `UpdateEvent` does
  with R as `instanceStart`, or deletes the resource, as `DeleteEvent`
  does. The first event is the earliest one `ListEvents` shows
  (`firstOccurrence`, the event list's `first`): of the rule's events,
  `DTSTART` included, the `RDATE`s and the overrides' `RECURRENCE-ID`s,
  none of them an `EXDATE` or a cancelled override.
- **The write order** (`writeCreatedThenMaster` in
  `internal/caldav/writes.go`, which the completion of a repeating task
  shares): the new series is created first, with `If-None-Match: *`, and
  then the old series is written, with `If-Match`. A failure in between
  can leave events twice, which the user sees, but never loses the later
  ones. What a failed split wrote goes again as far as Lucid can tell:
  - The create fails: the old series is not written. A failure that is no
    refusal by the server, such as a timeout or a proxy's `5xx`, can come
    after the server stored the new series. Lucid then reads its ETag and,
    if it is there, deletes it with `If-Match`; its `UID` is new, so no
    other client knows it. One whose ETag can't be read, or is weak, stays
    and is logged, and a create that lands only after this check can't be
    caught.
  - The old series' write fails: refused by the server, or with its ETag
    read back unchanged, it was not applied, and the new series is
    deleted again (unless the server told no ETag for it, which keeps it,
    logged); the error is answered. With its ETag changed, the write
    counts as applied, as behind a reverse proxy whose read timeout fired
    after the server committed: the split is saved, with the old series'
    new ETag unknown and no Undo. With its ETag unreadable, the new series
    stays, logged, and the error is answered.
- **In the UI**, "This and following events" comes before "All events" in
  the drop question, the editor's question and the delete question, after
  "Only this event" where that is offered too. It is missing at the series'
  first event, where it would do what "All events" does, without a word, and
  in a series with attendees, where the question says "With attendees, the
  series can't be split." Its note names the day of the event: "From Wed,
  Oct 21 on, as a series of its own. Earlier ones stay as they are.", "The
  series ends before Wed, Oct 21." on a delete, and "From Wed, Oct 21 on,
  only this event stays. Earlier ones stay as they are." for a save that
  removes the rule. While it has the pointer or the focus, the ring marks
  the events from R on, by recurrence ID, so an event before R that an
  override moved past it stays unmarked. None of these writes is optimistic:
  the calendar shows the change once the series is reloaded, and a dragged
  event shows busy until then. The toast says "Moved from Wed, Oct 21 on, as
  a series of its own." ("Changed …" for a resize or a save), and in red
  "The series now ends before Wed, Oct 21." for a delete or a save that
  removes the rule, with an Undo (see below). Where the server changed all
  events instead, at what had become the first event, the toast says "All
  events moved." or "All events changed.". A delete answered with `204` says
  that the series ends too, without an Undo: the answer can't tell a series
  deleted at its first event from one kept whose new ETag the server didn't
  tell.

### Undo

A change to a series returns an `undoToken` (FR-17) if its resource stays in
place and the CalDAV server tells the new ETag; a save that removes the rule
counts too. A non-recurring event gets none, nor does a delete that removes
the whole resource (a whole series, the last event of one, or the first
event and the following ones). Nor does a resource with an `ORGANIZER` or an
`ATTENDEE` on any of its events: a server that schedules implicitly may have
sent the attendees the change with its `SEQUENCE`, which must never go down
(RFC 5545 section 3.8.7.4), and the restore would write the older one back.
A split ("This and following events") gets one only if the server tells the
new ETags of both series: without the old series', the undo could not tell
its own change from another client's, and without the new series', it could
not delete the new series, which would then stand next to the restored one
with every event from R on twice.

Undo restores the resource **byte for byte** as it was read before that
write, a snapshot the backend keeps under the token, with one `PUT` and
`If-Match` of the ETag the write produced, instead of reversing the write:
the override, `EXDATE`s, shifted references and `UNTIL` all come back
together. If another client has changed the series since, the `PUT` fails,
the undo is refused (`409`) and nothing is written. The one exception is a
write that lands in the single round trip in which Lucid reads back an ETag
the server did not send with its answer to the change: the snapshot then
carries that ETag. The undo of a split restores the old series this way and
then deletes the new one, with `If-Match` of the ETag the split gave it. If
another app has changed the new series since, it stays, and the answer says
so (`copyKept`), as does the toast: "Undone. The new series was changed in
another app and stays." The store keeps a snapshot for 2 minutes and refuses one
over 1 MiB, so a series with years of overrides changes without an undo; it
can also drop a snapshot earlier, to keep at most 8 per session and 64 MiB
in total. The UI offers the Undo for 8 seconds, in the toast that says what
the change did, and only for the latest change of a series: a change that
starts while an earlier one's toast is shown, or before its answer arrived,
takes that Undo away.

### Limits

- The two series of a split are independent resources: a later change of
  "All events" of one of them, in Lucid or in another client, leaves the
  other as it is.
- A series with an `ORGANIZER` or an `ATTENDEE` can't be split: only one of
  its events or all of them change. Neither can a series with an `EXRULE` or
  a rule Lucid can't read (see "This and following events").
- A split that fails can leave its new series next to the old one, as a
  duplicate the user can see and delete: where the server stored it only
  after Lucid checked, where its ETag can't be read or is weak, and where
  the old series' write can't be verified.
- An `EXDATE` or `RDATE` property with a value Lucid can't read stays with
  the old series as it is. A client that reads it then shows, in the new
  series, an event that such an `EXDATE` deleted.
- Google's handling of existing exceptions on "All events" is **unknown**:
  the only sources found contradict each other (overwritten vs. kept if
  still matching), and no capture of a before/after state exists.
- "All events" can't move a `MONTHLY` or `YEARLY` series without `BY`
  parts where months and days can't keep every value on its day. Rather
  than let the series drift, Lucid refuses such a save with
  `400 series_move_unsupported` and writes nothing; "Only this event"
  still moves the one event.
  - From an event on another day of the month than `DTSTART`'s, such as
    an `RDATE`, to another date: a monthly series from 2026-01-15 with an
    `RDATE` of 01-31 and an `EXDATE` of 04-15 can't move from the 01-31
    event to 02-01. Counted in calendar days, `DTSTART` would leave the
    15th; counted in months and days (a month less 30 days), the rule's
    events would go to the 16th while the `EXDATE` stayed on 04-15, and
    the deleted event would come back.
  - Onto a day of the month that `DTSTART`'s month, the month of one of
    the series' events or a reference's month lacks: a monthly series from
    2026-01-15 can't move from its 03-15 event to 03-31 (it would lose
    its events in the five months without a 31st), a monthly series from
    2026-01-31 can't move from its 03-31 event to 04-30 (`DTSTART` would
    overflow to 03-02, and the series would repeat on the 2nd), and a
    yearly series from 2026-03-01 can't move from its 2028 event to 02-29
    (`DTSTART` would stay on March 1, and the references in leap years
    would match no event). A move that keeps every value in its month,
    such as one from the 31st to the 30th, goes through, and so does one
    within the month that carries an `UNTIL` or an `RDATE` off the
    series' day past its month's end, by calendar days.
- Turning a series all-day, or an all-day series timed, leaves its
  `EXDATE`s and overrides in their old value type (a date-time in a series
  made all-day, a date in one made timed), moved by the series' shift as on
  any other changed-rule save. They can then stop matching the series'
  events: a deleted event can come back, and an exception can show next to
  the event it replaces.
- Lucid cannot prevent what other clients do to the overrides and `EXDATE`s
  it writes. From the reports: a Nextcloud Calendar series move from the
  first occurrence leaves `EXDATE`/`UNTIL` unshifted and a weekday move
  orphans every override; its "this and all future" deletes later overrides
  and `EXDATE`s outright. Roundcube drops non-`X-` unknown properties,
  clears all `EXDATE`s whenever an `RDATE` exists, never shifts `EXDATE` on
  a move, and a "Future" edit with a time change wipes the master's
  `EXDATE`s. SOGo's editor deletes overrides when a series moves by more
  than the event's duration. InfCloud orphans later overrides on "this and
  following". eM Client (2014) and Apple Calendar 8.0 (2014) are reported
  to reset all overrides on a series edit. Lucid's reader already tolerates
  stale, unmatched overrides (it shows them, as Thunderbird, Evolution, SOGo
  and sabre do, rather than hiding them as KDE, Nextcloud and Roundcube do).
