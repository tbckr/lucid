import { addDays, differenceInCalendarDays } from 'date-fns'
import { z } from 'zod'
import { type Todo, type TodoInput } from './api/schemas'
import { anchorOf, withinWindow } from './calendarTasks'
import { dayKey, localDateToUtc, parseDayKey, utcToZoned, zonedToUtc } from './dates'
import { buildRRule, recurrenceFromRRule, type Recurrence } from './rrule'
import { todoToInput } from './tasks'

const optionalDate = z.union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'validation.date')])
const optionalTime = z.union([z.literal(''), z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'validation.time')])

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
}

/**
 * Task editor form; limits mirror domain.TodoInput.Validate. Messages are i18n keys.
 * `original` lets `validation.repeatNeedsDate` (FR-17) see whether the repeat itself
 * changes: a new task needs a date only if it is given a repeat, and an existing task
 * needs one only when its repeat changes, or when it had a date and both are cleared
 * while the rule stays (the backend rejects a kept rule without a date either way).
 * Not for edits that leave both the rule and an already-dateless series alone (a
 * `ruleUnsupported` series can be dateless, and its title must still be editable).
 */
export function buildTaskFormSchema(original?: Todo) {
  return z.object(taskFormShape).superRefine((v, ctx) => {
    // A rule recurs from the start, else the due date (FR-17). Removing a rule needs
    // no date, so this only fires while a rule stays set, and only when the rule is
    // the one being set, or a dated series just lost both its dates: an untouched
    // rule, kept on a task whose dates were never there, does not need one to be saved.
    const clearedDatedSeries = original !== undefined && anchorOf(original) !== null
    if (v.recurrence !== 'none' && v.startDate === '' && v.dueDate === '' && (repeatChanged(v, original) || clearedDatedSeries)) {
      ctx.addIssue({ code: 'custom', message: 'validation.repeatNeedsDate', path: ['recurrence'] })
    }
    if (v.dueTime !== '' && v.dueDate === '') {
      ctx.addIssue({ code: 'custom', message: 'validation.dateForTime', path: ['dueDate'] })
    }
    if (v.startTime !== '' && v.startDate === '') {
      ctx.addIssue({ code: 'custom', message: 'validation.dateForTime', path: ['startDate'] })
    }
    if (v.startDate === '' || v.dueDate === '') return
    // RFC 5545: DTSTART and DUE share a value type, and DUE is not before DTSTART (FR-16).
    if ((v.startTime === '') !== (v.dueTime === '')) {
      ctx.addIssue({ code: 'custom', message: 'validation.startDueType', path: ['startDate'] })
    } else if (`${v.startDate}T${v.startTime}` > `${v.dueDate}T${v.dueTime}`) {
      ctx.addIssue({ code: 'custom', message: 'validation.startAfterDue', path: ['startDate'] })
    }
  })
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

/** Date and time fields as a wire date; a date without time is all-day. */
function fromFields(date: string, time: string, timeZone: string): { value: string | null; allDay: boolean } {
  if (!date) return { value: null, allDay: false }
  if (time) return { value: zonedToUtc(date, time, timeZone).toISOString(), allDay: false }
  return { value: localDateToUtc(parseDayKey(date)).toISOString(), allDay: true }
}

type RepeatFields = Pick<TaskFormValues, 'recurrence' | 'customRule'>

/**
 * The repeat of a todo as the editor shows it (FR-17): a preset where the
 * rule is one, else "custom" with the rule kept verbatim. A rule Lucid can't
 * read, or a series of dates without a rule, is custom too: it can only be
 * kept or removed.
 */
function repeatOf(todo: Todo | undefined): RepeatFields {
  if (!todo) return { recurrence: 'none', customRule: '' }
  const custom = todo.ruleUnsupported || (todo.recurring && !todo.rrule.trim())
  const recurrence: Recurrence = custom ? 'custom' : recurrenceFromRRule(todo.rrule)
  return { recurrence, customRule: recurrence === 'custom' ? todo.rrule : '' }
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

export function taskToForm(todo: Todo, timeZone: string): TaskFormValues {
  const start = toFields(todo.start, todo.startAllDay, timeZone)
  const due = toFields(todo.due, todo.dueAllDay, timeZone)
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
    ...repeatOf(todo),
  }
}

export function formToTodoInput(v: TaskFormValues, timeZone: string, original?: Todo): TodoInput {
  const start = fromFields(v.startDate, v.startTime, timeZone)
  const due = fromFields(v.dueDate, v.dueTime, timeZone)
  const keepStatus = original && original.status !== 'COMPLETED' ? original.status : 'NEEDS-ACTION'
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
    ...(repeatChanged(v, original) ? { rrule: buildRRule(v.recurrence, v.customRule) } : {}),
    timezone: timeZone,
  }
}

const DATE_FIELDS = {
  start: { date: 'startDate', time: 'startTime', other: 'dueTime' },
  due: { date: 'dueDate', time: 'dueTime', other: 'startTime' },
} as const

/**
 * `v` with its start or due date set to `day` (FR-14, FR-16): a date that
 * moves keeps its time; a new one takes the other date's time, as RFC 5545
 * wants a time on both or neither.
 */
export function formWithDate(v: TaskFormValues, which: 'start' | 'due', day: string): TaskFormValues {
  const f = DATE_FIELDS[which]
  return { ...v, [f.date]: day, [f.time]: v[f.date] ? v[f.time] : v[f.other] }
}

/**
 * Whether the editor may give `todo` the start or due date `day` (FR-17):
 * the task it would save stays inside the move window of a fixed-day series.
 * A new or removed rule starts the series over from the dates it gets, so
 * only a kept rule binds them; without a window, any day will do.
 */
export function dayAllowed(
  todo: Todo | undefined,
  v: TaskFormValues,
  which: 'start' | 'due',
  day: string,
  timeZone: string,
): boolean {
  if (!todo) return true
  const input = formToTodoInput(formWithDate(v, which, day), timeZone, todo)
  return input.rrule !== undefined || withinWindow(todo, input)
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
 * `todo` with its due date set to `due`, in fields of `timeZone`: without a
 * date it is removed, without a time it is all-day (FR-14). The start moves by
 * as much as the due date and takes its kind, so the two stay a valid pair
 * (FR-16); a start that would still come after the due date ends at it.
 */
export function withDue(todo: Todo, due: Fields, timeZone: string): TodoInput {
  const next = fromFields(due.date, due.time, timeZone)
  const patch = { due: next.value, dueAllDay: next.allDay }
  if (!due.date || !todo.start) return todoToInput(todo, patch)

  const before = toFields(todo.due, todo.dueAllDay, timeZone)
  let start = toFields(todo.start, todo.startAllDay, timeZone)
  if (before.date) {
    const days = differenceInCalendarDays(parseDayKey(due.date), parseDayKey(before.date))
    const minutes = start.time && before.time && due.time ? minutesOf(due.time) - minutesOf(before.time) : 0
    start = shiftFields(start, days, minutes)
  }
  if (!due.time) start = { date: start.date, time: '' }
  else if (!start.time || !before.time) start = { date: start.date, time: due.time }
  if (`${start.date}T${start.time}` > `${due.date}T${due.time}`) start = due

  const s = fromFields(start.date, start.time, timeZone)
  return todoToInput(todo, { ...patch, start: s.value, startAllDay: s.allDay })
}
