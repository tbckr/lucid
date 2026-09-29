import { addDays, addMinutes, startOfDay } from 'date-fns'
import { type Todo } from './api/schemas'
import { utcDateToLocal } from './dates'

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
}

interface TaskDate {
  at: Date
  allDay: boolean
}

function taskDate(iso: string | null | undefined, allDay: boolean): TaskDate | null {
  if (!iso) return null
  return { at: allDay ? utcDateToLocal(iso) : new Date(iso), allDay }
}

/**
 * The calendar entry of a task, or null without dates. Start and due of the
 * same kind span the views (a due date counts as the whole day); a single
 * time becomes a fixed-size point, a single date an all-day entry. Invalid
 * combinations from other clients fall back to the due date alone.
 */
export function toCalTask(todo: Todo): CalTask | null {
  const start = taskDate(todo.start, todo.startAllDay)
  const due = taskDate(todo.due, todo.dueAllDay)
  const base = { kind: 'task' as const, key: `task:${todo.id}`, calendarId: todo.calendarId, title: todo.title, todo }

  if (start && due?.allDay === start.allDay) {
    if (start.allDay && start.at <= due.at) {
      return { ...base, allDay: true, point: false, dates: 'span', startsAt: start.at, endsAt: addDays(due.at, 1) }
    }
    if (!start.allDay && start.at < due.at) {
      return { ...base, allDay: false, point: false, dates: 'span', startsAt: start.at, endsAt: due.at }
    }
  }
  const single = due ?? start
  if (!single) return null
  const dates = due ? 'due' : 'start'
  if (single.allDay) {
    return { ...base, allDay: true, point: false, dates, startsAt: single.at, endsAt: addDays(single.at, 1) }
  }
  // Clamp to midnight so a late point stays on its day instead of becoming a bar.
  const end = addMinutes(single.at, TASK_POINT_MINUTES)
  const midnight = addDays(startOfDay(single.at), 1)
  return { ...base, allDay: false, point: true, dates, startsAt: single.at, endsAt: end < midnight ? end : midnight }
}
