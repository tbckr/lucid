import { format } from 'date-fns'
import { utcToZoned } from './dates'
import { type CalEvent } from './events'

/**
 * `seriesShift` and `canMoveAll` mirror `internal/caldav/seriesshift.go`
 * (FR-17): when a user drags one occurrence of a series, this decides
 * whether the whole series can follow it, and with which RRULE. The two
 * implementations are checked against the same case table,
 * `internal/caldav/testdata/series-shift.json`.
 */

/** RRULE weekday codes, in `Date#getDay()` order (Sunday first). */
const weekdayCodes = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const

/** Index of a plain two-letter weekday code, or -1 for an ordinal (`2MO`) or anything else. */
function weekdayIndex(code: string): number {
  return weekdayCodes.indexOf(code as (typeof weekdayCodes)[number])
}

/** Integer division rounding towards negative infinity, unlike JS "/" and "%". */
function floorDiv(a: number, b: number): number {
  let q = Math.trunc(a / b)
  if (a % b !== 0 && (a < 0) !== (b < 0)) q--
  return q
}

/** Modulo counterpart of floorDiv: always has the sign of b. */
function floorMod(a: number, b: number): number {
  return a - floorDiv(a, b) * b
}

/** The upper-cased name of an RRULE part such as "COUNT=3". */
function rulePartKey(part: string): string {
  const i = part.indexOf('=')
  const key = i === -1 ? part : part.slice(0, i)
  return key.trim().toUpperCase()
}

/** The value of the part named `key` (upper case) of `rule`, as written, or "" if absent. */
function rulePart(rule: string, key: string): string {
  for (const part of rule.split(';')) {
    if (rulePartKey(part) === key) {
      const i = part.indexOf('=')
      return (i === -1 ? '' : part.slice(i + 1)).trim()
    }
  }
  return ''
}

/** `rule` with the value of `key` replaced by `f`'s result; a part `f` keeps is left as written. */
function mapRulePart(rule: string, key: string, f: (v: string) => string): string {
  return rule
    .split(';')
    .map((part) => {
      if (rulePartKey(part) !== key) return part
      const eq = part.indexOf('=')
      const v = (eq === -1 ? '' : part.slice(eq + 1)).trim()
      const nv = f(v)
      return nv !== v ? `${key}=${nv}` : part
    })
    .join(';')
}

/** Whether `rule` recurs on fixed days rather than at a fixed interval from its anchor (case 1). */
function ruleHasFixedDays(rule: string): boolean {
  for (const part of rule.split(';')) {
    switch (rulePartKey(part)) {
      case '':
      case 'FREQ':
      case 'INTERVAL':
      case 'COUNT':
      case 'UNTIL':
      case 'WKST':
        break
      default:
        return true
    }
  }
  return false
}

/** Whether `rule` fixes the time of day via BYHOUR, BYMINUTE or BYSECOND. */
function hasClockParts(rule: string): boolean {
  for (const part of rule.split(';')) {
    switch (rulePartKey(part)) {
      case 'BYHOUR':
      case 'BYMINUTE':
      case 'BYSECOND':
        return true
      default:
        break
    }
  }
  return false
}

/**
 * Whether `rule` is FREQ=WEEKLY with BYDAY as its only part beyond FREQ,
 * INTERVAL, COUNT, UNTIL and WKST, and every BYDAY value a plain weekday
 * without an ordinal — case 2 of `seriesShift`. The FREQ value is compared
 * case-sensitively, matching the Go reference's `rulePart` exactly: it
 * normalizes part names (`rulePartKey`) but not values, so a non-upper-case
 * FREQ value (`freq=weekly`) falls through to case 3 on both sides.
 */
function weeklySimpleByDay(rule: string): boolean {
  if (rulePart(rule, 'FREQ') !== 'WEEKLY') return false
  let byday = ''
  for (const part of rule.split(';')) {
    switch (rulePartKey(part)) {
      case '':
      case 'FREQ':
      case 'INTERVAL':
      case 'COUNT':
      case 'UNTIL':
      case 'WKST':
        break
      case 'BYDAY':
        byday = rulePart(rule, 'BYDAY')
        break
      default:
        return false
    }
  }
  if (byday === '') return false
  for (const day of byday.split(',')) {
    if (weekdayIndex(day.trim()) < 0) return false
  }
  return true
}

/**
 * Case 2 of `seriesShift`: rotates each BYDAY weekday of `rule` by
 * `dayDelta`, mod 7, keeping their order. With INTERVAL > 1 it additionally
 * requires every weekday to land in the same relative week (judged against
 * WKST, MO if absent) — otherwise the occurrences would no longer all be
 * offset by the same amount, and the move is rejected (`null`).
 */
function weeklyByDayShift(rule: string, dayDelta: number): string | null {
  const iv = rulePart(rule, 'INTERVAL')
  const n = iv === '' ? NaN : Number(iv)
  const interval = Number.isInteger(n) ? n : 1

  if (interval > 1) {
    const w = weekdayIndex(rulePart(rule, 'WKST'))
    const wkst = w >= 0 ? w : weekdayIndex('MO')

    let week = 0
    let set = false
    for (const day of rulePart(rule, 'BYDAY').split(',')) {
      const p = floorMod(weekdayIndex(day.trim()) - wkst, 7)
      const wk = floorDiv(p + dayDelta, 7)
      if (!set) {
        week = wk
        set = true
      } else if (wk !== week) {
        return null
      }
    }
  }

  return mapRulePart(rule, 'BYDAY', (v) =>
    v
      .split(',')
      .map((day) => weekdayCodes[floorMod(weekdayIndex(day.trim()) + dayDelta, 7)] ?? '')
      .join(','),
  )
}

/** Parsed "yyyy-MM-ddTHH:mm" wall-clock fields, as written by `seriesShift`'s callers. */
function parseWallClock(s: string): { days: number; hh: number; mm: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(s)
  if (!m) throw new Error(`invalid wall-clock time: ${s}`)
  const [, y, mo, d, hh, mm] = m
  return {
    days: Date.UTC(Number(y), Number(mo) - 1, Number(d)) / 86400000,
    hh: Number(hh),
    mm: Number(mm),
  }
}

/**
 * Decides how the RRULE of a series follows when its start moves from the
 * wall-clock `from` to `to` (both "yyyy-MM-ddTHH:mm", spec §3, FR-17). Only
 * their date and clock fields matter; callers pass wall-clock values already
 * resolved to the series' own time zone. Mirrors
 * `internal/caldav/seriesshift.go`'s `seriesShift` exactly, returning the
 * rule to write, or `null` if the move is not allowed at all — a rejected
 * move must keep the series' original start.
 */
export function seriesShift(rule: string, from: string, to: string): string | null {
  const f = parseWallClock(from)
  const t = parseWallClock(to)
  const dayDelta = t.days - f.days

  // Case 1: nothing but FREQ, INTERVAL, COUNT, UNTIL, WKST — any move is
  // allowed, the rule stays as written.
  if (!ruleHasFixedDays(rule)) return rule

  // Case 2: FREQ=WEEKLY with BYDAY as its only part beyond the case 1 set,
  // every value a plain weekday — each weekday follows dayDelta.
  if (weeklySimpleByDay(rule)) return weeklyByDayShift(rule, dayDelta)

  // Case 3: everything else with a BY part (BYMONTHDAY, BYDAY with an
  // ordinal, BYSETPOS, BYMONTH, BYYEARDAY, BYWEEKNO, or a weekly rule with
  // further BY parts) — only a same-day move is allowed, and only a
  // same-clock move if the rule fixes the clock itself.
  if (dayDelta !== 0) return null
  if (hasClockParts(rule) && (f.hh !== t.hh || f.mm !== t.mm)) return null
  return rule
}

/** `date` as a "yyyy-MM-ddTHH:mm" wall-clock string in `timeZone`, or local midnight for an all-day date. */
function wallClock(date: Date, allDay: boolean, timeZone: string): string {
  if (allDay) return `${format(date, 'yyyy-MM-dd')}T00:00`
  const { date: d, time } = utcToZoned(date, timeZone)
  return `${d}T${time}`
}

/**
 * Whether a series can follow its event all the way to `newStart` (FR-17):
 * `seriesShift` of the event's rule from its current wall-clock start to
 * `newStart`'s, in `event.timezone` (the series' own zone) or, lacking one,
 * `browserZone`.
 */
export function canMoveAll(
  event: Pick<CalEvent, 'rrule' | 'allDay' | 'timezone' | 'startsAt'>,
  newStart: Date,
  browserZone: string,
): boolean {
  const zone = event.timezone || browserZone
  const from = wallClock(event.startsAt, event.allDay, zone)
  const to = wallClock(newStart, event.allDay, zone)
  return seriesShift(event.rrule, from, to) !== null
}
