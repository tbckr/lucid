import { addDays, addMinutes, startOfDay } from 'date-fns'
import { type TFunction } from 'i18next'
import { type OccurrenceState, type Todo, type TodoInput, type TodoOccurrence } from './api/schemas'
import { localDateToUtc, utcDateToLocal } from './dates'
import { type FormatPrefs } from './format'
import { describeRRule } from './rrule'
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

/**
 * The rule a `RecurringMark` names, in words (FR-17): anchored on the series'
 * own dates, else `fallback` (a placed occurrence's, when the series itself
 * has none). A rule `describeRRule` cannot put into words, or no anchor at
 * all, falls back to naming it verbatim.
 */
export function recurringLabel(t: TFunction, todo: Todo, fallback: Date | null, prefs: FormatPrefs, now: Date): string {
  const anchor = anchorOf(todo) ?? fallback
  if (!anchor) return t('recurrence.customRule', { rule: todo.rrule })
  return describeRRule(todo.rrule, anchor, prefs, now, t) ?? t('recurrence.customRule', { rule: todo.rrule })
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

/** The window a recurring series may move within (FR-17), as local `Date`s. */
export interface MoveWindow {
  /** The start of the current occurrence's day, in the series' zone. */
  from: Date
  /**
   * Exclusive: the start of the next occurrence's day, or the next occurrence itself when it falls on the same day;
   * null without an upper bound.
   */
  until: Date | null
}

/**
 * The move window of a recurring series, or null when it isn't bounded
 * (FR-17): the server's (`Todo.moveWindow`), which also refuses a move that
 * leaves it. A fixed-day series keeps its later occurrences on their days,
 * so a move must stay from the start of the current occurrence's day to
 * before the next one's, and so must a repeat off the rule, which moves
 * alone. Days count in the series' own zone, which need not be the
 * browser's: a local day can be covered only in part. The hatch keeps such a
 * day open (`outsideWindow`), while a drop or a picked date is checked at its
 * exact time (`withinWindow`), as the server checks it. The last repeat has
 * no next occurrence to stay before (`until: null`), so it only must not land
 * on a day before its own. Other series move freely, like `ruleUnsupported`
 * ones can't move at all (`canDrag`). An all-day current occurrence counts
 * dates, which the wire writes as midnight UTC, and they become local
 * midnights like its own dates (`anchorOf`).
 */
export function moveWindow(todo: Todo): MoveWindow | null {
  const w = todo.moveWindow
  if (!w) return null
  const allDay = todo.start ? todo.startAllDay : todo.dueAllDay
  const at = (iso: string) => (allDay ? utcDateToLocal(iso) : new Date(iso))
  return { from: at(w.from), until: w.until ? at(w.until) : null }
}

/** Whether `input`'s anchor still falls inside `todo`'s move window; true when it has none (FR-17). */
export function withinWindow(todo: Todo, input: TaskDates): boolean {
  const w = moveWindow(todo)
  if (!w) return true
  const anchor = anchorOf(input)
  if (!anchor) return false
  return anchor >= w.from && (w.until === null || anchor < w.until)
}

/**
 * Which edge of `w` an anchor lies outside of, or null when it's within
 * (FR-17): shared by a blocked drag (`dropBlocked`) and the task editor's
 * submit guard, so a move and a typed date name the same edge the same way.
 */
export function windowEdge(w: MoveWindow, anchor: Date): { edge: 'from' | 'until'; date: Date } | null {
  if (anchor < w.from) return { edge: 'from', date: w.from }
  const { until } = w
  if (until !== null && anchor >= until) return { edge: 'until', date: startOfDay(new Date(until.getTime() - 1)) }
  return null
}

/** The last day a move within `w` may land on (inclusive), or null without an upper bound. */
export function lastAllowedDay(w: MoveWindow): Date | null {
  return w.until === null ? null : startOfDay(new Date(w.until.getTime() - 1))
}

/**
 * Whether `day` falls outside `w`, so the calendar views can hatch it while
 * dragging (FR-17): before `from` always; past the last allowed day only
 * when `w` has one.
 */
export function outsideWindow(w: MoveWindow, day: Date): boolean {
  const last = lastAllowedDay(w)
  return day < startOfDay(w.from) || (last !== null && day > last)
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
