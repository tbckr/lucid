import { describe, expect, it } from 'vitest'
import { calendar } from '@/test/fixtures'
import { TASK_POINT_MINUTES } from './calendarTasks'
import { PX_PER_MINUTE, dropResult, withDrop } from './dnd'
import { eventFormSchema, formToInput } from './eventForm'
import { type CalEvent, type CalItem } from './events'
import {
  chooseCalendar,
  draftOf,
  draggedWhen,
  eventForm,
  eventFromTask,
  eventWhen,
  previewOf,
  shiftTask,
  switchDraft,
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

  it('keeps a time set in the popover after a click in a month cell', () => {
    // The cell started the event at 09:00; the user moved it to 14:00.
    const started = { ...clickWhen, startTime: '09:00', endTime: '10:00' }
    const month = { granularity: 'day', ranged: false } as const
    expect(taskWhen({ ...clickWhen, startTime: '14:00', endTime: '15:00' }, month, started)).toEqual(due('2026-09-30', '14:00'))
    expect(taskWhen({ ...started, startDate: '2026-10-01', endDate: '2026-10-01' }, month, started)).toEqual(due('2026-10-01', ''))
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

describe('draftOf', () => {
  it('starts an event at the clicked hour and a task due then', () => {
    expect(draftOf(click, TZ)).toEqual({
      title: '',
      description: '',
      calendarId: '',
      event: clickWhen,
      task: due('2026-09-30', '10:15'),
      origin: { granularity: 'time', ranged: false },
      started: clickWhen,
    })
  })

  it('makes a task due on a whole day without a time', () => {
    // "Create" and `c` start at a default hour on the day, like a month cell.
    const day: CreateOrigin = { ...click, start: new Date(2026, 8, 30, 9), end: new Date(2026, 8, 30, 10), granularity: 'day' }
    expect(draftOf(day, TZ)).toMatchObject({ event: { startTime: '09:00' }, task: due('2026-09-30', '') })
  })
})

describe('switchDraft', () => {
  const draft = draftOf({ ...click, granularity: 'day' }, TZ)

  it('makes the event a task with the rules of the popover', () => {
    expect(switchDraft(draft, 'task').task).toEqual(due('2026-09-30', ''))
    const moved = { ...draft, event: { ...clickWhen, startTime: '14:00', endTime: '15:00' } }
    expect(switchDraft(moved, 'task').task).toEqual(due('2026-09-30', '14:00'))
  })

  it('makes the task an event with the length of the one it was', () => {
    expect(switchDraft({ ...draft, task: due('2026-10-01', '16:00') }, 'event').event).toEqual({
      allDay: false,
      startDate: '2026-10-01',
      startTime: '16:00',
      endDate: '2026-10-01',
      endTime: '17:00',
    })
  })

  it('keeps the event to return to, and the title, notes and chosen calendar', () => {
    const named = { ...draft, title: 'Call', description: 'Agenda', calendarId: 'c2' }
    const task = switchDraft(named, 'task')
    expect(task).toMatchObject({ title: 'Call', description: 'Agenda', calendarId: 'c2', event: clickWhen })
    expect(switchDraft(task, 'event')).toMatchObject({ title: 'Call', description: 'Agenda', calendarId: 'c2', event: clickWhen })
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
})

describe('previewOf', () => {
  it('previews an event as the item it will be', () => {
    expect(previewOf('event', clickWhen, 'c1', 'Review', TZ)).toMatchObject({
      kind: 'event',
      calendarId: 'c1',
      title: 'Review',
      startsAt: new Date(2026, 8, 30, 10, 15),
      endsAt: new Date(2026, 8, 30, 11, 15),
      allDay: false,
      recurring: false,
    })
  })

  it('previews a task due at a time as a point', () => {
    expect(previewOf('task', due('2026-09-30', '10:15'), 'c3', '', TZ)).toMatchObject({
      kind: 'task',
      calendarId: 'c3',
      startsAt: new Date(2026, 8, 30, 10, 15),
      endsAt: new Date(2026, 8, 30, 10, 15 + TASK_POINT_MINUTES),
      allDay: false,
      point: true,
    })
  })

  it('previews a task due on a day as all-day', () => {
    expect(previewOf('task', due('2026-09-30', ''), 'c3', 'Call', TZ)).toMatchObject({
      startsAt: new Date(2026, 8, 30),
      endsAt: new Date(2026, 9, 1),
      allDay: true,
      point: false,
    })
  })

  it('previews an all-day event through its last day', () => {
    expect(previewOf('event', { ...clickWhen, allDay: true }, 'c1', '', TZ)).toMatchObject({
      startsAt: new Date(2026, 8, 30),
      endsAt: new Date(2026, 9, 1),
      allDay: true,
    })
  })

  it('has no preview for invalid values', () => {
    expect(previewOf('event', { ...clickWhen, endTime: '09:00' }, 'c1', '', TZ)).toBeNull()
    expect(previewOf('task', due('', ''), 'c3', 'Call', TZ)).toBeNull()
  })
})

describe('draggedWhen', () => {
  // The draft of the popover as the time grid shows it, dragged as CalendarDnd drags it.
  const wed = new Date(2026, 8, 30)
  const thu = new Date(2026, 9, 1)
  const draft = (kind: 'event' | 'task', when: EventWhen | TaskWhen) => previewOf(kind, when, 'c2', 'Review', TZ)!
  const moved = (item: CalItem, day: Date, minutes: number) => {
    const drag = { type: 'timed', event: item, originDay: wed, draft: true } as const
    return withDrop(drag, dropResult(drag, { type: 'column', day }, minutes * PX_PER_MINUTE)!).event
  }
  const resized = (item: CalEvent, minutes: number) => {
    const drag = { type: 'resize', event: item, draft: true } as const
    return withDrop(drag, dropResult(drag, null, minutes * PX_PER_MINUTE)!).event
  }

  it('moves an event, keeping its length', () => {
    expect(draggedWhen(moved(draft('event', clickWhen), wed, 45), TZ)).toEqual({
      event: { allDay: false, startDate: '2026-09-30', startTime: '11:00', endDate: '2026-09-30', endTime: '12:00' },
    })
  })

  it('moves an event to another day', () => {
    expect(draggedWhen(moved(draft('event', clickWhen), thu, -30), TZ)).toEqual({
      event: { allDay: false, startDate: '2026-10-01', startTime: '09:45', endDate: '2026-10-01', endTime: '10:45' },
    })
  })

  it('moves an event past midnight', () => {
    const late = { ...clickWhen, startTime: '22:30', endTime: '23:30' }
    expect(draggedWhen(moved(draft('event', late), wed, 60), TZ)).toEqual({
      event: { allDay: false, startDate: '2026-09-30', startTime: '23:30', endDate: '2026-10-01', endTime: '00:30' },
    })
  })

  it('changes the end of an event', () => {
    const item = draft('event', clickWhen)
    if (item.kind !== 'event') throw new Error('not an event')
    expect(draggedWhen(resized(item, 30), TZ)).toEqual({ event: { ...clickWhen, endTime: '11:45' } })
  })

  it('moves a task due at a time, which stays due only', () => {
    expect(draggedWhen(moved(draft('task', due('2026-09-30', '10:15')), thu, 60), TZ)).toEqual({
      task: due('2026-10-01', '11:15'),
    })
  })

  it('moves both dates of a task span', () => {
    const span = { startDate: '2026-09-30', startTime: '10:00', dueDate: '2026-09-30', dueTime: '12:00' }
    expect(draggedWhen(moved(draft('task', span), thu, -30), TZ)).toEqual({
      task: { startDate: '2026-10-01', startTime: '09:30', dueDate: '2026-10-01', dueTime: '11:30' },
    })
  })
})
