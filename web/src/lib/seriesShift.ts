import { formatInTimeZone } from 'date-fns-tz'
import { type Todo } from './api/schemas'
import { type TaskDates, type TaskRepeat, type ZonedTaskDates } from './calendarTasks'
import { movedAs, utcDateToLocal, utcToZoned } from './dates'
import { type CalEvent } from './events'

/**
 * `seriesShift` mirrors `internal/caldav/seriesshift.go` (FR-17): when a
 * user drags one occurrence of a series, it decides whether the whole series
 * can follow it, and with which RRULE; `moveAllRefusal` asks it about a move
 * of an event and `taskMoveRefusal` about one of a task's repeat, and both
 * say why not. The two implementations of `seriesShift` are checked against
 * the same case table, `internal/caldav/testdata/series-shift.json`.
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
 * Why the rule `rule` cannot follow its series from the wall clock `from` to
 * `to`, or `null` if it can (FR-17). A refusal is `'fixedTimes'` when the
 * rule fixes the clock itself (BYHOUR, BYMINUTE or BYSECOND) and the move
 * changes the clock — that is what the user can change — and `'fixedDays'`
 * otherwise.
 */
function shiftRefusal(rule: string, from: string, to: string): ShiftReason | null {
  if (seriesShift(rule, from, to) !== null) return null
  const f = parseWallClock(from)
  const t = parseWallClock(to)
  const clockChanged = f.hh !== t.hh || f.mm !== t.mm
  return hasClockParts(rule) && clockChanged ? 'fixedTimes' : 'fixedDays'
}

/**
 * Why a series cannot follow its event all the way to `newStart` (FR-17), or
 * `null` if it can: `seriesShift` of the event's rule from its RECURRENCE-ID
 * (`recurrenceId`, else its start) by the distance the event moves, from its
 * current wall-clock start to `newStart`'s, in days and minutes on the wall
 * clock. That is how far the server moves the series, and an exception at
 * another time of day than its series can cross midnight where the series
 * does not (#6). All-day events have no real zone, so their day comes from
 * the UTC-midnight wire format (`start`), read in UTC, never from
 * `startsAt`; timed events are read in `event.timezone` (the series' own
 * zone, which the server reports for an exception in another too), else in
 * UTC, as the server reads a time in UTC ("Z"), a floating one and one in a
 * zone it cannot resolve, which it reports without `timezone`. Never in the
 * browser's zone, as `taskMoveRefusal`.
 *
 * A refusal is `'fixedTimes'` when the rule fixes the clock itself (BYHOUR,
 * BYMINUTE or BYSECOND) and the move changes the clock — that is what the
 * user can change — and `'fixedDays'` otherwise. All-day events have no
 * clock, so theirs is always `'fixedDays'`.
 */
export function moveAllRefusal(
  event: Pick<CalEvent, 'rrule' | 'allDay' | 'timezone' | 'startsAt' | 'start' | 'recurrenceId'>,
  newStart: Date,
): ShiftReason | null {
  const rid = new Date(event.recurrenceId ?? event.start)
  let ridWall: string
  let from: string
  let to: string
  if (event.allDay) {
    ridWall = allDayWallClock(rid)
    from = allDayWallClock(new Date(event.start))
    to = allDayWallClock(newStart)
  } else {
    const zone = event.timezone || 'UTC'
    ridWall = wallClock(rid, zone)
    from = wallClock(event.startsAt, zone)
    to = wallClock(newStart, zone)
  }
  return shiftRefusal(event.rrule, ridWall, addWallMinutes(ridWall, wallMinutes(to) - wallMinutes(from)))
}

/** Where a series' rule recurs: on the wall clock of `zone`, read at its event `at` (FR-17, FR-18). */
export interface RuleClock {
  at: Date
  zone: string
}

/**
 * A clock in `zone` at `at`, or `null` where the browser can't read that
 * zone: the server resolves zones an older browser may not know yet, and
 * the rule then reads as written, as before Lucid read rules in their zone.
 */
function readableClock(at: Date, zone: string): RuleClock | null {
  try {
    utcToZoned(at, zone)
    return { at, zone }
  } catch {
    return null
  }
}

/**
 * `rule`, which recurs on the wall clock of `from`, as it reads on the wall
 * clock of `to` (FR-17, FR-18), or `null` where it does not read the same
 * there: `seriesShift` from the one wall clock to the other at the series'
 * event `at`, as if the series moved there. A rule without fixed days stays,
 * plain weekdays follow the date, and other fixed days or times only read
 * the same on the same date and clock. Its own zone leaves it as written.
 *
 * The browser shows a series, and its editors build a rule, on its own wall
 * clock; the server evaluates the rule on the series'. Two zones can be a
 * date apart for part of the year only, so `at` is the event the rule is
 * read at, the same for both directions.
 */
export function ruleInZone(rule: string, at: Date, from: string, to: string): string | null {
  return from === to ? rule : seriesShift(rule, wallClock(at, from), wallClock(at, to))
}

/**
 * Where the rule of the event series `event` recurs (FR-17, FR-18), read at
 * the event's place in the rule, its RECURRENCE-ID, not where an exception
 * moved it: a timed series in its own zone, else in UTC, as the server
 * reads a time in UTC, a floating one and one in a zone it cannot resolve
 * (see `moveAllRefusal`); `null` for an all-day series, whose days are
 * dates, the same in every zone, and for a zone the browser can't read.
 */
export function eventRuleClock(event: Pick<CalEvent, 'allDay' | 'timezone' | 'startsAt' | 'recurrenceId'>): RuleClock | null {
  if (event.allDay) return null
  return readableClock(event.recurrenceId ? new Date(event.recurrenceId) : event.startsAt, event.timezone || 'UTC')
}

/**
 * Where the rule of the series of `event` places it on the browser's wall
 * clock once it starts at `start`, by default where it is shown (FR-17): at
 * its RECURRENCE-ID, not where an exception moved it, moved as far as
 * `start` lies from the shown start, as a save moves the series; by dates
 * where either is all-day, an all-day event's read as a date. What a rule
 * leaves to the series' start, the weekday of `FREQ=WEEKLY` or the day of
 * `FREQ=MONTHLY`, is filled in from there (`describeRRule`). A single event
 * is at `start`.
 */
export function eventRuleStart(
  event: Pick<CalEvent, 'allDay' | 'startsAt' | 'recurrenceId'>,
  start: Date = event.startsAt,
  allDay: boolean = event.allDay,
): Date {
  if (!event.recurrenceId) return start
  const rid = event.allDay ? utcDateToLocal(event.recurrenceId) : new Date(event.recurrenceId)
  return movedAs(start, event.startsAt, rid, allDay || event.allDay)
}

/**
 * Where the rule of the task `todo` recurs, before and after a save that
 * changes it (FR-17, FR-18), read at its current repeat's place in the rule,
 * its RECURRENCE-ID, else at its anchor (start, else due): a timed series in
 * its own zone, else in UTC, as `taskMoveRefusal` reads it, and a single task
 * with a zone of its own in that zone, which the server keeps for a rule it
 * is given. `null` where a rule recurs on dates, or, for a single task
 * without a zone, in the zone the write names, and for a zone the browser
 * can't read.
 */
export function taskRuleClock(todo: Todo): RuleClock | null {
  const anchor = taskAnchor(todo)
  if (!anchor || anchor.allDay) return null
  const zone = (todo.timezone ?? '') || (todo.recurring ? 'UTC' : '')
  return zone ? readableClock(new Date(todo.recurrenceId ?? anchor.at), zone) : null
}

/** The date that places a task's dates (start, else due) as written, with its value type; `null` without one. */
function taskAnchor(d: TaskDates): { at: string; allDay: boolean } | null {
  if (d.start) return { at: d.start, allDay: d.startAllDay }
  if (d.due) return { at: d.due, allDay: d.dueAllDay }
  return null
}

/** A wire date as a wall-clock string: a date (all-day) by its UTC date, a time in `zone`. */
function taskWallClock(at: string, allDay: boolean, zone: string): string {
  return allDay ? allDayWallClock(new Date(at)) : wallClock(new Date(at), zone)
}

/** Minutes from 1970-01-01T00:00 to the wall-clock string `s`, counted on the wall clock, which has no DST. */
function wallMinutes(s: string): number {
  const { days, hh, mm } = parseWallClock(s)
  return days * 1440 + hh * 60 + mm
}

/** The wall-clock string `minutes` after `s`. */
function addWallMinutes(s: string, minutes: number): string {
  return new Date((wallMinutes(s) + minutes) * 60_000).toISOString().slice(0, 16)
}

/**
 * Why a task series cannot follow its `repeat` to the dates `to` (FR-17), or
 * `null` if it can, classified as `moveAllRefusal` classifies it. The rule
 * moves from the RECURRENCE-ID of the repeat, or, `from: 'current'` for
 * "all repeats" from a later repeat, of the series' current repeat
 * (`todo.recurrenceId`), by the distance the repeat moves: from the dates it
 * is shown on to `to`, each anchored on its start, else its due, in days and
 * minutes on the wall clock. That is the distance of an override another app
 * moved too, as the server measures it.
 *
 * Wall clocks are read in the series' zone (`todo.timezone`), else in UTC,
 * as the server reads a time in UTC ("Z"), a floating one and one in a zone
 * it cannot resolve, which it reports without `timezone`; as an event's
 * (`moveAllRefusal`), never in the browser's zone. A date, all-day, is read
 * by its UTC date. A time given to a repeat shown on a date of a series
 * without a zone, an all-day series, is read in the zone the write names
 * (`to.timezone`), else in UTC, where the server writes it and reads the
 * move. A RECURRENCE-ID is read in the value type of the repeat it names, as
 * shown. A move between a date and a time moves by its change of date alone,
 * as on the server. An off-rule current repeat moves from its RECURRENCE-ID
 * too, where the server takes the rule's instance before it; where they
 * disagree, the server refuses the write. No dates to move to, or none
 * shown, is no move here.
 */
export function taskMoveRefusal(repeat: TaskRepeat, to: ZonedTaskDates, from: 'repeat' | 'current'): ShiftReason | null {
  const shown = taskAnchor(repeat.shown)
  const moved = taskAnchor(to)
  if (!shown || !moved) return null
  // Left out, or empty, for a date or a time the server reads in UTC.
  const zone = (repeat.todo.timezone ?? '') || 'UTC'
  // An all-day series takes a time in the write's zone (the server's seriesForm and moveShown).
  const movedZone = shown.allDay && !moved.allDay && !repeat.todo.timezone ? (to.timezone ?? '') || 'UTC' : zone
  const before = wallMinutes(taskWallClock(shown.at, shown.allDay, zone))
  const after = wallMinutes(taskWallClock(moved.at, moved.allDay, movedZone))
  const distance =
    shown.allDay === moved.allDay ? after - before : (Math.floor(after / 1440) - Math.floor(before / 1440)) * 1440

  // The current repeat's dates are the series' own.
  const [rid, named] =
    from === 'current' && repeat.todo.recurrenceId
      ? [repeat.todo.recurrenceId, repeat.todo]
      : [repeat.recurrenceId, repeat.shown]
  const ridWall = taskWallClock(rid, taskAnchor(named)?.allDay ?? shown.allDay, zone)
  return shiftRefusal(repeat.todo.rrule, ridWall, addWallMinutes(ridWall, distance))
}
