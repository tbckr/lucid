import { addDays, differenceInCalendarDays } from 'date-fns'
import { z } from 'zod'
import { type Todo, type TodoInput } from './api/schemas'
import { dayKey, localDateToUtc, parseDayKey, utcToZoned, zonedToUtc } from './dates'
import { todoToInput } from './tasks'

const optionalDate = z.union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'validation.date')])
const optionalTime = z.union([z.literal(''), z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'validation.time')])

/** Task editor form; limits mirror domain.TodoInput.Validate. Messages are i18n keys. */
export const taskFormSchema = z
  .object({
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
  })
  .superRefine((v, ctx) => {
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
  }
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
