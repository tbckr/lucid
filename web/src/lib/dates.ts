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
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz'
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

/** yyyy-MM-dd of a local date (stable key for days). */
export function dayKey(date: Date): string {
  return format(date, 'yyyy-MM-dd')
}

/** Parse a yyyy-MM-dd key as local midnight. */
export function parseDayKey(key: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
  if (!m) return new Date(1970, 0, 1)
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
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

/** Round minutes to the nearest step. */
export function snapMinutes(minutes: number, step = 15): number {
  return Math.round(minutes / step) * step
}

/** Wall-clock date + time in `timeZone` → UTC instant. */
export function zonedToUtc(date: string, time: string, timeZone: string): Date {
  return fromZonedTime(`${date}T${time}:00`, timeZone)
}

/** UTC instant → wall-clock date/time strings in `timeZone`. */
export function utcToZoned(instant: Date, timeZone: string): { date: string; time: string } {
  return {
    date: formatInTimeZone(instant, timeZone, 'yyyy-MM-dd'),
    time: formatInTimeZone(instant, timeZone, 'HH:mm'),
  }
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
