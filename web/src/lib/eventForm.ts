import { addDays, differenceInCalendarDays, format } from 'date-fns'
import { z } from 'zod'
import { type EventInput, type OccurrenceInput } from './api/schemas'
import { isFormDate, isFormTime, localDateToUtc, parseDayKey, utcToZoned, zonedToUtc, zonedToUtcAfter } from './dates'
import { type CalEvent } from './events'
import { type Duration } from './format'
import { browserTimeZone } from './locale'
import { buildRRule, fitUntil, recurrenceFromRRule, type Recurrence } from './rrule'
import { fieldZone, sameZone, sentZone } from './zones'

/**
 * Event editor form. Messages are i18n keys resolved by the form.
 * Limits mirror domain.EventInput.Validate.
 */
export const eventFormSchema = z
  .object({
    title: z.string().max(1024, 'validation.tooLong'),
    calendarId: z.string().min(1, 'validation.calendarRequired'),
    allDay: z.boolean(),
    startDate: z.string().refine(isFormDate, 'validation.date'),
    // Checked below, only where they are shown: a time All day hides can't keep the event from
    // being saved, even one its field couldn't read (FR-09).
    startTime: z.string(),
    endDate: z.string().refine(isFormDate, 'validation.date'),
    endTime: z.string(),
    location: z.string().max(1024, 'validation.tooLong'),
    description: z.string().max(64 * 1024, 'validation.tooLong'),
    recurrence: z.enum(['none', 'daily', 'weekly', 'monthly', 'yearly', 'custom']),
    customRule: z.string().max(1024, 'validation.tooLong'),
    // The zones the start's and the end's fields are in; "" is none, the browser's (FR-18).
    startZone: z.string(),
    endZone: z.string(),
  })
  .superRefine((v, ctx) => {
    if (!v.allDay) {
      for (const path of ['startTime', 'endTime'] as const) {
        if (!isFormTime(v[path])) ctx.addIssue({ code: 'custom', message: 'validation.time', path: [path] })
      }
    }
    if (!isFormDate(v.startDate) || !isFormDate(v.endDate)) return
    // At the instants saved, each row in its own zone: a time summer time skips counts where it
    // is saved, an hour later (#10, FR-18).
    const endBeforeStart = v.allDay
      ? v.endDate < v.startDate
      : isFormTime(v.startTime) && isFormTime(v.endTime) && rowMinutes(v, browserTimeZone()) < 0
    if (endBeforeStart) {
      ctx.addIssue({ code: 'custom', message: 'validation.endBeforeStart', path: ['endDate'] })
    }
  })

export type EventFormValues = z.infer<typeof eventFormSchema>

type Rows = Pick<EventFormValues, 'startDate' | 'startTime' | 'endDate' | 'endTime' | 'startZone' | 'endZone'>

/**
 * The minutes from the start to the end at the instants the rows are saved as, each read in its
 * field's zone (FR-18): a time summer time skips where it is saved, a time it repeats at its
 * first pass, as the server reads them (`zonedToUtc`).
 */
function rowMinutes(v: Rows, browserZone: string): number {
  const start = zonedToUtc(v.startDate, v.startTime, fieldZone(v.startZone, browserZone))
  const end = zonedToUtc(v.endDate, v.endTime, fieldZone(v.endZone, browserZone))
  return (end.getTime() - start.getTime()) / 60_000
}

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
    endTime: defaults.allDay ? '09:30' : e.time,
    location: '',
    description: '',
    recurrence: 'none',
    customRule: '',
    // No zone: a new single event is saved without one unless one is picked, a new series in
    // the browser's (FR-18).
    startZone: '',
    endZone: '',
  }
}

/**
 * Values for editing an existing occurrence (FR-17, FR-18): its rule as
 * stored, and its fields in its own zones, `fieldZone` of each row's. A timed
 * series without a zone recurs on UTC's clock, where the server reads it, and
 * is edited there; a single event without one, and an all-day event, have no
 * zone and are shown in `browserZone`.
 */
export function editFormValues(event: CalEvent, browserZone: string): EventFormValues {
  const rule = event.rrule
  // A series of dates without a rule repeats too: "custom" without a rule, kept as it is (FR-17).
  const recurrence: Recurrence = event.recurring && !rule.trim() ? 'custom' : recurrenceFromRRule(rule)
  const base = {
    title: event.title,
    calendarId: event.calendarId,
    location: event.location,
    description: event.description,
    recurrence,
    customRule: recurrence === 'custom' ? rule : '',
  }
  if (event.allDay) {
    const lastDay = addDays(event.endsAt, -1)
    return {
      ...base,
      allDay: true,
      startDate: format(event.startsAt, 'yyyy-MM-dd'),
      startTime: '09:00',
      endDate: format(lastDay < event.startsAt ? event.startsAt : lastDay, 'yyyy-MM-dd'),
      endTime: '09:30',
      startZone: '',
      endZone: '',
    }
  }
  // A series' "no zone" is UTC, where the server reads it; a single event's is none, the browser's.
  const none = event.recurring ? 'UTC' : ''
  const startZone = event.timezone || none
  const endZone = event.endTimezone || none
  const s = utcToZoned(event.startsAt, fieldZone(startZone, browserZone))
  const e = utcToZoned(event.endsAt, fieldZone(endZone, browserZone))
  return { ...base, allDay: false, startDate: s.date, startTime: s.time, endDate: e.date, endTime: e.time, startZone, endZone }
}

/** Whether the zone of either row differs from the editor's initial values (FR-18), by `sameZone`. */
export function zonesChanged(
  v: Pick<EventFormValues, 'startZone' | 'endZone'>,
  initial: Pick<EventFormValues, 'startZone' | 'endZone'>,
): boolean {
  return !sameZone(v.startZone, initial.startZone) || !sameZone(v.endZone, initial.endZone)
}

/**
 * `v` with the start in `zone`, the clock times kept (FR-18). The end
 * follows while it is in the start's zone; one in a zone of its own keeps it.
 */
export function withStartZone(v: EventFormValues, zone: string): EventFormValues {
  return { ...v, startZone: zone, endZone: sameZone(v.endZone, v.startZone) ? zone : v.endZone }
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

/**
 * Whether the form keeps a series' repeat rule and all-day flag as the editor
 * opened with them (FR-17): only then does saving ask which events of the
 * series change, keep the series' own time zone, and send the stored rule
 * back verbatim.
 */
export function keepsRuleAndAllDay(values: EventFormValues, initial: EventFormValues): boolean {
  return !ruleChanged(values, initial) && values.allDay === initial.allDay
}

/**
 * Convert form values to the API payload (FR-17, FR-18). `event` is set when
 * editing. Each row's fields are read in its field's zone (`fieldZone`).
 * A zone goes out only where it changes, as an absent one keeps the zone and
 * form the server has: the start's (`timezone`) where its row's zone differs
 * from the one the editor opened with, or where a timed series is made (new,
 * from a single event, or from an all-day one) and the row has no zone; the
 * end's (`endTimezone`) likewise, and whenever the start's goes, as an absent
 * end follows a start zone sent. A series without a start zone the editor
 * shows in UTC thus stays as it is where only its end's zone changes. A row
 * without a zone is sent as the browser's zone for a series, which needs a
 * zone to keep its time across summer time, and as "" (UTC) for a single
 * event; a changed zone that names UTC as `PICKED_UTC`, a UTC picked, which
 * is stored as such. An all-day event has none.
 */
export function formToInput(v: EventFormValues, browserZone: string, event?: CalEvent): EventInput {
  const initial = event ? editFormValues(event, browserZone) : undefined
  const startZone = fieldZone(v.startZone, browserZone)
  const endZone = fieldZone(v.endZone, browserZone)
  let start: Date
  let end: Date
  if (v.allDay) {
    start = localDateToUtc(parseDayKey(v.startDate))
    // All-day end is exclusive: the day after the last day.
    end = localDateToUtc(addDays(parseDayKey(v.endDate), 1))
  } else {
    // The fields can't say which of a time summer time repeats it is, so a
    // row left as the editor opened it, its zone too, keeps its instant, and
    // an end entered anew is not before the start (#10, FR-18).
    const timed = event !== undefined && initial !== undefined && !initial.allDay
    start =
      timed &&
      v.startDate === initial.startDate &&
      v.startTime === initial.startTime &&
      sameZone(startZone, fieldZone(initial.startZone, browserZone))
        ? event.startsAt
        : zonedToUtc(v.startDate, v.startTime, startZone)
    end =
      timed &&
      v.endDate === initial.endDate &&
      v.endTime === initial.endTime &&
      sameZone(endZone, fieldZone(initial.endZone, browserZone))
        ? event.endsAt
        : zonedToUtcAfter(v.endDate, v.endTime, endZone, start)
  }
  // While a series' rule and all-day flag are unchanged from the editor's
  // initial values, the stored RRULE goes back verbatim (FR-17): rebuilding
  // it from the preset can rewrite text the server would then see as a
  // changed rule. A rule built here is read in the start's zone, its UNTIL
  // too.
  const rrule =
    event?.recurring && initial && keepsRuleAndAllDay(v, initial)
      ? event.rrule
      : fitUntil(buildRRule(v.recurrence, v.customRule), v.allDay, startZone)
  // A series after the save: one with a rule, or a series of dates that keeps its dates (FR-17).
  const series = rrule !== '' || (event?.recurring === true && v.recurrence !== 'none')
  const madeSeries = series && (!event?.recurring || initial?.allDay === true)
  const opened = initial ?? { startZone: '', endZone: '' }
  const startChanged = !sameZone(v.startZone, opened.startZone)
  const endChanged = !sameZone(v.endZone, opened.endZone)
  const sendStart = !v.allDay && (startChanged || (madeSeries && v.startZone === ''))
  const sendEnd = !v.allDay && (sendStart || endChanged || (madeSeries && v.endZone === ''))
  const sent = (zone: string, changed: boolean) => sentZone(zone, changed, series, browserZone)
  return {
    title: v.title.trim(),
    description: v.description,
    location: v.location.trim(),
    start: start.toISOString(),
    end: end.toISOString(),
    allDay: v.allDay,
    ...(sendStart ? { timezone: sent(v.startZone, startChanged) } : {}),
    ...(sendEnd ? { endTimezone: sent(v.endZone, endChanged) } : {}),
    rrule,
    ...(event?.recurring && event.recurrenceId ? { instanceStart: event.recurrenceId } : {}),
  }
}

/**
 * Drops the fields `OccurrenceInput` doesn't have (FR-17): the rule belongs
 * to the series, and the occurrence being edited is already named in the
 * path, not the body. Its zones too: a series has one zone for all its
 * events, which "Only this event" keeps (FR-18).
 */
export function occurrenceInput(input: EventInput): OccurrenceInput {
  const { rrule: _rrule, instanceStart: _instanceStart, timezone: _timezone, endTimezone: _endTimezone, ...rest } = input
  return rest
}

/**
 * When the start moves, keep the event's duration (Google Calendar behaviour).
 * Returns the new end date/time strings. A start or an end its field couldn't
 * read leaves the end as it is (FR-09): its note still says what to type.
 * Rows in one zone keep their length on the wall clock; rows in two zones
 * (each its field's zone, rows without zones in `browserZone`) keep the time
 * between their instants, the end written in its own zone (FR-18).
 */
export function shiftEnd(
  prev: Pick<EventFormValues, 'startDate' | 'startTime' | 'endDate' | 'endTime' | 'allDay'> &
    Partial<Pick<EventFormValues, 'startZone' | 'endZone'>>,
  nextStartDate: string,
  nextStartTime: string,
  browserZone: string = browserTimeZone(),
): { endDate: string; endTime: string } {
  if (!isFormDate(prev.startDate) || !isFormDate(nextStartDate) || !isFormDate(prev.endDate)) {
    return { endDate: prev.endDate, endTime: prev.endTime }
  }
  if (prev.allDay) {
    const span = Math.max(0, differenceInCalendarDays(parseDayKey(prev.endDate), parseDayKey(prev.startDate)))
    return { endDate: format(addDays(parseDayKey(nextStartDate), span), 'yyyy-MM-dd'), endTime: prev.endTime }
  }
  if (!isFormTime(prev.startTime) || !isFormTime(prev.endTime) || !isFormTime(nextStartTime)) {
    return { endDate: prev.endDate, endTime: prev.endTime }
  }
  const rows = { ...prev, startZone: prev.startZone ?? '', endZone: prev.endZone ?? '' }
  const startZone = fieldZone(rows.startZone, browserZone)
  const endZone = fieldZone(rows.endZone, browserZone)
  if (!sameZone(startZone, endZone)) {
    const minutes = Math.max(0, rowMinutes(rows, browserZone))
    const start = zonedToUtc(nextStartDate, nextStartTime, startZone)
    const end = utcToZoned(new Date(start.getTime() + minutes * 60_000), endZone)
    return { endDate: end.date, endTime: end.time }
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
 * Length of the event as the form shows it: for timed events, minutes on the
 * wall clock while both rows are in one zone, else between the instants they
 * are saved as, each row in its field's zone (FR-18); days (the last one
 * included) for all-day events. Null while a value is invalid or the end lies
 * before the start.
 */
export function formDuration(
  v: Pick<EventFormValues, 'allDay' | 'startDate' | 'startTime' | 'endDate' | 'endTime' | 'startZone' | 'endZone'>,
  browserZone: string,
): Duration | null {
  if (!isFormDate(v.startDate) || !isFormDate(v.endDate)) return null
  if (v.allDay) {
    const days = differenceInCalendarDays(parseDayKey(v.endDate), parseDayKey(v.startDate)) + 1
    return days > 0 ? { days } : null
  }
  if (!isFormTime(v.startTime) || !isFormTime(v.endTime)) return null
  const minutes = sameZone(fieldZone(v.startZone, browserZone), fieldZone(v.endZone, browserZone))
    ? (wallClockMs(v.endDate, v.endTime) - wallClockMs(v.startDate, v.startTime)) / 60_000
    : rowMinutes(v, browserZone)
  return minutes >= 0 ? { minutes } : null
}

/** The times of a day in steps of `step` minutes ("HH:mm"), as the time fields list them (FR-09). */
export function timeOptions(step: number): string[] {
  const out: string[] = []
  for (let m = 0; m < 24 * 60; m += step) {
    out.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`)
  }
  return out
}
