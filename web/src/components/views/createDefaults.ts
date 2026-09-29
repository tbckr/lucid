import { addHours, isSameDay, startOfHour } from 'date-fns'
import { atMinutes } from '@/lib/dates'
import { browserTimeZone } from '@/lib/locale'
import { draftOf, type CreateOrigin, type Draft } from '@/lib/quickCreate'

/** Default times when creating an event on `day`: next full hour today, otherwise 09:00. */
export function defaultCreateTimes(day: Date, now: Date): Pick<CreateOrigin, 'start' | 'end' | 'allDay'> {
  let start: Date
  if (isSameDay(day, now)) {
    start = addHours(startOfHour(now), 1)
    if (!isSameDay(start, day)) start = atMinutes(day, 23 * 60)
  } else {
    start = atMinutes(day, 9 * 60)
  }
  return { start, end: addHours(start, 1), allDay: false }
}

/** A new entry from "Create" or `c` on `day` (FR-09, FR-16): its default hour, like a click in its month cell. */
export function newDraft(day: Date, now: Date): Draft {
  return draftOf({ ...defaultCreateTimes(day, now), granularity: 'day', ranged: false }, browserTimeZone())
}
