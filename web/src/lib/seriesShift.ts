import { formatInTimeZone } from 'date-fns-tz'
import { utcToZoned } from './dates'
import { type CalEvent } from './events'

/**
 * `seriesShift` mirrors `internal/caldav/seriesshift.go` (FR-17): when a
 * user drags one occurrence of a series, it decides whether the whole series
 * can follow it, and with which RRULE; `moveAllRefusal` asks it about a move
 * and says why not. The two implementations of `seriesShift` are checked
 * against the same case table, `internal/caldav/testdata/series-shift.json`.
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
 * `internal/caldav/seriesshift.go`'s `seriesShift`, returning the rule to
 * write, or `null` if the move is not allowed at all — a rejected move must
 * keep the series' original start. One check is the server's alone: with
 * INTERVAL > 1, `from`'s weekday (there DTSTART's) must stay in the BYDAY
 * days' week too, which only matters for a DTSTART off those days, and the
 * browser doesn't know DTSTART.
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

/** `date` as a "yyyy-MM-ddTHH:mm" wall-clock string in `timeZone`. */
function wallClock(date: Date, timeZone: string): string {
  const { date: d, time } = utcToZoned(date, timeZone)
  return `${d}T${time}`
}

/**
 * `date`'s calendar date in UTC, as a "yyyy-MM-ddT00:00" wall-clock string.
 * All-day events are date-only on the wire (UTC midnight): reading their day
 * through the environment's local getters (as plain `format` does) shifts
 * it west of UTC, where midnight reads back as the previous day even though
 * nothing moved.
 */
function allDayWallClock(date: Date): string {
  return `${formatInTimeZone(date, 'UTC', 'yyyy-MM-dd')}T00:00`
}

/** Why a series cannot follow a move: it stays on its days, or at its times of day. */
export type ShiftReason = 'fixedDays' | 'fixedTimes'

/**
 * Why a series cannot follow its event all the way to `newStart` (FR-17), or
 * `null` if it can: `seriesShift` of the event's rule from its current
 * wall-clock start to `newStart`'s. All-day events have no real zone, so
 * their day comes from the UTC-midnight wire format (`start`), read in UTC,
 * never from `startsAt` or `browserZone`; timed events use `event.timezone`
 * (the series' own zone) or, lacking one, `browserZone`, as before.
 *
 * A refusal is `'fixedTimes'` when the rule fixes the clock itself (BYHOUR,
 * BYMINUTE or BYSECOND) and the move changes the clock — that is what the
 * user can change — and `'fixedDays'` otherwise. All-day events have no
 * clock, so theirs is always `'fixedDays'`.
 */
export function moveAllRefusal(
  event: Pick<CalEvent, 'rrule' | 'allDay' | 'timezone' | 'startsAt' | 'start'>,
  newStart: Date,
  browserZone: string,
): ShiftReason | null {
  let from: string
  let to: string
  if (event.allDay) {
    from = allDayWallClock(new Date(event.start))
    to = allDayWallClock(newStart)
  } else {
    const zone = event.timezone || browserZone
    from = wallClock(event.startsAt, zone)
    to = wallClock(newStart, zone)
  }
  if (seriesShift(event.rrule, from, to) !== null) return null

  const f = parseWallClock(from)
  const t = parseWallClock(to)
  const clockChanged = f.hh !== t.hh || f.mm !== t.mm
  return hasClockParts(event.rrule) && clockChanged ? 'fixedTimes' : 'fixedDays'
}
