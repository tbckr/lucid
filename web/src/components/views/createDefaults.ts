import { addHours, isSameDay, startOfHour } from 'date-fns'
import { atMinutes } from '@/lib/dates'
import { type CreateDefaults } from '@/stores/ui'

/** Default times when creating an event on `day`: next full hour today, otherwise 09:00. */
export function defaultCreateTimes(day: Date, now: Date): CreateDefaults {
  let start: Date
  if (isSameDay(day, now)) {
    start = addHours(startOfHour(now), 1)
    if (!isSameDay(start, day)) start = atMinutes(day, 23 * 60)
  } else {
    start = atMinutes(day, 9 * 60)
  }
  return { start, end: addHours(start, 1), allDay: false }
}
