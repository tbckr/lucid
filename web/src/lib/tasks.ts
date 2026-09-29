import { differenceInCalendarDays, format } from 'date-fns'
import { type Calendar, type ChecklistItem, type Todo, type TodoInput, type TodoStatus } from './api/schemas'
import { utcDateToLocal } from './dates'
import { formatTime, type FormatPrefs } from './format'

export type PriorityLevel = 'none' | 'high' | 'medium' | 'low'

/** RFC 5545 priority → level: 1-4 high, 5 medium, 6-9 low, 0 none. */
export function priorityLevel(priority: number): PriorityLevel {
  if (priority >= 1 && priority <= 4) return 'high'
  if (priority === 5) return 'medium'
  if (priority >= 6 && priority <= 9) return 'low'
  return 'none'
}

/** Canonical RFC 5545 value for a level (used by the editor). */
export function priorityValue(level: PriorityLevel): number {
  switch (level) {
    case 'high':
      return 1
    case 'medium':
      return 5
    case 'low':
      return 9
    case 'none':
      return 0
  }
}

export function isDone(todo: Pick<Todo, 'status'>): boolean {
  return todo.status === 'COMPLETED' || todo.status === 'CANCELLED'
}

/** Priority rank for sorting: 1 (highest) first, "none" (0) last. */
function priorityRank(p: number): number {
  return p === 0 ? 10 : p
}

/** Sort: incomplete first, then by due date (none last), then priority, then title. */
export function compareTodos(a: Todo, b: Todo): number {
  const doneA = isDone(a)
  const doneB = isDone(b)
  if (doneA !== doneB) return doneA ? 1 : -1
  const dueA = a.due ? Date.parse(a.due) : Number.POSITIVE_INFINITY
  const dueB = b.due ? Date.parse(b.due) : Number.POSITIVE_INFINITY
  if (dueA !== dueB) return dueA < dueB ? -1 : 1
  const pr = priorityRank(a.priority) - priorityRank(b.priority)
  if (pr !== 0) return pr
  return a.title.localeCompare(b.title)
}

/** The task list shown in the sidebar: the saved one, or the first if it is gone (FR-12). */
export function selectTaskList<T extends { calendar: Pick<Calendar, 'id'> }>(lists: T[], id: string): T | undefined {
  return lists.find((l) => l.calendar.id === id) ?? lists[0]
}

export function isOverdue(todo: Pick<Todo, 'due' | 'dueAllDay' | 'status'>, now: Date): boolean {
  if (!todo.due || isDone(todo)) return false
  const due = new Date(todo.due)
  if (todo.dueAllDay) {
    // All-day due dates are midnight UTC of the date: overdue after that local day.
    const localEnd = new Date(due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate() + 1)
    return now.getTime() >= localEnd.getTime()
  }
  return now.getTime() > due.getTime()
}

/* Checklist operations (immutable). */

export function addChecklistItem(items: ChecklistItem[], text: string): ChecklistItem[] {
  const t = text.trim()
  if (!t) return items
  return [...items, { text: t, done: false }]
}

export function toggleChecklistItem(items: ChecklistItem[], index: number): ChecklistItem[] {
  return items.map((it, i) => (i === index ? { ...it, done: !it.done } : it))
}

export function removeChecklistItem(items: ChecklistItem[], index: number): ChecklistItem[] {
  return items.filter((_, i) => i !== index)
}

export function checklistProgress(items: ChecklistItem[]): { done: number; total: number } {
  return { done: items.filter((i) => i.done).length, total: items.length }
}

/** Todo → input for PUT, optionally overriding fields. */
export function todoToInput(todo: Todo, patch: Partial<TodoInput> = {}): TodoInput {
  return {
    title: todo.title,
    description: todo.description,
    checklist: todo.checklist,
    start: todo.start ?? null,
    startAllDay: todo.startAllDay,
    due: todo.due ?? null,
    dueAllDay: todo.dueAllDay,
    priority: todo.priority,
    status: todo.status,
    ...patch,
  }
}

export function toggledStatus(todo: Pick<Todo, 'status'>): TodoStatus {
  return todo.status === 'COMPLETED' ? 'NEEDS-ACTION' : 'COMPLETED'
}

/** The due date as a local date: all-day due dates are midnight UTC of the date. */
function localDue(todo: Pick<Todo, 'due' | 'dueAllDay'>): Date | null {
  if (!todo.due) return null
  return todo.dueAllDay ? utcDateToLocal(todo.due) : new Date(todo.due)
}

/**
 * Due label: "Today", "Tomorrow", "Yesterday" or a short date, plus time for
 * timed due dates. With `timeOnly` a heading names the day, so only the time is left.
 */
export function formatDue(
  todo: Pick<Todo, 'due' | 'dueAllDay'>,
  now: Date,
  prefs: FormatPrefs,
  labels: { today: string; tomorrow: string; yesterday: string },
  { timeOnly = false }: { timeOnly?: boolean } = {},
): string | null {
  const due = localDue(todo)
  if (!due) return null
  if (timeOnly) return todo.dueAllDay ? null : formatTime(due, prefs)
  const diff = differenceInCalendarDays(due, now)
  let day: string
  if (diff === 0) day = labels.today
  else if (diff === 1) day = labels.tomorrow
  else if (diff === -1) day = labels.yesterday
  else day = format(due, Math.abs(diff) < 180 ? 'EEE, d MMM' : 'PP', { locale: prefs.locale })
  return todo.dueAllDay ? day : `${day}, ${formatTime(due, prefs)}`
}

export type TaskGroupKind = 'overdue' | 'today' | 'tomorrow' | 'later' | 'noDue' | 'completed'

export interface TaskGroup {
  kind: TaskGroupKind
  todos: Todo[]
}

const GROUP_ORDER: TaskGroupKind[] = ['overdue', 'today', 'tomorrow', 'later', 'noDue', 'completed']

function groupOf(todo: Todo, now: Date): TaskGroupKind {
  if (isDone(todo)) return 'completed'
  const due = localDue(todo)
  if (!due) return 'noDue'
  if (isOverdue(todo, now)) return 'overdue'
  const diff = differenceInCalendarDays(due, now)
  if (diff === 0) return 'today'
  return diff === 1 ? 'tomorrow' : 'later'
}

/** The task list by when its tasks are due, completed last; empty groups are left out (FR-12, FR-14). */
export function groupTodos(todos: Todo[], now: Date): TaskGroup[] {
  const byKind = new Map<TaskGroupKind, Todo[]>(GROUP_ORDER.map((kind) => [kind, []]))
  for (const todo of [...todos].sort(compareTodos)) byKind.get(groupOf(todo, now))?.push(todo)
  return GROUP_ORDER.flatMap((kind) => {
    const list = byKind.get(kind) ?? []
    return list.length > 0 ? [{ kind, todos: list }] : []
  })
}
