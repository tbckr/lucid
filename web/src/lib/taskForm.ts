import { addDays, differenceInCalendarDays } from 'date-fns'
import { z } from 'zod'
import { type Todo, type TodoInput } from './api/schemas'
import { anchorOf, type TaskDates } from './calendarTasks'
import { dayKey, isFormDate, isFormTime, localDateToUtc, parseDayKey, utcToZoned, zonedToUtc, zonedToUtcAfter } from './dates'
import { browserTimeZone } from './locale'
import { buildRRule, fitUntil, recurrenceFromRRule, type Recurrence } from './rrule'
import { todoToInput } from './tasks'
import { fieldZone, sameZone } from './zones'

// A date or time the task may leave out: empty, or as the forms hold it (FR-09).
const optionalDate = z.string().refine((v) => v === '' || isFormDate(v), 'validation.date')
const optionalTime = z.string().refine((v) => v === '' || isFormTime(v), 'validation.time')

const taskFormShape = {
  title: z.string().trim().min(1, 'validation.titleRequired').max(1024, 'validation.tooLong'),
  description: z.string().max(64 * 1024, 'validation.tooLong'),
  startDate: optionalDate,
  startTime: optionalTime,
  dueDate: optionalDate,
  dueTime: optionalTime,
  priority: z.number().int().min(0).max(9),
  completed: z.boolean(),
  checklist: z
    .array(z.object({ text: z.string().trim().min(1, 'validation.itemRequired').max(1024, 'validation.tooLong'), done: z.boolean() }))
    .max(200, 'validation.tooManyItems'),
  recurrence: z.enum(['none', 'daily', 'weekly', 'monthly', 'yearly', 'custom']),
  customRule: z.string().max(1024, 'validation.tooLong'),
  // The zones the start's and the due's fields are in; "" is none, the browser's (FR-18).
  startZone: z.string(),
  dueZone: z.string(),
}

/**
 * Task editor form; limits mirror domain.TodoInput.Validate. Messages are i18n keys.
 * `edit.original`, the task edited, lets `validation.repeatNeedsDate` (FR-17) see whether
 * the repeat itself changes: a new task needs a date only if it is given a repeat, and an
 * existing task needs one only when its repeat changes, or when it had a date and both are
 * cleared while the rule stays (the backend rejects a kept rule without a date either way).
 * Not for edits that leave both the rule and an already-dateless series alone (a
 * `ruleUnsupported` series can be dateless, and its title must still be editable).
 */
export function buildTaskFormSchema(edit?: { original: Todo }) {
  const original = edit?.original
  return z.object(taskFormShape).superRefine((v, ctx) => {
    // Text a date or time field couldn't read is refused as such, above (FR-09): nothing is read from it, not
    // the order of the dates, until it can be.
    const readable =
      [v.startDate, v.dueDate].every((d) => d === '' || isFormDate(d)) &&
      [v.startTime, v.dueTime].every((t) => t === '' || isFormTime(t))
    // A rule recurs from the start, else the due date (FR-17). Removing a rule needs
    // no date, so this only fires while a rule stays set, and only when the rule is
    // the one being set, or a dated series just lost both its dates: an untouched
    // rule, kept on a task whose dates were never there, does not need one to be saved.
    const clearedDatedSeries = original !== undefined && anchorOf(original) !== null
    // A new task's repeat is new whatever it is.
    const changed = edit ? repeatChanged(v, edit.original) : v.recurrence !== 'none'
    if (v.recurrence !== 'none' && v.startDate === '' && v.dueDate === '' && (changed || clearedDatedSeries)) {
      ctx.addIssue({ code: 'custom', message: 'validation.repeatNeedsDate', path: ['recurrence'] })
    }
    if (v.dueTime !== '' && v.dueDate === '') {
      ctx.addIssue({ code: 'custom', message: 'validation.dateForTime', path: ['dueDate'] })
    }
    if (v.startTime !== '' && v.startDate === '') {
      ctx.addIssue({ code: 'custom', message: 'validation.dateForTime', path: ['startDate'] })
    }
    if (!readable || v.startDate === '' || v.dueDate === '') return
    // RFC 5545: DTSTART and DUE share a value type, and DUE is not before DTSTART (FR-16). Times
    // compare at the instants saved, each in its field's zone: one summer time skips counts where
    // it is saved, an hour later (#10, FR-18).
    if ((v.startTime === '') !== (v.dueTime === '')) {
      ctx.addIssue({ code: 'custom', message: 'validation.startDueType', path: ['startDate'] })
    } else if (v.startTime === '' ? v.startDate > v.dueDate : startAfterDue(v, browserTimeZone())) {
      ctx.addIssue({ code: 'custom', message: 'validation.startAfterDue', path: ['startDate'] })
    }
  })
}

/** Whether the timed start of `v` is saved after its due, each read in its field's zone (FR-16, FR-18). */
function startAfterDue(
  v: Pick<TaskFormValues, 'startDate' | 'startTime' | 'startZone' | 'dueDate' | 'dueTime' | 'dueZone'>,
  browserZone: string,
): boolean {
  const start = zonedToUtc(v.startDate, v.startTime, fieldZone(v.startZone, browserZone))
  const due = zonedToUtc(v.dueDate, v.dueTime, fieldZone(v.dueZone, browserZone))
  return start > due
}

/** The schema for a new task: no original to compare the repeat against. */
export const taskFormSchema = buildTaskFormSchema()

export type TaskFormValues = z.infer<typeof taskFormSchema>

/** A wire date (UTC midnight for all-day values) as date and time fields in `timeZone`. */
function toFields(iso: string | null | undefined, allDay: boolean, timeZone: string): { date: string; time: string } {
  if (!iso) return { date: '', time: '' }
  if (allDay) return { date: iso.slice(0, 10), time: '' }
  return utcToZoned(new Date(iso), timeZone)
}

/**
 * Date and time fields, in `timeZone`, as a wire date; a date without time is
 * all-day. The fields can't say which of a time summer time repeats it is, so
 * a time left as the editor opened it, `opened`, read in `openedZone`, keeps
 * its instant while it is read in that zone still, and a due time entered
 * anew is not before the start, `after` (#10, FR-18).
 */
function fromFields(
  date: string,
  time: string,
  timeZone: string,
  {
    opened,
    openedAllDay = false,
    openedZone = timeZone,
    after,
  }: { opened?: string | null; openedAllDay?: boolean; openedZone?: string; after?: string | null } = {},
): { value: string | null; allDay: boolean } {
  if (!date) return { value: null, allDay: false }
  if (time) {
    const shown = opened && !openedAllDay ? toFields(opened, false, openedZone) : null
    const at =
      opened && shown?.date === date && shown.time === time && sameZone(timeZone, openedZone)
        ? new Date(opened)
        : after
          ? zonedToUtcAfter(date, time, timeZone, new Date(after))
          : zonedToUtc(date, time, timeZone)
    return { value: at.toISOString(), allDay: false }
  }
  return { value: localDateToUtc(parseDayKey(date)).toISOString(), allDay: true }
}

type RepeatFields = Pick<TaskFormValues, 'recurrence' | 'customRule'>

type ZoneFields = Pick<TaskFormValues, 'startZone' | 'dueZone'>

/**
 * The repeat of a todo as the editor shows it (FR-17): a preset where the
 * rule is one, else "custom" with the rule kept verbatim, as stored: the
 * editor shows and builds it in the task's own zone (FR-18). A rule Lucid
 * can't read, or a series of dates without a rule, is custom too: it can only
 * be kept or removed.
 */
function repeatOf(todo: Todo | undefined): RepeatFields {
  if (!todo) return { recurrence: 'none', customRule: '' }
  const rule = todo.rrule
  const custom = todo.ruleUnsupported || (todo.recurring && !rule.trim())
  const recurrence: Recurrence = custom ? 'custom' : recurrenceFromRRule(rule)
  return { recurrence, customRule: recurrence === 'custom' ? rule : '' }
}

/**
 * Whether `v` changes the repeat of `original`, or gives a new task one
 * (FR-17). An untouched repeat is not sent: the preset would write the stored
 * rule in its own words ("FREQ=WEEKLY" for "FREQ=WEEKLY;INTERVAL=1"), which
 * the server takes as a new rule, starting the series over.
 */
export function repeatChanged(v: RepeatFields, original?: Todo): boolean {
  const before = repeatOf(original)
  return v.recurrence !== before.recurrence || (v.recurrence === 'custom' && v.customRule !== before.customRule)
}

/** Whether `dates` has a time, at its start or its due. */
function hasTime(dates: TaskDates): boolean {
  return (!!dates.start && !dates.startAllDay) || (!!dates.due && !dates.dueAllDay)
}

/**
 * The zones of the rows of `dates`, a task of `series` (FR-18): a timed
 * start's is the series' `timezone`, a timed due's its `dueTimezone`; a timed
 * series without one recurs on UTC's clock, where the server reads it, and is
 * edited there; a single task without one has none, the browser's. A row
 * without a time is in the other's zone, where a time given it is saved: the
 * server gives a date the task doesn't have yet the form of the other one.
 * Without any time, there is none.
 */
function rowZones(dates: TaskDates, series: Todo): ZoneFields {
  const none = series.recurring ? 'UTC' : ''
  const start = dates.start && !dates.startAllDay ? (series.timezone ?? '') || none : null
  const due = dates.due && !dates.dueAllDay ? (series.dueTimezone ?? '') || none : null
  return { startZone: start ?? due ?? '', dueZone: due ?? start ?? '' }
}

/**
 * The form of `todo` (FR-17, FR-18): its rows in their own zones (`rowZones`),
 * each row's fields in its `fieldZone`, so a zone this browser can't read is
 * kept and its fields are in `browserZone`. Its repeat and zones are the ones
 * of `series`, the task itself unless `todo` holds the dates of one of its
 * repeats, its rule as stored.
 */
export function taskToForm(todo: Todo, browserZone: string, series: Todo = todo): TaskFormValues {
  const zones = rowZones(todo, series)
  const start = toFields(todo.start, todo.startAllDay, fieldZone(zones.startZone, browserZone))
  const due = toFields(todo.due, todo.dueAllDay, fieldZone(zones.dueZone, browserZone))
  return {
    title: todo.title,
    description: todo.description,
    startDate: start.date,
    startTime: start.time,
    dueDate: due.date,
    dueTime: due.time,
    priority: todo.priority,
    completed: todo.status === 'COMPLETED',
    checklist: todo.checklist.map((c) => ({ ...c })),
    ...repeatOf(series),
    ...zones,
  }
}

/** The due picker's fields of `todo` (FR-14): its due in `timeZone`, the browser's, whatever zone the task is in. */
export function dueFields(todo: Todo, timeZone: string): { dueDate: string; dueTime: string } {
  const due = toFields(todo.due, todo.dueAllDay, timeZone)
  return { dueDate: due.date, dueTime: due.time }
}

/** Whether the zone of either row differs from the one the editor opened with (FR-18), by `sameZone`. */
export function taskZonesChanged(v: ZoneFields, opened: ZoneFields): boolean {
  return !sameZone(v.startZone, opened.startZone) || !sameZone(v.dueZone, opened.dueZone)
}

/**
 * `v` with the start in `zone`, the clock times kept (FR-18). The due
 * follows while it is in the start's zone; one in a zone of its own keeps it.
 */
export function withTaskStartZone(v: TaskFormValues, zone: string): TaskFormValues {
  return { ...v, startZone: zone, dueZone: sameZone(v.dueZone, v.startZone) ? zone : v.dueZone }
}

/**
 * The body of a save of `v` (FR-17, FR-18). `original` is the task edited,
 * `opened` the dates the editor opened with: a repeat's own, else the task's.
 * Each row's fields are read in its field's zone (`fieldZone`), a row left as
 * the editor opened it keeping its instant (#10). A changed repeat is written
 * as built, its UNTIL in the zone of the date it recurs from.
 *
 * Zones go out only with a change, `timezone` and `dueTimezone` together, as
 * the server takes a zone sent back unchanged as no change: where a row's
 * zone differs from the one the editor opened with, or where a timed series
 * is made (new, from a single task, or from one without a time) and a timed
 * row has no zone. A row without one is then sent as the browser's zone for a
 * series, which needs a zone to keep its time across summer time, and as ""
 * (UTC) for a single task. `timezone` is the start's, the due's for a task
 * without a start, where it names DUE's zone as `dueTimezone` does; a task
 * without a time sends none.
 */
export function formToTodoInput(v: TaskFormValues, browserZone: string, original?: Todo, opened?: TaskDates): TodoInput {
  const openedDates = opened ?? original
  const openedZones = original && openedDates ? rowZones(openedDates, original) : { startZone: '', dueZone: '' }
  const startZone = fieldZone(v.startZone, browserZone)
  const dueZone = fieldZone(v.dueZone, browserZone)
  const start = fromFields(v.startDate, v.startTime, startZone, {
    opened: opened?.start,
    openedAllDay: opened?.startAllDay,
    openedZone: fieldZone(openedZones.startZone, browserZone),
  })
  const due = fromFields(v.dueDate, v.dueTime, dueZone, {
    opened: opened?.due,
    openedAllDay: opened?.dueAllDay,
    openedZone: fieldZone(openedZones.dueZone, browserZone),
    after: start.allDay ? null : start.value,
  })
  const keepStatus = original && original.status !== 'COMPLETED' ? original.status : 'NEEDS-ACTION'
  // The rule recurs from the start, else the due date, in its zone.
  const [anchorTime, anchorZone] = v.startDate ? [v.startTime, startZone] : [v.dueTime, dueZone]
  const rrule = repeatChanged(v, original) ? fitUntil(buildRRule(v.recurrence, v.customRule), anchorTime === '', anchorZone) : null
  // A series after the save: one given a rule, or one that keeps its own (FR-17).
  const series = rrule === null ? (original?.recurring ?? false) : rrule !== ''
  const timedStart = start.value !== null && !start.allDay
  const timedDue = due.value !== null && !due.allDay
  const madeTimedSeries = series && (!original?.recurring || !openedDates || !hasTime(openedDates))
  const zoned =
    (timedStart || timedDue) &&
    (taskZonesChanged(v, openedZones) ||
      (madeTimedSeries && ((timedStart && v.startZone === '') || (timedDue && v.dueZone === ''))))
  const sent = (zone: string) => (zone === '' && series ? browserZone : zone)
  const anchor = sent(v.startDate ? v.startZone : v.dueZone)
  return {
    title: v.title.trim(),
    description: v.description,
    checklist: v.checklist.map((c) => ({ text: c.text.trim(), done: c.done })),
    start: start.value,
    startAllDay: start.allDay,
    due: due.value,
    dueAllDay: due.allDay,
    priority: v.priority,
    status: v.completed ? 'COMPLETED' : keepStatus,
    // Absent keeps the stored rule, "" removes it (FR-17).
    ...(rrule !== null ? { rrule } : {}),
    ...(zoned ? { timezone: anchor, dueTimezone: v.dueDate ? sent(v.dueZone) : anchor } : {}),
  }
}

/**
 * Which of the fields a write to a series compares (title, notes, checklist,
 * priority) the user edited (FR-17): those that differ from the values the
 * editor opened with.
 */
export interface EditedFields {
  title?: boolean
  description?: boolean
  checklist?: boolean
  priority?: boolean
}

/**
 * The fields of `values` that differ from `opened`, the values the editor
 * opened with (FR-17). Texts compare trimmed, as a save trims them, so a stray
 * space is no edit.
 */
export function editedFields(opened: TaskFormValues, values: TaskFormValues): Required<EditedFields> {
  const sameItems =
    opened.checklist.length === values.checklist.length &&
    opened.checklist.every((c, i) => {
      const item = values.checklist[i]
      return item?.text.trim() === c.text.trim() && item.done === c.done
    })
  return {
    title: values.title.trim() !== opened.title.trim(),
    description: values.description !== opened.description,
    checklist: !sameItems,
    priority: values.priority !== opened.priority,
  }
}

/**
 * The body of a write to the task series `series` from the editor (FR-17):
 * `input`, with the series' own title, notes, checklist and priority where
 * the user left them alone (`dirty`). The server takes a field as changed
 * where it differs from the series', and writes it into the repeats; a
 * repeat's own value the editor showed, such as the title another app gave
 * a later repeat, is then not mistaken for the user's change.
 */
export function seriesEditInput(series: Todo, input: TodoInput, dirty: EditedFields): TodoInput {
  return {
    ...input,
    title: dirty.title ? input.title : series.title,
    description: dirty.description ? input.description : series.description,
    checklist: dirty.checklist ? input.checklist : series.checklist,
    priority: dirty.priority ? input.priority : series.priority,
  }
}

const DATE_FIELDS = {
  start: { date: 'startDate', time: 'startTime', zone: 'startZone', other: 'due' },
  due: { date: 'dueDate', time: 'dueTime', zone: 'dueZone', other: 'start' },
} as const

/**
 * `v` with its start or due date set to `day` (FR-14, FR-16): a date that
 * moves keeps its time; a new one takes the other date's time, as RFC 5545
 * wants a time on both or neither, in the other date's zone, where it means
 * the same moment (FR-18).
 */
export function formWithDate(v: TaskFormValues, which: 'start' | 'due', day: string): TaskFormValues {
  const f = DATE_FIELDS[which]
  const o = DATE_FIELDS[f.other]
  if (v[f.date] || !v[o.time]) return { ...v, [f.date]: day, [f.time]: v[f.date] ? v[f.time] : v[o.time] }
  return { ...v, [f.date]: day, [f.time]: v[o.time], [f.zone]: v[o.zone] }
}

/**
 * `v` with the time of its start or due date set to `time` (FR-14, FR-16):
 * with both dates, a time removed from one goes from the other too, and a time
 * given to one goes to the other where it has none, in its zone (FR-18), as
 * RFC 5545 wants a time on both or neither, and as a change of the due date in
 * the list does (`withDue`). A time changed, and text that can't be read,
 * leave the other.
 */
export function formWithTime(v: TaskFormValues, which: 'start' | 'due', time: string): TaskFormValues {
  const f = DATE_FIELDS[which]
  const o = DATE_FIELDS[f.other]
  const next = { ...v, [f.time]: time }
  if (!v.startDate || !v.dueDate) return next
  if (time === '') return { ...next, [o.time]: '' }
  if (isFormTime(time) && v[o.time] === '') return { ...next, [o.time]: time, [o.zone]: v[f.zone] }
  return next
}

interface Fields {
  date: string
  time: string
}

function minutesOf(time: string): number {
  const [h = 0, m = 0] = time.split(':').map(Number)
  return h * 60 + m
}

/** Date and time fields moved by `days` and `minutes`, carrying past midnight; wall-clock arithmetic, so DST cannot skew it. */
function shiftFields(f: Fields, days: number, minutes: number): Fields {
  if (!f.time) return { date: dayKey(addDays(parseDayKey(f.date), days)), time: '' }
  const total = minutesOf(f.time) + minutes
  const carry = Math.floor(total / 1440)
  const m = total - carry * 1440
  const pad = (n: number) => String(n).padStart(2, '0')
  return {
    date: dayKey(addDays(parseDayKey(f.date), days + carry)),
    time: `${pad(Math.floor(m / 60))}:${pad(m % 60)}`,
  }
}

/**
 * `todo` with its due date set to `due`, in fields of `browserZone`, as the
 * due picker shows it (`dueFields`): without a date it is removed, without a
 * time it is all-day (FR-14). The start moves by as much as the due date and
 * takes its kind, so the two stay a valid pair (FR-16); a start that would
 * still come after the due date ends at it. The write names no zone: the
 * task keeps its own (FR-18), except where a series without a time is given
 * one, which the server writes in the zone the write names, as the editor's
 * does (`formToTodoInput`, FR-17).
 */
export function withDue(todo: Todo, due: Fields, browserZone: string): TodoInput {
  const next = fromFields(due.date, due.time, browserZone)
  const timed = todo.recurring && !hasTime(todo) && !next.allDay && next.value !== null
  const patch = { due: next.value, dueAllDay: next.allDay, ...(timed ? { timezone: browserZone } : {}) }
  if (!due.date || !todo.start) return todoToInput(todo, patch)

  const before = toFields(todo.due, todo.dueAllDay, browserZone)
  let start = toFields(todo.start, todo.startAllDay, browserZone)
  if (before.date) {
    const days = differenceInCalendarDays(parseDayKey(due.date), parseDayKey(before.date))
    const minutes = start.time && before.time && due.time ? minutesOf(due.time) - minutesOf(before.time) : 0
    start = shiftFields(start, days, minutes)
  }
  if (!due.time) start = { date: start.date, time: '' }
  else if (!start.time || !before.time) start = { date: start.date, time: due.time }
  // A start after the due date moves back to it, at the times saved: on the night summer time starts,
  // 02:45 is saved after 03:15 (#10, FR-18).
  let s = fromFields(start.date, start.time, browserZone)
  if (s.value && next.value && Date.parse(s.value) > Date.parse(next.value)) s = next
  return todoToInput(todo, { ...patch, start: s.value, startAllDay: s.allDay })
}
