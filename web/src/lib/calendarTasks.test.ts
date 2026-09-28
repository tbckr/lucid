import { describe, expect, it } from 'vitest'
import { todo } from '@/test/fixtures'
import { toCalTask } from './calendarTasks'
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
    })
  })

  it('spans all-day from the start day through the due day', () => {
    const task = toCalTask(
      todo({ start: allDay('2026-09-25'), startAllDay: true, due: allDay('2026-09-27'), dueAllDay: true }),
    )
    expect(task).toMatchObject({ startsAt: new Date(2026, 8, 25), endsAt: new Date(2026, 8, 28), allDay: true, point: false })
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
    })
  })

  it('shows a start time alone as a point', () => {
    const task = toCalTask(todo({ start: '2026-09-25T08:00:00Z' }))
    expect(task).toMatchObject({ startsAt: new Date(2026, 8, 25, 10), endsAt: new Date(2026, 8, 25, 10, 30), point: true })
  })

  it('ends a point late in the day at midnight', () => {
    const task = toCalTask(todo({ due: '2026-09-25T21:45:00Z' }))!
    expect(task).toMatchObject({ startsAt: new Date(2026, 8, 25, 23, 45), endsAt: new Date(2026, 8, 26), point: true })
    expect(isSpanning(task)).toBe(false)
  })

  it('shows a due date alone on that day', () => {
    const task = toCalTask(todo({ due: allDay('2026-09-25'), dueAllDay: true }))
    expect(task).toMatchObject({ startsAt: new Date(2026, 8, 25), endsAt: new Date(2026, 8, 26), allDay: true, point: false })
  })

  it('shows a start date alone on that day', () => {
    const task = toCalTask(todo({ start: allDay('2026-09-25'), startAllDay: true }))
    expect(task).toMatchObject({ startsAt: new Date(2026, 8, 25), endsAt: new Date(2026, 8, 26), allDay: true })
  })

  it.each([
    ['start after due', { start: '2026-09-25T10:00:00Z', due: '2026-09-25T08:00:00Z' }],
    ['equal timed start and due', { start: '2026-09-25T08:00:00Z', due: '2026-09-25T08:00:00Z' }],
    ['start date with timed due', { start: allDay('2026-09-24'), startAllDay: true, due: '2026-09-25T08:00:00Z' }],
  ])('falls back to the due time for %s', (_name, dates) => {
    expect(toCalTask(todo(dates))).toMatchObject({ startsAt: new Date(2026, 8, 25, 10), point: true })
  })

  it('falls back to the due day for a timed start with an all-day due', () => {
    const task = toCalTask(todo({ start: '2026-09-24T08:00:00Z', due: allDay('2026-09-25'), dueAllDay: true }))
    expect(task).toMatchObject({ startsAt: new Date(2026, 8, 25), endsAt: new Date(2026, 8, 26), allDay: true })
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
