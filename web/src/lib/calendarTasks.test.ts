import { describe, expect, it } from 'vitest'
import { todo } from '@/test/fixtures'
import { movedTodo, toCalTask } from './calendarTasks'
import { isSpanning } from './events'

// Vitest runs in Europe/Berlin (CEST until 25 Oct 2026, UTC+2).
const allDay = (iso: string) => `${iso}T00:00:00Z`

describe('toCalTask', () => {
  it('spans from start to due when both have a time', () => {
    const task = toCalTask(todo({ start: '2026-09-25T07:00:00Z', due: '2026-09-25T09:00:00Z' }))
    expect(task).toMatchObject({
      startsAt: new Date(2026, 8, 25, 9),
      endsAt: new Date(2026, 8, 25, 11),
      allDay: false,
      point: false,
      dates: 'span',
    })
  })

  it('spans all-day from the start day through the due day', () => {
    const task = toCalTask(
      todo({ start: allDay('2026-09-25'), startAllDay: true, due: allDay('2026-09-27'), dueAllDay: true }),
    )
    expect(task).toMatchObject({
      startsAt: new Date(2026, 8, 25),
      endsAt: new Date(2026, 8, 28),
      allDay: true,
      point: false,
      dates: 'span',
    })
  })

  it('keeps an all-day span on local midnights across the DST change', () => {
    const task = toCalTask(
      todo({ start: allDay('2026-10-24'), startAllDay: true, due: allDay('2026-10-26'), dueAllDay: true }),
    )
    expect(task).toMatchObject({ startsAt: new Date(2026, 9, 24), endsAt: new Date(2026, 9, 27) })
  })

  it('shows a due time alone as a 30-minute point', () => {
    const task = toCalTask(todo({ due: '2026-09-25T08:00:00Z' }))
    expect(task).toMatchObject({
      startsAt: new Date(2026, 8, 25, 10),
      endsAt: new Date(2026, 8, 25, 10, 30),
      allDay: false,
      point: true,
      dates: 'due',
    })
  })

  it('shows a start time alone as a point', () => {
    const task = toCalTask(todo({ start: '2026-09-25T08:00:00Z' }))
    expect(task).toMatchObject({
      startsAt: new Date(2026, 8, 25, 10),
      endsAt: new Date(2026, 8, 25, 10, 30),
      point: true,
      dates: 'start',
    })
  })

  it('ends a point late in the day at midnight', () => {
    const task = toCalTask(todo({ due: '2026-09-25T21:45:00Z' }))!
    expect(task).toMatchObject({ startsAt: new Date(2026, 8, 25, 23, 45), endsAt: new Date(2026, 8, 26), point: true })
    expect(isSpanning(task)).toBe(false)
  })

  it('shows a due date alone on that day', () => {
    const task = toCalTask(todo({ due: allDay('2026-09-25'), dueAllDay: true }))
    expect(task).toMatchObject({
      startsAt: new Date(2026, 8, 25),
      endsAt: new Date(2026, 8, 26),
      allDay: true,
      point: false,
      dates: 'due',
    })
  })

  it('shows a start date alone on that day', () => {
    const task = toCalTask(todo({ start: allDay('2026-09-25'), startAllDay: true }))
    expect(task).toMatchObject({ startsAt: new Date(2026, 8, 25), endsAt: new Date(2026, 8, 26), allDay: true, dates: 'start' })
  })

  it.each([
    ['start after due', { start: '2026-09-25T10:00:00Z', due: '2026-09-25T08:00:00Z' }],
    ['equal timed start and due', { start: '2026-09-25T08:00:00Z', due: '2026-09-25T08:00:00Z' }],
    ['start date with timed due', { start: allDay('2026-09-24'), startAllDay: true, due: '2026-09-25T08:00:00Z' }],
  ])('falls back to the due time for %s', (_name, dates) => {
    expect(toCalTask(todo(dates))).toMatchObject({ startsAt: new Date(2026, 8, 25, 10), point: true, dates: 'due' })
  })

  it('falls back to the due day for a timed start with an all-day due', () => {
    const task = toCalTask(todo({ start: '2026-09-24T08:00:00Z', due: allDay('2026-09-25'), dueAllDay: true }))
    expect(task).toMatchObject({ startsAt: new Date(2026, 8, 25), endsAt: new Date(2026, 8, 26), allDay: true, dates: 'due' })
  })

  it('has no calendar entry without dates', () => {
    expect(toCalTask(todo())).toBeNull()
  })

  it('carries the todo', () => {
    const t = todo({ id: 't1', calendarId: 'c9', title: 'Pay rent', due: allDay('2026-09-25'), dueAllDay: true })
    const task = toCalTask(t)
    expect(task).toMatchObject({ kind: 'task', key: 'task:t1', calendarId: 'c9', title: 'Pay rent' })
    expect(task?.todo).toBe(t)
  })
})

describe('movedTodo', () => {
  it('moves a timed span by days and minutes, keeping its length', () => {
    const t = todo({ title: 'Pay rent', start: '2026-09-25T07:00:00Z', due: '2026-09-25T09:00:00Z', priority: 1 })
    expect(movedTodo(t, 2, 30)).toEqual({
      title: 'Pay rent',
      description: '',
      checklist: [],
      start: '2026-09-27T07:30:00.000Z',
      startAllDay: false,
      due: '2026-09-27T09:30:00.000Z',
      dueAllDay: false,
      priority: 1,
      status: 'NEEDS-ACTION',
    })
  })

  it('moves an all-day span by whole dates', () => {
    const t = todo({ start: allDay('2026-09-25'), startAllDay: true, due: allDay('2026-09-27'), dueAllDay: true })
    expect(movedTodo(t, -1, 0)).toMatchObject({
      start: '2026-09-24T00:00:00.000Z',
      startAllDay: true,
      due: '2026-09-26T00:00:00.000Z',
      dueAllDay: true,
    })
  })

  it('moves only the date a task has', () => {
    expect(movedTodo(todo({ due: '2026-09-25T08:00:00Z' }), 1, -15)).toMatchObject({
      start: null,
      due: '2026-09-26T07:45:00.000Z',
    })
    expect(movedTodo(todo({ start: allDay('2026-09-25'), startAllDay: true }), 3, 0)).toMatchObject({
      start: '2026-09-28T00:00:00.000Z',
      due: null,
    })
  })

  it('keeps the wall-clock time across the DST change', () => {
    // 10:00 CEST on 24 Oct is 10:00 CET on 25 Oct.
    expect(movedTodo(todo({ due: '2026-10-24T08:00:00Z' }), 1, 0).due).toBe('2026-10-25T09:00:00.000Z')
  })

  it('keeps all-day dates on UTC midnight across the DST change', () => {
    const t = todo({ due: allDay('2026-10-24'), dueAllDay: true })
    expect(movedTodo(t, 2, 0).due).toBe('2026-10-26T00:00:00.000Z')
  })

  it('moves each date by its own kind', () => {
    // A mix from another client: the all-day start moves by days only.
    const t = todo({ start: allDay('2026-09-24'), startAllDay: true, due: '2026-09-25T08:00:00Z' })
    expect(movedTodo(t, 1, 45)).toMatchObject({ start: '2026-09-25T00:00:00.000Z', due: '2026-09-26T08:45:00.000Z' })
  })
})
