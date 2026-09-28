import { addDays, differenceInCalendarDays, startOfDay } from 'date-fns'
import { type ApiEvent, type CorruptedItem } from './api/schemas'
import { type CalTask } from './calendarTasks'
import { dayKey, localDateToUtc, shiftInterval, utcDateToLocal, type DateRange } from './dates'

/** An event occurrence prepared for display: dates are local `Date`s. */
export interface CalEvent extends ApiEvent {
  kind: 'event'
  /** Local start (all-day: local midnight of the start date). */
  startsAt: Date
  /** Local exclusive end (all-day: local midnight after the last day). */
  endsAt: Date
}

export type EventItem = CalEvent | CorruptedItem

/** Anything placed in the calendar views: events and tasks with dates (FR-16). */
export type CalItem = CalEvent | CalTask

/** Display title, falling back to a placeholder for untitled events. */
export function eventTitle(e: Pick<CalEvent, 'title'>, untitled: string): string {
  return e.title.trim() || untitled
}

export function toCalEvent(e: ApiEvent): CalEvent {
  if (e.allDay) {
    const s = utcDateToLocal(e.start)
    let en = utcDateToLocal(e.end)
    if (en <= s) en = addDays(s, 1)
    return { ...e, kind: 'event', startsAt: s, endsAt: en }
  }
  return { ...e, kind: 'event', startsAt: new Date(e.start), endsAt: new Date(e.end) }
}

/** First local day (midnight) the event occupies. */
export function firstDay(e: Pick<CalEvent, 'startsAt'>): Date {
  return startOfDay(e.startsAt)
}

/** Last local day (midnight) the event occupies; `end` is exclusive. */
export function lastDay(e: Pick<CalEvent, 'startsAt' | 'endsAt'>): Date {
  if (e.endsAt.getTime() <= e.startsAt.getTime()) return startOfDay(e.startsAt)
  return startOfDay(new Date(e.endsAt.getTime() - 1))
}

/** Rendered as a spanning bar: all-day or crossing midnight. */
export function isSpanning(e: Pick<CalItem, 'allDay' | 'startsAt' | 'endsAt'>): boolean {
  return e.allDay || differenceInCalendarDays(lastDay(e), firstDay(e)) > 0
}

export function overlapsDay(e: Pick<CalEvent, 'startsAt' | 'endsAt'>, day: Date): boolean {
  const d = startOfDay(day)
  return firstDay(e) <= d && lastDay(e) >= d
}

export function overlapsRange(e: Pick<CalEvent, 'startsAt' | 'endsAt'>, range: DateRange): boolean {
  return firstDay(e) < range.end && lastDay(e) >= startOfDay(range.start)
}

/** Stable display order: all-day first, then by start, longer first, events before tasks, then title. */
export function compareEvents(a: CalItem, b: CalItem): number {
  if (a.allDay !== b.allDay) return a.allDay ? -1 : 1
  const byStart = a.startsAt.getTime() - b.startsAt.getTime()
  if (byStart !== 0) return byStart
  const byLen = b.endsAt.getTime() - b.startsAt.getTime() - (a.endsAt.getTime() - a.startsAt.getTime())
  if (byLen !== 0) return byLen
  if (a.kind !== b.kind) return a.kind === 'event' ? -1 : 1
  return a.title.localeCompare(b.title)
}

/** Group events by local day key for the given days (multi-day events appear on each day). */
export function groupByDay<T extends CalItem>(events: T[], days: Date[]): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const d of days) map.set(dayKey(d), [])
  const sorted = [...events].sort(compareEvents)
  for (const e of sorted) {
    for (const d of days) {
      if (overlapsDay(e, d)) map.get(dayKey(d))?.push(e)
    }
  }
  return map
}

/**
 * New start/end for an event moved by drag and drop, in wire format (ISO).
 * All-day events move by whole UTC days; timed events by local days + minutes.
 */
export function movedTimes(
  e: CalEvent,
  dayDelta: number,
  minuteDelta: number,
): { start: string; end: string } {
  if (e.allDay) {
    const s = localDateToUtc(addDays(e.startsAt, dayDelta))
    const en = localDateToUtc(addDays(e.endsAt, dayDelta))
    return { start: s.toISOString(), end: en.toISOString() }
  }
  const moved = shiftInterval(e.startsAt, e.endsAt, dayDelta, minuteDelta)
  return { start: moved.start.toISOString(), end: moved.end.toISOString() }
}

/** The event with new wire-format times, e.g. to preview a drag before it is saved. */
export function withTimes(e: CalEvent, times: { start: string; end: string }): CalEvent {
  return toCalEvent({ ...e, ...times })
}
