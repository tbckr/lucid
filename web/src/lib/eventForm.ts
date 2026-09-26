import { addDays, differenceInCalendarDays, format } from 'date-fns'
import { z } from 'zod'
import { type EventInput } from './api/schemas'
import { localDateToUtc, parseDayKey, utcToZoned, zonedToUtc } from './dates'
import { type CalEvent } from './events'
import { buildRRule, recurrenceFromRRule, type Recurrence } from './rrule'

const dateRe = /^\d{4}-\d{2}-\d{2}$/
const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/

/**
 * Event editor form. Messages are i18n keys resolved by the form.
 * Limits mirror domain.EventInput.Validate.
 */
export const eventFormSchema = z
  .object({
    title: z.string().max(1024, 'validation.tooLong'),
    calendarId: z.string().min(1, 'validation.calendarRequired'),
    allDay: z.boolean(),
    startDate: z.string().regex(dateRe, 'validation.date'),
    startTime: z.string().regex(timeRe, 'validation.time'),
    endDate: z.string().regex(dateRe, 'validation.date'),
    endTime: z.string().regex(timeRe, 'validation.time'),
    location: z.string().max(1024, 'validation.tooLong'),
    description: z.string().max(64 * 1024, 'validation.tooLong'),
    recurrence: z.enum(['none', 'daily', 'weekly', 'monthly', 'yearly', 'custom']),
    customRule: z.string().max(1024, 'validation.tooLong'),
  })
  .superRefine((v, ctx) => {
    if (!dateRe.test(v.startDate) || !dateRe.test(v.endDate)) return
    const endBeforeStart = v.allDay
      ? v.endDate < v.startDate
      : `${v.endDate}T${v.endTime}` < `${v.startDate}T${v.startTime}`
    if (endBeforeStart) {
      ctx.addIssue({ code: 'custom', message: 'validation.endBeforeStart', path: ['endDate'] })
    }
  })

export type EventFormValues = z.infer<typeof eventFormSchema>

/** Initial values for creating an event. */
export function createFormValues(
  defaults: { start: Date; end: Date; allDay: boolean },
  calendarId: string,
  timeZone: string,
): EventFormValues {
  const s = utcToZoned(defaults.start, timeZone)
  const e = utcToZoned(defaults.end, timeZone)
  return {
    title: '',
    calendarId,
    allDay: defaults.allDay,
    startDate: s.date,
    startTime: defaults.allDay ? '09:00' : s.time,
    endDate: defaults.allDay ? s.date : e.date,
    endTime: defaults.allDay ? '10:00' : e.time,
    location: '',
    description: '',
    recurrence: 'none',
    customRule: '',
  }
}

/** Values for editing an existing occurrence (shown in the browser time zone). */
export function editFormValues(event: CalEvent, timeZone: string): EventFormValues {
  const recurrence: Recurrence = recurrenceFromRRule(event.rrule)
  const base = {
    title: event.title,
    calendarId: event.calendarId,
    location: event.location,
    description: event.description,
    recurrence,
    customRule: recurrence === 'custom' ? event.rrule : '',
  }
  if (event.allDay) {
    const lastDay = addDays(event.endsAt, -1)
    return {
      ...base,
      allDay: true,
      startDate: format(event.startsAt, 'yyyy-MM-dd'),
      startTime: '09:00',
      endDate: format(lastDay < event.startsAt ? event.startsAt : lastDay, 'yyyy-MM-dd'),
      endTime: '10:00',
    }
  }
  const s = utcToZoned(event.startsAt, timeZone)
  const e = utcToZoned(event.endsAt, timeZone)
  return { ...base, allDay: false, startDate: s.date, startTime: s.time, endDate: e.date, endTime: e.time }
}

/** Convert form values to the API payload. `event` is set when editing. */
export function formToInput(v: EventFormValues, timeZone: string, event?: CalEvent): EventInput {
  let start: Date
  let end: Date
  if (v.allDay) {
    start = localDateToUtc(parseDayKey(v.startDate))
    // All-day end is exclusive: the day after the last day.
    end = localDateToUtc(addDays(parseDayKey(v.endDate), 1))
  } else {
    start = zonedToUtc(v.startDate, v.startTime, timeZone)
    end = zonedToUtc(v.endDate, v.endTime, timeZone)
  }
  return {
    title: v.title.trim(),
    description: v.description,
    location: v.location.trim(),
    start: start.toISOString(),
    end: end.toISOString(),
    allDay: v.allDay,
    timezone: v.allDay ? '' : timeZone,
    rrule: buildRRule(v.recurrence, v.customRule),
    ...(event?.recurring && event.recurrenceId ? { instanceStart: event.recurrenceId } : {}),
  }
}

/**
 * When the start moves, keep the event's duration (Google Calendar behaviour).
 * Returns the new end date/time strings.
 */
export function shiftEnd(
  prev: Pick<EventFormValues, 'startDate' | 'startTime' | 'endDate' | 'endTime' | 'allDay'>,
  nextStartDate: string,
  nextStartTime: string,
): { endDate: string; endTime: string } {
  if (!dateRe.test(prev.startDate) || !dateRe.test(nextStartDate)) {
    return { endDate: prev.endDate, endTime: prev.endTime }
  }
  if (prev.allDay) {
    const span = Math.max(0, differenceInCalendarDays(parseDayKey(prev.endDate), parseDayKey(prev.startDate)))
    return { endDate: format(addDays(parseDayKey(nextStartDate), span), 'yyyy-MM-dd'), endTime: prev.endTime }
  }
  if (!timeRe.test(prev.startTime) || !timeRe.test(prev.endTime) || !timeRe.test(nextStartTime)) {
    return { endDate: prev.endDate, endTime: prev.endTime }
  }
  // Wall-clock arithmetic in a fixed offset (UTC) keeps the displayed duration.
  const toMs = (d: string, t: string) => Date.parse(`${d}T${t}:00Z`)
  const duration = Math.max(0, toMs(prev.endDate, prev.endTime) - toMs(prev.startDate, prev.startTime))
  const end = new Date(toMs(nextStartDate, nextStartTime) + duration)
  return { endDate: end.toISOString().slice(0, 10), endTime: end.toISOString().slice(11, 16) }
}

/** Time options in 15-minute steps (value "HH:mm"). */
export function timeOptions(step = 15): string[] {
  const out: string[] = []
  for (let m = 0; m < 24 * 60; m += step) {
    out.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`)
  }
  return out
}
