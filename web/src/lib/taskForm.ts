import { z } from 'zod'
import { type Todo, type TodoInput } from './api/schemas'
import { localDateToUtc, parseDayKey, utcToZoned, zonedToUtc } from './dates'

const optionalDate = z.union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'validation.date')])
const optionalTime = z.union([z.literal(''), z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'validation.time')])

/** Task editor form; limits mirror domain.TodoInput.Validate. Messages are i18n keys. */
export const taskFormSchema = z
  .object({
    title: z.string().trim().min(1, 'validation.titleRequired').max(1024, 'validation.tooLong'),
    description: z.string().max(64 * 1024, 'validation.tooLong'),
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
  })

export type TaskFormValues = z.infer<typeof taskFormSchema>

export function taskToForm(todo: Todo, timeZone: string): TaskFormValues {
  let dueDate = ''
  let dueTime = ''
  if (todo.due) {
    if (todo.dueAllDay) {
      dueDate = todo.due.slice(0, 10)
    } else {
      const z = utcToZoned(new Date(todo.due), timeZone)
      dueDate = z.date
      dueTime = z.time
    }
  }
  return {
    title: todo.title,
    description: todo.description,
    dueDate,
    dueTime,
    priority: todo.priority,
    completed: todo.status === 'COMPLETED',
    checklist: todo.checklist.map((c) => ({ ...c })),
  }
}

export function formToTodoInput(v: TaskFormValues, timeZone: string, original?: Todo): TodoInput {
  let due: string | null = null
  let dueAllDay = false
  if (v.dueDate) {
    if (v.dueTime) {
      due = zonedToUtc(v.dueDate, v.dueTime, timeZone).toISOString()
    } else {
      due = localDateToUtc(parseDayKey(v.dueDate)).toISOString()
      dueAllDay = true
    }
  }
  const keepStatus = original && original.status !== 'COMPLETED' ? original.status : 'NEEDS-ACTION'
  return {
    title: v.title.trim(),
    description: v.description,
    checklist: v.checklist.map((c) => ({ text: c.text.trim(), done: c.done })),
    due,
    dueAllDay,
    priority: v.priority,
    status: v.completed ? 'COMPLETED' : keepStatus,
  }
}
