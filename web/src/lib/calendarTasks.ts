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
  /**
   * Set when this entry is one occurrence of a recurring series (FR-17), not the series itself. Besides its state, it
   * keeps the occurrence's wire dates, which a write to it starts from: `startsAt` and `endsAt` are local `Date`s,
   * with the value type and the zone of the wire gone. `offRule` marks a repeat that lies on none of the rule's
   * instances.
   */
  occurrence?: TaskDates & { state: OccurrenceState; recurrenceId: string; offRule: boolean }
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
  return { allDay: false, point: true, dates, startsAt: single.at, endsAt: pointEnd(single.at) }
}

/** Where a point starting at `at` ends: clamped to midnight, so a late point stays on its day instead of becoming a bar. */
function pointEnd(at: Date): Date {
  const end = addMinutes(at, TASK_POINT_MINUTES)
  const midnight = addDays(startOfDay(at), 1)
  return end < midnight ? end : midnight
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
    occurrence: {
      state: occ.state,
      recurrenceId: occ.recurrenceId,
      offRule: occ.offRule,
      start: occ.start,
      startAllDay: occ.startAllDay,
      due: occ.due,
      dueAllDay: occ.dueAllDay,
    },
    ...p,
  }
}

/**
 * The open repeat of a task series a change starts from (FR-17): the series
 * `todo`, the repeat's RECURRENCE-ID, which the writes to it name, whether it
 * is the current repeat or a later one, and the dates it is `shown` on, which
 * an override can have moved from its RECURRENCE-ID. `last` marks the current
 * repeat of a series without a next one, which acts as a single task.
 * `offRule` marks a repeat on none of the rule's instances, from which no
 * series can go on.
 */
export interface TaskRepeat {
  todo: Todo
  recurrenceId: string
  at: 'current' | 'upcoming'
  last: boolean
  offRule: boolean
  shown: TaskDates
}

/**
 * The repeat a calendar entry shows (FR-17), or `null` for a plain task and
 * a done repeat, which no change of the series starts from. The shown dates
 * are the occurrence's wire dates; a drag preview keeps those of the pick-up,
 * so the dates it moves to come from the drop.
 */
export function repeatOf(task: CalTask): TaskRepeat | null {
  const occ = task.occurrence
  if (!occ || occ.state === 'done') return null
  return {
    todo: task.todo,
    recurrenceId: occ.recurrenceId,
    at: occ.state,
    last: occ.state === 'current' && !task.todo.next,
    offRule: occ.offRule,
    shown: { start: occ.start, startAllDay: occ.startAllDay, due: occ.due, dueAllDay: occ.dueAllDay },
  }
}

/**
 * The current repeat of `todo`, as the task list shows it (FR-17): named by
 * `todo.recurrenceId` and shown on the series' own dates, which are the
 * current repeat's. `null` without one, for a task that does not repeat or a
 * series that is done. Whether it lies off the rule is not reported for it,
 * and matters only for a later repeat.
 */
export function currentRepeat(todo: Todo): TaskRepeat | null {
  if (!todo.recurrenceId) return null
  return {
    todo,
    recurrenceId: todo.recurrenceId,
    at: 'current',
    last: !todo.next,
    offRule: false,
    shown: { start: todo.start, startAllDay: todo.startAllDay, due: todo.due, dueAllDay: todo.dueAllDay },
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
 * Whether a task can be dragged to move it (FR-10, FR-16, FR-17): what
 * `canComplete` allows, and an upcoming occurrence of a series whose rule can
 * be read. A plain task's eligibility doesn't depend on being done, so it
 * keeps moving after completion, like before occurrences existed. An upcoming
 * occurrence moves the series by the distance it was dragged, as an event's
 * occurrence does.
 */
export function canDrag(task: CalTask): boolean {
  if (task.occurrence?.state === 'upcoming') return !task.todo.ruleUnsupported
  return canComplete(task)
}

/** A wire date moved like an event (`movedTimes`): all-day by whole dates, timed by local days, then minutes. */
function movedDate(iso: string | null | undefined, allDay: boolean, days: number, minutes: number): string | null {
  if (!iso) return null
  if (allDay) return localDateToUtc(addDays(utcDateToLocal(iso), days)).toISOString()
  return addMinutes(addDays(new Date(iso), days), minutes).toISOString()
}

/**
 * `task` shown `days` and `minutes` later, the way `movedTodo` moves dates
 * (FR-10, FR-17): where a drag previews an upcoming occurrence, which the
 * series' own dates don't place.
 */
export function shiftedTask(task: CalTask, days: number, minutes: number): CalTask {
  const startsAt = addMinutes(addDays(task.startsAt, days), minutes)
  const endsAt = task.point ? pointEnd(startsAt) : addMinutes(addDays(task.endsAt, days), minutes)
  return { ...task, startsAt, endsAt }
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
