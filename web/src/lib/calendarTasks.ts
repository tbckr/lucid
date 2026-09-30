import { addDays, addMinutes, startOfDay } from 'date-fns'
import { type OccurrenceState, type Todo, type TodoInput, type TodoOccurrence } from './api/schemas'
import { localDateToUtc, utcDateToLocal } from './dates'
import { todoToInput } from './tasks'

/** Height of a task that has a single point in time (FR-16). */
export const TASK_POINT_MINUTES = 30

/** A task placed in the calendar views (FR-16); dates are local `Date`s like `CalEvent`'s. */
export interface CalTask {
  kind: 'task'
  key: string
  calendarId: string
  title: string
  allDay: boolean
  /** A single point in time shown with a fixed size; labels show only `startsAt`. */
  point: boolean
  /** The dates that place it: start through due, or only one of them. */
  dates: 'span' | 'due' | 'start'
  startsAt: Date
  /** Exclusive end (all-day: local midnight after the last day). */
  endsAt: Date
  todo: Todo
  /** Set when this entry is one occurrence of a recurring series (FR-17), not the series itself. */
  occurrence?: { state: OccurrenceState; recurrenceId: string }
}

/** The dates of a todo, an occurrence, or a `TodoInput` about to be saved (FR-17). */
export interface TaskDates {
  start?: string | null
  startAllDay: boolean
  due?: string | null
  dueAllDay: boolean
}

interface TaskDate {
  at: Date
  allDay: boolean
}

function taskDate(iso: string | null | undefined, allDay: boolean): TaskDate | null {
  if (!iso) return null
  return { at: allDay ? utcDateToLocal(iso) : new Date(iso), allDay }
}

/** The instant that places a task, occurrence, or planned move (FR-16, FR-17): start, else due. */
export function anchorOf(d: TaskDates): Date | null {
  return taskDate(d.start, d.startAllDay)?.at ?? taskDate(d.due, d.dueAllDay)?.at ?? null
}

type Placement = Pick<CalTask, 'allDay' | 'point' | 'dates' | 'startsAt' | 'endsAt'>

/**
 * Where dates place a task or occurrence in the views, or null without dates.
 * Start and due of the same kind span the views (a due date counts as the
 * whole day); a single time becomes a fixed-size point, a single date an
 * all-day entry. Invalid combinations from other clients fall back to the due
 * date alone.
 */
function place(d: TaskDates): Placement | null {
  const start = taskDate(d.start, d.startAllDay)
  const due = taskDate(d.due, d.dueAllDay)

  if (start && due?.allDay === start.allDay) {
    if (start.allDay && start.at <= due.at) {
      return { allDay: true, point: false, dates: 'span', startsAt: start.at, endsAt: addDays(due.at, 1) }
    }
    if (!start.allDay && start.at < due.at) {
      return { allDay: false, point: false, dates: 'span', startsAt: start.at, endsAt: due.at }
    }
  }
  const single = due ?? start
  if (!single) return null
  const dates = due ? 'due' : 'start'
  if (single.allDay) {
    return { allDay: true, point: false, dates, startsAt: single.at, endsAt: addDays(single.at, 1) }
  }
  // Clamp to midnight so a late point stays on its day instead of becoming a bar.
  const end = addMinutes(single.at, TASK_POINT_MINUTES)
  const midnight = addDays(startOfDay(single.at), 1)
  return { allDay: false, point: true, dates, startsAt: single.at, endsAt: end < midnight ? end : midnight }
}

/** The calendar entry of a task, or null without dates (FR-16). */
export function toCalTask(todo: Todo): CalTask | null {
  const p = place(todo)
  if (!p) return null
  return { kind: 'task', key: `task:${todo.id}`, calendarId: todo.calendarId, title: todo.title, todo, ...p }
}

/**
 * The calendar entry of one occurrence of a recurring series (FR-17): placed
 * by the occurrence's own dates and keyed and titled by it, but carrying the
 * series as `todo` so completing or moving it acts on the series.
 */
export function occurrenceTask(occ: TodoOccurrence, todo: Todo): CalTask | null {
  const p = place(occ)
  if (!p) return null
  return {
    kind: 'task',
    key: occ.key,
    calendarId: occ.calendarId,
    title: occ.title,
    todo,
    occurrence: { state: occ.state, recurrenceId: occ.recurrenceId },
    ...p,
  }
}

/**
 * Whether a task can be completed (FR-15, FR-17): a plain task unless its
 * rule can't be read; an occurrence only when it is the current one, so
 * repeats are completed in order.
 */
export function canComplete(task: CalTask): boolean {
  if (!task.occurrence) return !task.todo.ruleUnsupported
  return task.occurrence.state === 'current'
}

/**
 * Whether a task can be dragged to move it (FR-10, FR-16, FR-17): the same
 * as `canComplete`. A plain task's eligibility doesn't depend on being done,
 * so it keeps moving after completion, like before occurrences existed; an
 * occurrence, or a todo whose rule Lucid can't read, may only move while it
 * could also be completed.
 */
export function canDrag(task: CalTask): boolean {
  return canComplete(task)
}

/** The window a recurring series may move within (FR-17). */
export interface MoveWindow {
  /** Local midnight of the series' current occurrence. */
  from: Date
  /** Exclusive: the anchor of the next occurrence. */
  until: Date
}

/**
 * The move window of a recurring series, or null when it isn't bounded
 * (FR-17): only a series with fixed days (an `RRULE` of just
 * FREQ/INTERVAL/COUNT/UNTIL/WKST, plus any `RDATE`) keeps its calendar dates
 * meaningful across a move, so it may move up to, but not past, its next
 * occurrence. Other series move freely, like `ruleUnsupported` ones can't
 * move at all (`canDrag`).
 */
export function moveWindow(todo: Todo): MoveWindow | null {
  if (!todo.recurring || !todo.fixedDays || !todo.next) return null
  const from = anchorOf(todo)
  if (!from) return null
  const until = anchorOf({
    start: todo.next.start,
    startAllDay: todo.startAllDay,
    due: todo.next.due,
    dueAllDay: todo.dueAllDay,
  })
  if (!until) return null
  return { from: startOfDay(from), until }
}

/** Whether `input`'s anchor still falls inside `todo`'s move window; true when it has none (FR-17). */
export function withinWindow(todo: Todo, input: TaskDates): boolean {
  const w = moveWindow(todo)
  if (!w) return true
  const anchor = anchorOf(input)
  if (!anchor) return false
  return anchor >= w.from && anchor < w.until
}

/** The last day a move within `w` may land on (inclusive). */
export function lastAllowedDay(w: MoveWindow): Date {
  return startOfDay(new Date(w.until.getTime() - 1))
}

/** A wire date moved like an event (`movedTimes`): all-day by whole dates, timed by local days, then minutes. */
function movedDate(iso: string | null | undefined, allDay: boolean, days: number, minutes: number): string | null {
  if (!iso) return null
  if (allDay) return localDateToUtc(addDays(utcDateToLocal(iso), days)).toISOString()
  return addMinutes(addDays(new Date(iso), days), minutes).toISOString()
}

/**
 * `todo` moved by a drag in the calendar views (FR-10, FR-16): start and due
 * move alike, so a span keeps its length, and each keeps its kind.
 */
export function movedTodo(todo: Todo, days: number, minutes: number): TodoInput {
  return todoToInput(todo, {
    start: movedDate(todo.start, todo.startAllDay, days, minutes),
    due: movedDate(todo.due, todo.dueAllDay, days, minutes),
  })
}
