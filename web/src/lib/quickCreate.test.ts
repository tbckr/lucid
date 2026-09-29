import { describe, expect, it } from 'vitest'
import { calendar } from '@/test/fixtures'
import { TASK_POINT_MINUTES } from './calendarTasks'
import { eventFormSchema, formToInput } from './eventForm'
import {
  chooseCalendar,
  eventDefaults,
  eventForm,
  eventFromTask,
  eventWhen,
  previewOf,
  shiftTask,
  taskForm,
  taskWhen,
  type CreateOrigin,
  type EventWhen,
  type TaskWhen,
} from './quickCreate'
import { formToTodoInput, taskFormSchema } from './taskForm'

const TZ = 'Europe/Berlin'

const personal = calendar({ id: 'c1', name: 'Personal', supportsTodos: false })
const work = calendar({ id: 'c2', name: 'Work' })
const tasks = calendar({ id: 'c3', name: 'Tasks', supportsEvents: false })
const ro = calendar({ id: 'c4', name: 'Shared', readOnly: true })

// A click on Wednesday, 30 September 2026 at 10:15 in the time grid.
const click: CreateOrigin = {
  start: new Date(2026, 8, 30, 10, 15),
  end: new Date(2026, 8, 30, 11, 15),
  allDay: false,
  granularity: 'time',
  ranged: false,
}
const clickWhen: EventWhen = { allDay: false, startDate: '2026-09-30', startTime: '10:15', endDate: '2026-09-30', endTime: '11:15' }
const due = (dueDate: string, dueTime: string): TaskWhen => ({ startDate: '', startTime: '', dueDate, dueTime })

describe('eventWhen', () => {
  it('keeps the clicked hour', () => {
    expect(eventWhen(click, TZ)).toEqual(clickWhen)
  })

  it('ends the next day after a click at 23:30', () => {
    const late = { ...click, start: new Date(2026, 8, 30, 23, 30), end: new Date(2026, 9, 1, 0, 30) }
    expect(eventWhen(late, TZ)).toMatchObject({ startDate: '2026-09-30', startTime: '23:30', endDate: '2026-10-01', endTime: '00:30' })
  })

  it('is all-day for the all-day row', () => {
    const day = { ...click, start: new Date(2026, 8, 30), end: new Date(2026, 8, 30), allDay: true, granularity: 'day' as const }
    expect(eventWhen(day, TZ)).toMatchObject({ allDay: true, startDate: '2026-09-30', endDate: '2026-09-30' })
  })
})

describe('taskWhen', () => {
  it('is due at the clicked time', () => {
    expect(taskWhen(clickWhen, click)).toEqual(due('2026-09-30', '10:15'))
  })

  it('runs from start to due after a drag', () => {
    expect(taskWhen({ ...clickWhen, startTime: '10:00', endTime: '12:00' }, { granularity: 'time', ranged: true })).toEqual({
      startDate: '2026-09-30',
      startTime: '10:00',
      dueDate: '2026-09-30',
      dueTime: '12:00',
    })
  })

  it.each([
    ['a month cell', { ...clickWhen, startTime: '09:00', endTime: '10:00' }, { granularity: 'day', ranged: false }],
    ['the all-day row', { ...clickWhen, allDay: true }, { granularity: 'day', ranged: false }],
  ] as const)('is due on the day, without a time, from %s', (_, when, origin) => {
    expect(taskWhen(when, origin)).toEqual(due('2026-09-30', ''))
  })
})

describe('eventFromTask', () => {
  it('starts at the due time and keeps the event length', () => {
    // Clicked at 10:15, moved to 14:00 as a task: the event is 14:00-15:00 again.
    expect(eventFromTask(due('2026-09-30', '14:00'), clickWhen)).toEqual({
      allDay: false,
      startDate: '2026-09-30',
      startTime: '14:00',
      endDate: '2026-09-30',
      endTime: '15:00',
    })
  })

  it('keeps a 90-minute length', () => {
    expect(eventFromTask(due('2026-09-30', '14:00'), { ...clickWhen, endTime: '11:45' })).toMatchObject({
      startTime: '14:00',
      endTime: '15:30',
    })
  })

  it('moves the event to a due date without time, keeping its hours', () => {
    expect(eventFromTask(due('2026-10-02', ''), clickWhen)).toEqual({ ...clickWhen, startDate: '2026-10-02', endDate: '2026-10-02' })
  })

  it('turns a remembered all-day event into one hour at the due time', () => {
    const allDay = { ...clickWhen, allDay: true, startTime: '09:00', endTime: '10:00' }
    expect(eventFromTask(due('2026-09-30', '14:00'), allDay)).toEqual({
      allDay: false,
      startDate: '2026-09-30',
      startTime: '14:00',
      endDate: '2026-09-30',
      endTime: '15:00',
    })
  })

  it('spans start to due', () => {
    const span = { startDate: '2026-09-30', startTime: '10:00', dueDate: '2026-09-30', dueTime: '12:00' }
    expect(eventFromTask(span, clickWhen)).toEqual({ ...clickWhen, startTime: '10:00', endTime: '12:00' })
  })

  it('spans days for dates without times', () => {
    const span = { startDate: '2026-09-30', startTime: '', dueDate: '2026-10-02', dueTime: '' }
    expect(eventFromTask(span, clickWhen)).toMatchObject({ allDay: true, startDate: '2026-09-30', endDate: '2026-10-02' })
  })

  it('keeps the last event without dates', () => {
    expect(eventFromTask(due('', ''), clickWhen)).toEqual(clickWhen)
  })
})

describe('shiftTask', () => {
  const span = { startDate: '2026-09-30', startTime: '10:00', dueDate: '2026-09-30', dueTime: '12:00' }

  it('moves a single due date and time', () => {
    expect(shiftTask(due('2026-09-30', '10:15'), '2026-10-01', '11:00')).toEqual(due('2026-10-01', '11:00'))
  })

  it('keeps the span when the start moves', () => {
    expect(shiftTask(span, '2026-09-30', '11:00')).toEqual({ ...span, startTime: '11:00', dueTime: '13:00' })
  })

  it('moves both dates of a span', () => {
    expect(shiftTask(span, '2026-10-01', '10:00')).toEqual({ ...span, startDate: '2026-10-01', dueDate: '2026-10-01' })
  })
})

describe('chooseCalendar', () => {
  const all = [personal, work, tasks, ro]

  it.each([
    ['the first visible writable event calendar', 'event', { visible: all, taskList: '' }, 'c1'],
    ['a visible one over a hidden one', 'event', { visible: [work, tasks], taskList: '' }, 'c2'],
    ['a hidden one when none is visible', 'event', { visible: [], taskList: '' }, 'c1'],
    ['the task list of the sidebar', 'task', { visible: all, taskList: 'c3' }, 'c3'],
    ['the first writable list when the sidebar list is read-only', 'task', { visible: all, taskList: 'c4' }, 'c2'],
    ['the current calendar when it takes the kind', 'task', { visible: all, taskList: 'c3', current: 'c2' }, 'c2'],
    ['the default when the current one does not', 'task', { visible: all, taskList: 'c3', current: 'c1' }, 'c3'],
  ] as const)('picks %s', (_, kind, o, id) => {
    expect(chooseCalendar(kind, { all, ...o })?.id).toBe(id)
  })

  it('is null without a writable calendar for the kind', () => {
    expect(chooseCalendar('task', { all: [personal, ro], visible: [personal, ro], taskList: '' })).toBeNull()
  })
})

describe('payloads', () => {
  it('sends a task due at a time', () => {
    expect(formToTodoInput(taskForm('Call', taskWhen(clickWhen, click)), TZ)).toMatchObject({
      title: 'Call',
      start: null,
      due: '2026-09-30T08:15:00.000Z',
      dueAllDay: false,
      priority: 0,
      checklist: [],
      status: 'NEEDS-ACTION',
    })
  })

  it('sends a task due on a day', () => {
    expect(formToTodoInput(taskForm('Call', due('2026-09-30', '')), TZ)).toMatchObject({
      due: '2026-09-30T00:00:00.000Z',
      dueAllDay: true,
    })
  })

  it('sends start and due of a span', () => {
    const span = { startDate: '2026-09-30', startTime: '10:00', dueDate: '2026-09-30', dueTime: '12:00' }
    expect(formToTodoInput(taskForm('Call', span), TZ)).toMatchObject({
      start: '2026-09-30T08:00:00.000Z',
      due: '2026-09-30T10:00:00.000Z',
    })
  })

  it('sends a task due on the day the clocks go back in CET', () => {
    expect(formToTodoInput(taskForm('Call', due('2026-10-25', '09:00')), TZ).due).toBe('2026-10-25T08:00:00.000Z')
  })

  it('sends the event of a click', () => {
    expect(formToInput(eventForm('Review', 'c1', clickWhen), TZ)).toMatchObject({
      title: 'Review',
      start: '2026-09-30T08:15:00.000Z',
      end: '2026-09-30T09:15:00.000Z',
      allDay: false,
    })
  })

  it('validates with the editor rules', () => {
    expect(taskFormSchema.safeParse(taskForm(' ', taskWhen(clickWhen, click))).error?.issues[0]?.message).toBe(
      'validation.titleRequired',
    )
    expect(eventFormSchema.safeParse(eventForm('', 'c1', { ...clickWhen, endTime: '09:00' })).error?.issues[0]?.message).toBe(
      'validation.endBeforeStart',
    )
  })

  it('takes only the dates from a larger object', () => {
    expect(taskForm('Call', { ...due('2026-09-30', ''), title: 'x', calendarId: 'c3' } as TaskWhen)).not.toHaveProperty('calendarId')
  })

  it('turns event values back into editor defaults', () => {
    expect(eventDefaults(clickWhen, TZ)).toEqual({ start: new Date(2026, 8, 30, 10, 15), end: new Date(2026, 8, 30, 11, 15), allDay: false })
    expect(eventDefaults({ ...clickWhen, allDay: true }, TZ)).toEqual({ start: new Date(2026, 8, 30), end: new Date(2026, 8, 30), allDay: true })
  })
})

describe('previewOf', () => {
  it('previews an event', () => {
    expect(previewOf('event', clickWhen, 'c1', 'Review', TZ)).toEqual({
      kind: 'event',
      calendarId: 'c1',
      title: 'Review',
      start: new Date(2026, 8, 30, 10, 15),
      end: new Date(2026, 8, 30, 11, 15),
      allDay: false,
      point: false,
    })
  })

  it('previews a task due at a time as a point', () => {
    expect(previewOf('task', due('2026-09-30', '10:15'), 'c3', '', TZ)).toMatchObject({
      kind: 'task',
      start: new Date(2026, 8, 30, 10, 15),
      end: new Date(2026, 8, 30, 10, 15 + TASK_POINT_MINUTES),
      allDay: false,
      point: true,
    })
  })

  it('previews a task due on a day as all-day', () => {
    expect(previewOf('task', due('2026-09-30', ''), 'c3', 'Call', TZ)).toMatchObject({
      start: new Date(2026, 8, 30),
      end: new Date(2026, 9, 1),
      allDay: true,
      point: false,
    })
  })

  it('previews an all-day event through its last day', () => {
    expect(previewOf('event', { ...clickWhen, allDay: true }, 'c1', '', TZ)).toMatchObject({
      start: new Date(2026, 8, 30),
      end: new Date(2026, 9, 1),
      allDay: true,
    })
  })

  it('has no preview for invalid values', () => {
    expect(previewOf('event', { ...clickWhen, endTime: '09:00' }, 'c1', '', TZ)).toBeNull()
    expect(previewOf('task', due('', ''), 'c3', 'Call', TZ)).toBeNull()
  })
})
