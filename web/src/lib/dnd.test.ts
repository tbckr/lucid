import { describe, expect, it } from 'vitest'
import { apiEvent, todo } from '@/test/fixtures'
import { toCalTask } from './calendarTasks'
import { acceptsDrop, createRange, dropBlocked, dropResult, PX_PER_MINUTE, withDrop, type DragData } from './dnd'
import { toCalEvent } from './events'

const timed = toCalEvent(apiEvent()) // 10:00-11:00 local on 2026-09-25
const allDay = toCalEvent(apiEvent({ allDay: true, start: '2026-09-25T00:00:00Z', end: '2026-09-26T00:00:00Z' }))
const task = toCalTask(todo({ start: '2026-09-25T07:00:00Z', due: '2026-09-25T09:00:00Z' }))! // 09:00-11:00 local
const day = (d: number) => new Date(2026, 8, d)

describe('dropResult', () => {
  it('moves month chips by days, keeping the time', () => {
    expect(dropResult({ type: 'event', event: timed, originDay: day(25) }, { type: 'day', day: day(27) }, 999)).toEqual({
      kind: 'event',
      event: timed,
      times: { start: '2026-09-27T08:00:00.000Z', end: '2026-09-27T09:00:00.000Z' },
    })
    expect(dropResult({ type: 'event', event: allDay, originDay: day(25) }, { type: 'day', day: day(24) }, 0)).toEqual({
      kind: 'event',
      event: allDay,
      times: { start: '2026-09-24T00:00:00.000Z', end: '2026-09-25T00:00:00.000Z' },
    })
  })

  it('moves time-grid items in 15-minute steps', () => {
    const drag = { type: 'timed' as const, event: timed, originDay: day(25) }
    expect(dropResult(drag, { type: 'column', day: day(25) }, 40 * PX_PER_MINUTE)).toEqual({
      kind: 'event',
      event: timed,
      times: { start: '2026-09-25T08:45:00.000Z', end: '2026-09-25T09:45:00.000Z' },
    })
    expect(dropResult(drag, { type: 'column', day: day(26) }, -60 * PX_PER_MINUTE)).toMatchObject({
      times: { start: '2026-09-26T07:00:00.000Z' },
    })
  })

  it('moves the dates of a task instead of its displayed span (FR-16)', () => {
    expect(dropResult({ type: 'event', event: task, originDay: day(25) }, { type: 'day', day: day(27) }, 999)).toEqual({
      kind: 'task',
      task,
      input: {
        title: 'Task',
        description: '',
        checklist: [],
        start: '2026-09-27T07:00:00.000Z',
        startAllDay: false,
        due: '2026-09-27T09:00:00.000Z',
        dueAllDay: false,
        priority: 0,
        status: 'NEEDS-ACTION',
      },
    })
    const drag = { type: 'timed' as const, event: task, originDay: day(25) }
    expect(dropResult(drag, { type: 'column', day: day(26) }, 30 * PX_PER_MINUTE)).toMatchObject({
      kind: 'task',
      input: { start: '2026-09-26T07:30:00.000Z', due: '2026-09-26T09:30:00.000Z' },
    })
  })

  it('returns null for no-ops and incompatible targets', () => {
    expect(dropResult({ type: 'event', event: timed, originDay: day(25) }, { type: 'day', day: day(25) }, 0)).toBeNull()
    expect(dropResult({ type: 'timed', event: timed, originDay: day(25) }, { type: 'day', day: day(26) }, 0)).toBeNull()
    expect(dropResult({ type: 'event', event: timed, originDay: day(25) }, null, 0)).toBeNull()
    expect(dropResult({ type: 'timed', event: timed, originDay: day(25) }, { type: 'column', day: day(25) }, 3)).toBeNull()
    expect(dropResult({ type: 'event', event: task, originDay: day(25) }, { type: 'day', day: day(25) }, 0)).toBeNull()
    expect(dropResult({ type: 'timed', event: task, originDay: day(25) }, { type: 'day', day: day(26) }, 0)).toBeNull()
  })

  it('resizes the end, never below 15 minutes', () => {
    expect(dropResult({ type: 'resize', event: timed }, null, 30 * PX_PER_MINUTE)).toEqual({
      kind: 'event',
      event: timed,
      times: { start: timed.start, end: '2026-09-25T09:30:00.000Z' },
    })
    expect(dropResult({ type: 'resize', event: timed }, null, -300 * PX_PER_MINUTE)).toMatchObject({
      times: { end: '2026-09-25T08:15:00.000Z' },
    })
    expect(dropResult({ type: 'resize', event: timed }, null, 2)).toBeNull()
    const short = toCalEvent(apiEvent({ end: '2026-09-25T08:15:00Z' }))
    expect(dropResult({ type: 'resize', event: short }, null, -15 * PX_PER_MINUTE)).toBeNull()
  })

  it('acceptsDrop pairs', () => {
    expect(acceptsDrop('event', 'day')).toBe(true)
    expect(acceptsDrop('event', 'column')).toBe(false)
    expect(acceptsDrop('timed', 'column')).toBe(true)
    expect(acceptsDrop('resize', 'column')).toBe(true)
  })
})

describe('dropResult and dropBlocked for a bounded series (FR-17)', () => {
  // Fixed-day series due 10-05, next occurrence due 10-08: window [10-05, 10-08).
  const fixedTask = toCalTask(
    todo({
      id: 't2',
      due: '2026-10-05T00:00:00Z',
      dueAllDay: true,
      recurring: true,
      fixedDays: true,
      next: { due: '2026-10-08T00:00:00Z' },
    }),
  )!
  const drag = { type: 'event' as const, event: fixedTask, originDay: new Date(2026, 9, 5) }
  const drop = (d: number) => ({ type: 'day' as const, day: new Date(2026, 9, d) })

  it('allows a move that still lands before the next occurrence', () => {
    expect(dropResult(drag, drop(7), 0)).not.toBeNull()
  })

  it('blocks a move that reaches the next occurrence, naming the last allowed day', () => {
    expect(dropResult(drag, drop(8), 0)).toBeNull()
    expect(dropBlocked(drag, drop(8), 0)).toEqual(new Date(2026, 9, 7))
  })

  it('blocks a move before the window', () => {
    expect(dropResult(drag, drop(4), 0)).toBeNull()
  })

  it('lets a non-fixed-day series move past where a fixed one would be blocked', () => {
    const intervalTask = toCalTask(
      todo({
        id: 't3',
        due: '2026-10-05T00:00:00Z',
        dueAllDay: true,
        recurring: true,
        fixedDays: false,
        next: { due: '2026-10-08T00:00:00Z' },
      }),
    )!
    const free = { type: 'event' as const, event: intervalTask, originDay: new Date(2026, 9, 5) }
    expect(dropResult(free, drop(15), 0)).not.toBeNull()
  })
})

describe('withDrop', () => {
  it('shows a dragged event at its new times', () => {
    const drag: DragData = { type: 'timed', event: timed, originDay: day(25) }
    const moved = withDrop(drag, dropResult(drag, { type: 'column', day: day(26) }, 60 * PX_PER_MINUTE)!)
    expect(moved.type).toBe('timed')
    expect(moved.event.startsAt).toEqual(new Date(2026, 8, 26, 11))
    expect(moved.event.endsAt).toEqual(new Date(2026, 8, 26, 12))
  })

  it('shows a dragged task where its new dates place it', () => {
    const drag: DragData = { type: 'event', event: task, originDay: day(25) }
    const moved = withDrop(drag, dropResult(drag, { type: 'day', day: day(23) }, 0)!)
    expect(moved.event.kind).toBe('task')
    expect(moved.event.startsAt).toEqual(new Date(2026, 8, 23, 9))
    expect(moved.event.endsAt).toEqual(new Date(2026, 8, 23, 11))
  })
})

describe('createRange', () => {
  // Minutes since midnight: 545 = 09:05, 620 = 10:20.
  it.each([
    ['dragging down', 545, 620, { startMin: 540, endMin: 630 }],
    ['dragging up', 620, 545, { startMin: 540, endMin: 630 }],
    ['a move within one slot', 545, 550, { startMin: 540, endMin: 555 }],
    ['a slot boundary, which belongs to the slot below it', 540, 600, { startMin: 540, endMin: 615 }],
    ['a pointer past midnight', 1430, 1500, { startMin: 1425, endMin: 1440 }],
    ['a pointer above the day', 10, -30, { startMin: 0, endMin: 15 }],
  ])('covers every 15-minute slot between press and pointer for %s', (_, anchor, pointer, want) => {
    expect(createRange(anchor, pointer)).toEqual(want)
  })
})
