import { describe, expect, it } from 'vitest'
import { apiEvent, occurrence, todo } from '@/test/fixtures'
import { occurrenceTask, toCalTask } from './calendarTasks'
import {
  acceptsDrop,
  createRange,
  dropBlocked,
  dropResult,
  PX_PER_MINUTE,
  withDrop,
  withScopePreview,
  type DragData,
} from './dnd'
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
      delta: { days: 2, minutes: 0 },
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
      moveWindow: { from: '2026-10-05T00:00:00Z', until: '2026-10-08T00:00:00Z' },
    }),
  )!
  const drag = { type: 'event' as const, event: fixedTask, originDay: new Date(2026, 9, 5) }
  const drop = (d: number) => ({ type: 'day' as const, day: new Date(2026, 9, d) })

  it('allows a move that still lands before the next occurrence', () => {
    expect(dropResult(drag, drop(7), 0)).not.toBeNull()
  })

  it('blocks a move that reaches the next occurrence, naming the last allowed day', () => {
    expect(dropResult(drag, drop(8), 0)).toBeNull()
    expect(dropBlocked(drag, drop(8), 0)).toEqual({ edge: 'until', date: new Date(2026, 9, 7) })
  })

  it('blocks a move before the window, naming the first allowed day', () => {
    expect(dropResult(drag, drop(4), 0)).toBeNull()
    expect(dropBlocked(drag, drop(4), 0)).toEqual({ edge: 'from', date: new Date(2026, 9, 5) })
  })

  // The same shape with a time: Mon 09:00 local, next Thu 09:00 local.
  const fixedTimed = toCalTask(
    todo({
      id: 't4',
      due: '2026-10-05T07:00:00Z',
      recurring: true,
      fixedDays: true,
      next: { due: '2026-10-08T07:00:00Z' },
      moveWindow: { from: '2026-10-04T22:00:00Z', until: '2026-10-07T22:00:00Z' },
    }),
  )!
  const timedDrag = { type: 'timed' as const, event: fixedTimed, originDay: new Date(2026, 9, 5) }
  const column = (d: number) => ({ type: 'column' as const, day: new Date(2026, 9, d) })

  it('blocks a week-view drop at an earlier time on the day the next occurrence is due', () => {
    expect(dropResult(timedDrag, column(8), -60 * PX_PER_MINUTE)).toBeNull()
    expect(dropBlocked(timedDrag, column(8), -60 * PX_PER_MINUTE)).toEqual({ edge: 'until', date: new Date(2026, 9, 7) })
  })

  it('allows a week-view drop at any time on the last allowed day', () => {
    expect(dropResult(timedDrag, column(7), 13 * 60 * PX_PER_MINUTE)).toMatchObject({
      kind: 'task',
      input: { due: '2026-10-07T20:00:00.000Z' },
    })
  })

  it('refuses a drop the server would refuse, for a series in another zone (A-14)', () => {
    // A series in UTC−5, due at 15:00 in Berlin: its days start at 07:00 in Berlin.
    const zoned = toCalTask(
      todo({
        id: 't6',
        due: '2026-10-05T13:00:00Z',
        recurring: true,
        fixedDays: true,
        next: { due: '2026-10-08T13:00:00Z' },
        moveWindow: { from: '2026-10-05T05:00:00Z', until: '2026-10-08T05:00:00Z' },
      }),
    )!
    const zonedDrag = { type: 'timed' as const, event: zoned, originDay: new Date(2026, 9, 5) }
    // 06:00 local on its own day lies before the series' day begins; 07:00 is where it begins.
    expect(dropResult(zonedDrag, column(5), -9 * 60 * PX_PER_MINUTE)).toBeNull()
    expect(dropBlocked(zonedDrag, column(5), -9 * 60 * PX_PER_MINUTE)).toEqual({
      edge: 'from',
      date: new Date('2026-10-05T05:00:00Z'),
    })
    expect(dropResult(zonedDrag, column(5), -8 * 60 * PX_PER_MINUTE)).not.toBeNull()
    // On the next repeat's local day, the series' day only begins at 07:00.
    expect(dropResult(zonedDrag, column(8), -8.5 * 60 * PX_PER_MINUTE)).not.toBeNull()
    expect(dropResult(zonedDrag, column(8), -8 * 60 * PX_PER_MINUTE)).toBeNull()
    expect(dropBlocked(zonedDrag, column(8), -8 * 60 * PX_PER_MINUTE)).toEqual({ edge: 'until', date: new Date(2026, 9, 8) })
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
        moveWindow: null,
      }),
    )!
    const free = { type: 'event' as const, event: intervalTask, originDay: new Date(2026, 9, 5) }
    expect(dropResult(free, drop(15), 0)).not.toBeNull()
  })

  describe('the last repeat of a fixed-day series', () => {
    const lastTask = toCalTask(
      todo({
        id: 't5',
        due: '2026-10-05T00:00:00Z',
        dueAllDay: true,
        recurring: true,
        fixedDays: true,
        next: null,
        moveWindow: { from: '2026-10-05T00:00:00Z', until: null },
      }),
    )!
    const lastDrag = { type: 'event' as const, event: lastTask, originDay: new Date(2026, 9, 5) }

    it('blocks a move to an earlier day, naming the first allowed day', () => {
      expect(dropResult(lastDrag, drop(4), 0)).toBeNull()
      expect(dropBlocked(lastDrag, drop(4), 0)).toEqual({ edge: 'from', date: new Date(2026, 9, 5) })
    })

    it('allows a move to a later day, with nothing blocked', () => {
      expect(dropResult(lastDrag, drop(25), 0)).not.toBeNull()
      expect(dropBlocked(lastDrag, drop(25), 0)).toBeNull()
    })
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

describe('dropResult and withDrop for an upcoming occurrence (FR-17)', () => {
  // A daily series whose current occurrence is due 09-25 (09:00-11:00 local when timed);
  // the occurrence dragged is the one two days later.
  const daily = todo({ recurring: true, rrule: 'FREQ=DAILY', due: '2026-09-25T00:00:00Z', dueAllDay: true })
  const upcoming = occurrenceTask(
    occurrence({ key: 't1@27', recurrenceId: '2026-09-27T00:00:00Z', due: '2026-09-27T00:00:00Z', state: 'upcoming' }),
    daily,
  )!

  it('moves the series by the distance the occurrence was dragged', () => {
    const drag: DragData = { type: 'event', event: upcoming, originDay: day(27) }
    expect(dropResult(drag, { type: 'day', day: day(29) }, 0)).toMatchObject({
      kind: 'task',
      task: upcoming,
      input: { due: '2026-09-27T00:00:00.000Z', dueAllDay: true },
    })
  })

  it('shows the dragged occurrence, still pencilled in, where the drop puts it', () => {
    const drag: DragData = { type: 'event', event: upcoming, originDay: day(27) }
    const moved = withDrop(drag, dropResult(drag, { type: 'day', day: day(29) }, 0)!).event
    expect(moved.startsAt).toEqual(day(29))
    expect(moved.endsAt).toEqual(day(30))
    expect(moved.kind === 'task' && moved.occurrence).toEqual({ state: 'upcoming', recurrenceId: '2026-09-27T00:00:00Z' })
    expect(moved.key).toBe('t1@27')
  })

  it('moves a timed occurrence by days and minutes', () => {
    const timedDaily = todo({
      recurring: true,
      rrule: 'FREQ=DAILY',
      start: '2026-09-25T07:00:00Z',
      due: '2026-09-25T09:00:00Z',
    })
    const timedUpcoming = occurrenceTask(
      occurrence({
        recurrenceId: '2026-09-27T07:00:00Z',
        start: '2026-09-27T07:00:00Z',
        due: '2026-09-27T09:00:00Z',
        dueAllDay: false,
        state: 'upcoming',
      }),
      timedDaily,
    )!
    const drag: DragData = { type: 'timed', event: timedUpcoming, originDay: day(27) }
    const result = dropResult(drag, { type: 'column', day: day(28) }, 60 * PX_PER_MINUTE)!
    expect(result).toMatchObject({ input: { start: '2026-09-26T08:00:00.000Z', due: '2026-09-26T10:00:00.000Z' } })
    const moved = withDrop(drag, result).event
    expect(moved.startsAt).toEqual(new Date(2026, 8, 28, 10))
    expect(moved.endsAt).toEqual(new Date(2026, 8, 28, 12))
  })
})

describe('withScopePreview (FR-17)', () => {
  // Two events of a daily series at 10:00-11:00 local, and an all-day series.
  const series = { recurring: true, rrule: 'FREQ=DAILY' }
  const first = toCalEvent(apiEvent({ ...series, key: 'e1@25', recurrenceId: '2026-09-25T08:00:00Z' }))
  const second = toCalEvent(
    apiEvent({ ...series, key: 'e1@26', recurrenceId: '2026-09-26T08:00:00Z', start: '2026-09-26T08:00:00Z', end: '2026-09-26T09:00:00Z' }),
  )
  const holiday = toCalEvent(
    apiEvent({ ...series, id: 'e2', key: 'e2@25', allDay: true, start: '2026-09-25T00:00:00Z', end: '2026-09-26T00:00:00Z' }),
  )

  it('shows only the dropped event at the times of the drop', () => {
    const scope = { key: 'e1@25', id: 'e1', start: '2026-09-27T09:00:00.000Z', end: '2026-09-27T10:00:00.000Z', reach: 'all' as const }
    const [moved, other, own] = withScopePreview([first, second, task], scope)
    expect(moved?.startsAt).toEqual(new Date(2026, 8, 27, 11))
    expect(moved?.endsAt).toEqual(new Date(2026, 8, 27, 12))
    expect(moved?.key).toBe('e1@25')
    expect(other).toBe(second)
    expect(own).toBe(task)
  })

  it('places an all-day event on local days, as loading it would', () => {
    const scope = { key: 'e2@25', id: 'e2', start: '2026-09-27T00:00:00.000Z', end: '2026-09-28T00:00:00.000Z', reach: null }
    const [moved] = withScopePreview([holiday], scope)
    expect(moved?.startsAt).toEqual(day(27))
    expect(moved?.endsAt).toEqual(day(28))
  })

  it('leaves the items as they are without a question', () => {
    const items = [first, second]
    expect(withScopePreview(items, null)).toBe(items)
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
