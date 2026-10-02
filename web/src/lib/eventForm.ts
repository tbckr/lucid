import { addDays, differenceInCalendarDays, format } from 'date-fns'
import { z } from 'zod'
import { type EventInput, type OccurrenceInput } from './api/schemas'
import { localDateToUtc, parseDayKey, utcToZoned, zonedToUtc } from './dates'
import { type CalEvent } from './events'
import { type Duration } from './format'
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
  defaults: { start: Date; end: Date; allDay: boolean; title?: string | undefined },
  calendarId: string,
  timeZone: string,
): EventFormValues {
  const s = utcToZoned(defaults.start, timeZone)
  const e = utcToZoned(defaults.end, timeZone)
  return {
    title: defaults.title ?? '',
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

/**
 * Whether the form's repeat rule differs from the editor's initial values
 * (FR-17): by preset, or by the custom rule's text while on "custom". This
 * compares the editor's own fields, never RRULE text, so a stored rule the
 * presets would rewrite (Apple's explicit "INTERVAL=1", lower case, ...)
 * still counts as unchanged.
 */
export function ruleChanged(values: EventFormValues, initial: EventFormValues): boolean {
  return (
    values.recurrence !== initial.recurrence ||
    (values.recurrence === 'custom' && values.customRule.trim() !== initial.customRule.trim())
  )
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
  // While a series' rule and all-day flag are unchanged from the editor's
  // initial values, the stored RRULE goes back verbatim (FR-17): rebuilding
  // it from the preset can rewrite text the server would then see as a
  // changed rule, losing the fast path that keeps the series' own time zone.
  const initial = event ? editFormValues(event, timeZone) : undefined
  const rrule =
    event?.recurring && initial && !ruleChanged(v, initial) && v.allDay === initial.allDay
      ? event.rrule
      : buildRRule(v.recurrence, v.customRule)
  return {
    title: v.title.trim(),
    description: v.description,
    location: v.location.trim(),
    start: start.toISOString(),
    end: end.toISOString(),
    allDay: v.allDay,
    timezone: v.allDay ? '' : timeZone,
    rrule,
    ...(event?.recurring && event.recurrenceId ? { instanceStart: event.recurrenceId } : {}),
  }
}

/**
 * Drops the fields `OccurrenceInput` doesn't have (FR-17): the rule belongs
 * to the series, and the occurrence being edited is already named in the
 * path, not the body.
 */
export function occurrenceInput(input: EventInput): OccurrenceInput {
  const { rrule: _rrule, instanceStart: _instanceStart, ...rest } = input
  return rest
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
  const duration = Math.max(0, wallClockMs(prev.endDate, prev.endTime) - wallClockMs(prev.startDate, prev.startTime))
  const end = new Date(wallClockMs(nextStartDate, nextStartTime) + duration)
  return { endDate: end.toISOString().slice(0, 10), endTime: end.toISOString().slice(11, 16) }
}

// Wall-clock arithmetic in a fixed offset (UTC) keeps the displayed duration.
function wallClockMs(date: string, time: string): number {
  return Date.parse(`${date}T${time}:00Z`)
}

/**
 * Length of the event as the form shows it: wall-clock minutes for timed
 * events, days (the last one included) for all-day events. Null while a value
 * is invalid or the end lies before the start.
 */
export function formDuration(
  v: Pick<EventFormValues, 'startDate' | 'startTime' | 'endDate' | 'endTime' | 'allDay'>,
): Duration | null {
  if (!dateRe.test(v.startDate) || !dateRe.test(v.endDate)) return null
  if (v.allDay) {
    const days = differenceInCalendarDays(parseDayKey(v.endDate), parseDayKey(v.startDate)) + 1
    return days > 0 ? { days } : null
  }
  if (!timeRe.test(v.startTime) || !timeRe.test(v.endTime)) return null
  const minutes = (wallClockMs(v.endDate, v.endTime) - wallClockMs(v.startDate, v.startTime)) / 60_000
  return minutes >= 0 ? { minutes } : null
}

/** Time options in 15-minute steps (value "HH:mm"). */
export function timeOptions(step = 15): string[] {
  const out: string[] = []
  for (let m = 0; m < 24 * 60; m += step) {
    out.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`)
  }
  return out
}
