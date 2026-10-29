import { type TFunction } from 'i18next'
import { wallOf } from './dates'
import { formatEventWhen, type FormatPrefs } from './format'

/**
 * UTC as a zone the user picked: the server writes it as `TZID=Etc/UTC` with its VTIMEZONE, so that an item picked
 * into UTC reads back as UTC rather than as "no zone". "" and "UTC" write a plain `Z` (FR-18).
 */
export const PICKED_UTC = 'Etc/UTC'

/** Most zones "In your calendars" lists (FR-18). */
const MAX_IN_USE = 8

/** Names of UTC for an engine whose Intl would not give them one name. */
const UTC_NAMES: ReadonlySet<string> = new Set(['UTC', PICKED_UTC, 'GMT'])

/** The zone Intl formats in as `zone` names it (`Asia/Calcutta` for `Asia/Kolkata` in V8); null where it rejects it. */
const resolved = new Map<string, string | null>()

function resolve(zone: string): string | null {
  let name = resolved.get(zone)
  if (name === undefined) {
    try {
      name = new Intl.DateTimeFormat('en', { timeZone: zone }).resolvedOptions().timeZone
    } catch {
      name = null
    }
    resolved.set(zone, name)
  }
  return name
}

/**
 * The name Intl knows `zone` by, so that every name of a zone reads the same (`Etc/UTC` is `UTC`, `Asia/Kolkata` is
 * `Asia/Calcutta` in V8); `zone` itself where Intl rejects it (FR-18).
 */
export function canonicalZone(zone: string): string {
  return resolve(zone) ?? zone
}

/**
 * Whether two zone values name one zone (FR-18): "" is no zone and equals only itself, any other value its
 * canonical name. A zone Intl does not know equals only itself.
 */
export function sameZone(a: string, b: string): boolean {
  if (a === '' || b === '') return a === b
  return canonicalZone(a) === canonicalZone(b)
}

/** Whether Intl can format in `zone`; false for "". */
export function knownZone(zone: string): boolean {
  return resolve(zone) !== null
}

/**
 * The zone the fields of a row are in (FR-18): its `zone` while Intl knows it, else `browserZone`, where a row
 * without a zone and one in a zone this browser cannot read are shown and entered.
 */
export function fieldZone(zone: string, browserZone: string): string {
  return knownZone(zone) ? zone : browserZone
}

/**
 * The city of a zone ID for labels (FR-18): its last segment with the underscores spaced, "New York" for
 * `America/New_York`, "Buenos Aires" for `America/Argentina/Buenos_Aires`. Every name of UTC is "UTC".
 */
export function zoneCity(zone: string): string {
  if (UTC_NAMES.has(zone) || canonicalZone(zone) === 'UTC') return 'UTC'
  return (zone.split('/').pop() ?? zone).replaceAll('_', ' ')
}

/**
 * The offset of `zone` from UTC at `at` (FR-18), such as "UTC+1", "UTC−4" (a true minus) and "UTC+5:30", read from
 * the difference between the zone's wall clock and the instant, as the editors read every zone (`wallOf`). Empty
 * for a zone Intl does not know.
 */
export function zoneOffset(zone: string, at: Date): string {
  if (!knownZone(zone)) return ''
  // The wall clock has whole seconds: take the instant's milliseconds off, or they would skew the difference.
  const t = Math.floor(at.getTime() / 1000) * 1000
  const minutes = Math.round((wallOf(t, zone) - t) / 60_000)
  const abs = Math.abs(minutes)
  const rest = abs % 60
  return `UTC${minutes < 0 ? '−' : '+'}${Math.floor(abs / 60)}${rest === 0 ? '' : `:${String(rest).padStart(2, '0')}`}`
}

/**
 * The editors' "In your time zone (Berlin): …" line (FR-18): where an item lies for the browser, from `start` to
 * `end` in `browserZone` (one time where they are one, such as a task's due), while the fields of one of its timed
 * rows, whose zones are `zones`, are in another zone. A row without a zone counts as the browser's, as does one in a
 * zone Intl doesn't know, whose fields are the browser's. Null while every row does, and for an end before the
 * start, which the form refuses. Where the line wraps, a number keeps the words beside it on its line, a day its
 * month and a time its "PM", and the dash the time before it, so no line starts with "–".
 */
export function inYourZone(
  t: TFunction,
  prefs: FormatPrefs,
  now: Date,
  o: { zones: readonly string[]; browserZone: string; start: Date; end: Date },
): string | null {
  const elsewhere = o.zones.some((zone) => !sameZone(fieldZone(zone, o.browserZone), o.browserZone))
  if (!elsewhere || o.end < o.start) return null
  const when = formatEventWhen({ allDay: false, startsAt: o.start, endsAt: o.end }, prefs, now, o.browserZone)
    .replace(/(\d\.?) (?=\p{L})/gu, '$1\u00a0')
    .replace(/(\p{L}\.?) (?=\d)/gu, '$1\u00a0')
    // Intl's thin space around the dash, or a plain one, stays as narrow as it was.
    .replace(/[ \u2009](?=–)/gu, (space) => (space === ' ' ? '\u00a0' : '\u202f'))
  return t('zone.inYourZone', { zone: zoneCity(o.browserZone), when })
}

/**
 * Every zone the picker offers (FR-18): the zones Intl lists, and UTC as `PICKED_UTC` (Intl's own "UTC", where it
 * lists one, would be sent as no zone). Only UTC without the API.
 */
export function allZones(): string[] {
  const listed = (Intl as Partial<Pick<typeof Intl, 'supportedValuesOf'>>).supportedValuesOf?.('timeZone') ?? []
  return [...listed.filter((zone) => zone !== 'UTC' && zone !== PICKED_UTC), PICKED_UTC]
}

/** City names in English, as the IDs spell them, whatever the language of the interface. */
const collator = new Intl.Collator('en')

/** `zones` by city, then ID. */
function byCity(zones: readonly string[]): string[] {
  return zones
    .map((zone) => ({ zone, city: zoneCity(zone) }))
    .sort((a, b) => collator.compare(a.city, b.city) || (a.zone < b.zone ? -1 : a.zone > b.zone ? 1 : 0))
    .map((entry) => entry.zone)
}

/**
 * The zones the picker lists as "In your calendars" (FR-18), from the zones of the loaded items: each zone once
 * (`sameZone`), without "" (no zone) and the browser's, by city, at most eight.
 */
export function zonesInUse(zones: Iterable<string>, browserZone: string): string[] {
  const seen = new Set([canonicalZone(browserZone)])
  const found: string[] = []
  for (const zone of zones) {
    if (zone === '') continue
    const name = canonicalZone(zone)
    if (seen.has(name)) continue
    seen.add(name)
    found.push(zone)
  }
  return byCity(found).slice(0, MAX_IN_USE)
}

export interface ZoneGroup {
  kind: 'here' | 'inUse' | 'all'
  zones: string[]
}

/** A text as the zone search reads it: lower case, without accents, "−" as "-", "_" as a space, "’" as "'". */
function plain(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replaceAll('−', '-')
    .replaceAll('_', ' ')
    .replaceAll('’', "'")
}

/** A query the offset is searched for: one with a digit or a sign, so that "utc" is not every zone's "UTC+1". */
const OFFSET_QUERY = /[\d+-]/

const nameFormats = new Map<string, Intl.DateTimeFormat | null>()

/** The generic name of `zone` in the language `tag` at `at` ("Mitteleuropäische Zeit", "MEZ"); empty without one. */
export function genericName(zone: string, tag: string, style: 'longGeneric' | 'shortGeneric', at: Date): string {
  const key = `${tag}|${style}|${zone}`
  let format = nameFormats.get(key)
  if (format === undefined) {
    try {
      format = new Intl.DateTimeFormat(tag, { timeZone: zone, timeZoneName: style })
    } catch {
      format = null
    }
    nameFormats.set(key, format)
  }
  return format?.formatToParts(at).find((part) => part.type === 'timeZoneName')?.value ?? ''
}

/** Whether `query` (already plain) matches the city, ID, generic names (in `tag`) or offset (at `at`) of `zone`. */
function matches(zone: string, query: string, at: Date, tag: string): boolean {
  const has = (text: string) => plain(text).includes(query)
  return (
    has(zoneCity(zone)) ||
    has(zone) ||
    has(genericName(zone, tag, 'longGeneric', at)) ||
    has(genericName(zone, tag, 'shortGeneric', at)) ||
    (OFFSET_QUERY.test(query) && has(zoneOffset(zone, at)))
  )
}

/**
 * The groups of the zone picker's list for what was typed (FR-18): "here" is the browser's zone, "inUse" the zones
 * of the loaded items, "all" every zone by city, then ID, plus `current` where the list has no name of it (a stored
 * zone Intl does not list is shown and kept). A query keeps the zones whose city, ID, generic names in the language
 * `tag` or offset at `at` contain it, without regard to case and accents, "-" for "−"; a group left empty is
 * dropped.
 */
export function zoneGroups(o: {
  query: string
  at: Date
  tag: string
  browserZone: string
  inUse: string[]
  current: string
}): ZoneGroup[] {
  const all = allZones()
  if (o.current !== '' && !all.some((zone) => sameZone(zone, o.current))) all.push(o.current)
  const query = plain(o.query).trim()
  const keep = (zones: string[]) => (query === '' ? zones : zones.filter((zone) => matches(zone, query, o.at, o.tag)))
  const groups: ZoneGroup[] = [
    { kind: 'here', zones: keep([o.browserZone]) },
    { kind: 'inUse', zones: keep(o.inUse) },
    { kind: 'all', zones: byCity(keep(all)) },
  ]
  return groups.filter((group) => group.zones.length > 0)
}

/**
 * A local `Date` whose fields (year to millisecond) are the wall clock of `instant` in `zone`, such as 18:00 on
 * 2026-11-10 for 23:00Z in New York, for the pickers that take a local date (FR-18). A wall clock the browser's own
 * zone skips moves on by the gap. Throws for a zone Intl does not know.
 */
export function wallDate(instant: Date, zone: string): Date {
  const wall = new Date(wallOf(instant.getTime(), zone))
  return new Date(
    wall.getUTCFullYear(),
    wall.getUTCMonth(),
    wall.getUTCDate(),
    wall.getUTCHours(),
    wall.getUTCMinutes(),
    wall.getUTCSeconds(),
    instant.getUTCMilliseconds(),
  )
}
