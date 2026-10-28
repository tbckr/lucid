import {
  addDays,
  addMinutes,
  addMonths,
  addWeeks,
  differenceInCalendarDays,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from 'date-fns'
import { type WeekStart } from './locale'

export type ViewKind = 'month' | 'week' | 'day' | 'agenda'
export const VIEWS: readonly ViewKind[] = ['month', 'week', 'day', 'agenda']

/** Number of days shown by the agenda view. */
export const AGENDA_DAYS = 30

/** A half-open local date range [start, end). */
export interface DateRange {
  start: Date
  end: Date
}

/** The dates shown by a view (local time, end exclusive). */
export function visibleRange(view: ViewKind, date: Date, weekStartsOn: WeekStart): DateRange {
  switch (view) {
    case 'month': {
      const start = startOfWeek(startOfMonth(date), { weekStartsOn })
      const end = addDays(startOfDay(endOfWeek(endOfMonth(date), { weekStartsOn })), 1)
      return { start, end }
    }
    case 'week': {
      const start = startOfWeek(date, { weekStartsOn })
      return { start, end: addDays(start, 7) }
    }
    case 'day': {
      const start = startOfDay(date)
      return { start, end: addDays(start, 1) }
    }
    case 'agenda': {
      const start = startOfDay(date)
      return { start, end: addDays(start, AGENDA_DAYS) }
    }
  }
}

/**
 * The range requested from the API. Padded by a day on both sides so all-day
 * events (stored as UTC midnight) are included for every UTC offset; views
 * filter by local day anyway.
 */
export function fetchRange(range: DateRange): DateRange {
  return { start: addDays(range.start, -1), end: addDays(range.end, 1) }
}

/** Move the anchor date one period forward (+1) or back (-1). */
export function stepDate(view: ViewKind, date: Date, dir: 1 | -1): Date {
  switch (view) {
    case 'month':
      return addMonths(date, dir)
    case 'week':
      return addWeeks(date, dir)
    case 'day':
      return addDays(date, dir)
    case 'agenda':
      return addDays(date, dir * AGENDA_DAYS)
  }
}

/** Days of `range`, one Date (local midnight) per day. DST-safe. */
export function eachDay(range: DateRange): Date[] {
  const days: Date[] = []
  const n = differenceInCalendarDays(range.end, range.start)
  for (let i = 0; i < n; i++) days.push(addDays(range.start, i))
  return days
}

/** The month grid as rows of 7 days. */
export function monthGrid(date: Date, weekStartsOn: WeekStart): Date[][] {
  const days = eachDay(visibleRange('month', date, weekStartsOn))
  const weeks: Date[][] = []
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7))
  return weeks
}

/** Weekday dates (local midnight) for the week containing `date`. */
export function weekDays(date: Date, weekStartsOn: WeekStart): Date[] {
  return eachDay(visibleRange('week', date, weekStartsOn))
}

const dayKeyRe = /^(\d{4})-(\d{2})-(\d{2})$/
const formTimeRe = /^([01]\d|2[0-3]):([0-5]\d)$/

/** yyyy-MM-dd of a local date (stable key for days). */
export function dayKey(date: Date): string {
  return format(date, 'yyyy-MM-dd')
}

/** Parse a yyyy-MM-dd key as local midnight. */
export function parseDayKey(key: string): Date {
  const m = dayKeyRe.exec(key)
  if (!m) return new Date(1970, 0, 1)
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

/**
 * Whether `value` is a date as the forms hold it (FR-09): "yyyy-MM-dd", of a
 * day the calendar has, so `parseDayKey` reads it back as itself. Text a date
 * field couldn't read goes up as typed, and may have the shape: "2026-02-31"
 * read as a date would be 3 March, so it is none, and the forms refuse it.
 */
export function isFormDate(value: string): boolean {
  return dayKeyRe.test(value) && dayKey(parseDayKey(value)) === value
}

/** Whether `value` is a time as the forms hold it, "HH:mm" (FR-09). */
export function isFormTime(value: string): boolean {
  return formTimeRe.test(value)
}

/** All-day events are midnight UTC of the date: map to local midnight of the same calendar date. */
export function utcDateToLocal(iso: string | Date): Date {
  const d = typeof iso === 'string' ? new Date(iso) : iso
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

/** Local calendar date → midnight UTC of the same date (all-day wire format). */
export function localDateToUtc(date: Date): Date {
  return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
}

/** Minutes since local midnight. */
export function minutesOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes()
}

/** Local `day` at `minutes` after midnight (setHours keeps DST gaps sane). */
export function atMinutes(day: Date, minutes: number): Date {
  const d = startOfDay(day)
  d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0)
  return d
}

/**
 * `date` moved as far as `to` lies from `from`, on the local wall clock: by
 * calendar days, and by the time of day too unless `byDays` (FR-17).
 */
export function movedAs(date: Date, from: Date, to: Date, byDays = false): Date {
  const days = differenceInCalendarDays(to, from)
  const minutes = byDays ? 0 : minutesOfDay(to) - minutesOfDay(from)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, date.getHours(), date.getMinutes() + minutes)
}

/** A form's "yyyy-MM-dd" date at its "HH:mm" time, as local time; midnight without a valid time. */
export function dayAt(date: string, time: string): Date {
  const m = formTimeRe.exec(time)
  return m ? atMinutes(parseDayKey(date), Number(m[1]) * 60 + Number(m[2])) : parseDayKey(date)
}

/** The step lists and gestures offer, in minutes (FR-09, FR-10). */
export const STEP_MINUTES = 30

/** Round minutes to the nearest step. */
export function snapMinutes(minutes: number, step: number): number {
  return Math.round(minutes / step) * step
}

/**
 * Wall-clock date + time in `timeZone` → UTC instant, as the server's `zoned`
 * reads a DATE-TIME with a TZID (RFC 5545 section 3.3.5): a time a change of
 * the zone's UTC offset skips takes the offset before the change, so 02:30 on
 * the night Berlin changes to summer time is 03:30 CEST, and a time a change
 * back repeats is the first of the two. The editors then put a time where the
 * calendar (`Date`) and the server put it (#10, FR-18).
 */
export function zonedToUtc(date: string, time: string, timeZone: string): Date {
  return new Date(resolveWall(date, time, timeZone).at)
}

/**
 * `zonedToUtc` for an end or due time entered with `start`: of a time a
 * change back repeats, the second where the first lies before `start`, as
 * for the end of an event at the second 02:00 on the night Berlin leaves
 * summer time, whose start is kept (#10, FR-18).
 */
export function zonedToUtcAfter(date: string, time: string, timeZone: string, start: Date): Date {
  const { at, later } = resolveWall(date, time, timeZone)
  return new Date(later !== undefined && at < start.getTime() ? later : at)
}

/**
 * The time `time` ("HH:mm") on `date` is saved as where `timeZone` skips it,
 * such as "03:30" for 02:30 on the night Berlin changes to summer time
 * (`zonedToUtc`), for the editors to say so before saving (#10, FR-18).
 * `null` where the time exists, a repeated one too, or a value is invalid.
 */
export function skippedTime(date: string, time: string, timeZone: string): string | null {
  if (!isFormDate(date) || !isFormTime(time)) return null
  const { at, skipped } = resolveWall(date, time, timeZone)
  return skipped ? new Date(wallOf(at, timeZone)).toISOString().slice(11, 16) : null
}

const DAY_MS = 24 * 3600 * 1000

/**
 * The instant of `date` at `time` in `timeZone`, see `zonedToUtc`, whether
 * the zone skips that time, and the second instant of one it repeats. The
 * offsets a day before and after, which no zone changes twice in between:
 * the instant at each, and whether the zone has that offset there (the
 * algorithm of the server's `zoned`).
 */
function resolveWall(date: string, time: string, timeZone: string): { at: number; skipped: boolean; later?: number } {
  const wall = Date.parse(`${date}T${time}:00Z`)
  const offsetAt = (t: number) => wallOf(t, timeZone) - t
  const at = (offset: number) => ({ t: wall - offset, ok: offsetAt(wall - offset) === offset })
  const before = at(offsetAt(wall - DAY_MS))
  const after = at(offsetAt(wall + DAY_MS))
  if (before.ok && after.ok && before.t !== after.t) {
    return { at: Math.min(before.t, after.t), skipped: false, later: Math.max(before.t, after.t) }
  }
  if (after.ok && !before.ok) return { at: after.t, skipped: false }
  // The time itself, or a skipped one.
  return { at: before.t, skipped: !before.ok && !after.ok }
}

const wallFormats = new Map<string, Intl.DateTimeFormat>()

/**
 * The date and clock time of the instant `t` in `timeZone`, read as UTC, in
 * ms. From Intl, not date-fns-tz, whose zoned dates go through the runtime's
 * own zone: a wall clock that zone skips comes out an hour off (London's
 * 02:30 at 01:30Z on 2026-03-29 formats as 03:30 in a Berlin browser).
 */
function wallOf(t: number, timeZone: string): number {
  let f = wallFormats.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    wallFormats.set(timeZone, f)
  }
  const parts = f.formatToParts(t)
  const n = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value)
  return Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'))
}

/**
 * UTC instant → wall-clock date/time strings in `timeZone`, through Intl as
 * `zonedToUtc` reads them (`wallOf`): a zone's wall clock that the browser's
 * own zone skips reads right, such as London's 02:30 on the night Berlin
 * changes to summer time (#10, FR-18). Throws for a zone Intl doesn't know.
 */
export function utcToZoned(instant: Date, timeZone: string): { date: string; time: string } {
  const wall = new Date(wallOf(instant.getTime(), timeZone)).toISOString()
  return { date: wall.slice(0, 10), time: wall.slice(11, 16) }
}

/** Shift an interval by whole local days and minutes, preserving duration. */
export function shiftInterval(
  start: Date,
  end: Date,
  dayDelta: number,
  minuteDelta: number,
): { start: Date; end: Date } {
  const newStart = addMinutes(addDays(start, dayDelta), minuteDelta)
  const duration = end.getTime() - start.getTime()
  return { start: newStart, end: new Date(newStart.getTime() + duration) }
}

export { isSameDay }
