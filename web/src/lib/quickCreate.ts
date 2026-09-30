import { type Calendar } from './api/schemas'
import { toCalTask } from './calendarTasks'
import { createFormValues, editFormValues, eventFormSchema, formToInput, shiftEnd, type EventFormValues } from './eventForm'
import { toCalEvent, type CalItem } from './events'
import { formToTodoInput, taskFormSchema, taskToForm, type TaskFormValues } from './taskForm'

/*
 * Rules of the popover that creates an event or a task from a click in the
 * calendar (FR-09, FR-16): the values a click starts with, what survives a
 * switch between the two kinds, which calendar takes the entry, the preview
 * the views draw, and the times a drag of that preview gives the entry.
 */

export type CreateKind = 'event' | 'task'

/** What was clicked: a time-grid slot or drag, or a whole day (all-day row, month cell). */
export interface CreateOrigin {
  start: Date
  end: Date
  allDay: boolean
  granularity: 'time' | 'day'
  /** Dragged over a span rather than clicked. */
  ranged: boolean
}

export type EventWhen = Pick<EventFormValues, 'allDay' | 'startDate' | 'startTime' | 'endDate' | 'endTime'>
export type TaskWhen = Pick<TaskFormValues, 'startDate' | 'startTime' | 'dueDate' | 'dueTime'>

/** When the entry happens, as an event and as a task: the popover keeps both for a switch of the kind. */
export interface CreateWhen {
  event: EventWhen
  task: TaskWhen
}

// Placeholders for fields the preview does not depend on, so their rules never hide it.
const ANY_TITLE = '-'
const ANY_CALENDAR = '-'
// The preview is no item of a calendar yet.
const DRAFT_ID = 'draft'

/** The event a click starts: the editor's create values (one hour, or all-day). */
export function eventWhen(origin: CreateOrigin, timeZone: string): EventWhen {
  const { allDay, startDate, startTime, endDate, endTime } = createFormValues(origin, '', timeZone)
  return { allDay, startDate, startTime, endDate, endTime }
}

/**
 * The event as a task: due when it begins, without a time for a whole day or
 * a day clicked as a whole, unless the user set its time since (`started`:
 * the event the click began with). A dragged span becomes start to due.
 */
export function taskWhen(
  event: EventWhen,
  origin: Pick<CreateOrigin, 'granularity' | 'ranged'>,
  started?: EventWhen,
): TaskWhen {
  if (origin.ranged && !event.allDay) {
    return { startDate: event.startDate, startTime: event.startTime, dueDate: event.endDate, dueTime: event.endTime }
  }
  const timeSet = started !== undefined && event.startTime !== started.startTime
  const dateOnly = event.allDay || (origin.granularity === 'day' && !timeSet)
  return { startDate: '', startTime: '', dueDate: event.startDate, dueTime: dateOnly ? '' : event.startTime }
}

/**
 * The task as an event: start to due, or `last` (the event before the switch)
 * moved to the task's date, beginning at its time if it has one.
 */
export function eventFromTask(task: TaskWhen, last: EventWhen): EventWhen {
  if (task.startDate && task.dueDate && (task.startTime === '') === (task.dueTime === '')) {
    const allDay = task.startTime === ''
    return {
      allDay,
      startDate: task.startDate,
      startTime: allDay ? last.startTime : task.startTime,
      endDate: task.dueDate,
      endTime: allDay ? last.endTime : task.dueTime,
    }
  }
  const date = task.dueDate || task.startDate
  const time = task.dueDate ? task.dueTime : task.startTime
  if (!date) return last
  if (!time) return { ...last, startDate: date, ...shiftEnd(last, date, last.startTime) }
  // An all-day event has no length in hours: it becomes the default hour.
  const base = last.allDay ? { ...last, allDay: false, endDate: last.startDate, startTime: '09:00', endTime: '10:00' } : last
  return { allDay: false, startDate: date, startTime: time, ...shiftEnd(base, date, time) }
}

/**
 * A new entry in the event or task editor (FR-09, FR-16). It keeps the dates
 * of both kinds, so a switch back returns to the event it was.
 */
export interface Draft {
  title: string
  description: string
  /** The calendar the user chose; empty while the editor chooses (`chooseCalendar`). */
  calendarId: string
  event: EventWhen
  task: TaskWhen
  /** How the entry began, and the event it began with: a switch to a task follows `taskWhen`. */
  origin: Pick<CreateOrigin, 'granularity' | 'ranged'>
  started: EventWhen
}

/** The entry a click starts, or "Create" and `c` on a day at its default hour. */
export function draftOf(origin: CreateOrigin, timeZone: string): Draft {
  const event = eventWhen(origin, timeZone)
  return {
    title: '',
    description: '',
    calendarId: '',
    event,
    task: taskWhen(event, origin),
    origin: { granularity: origin.granularity, ranged: origin.ranged },
    started: event,
  }
}

/** The entry as the other kind, with the dates the popover's switch gives it. */
export function switchDraft(draft: Draft, to: CreateKind): Draft {
  return to === 'task'
    ? { ...draft, task: taskWhen(draft.event, draft.origin, draft.started) }
    : { ...draft, event: eventFromTask(draft.task, draft.event) }
}

/** Move a task to `date` and `time`: a single date directly, a span keeping its length. */
export function shiftTask(task: TaskWhen, date: string, time: string): TaskWhen {
  if (task.startDate && task.dueDate) {
    const span = { allDay: task.startTime === '', startDate: task.startDate, startTime: task.startTime, endDate: task.dueDate, endTime: task.dueTime }
    const end = shiftEnd(span, date, time)
    return { startDate: date, startTime: time, dueDate: end.endDate, dueTime: end.endTime }
  }
  if (!task.dueDate && task.startDate) return { ...task, startDate: date, startTime: time }
  return { ...task, dueDate: date, dueTime: time }
}

/** Calendars that accept new entries of `kind`. */
export function writableFor(kind: CreateKind, calendars: readonly Calendar[]): Calendar[] {
  return calendars.filter((c) => !c.readOnly && (kind === 'event' ? c.supportsEvents : c.supportsTodos))
}

/**
 * The calendar a new entry goes to: the current one if it takes the kind, for
 * tasks the list shown in the sidebar, else the first visible, else the first
 * writable calendar. Null if none takes the kind.
 */
export function chooseCalendar(
  kind: CreateKind,
  o: { all: readonly Calendar[]; visible: readonly Calendar[]; taskList: string; current?: string },
): Calendar | null {
  const writable = writableFor(kind, o.all)
  const byId = (id: string | undefined) => (id ? writable.find((c) => c.id === id) : undefined)
  return (
    byId(o.current) ??
    (kind === 'task' ? byId(o.taskList) : undefined) ??
    writableFor(kind, o.visible)[0] ??
    writable[0] ??
    null
  )
}

/** The event editor's values for a new event. */
export function eventForm(title: string, calendarId: string, when: EventWhen): EventFormValues {
  const { allDay, startDate, startTime, endDate, endTime } = when
  return {
    title,
    calendarId,
    allDay,
    startDate,
    startTime,
    endDate,
    endTime,
    location: '',
    description: '',
    recurrence: 'none',
    customRule: '',
  }
}

/** The task editor's values for a new task. */
export function taskForm(title: string, when: TaskWhen): TaskFormValues {
  const { startDate, startTime, dueDate, dueTime } = when
  return { title, description: '', startDate, startTime, dueDate, dueTime, priority: 0, completed: false, checklist: [] }
}

/**
 * Where the entry will land, as the item the views draw and drag (FR-10), or
 * null while the values are invalid.
 */
export function previewOf(
  kind: CreateKind,
  when: EventWhen | TaskWhen,
  calendarId: string,
  title: string,
  timeZone: string,
): CalItem | null {
  const draft = { id: DRAFT_ID, calendarId, uid: '', etag: '' }
  if (kind === 'event') {
    const values = eventForm('', ANY_CALENDAR, when as EventWhen)
    if (!eventFormSchema.safeParse(values).success) return null
    const input = formToInput(values, timeZone)
    return toCalEvent({ ...input, ...draft, title, key: DRAFT_ID, recurring: false, recurrenceId: null })
  }
  // The task as the calendar places it (FR-16): a point, a span or a day.
  const values = taskForm(ANY_TITLE, when as TaskWhen)
  if (!taskFormSchema.safeParse(values).success) return null
  return toCalTask({
    ...formToTodoInput(values, timeZone),
    ...draft,
    title,
    completed: null,
    // The preview is never a recurring series (FR-17).
    rrule: '',
    recurring: false,
    fixedDays: false,
    ruleUnsupported: false,
  })
}

/**
 * The entry's times where a drag of its preview in the calendar put it
 * (FR-09, FR-10): an event's start and end, a task's dates as it has them.
 */
export function draggedWhen(item: CalItem, timeZone: string): Partial<CreateWhen> {
  if (item.kind === 'event') {
    const { allDay, startDate, startTime, endDate, endTime } = editFormValues(item, timeZone)
    return { event: { allDay, startDate, startTime, endDate, endTime } }
  }
  const { startDate, startTime, dueDate, dueTime } = taskToForm(item.todo, timeZone)
  return { task: { startDate, startTime, dueDate, dueTime } }
}
