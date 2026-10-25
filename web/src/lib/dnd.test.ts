import { describe, expect, it } from 'vitest'
import { apiEvent, occurrence, todo } from '@/test/fixtures'
import { occurrenceTask, toCalTask } from './calendarTasks'
import {
  acceptsDrop,
  createRange,
  dropResult,
  HOUR_HEIGHT,
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

  // A task the overflow column draws at its stack's place (FR-07): 9:15, drawn at 9:00.
  it('lands a tile drawn away from its task where the tile lands', () => {
    const point = toCalTask(todo({ due: '2026-09-25T07:15:00Z' }))!
    const drag = { type: 'timed' as const, event: point, originDay: day(25), offset: -15 }
    // Its tile's top moved from 9:00 to 2 PM: due 2 PM, not 2:15 PM.
    expect(dropResult(drag, { type: 'column', day: day(25) }, 300 * PX_PER_MINUTE)).toMatchObject({
      kind: 'task',
      input: { due: '2026-09-25T12:00:00.000Z' },
      delta: { days: 0, minutes: 285 },
    })
    // Across to the next day at the same height: 9 AM there.
    expect(dropResult(drag, { type: 'column', day: day(26) }, 0)).toMatchObject({ input: { due: '2026-09-26T07:00:00.000Z' } })
    // Put back where it was drawn: nothing moves.
    expect(dropResult(drag, { type: 'column', day: day(25) }, 3)).toBeNull()
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
    expect(acceptsDrop('timed', 'day')).toBe(false)
    expect(acceptsDrop('resize', 'column')).toBe(true)
    expect(acceptsDrop('resize', 'day')).toBe(false)
    expect(acceptsDrop('listed', 'column')).toBe(true)
    expect(acceptsDrop('listed', 'day')).toBe(true)
  })
})

describe('dropResult for a row dragged out of a time-grid list (FR-07, FR-10)', () => {
  // Due 09:00 local on 2026-09-25; a list row has no tile to measure a move from, so a drop on a column places it.
  const due = toCalTask(todo({ due: new Date(2026, 8, 25, 9).toISOString() }))!
  const listed = (event: DragData['event'], originDay = day(25)): DragData => ({ type: 'listed', event, originDay })
  const column = (d: Date) => ({ type: 'column' as const, day: d })

  it('lands a listed item at the dropped time', () => {
    const result = dropResult(listed(due), column(day(26)), 0, 14 * HOUR_HEIGHT + 5)
    expect(result).toMatchObject({ kind: 'task', input: { due: new Date(2026, 8, 26, 14).toISOString() } })
  })

  it('moves a task with a start and a due date as one, its start landing at the dropped time', () => {
    const span = toCalTask(
      todo({ start: new Date(2026, 8, 25, 9).toISOString(), due: new Date(2026, 8, 25, 11).toISOString() }),
    )!
    expect(dropResult(listed(span), column(day(25)), 0, 15 * HOUR_HEIGHT)).toMatchObject({
      input: { start: new Date(2026, 8, 25, 15).toISOString(), due: new Date(2026, 8, 25, 17).toISOString() },
      delta: { days: 0, minutes: 6 * 60 },
    })
  })

  it('lands a listed event at the dropped time, keeping its length', () => {
    expect(dropResult(listed(timed), column(day(25)), 0, 14 * HOUR_HEIGHT)).toEqual({
      kind: 'event',
      event: timed,
      times: { start: new Date(2026, 8, 25, 14).toISOString(), end: new Date(2026, 8, 25, 15).toISOString() },
    })
  })

  it('lands a listed item at the dropped time on a DST day', () => {
    // 2026-10-25 is the night Berlin changes back to winter time: the day is 25 hours long.
    const event = toCalEvent(apiEvent({ start: '2026-10-25T08:00:00Z', end: '2026-10-25T09:00:00Z' }))
    const drag = listed(event, new Date(2026, 9, 25))
    expect(dropResult(drag, column(new Date(2026, 9, 25)), 0, 14 * HOUR_HEIGHT)).toMatchObject({
      times: { start: '2026-10-25T13:00:00.000Z', end: '2026-10-25T14:00:00.000Z' },
    })
  })

  it('lands an item from before the change at the dropped time after it', () => {
    // 01:00 CEST is 23:00Z the day before; 14:00 on the wall clock is 13:00Z, not 12:00Z.
    const early = toCalEvent(apiEvent({ start: '2026-10-24T23:00:00Z', end: '2026-10-25T00:00:00Z' }))
    const same = dropResult(listed(early, new Date(2026, 9, 25)), column(new Date(2026, 9, 25)), 0, 14 * HOUR_HEIGHT)
    expect(same).toMatchObject({ times: { start: '2026-10-25T13:00:00.000Z', end: '2026-10-25T14:00:00.000Z' } })
    // From the day before, the winter-time day is reached by calendar days, not by 24 hours.
    const before = toCalEvent(apiEvent({ start: '2026-10-24T07:00:00Z', end: '2026-10-24T08:00:00Z' }))
    const next = dropResult(listed(before, new Date(2026, 9, 24)), column(new Date(2026, 9, 25)), 0, 9 * HOUR_HEIGHT)
    expect(next).toMatchObject({ times: { start: '2026-10-25T08:00:00.000Z', end: '2026-10-25T09:00:00.000Z' } })
  })

  it('snaps the top to 15 minutes and keeps it within the day', () => {
    const at = (top: number) => dropResult(listed(due), column(day(25)), 0, top)
    // 09:07 is below the item's 09:00 start but rounds to it: no change.
    expect(at(9 * HOUR_HEIGHT + 7 * PX_PER_MINUTE)).toBeNull()
    expect(at(9 * HOUR_HEIGHT + 8 * PX_PER_MINUTE)).toMatchObject({ input: { due: new Date(2026, 8, 25, 9, 15).toISOString() } })
    expect(at(-500)).toMatchObject({ input: { due: new Date(2026, 8, 25, 0).toISOString() } })
    expect(at(24 * HOUR_HEIGHT + 500)).toMatchObject({ input: { due: new Date(2026, 8, 25, 23, 45).toISOString() } })
  })

  it('measures from the first day of an item that began before the day it is listed on', () => {
    const night = toCalEvent(apiEvent({ start: new Date(2026, 8, 24, 22).toISOString(), end: new Date(2026, 8, 25, 2).toISOString() }))
    expect(dropResult(listed(night, day(24)), column(day(25)), 0, 8 * HOUR_HEIGHT)).toMatchObject({
      times: { start: new Date(2026, 8, 25, 8).toISOString(), end: new Date(2026, 8, 25, 12).toISOString() },
    })
  })

  it('keeps the time on an all-day cell', () => {
    expect(dropResult(listed(due), { type: 'day', day: day(27) }, 0)).toMatchObject({
      kind: 'task',
      input: { due: new Date(2026, 8, 27, 9).toISOString() },
      delta: { days: 2, minutes: 0 },
    })
    // The height of the pointer means nothing there.
    expect(dropResult(listed(due), { type: 'day', day: day(27) }, 400, 14 * HOUR_HEIGHT)).toMatchObject({
      input: { due: new Date(2026, 8, 27, 9).toISOString() },
    })
  })

  it('needs a top on a column', () => {
    expect(dropResult(listed(due), column(day(26)), 0)).toBeNull()
  })

  it('is a no-op where it already is', () => {
    expect(dropResult(listed(due), column(day(25)), 0, 9 * HOUR_HEIGHT)).toBeNull()
    expect(dropResult(listed(due), { type: 'day', day: day(25) }, 0)).toBeNull()
    expect(dropResult(listed(due), null, 0, 9 * HOUR_HEIGHT)).toBeNull()
  })

  it('previews the item where it lands', () => {
    const drag = listed(due)
    const moved = withDrop(drag, dropResult(drag, column(day(26)), 0, 14 * HOUR_HEIGHT)!)
    expect(moved.type).toBe('listed')
    expect(moved.event.startsAt).toEqual(new Date(2026, 8, 26, 14))
  })
})

describe('dropResult for a series on fixed days (FR-17)', () => {
  // Due 10-05, next occurrence due 10-08: no day is out of reach, because a move shifts the whole series.
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

  it.each([
    [4, '2026-10-04T00:00:00.000Z'],
    [7, '2026-10-07T00:00:00.000Z'],
    [8, '2026-10-08T00:00:00.000Z'],
    [25, '2026-10-25T00:00:00.000Z'],
  ])('moves it to day %i, before or past its next occurrence', (d, due) => {
    expect(dropResult(drag, drop(d), 0)).toMatchObject({ kind: 'task', input: { due } })
  })

  it('moves the last repeat, which has no next occurrence, to any day', () => {
    const last = toCalTask({ ...fixedTask.todo, next: null })!
    const lastDrag = { type: 'event' as const, event: last, originDay: new Date(2026, 9, 5) }
    expect(dropResult(lastDrag, drop(4), 0)).not.toBeNull()
    expect(dropResult(lastDrag, drop(25), 0)).not.toBeNull()
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
    expect(moved.kind === 'task' && moved.occurrence).toMatchObject({ state: 'upcoming', recurrenceId: '2026-09-27T00:00:00Z' })
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
    const scope = {
      kind: 'event' as const,
      key: 'e1@25',
      id: 'e1',
      from: '2026-09-25T08:00:00Z',
      start: '2026-09-27T09:00:00.000Z',
      end: '2026-09-27T10:00:00.000Z',
      reach: 'all' as const,
    }
    const [moved, other, own] = withScopePreview([first, second, task], scope)
    expect(moved?.startsAt).toEqual(new Date(2026, 8, 27, 11))
    expect(moved?.endsAt).toEqual(new Date(2026, 8, 27, 12))
    expect(moved?.key).toBe('e1@25')
    expect(other).toBe(second)
    expect(own).toBe(task)
  })

  it('places an all-day event on local days, as loading it would', () => {
    const scope = {
      kind: 'event' as const,
      key: 'e2@25',
      id: 'e2',
      from: '2026-09-25T00:00:00Z',
      start: '2026-09-27T00:00:00.000Z',
      end: '2026-09-28T00:00:00.000Z',
      reach: null,
    }
    const [moved] = withScopePreview([holiday], scope)
    expect(moved?.startsAt).toEqual(day(27))
    expect(moved?.endsAt).toEqual(day(28))
  })

  it('leaves the items as they are without a question', () => {
    const items = [first, second]
    expect(withScopePreview(items, null)).toBe(items)
  })

  // The current and the next repeat of a series due on Mondays and Thursdays, and a timed one.
  const watering = todo({ id: 't2', rrule: 'FREQ=WEEKLY;BYDAY=MO,TH', recurring: true, due: '2026-10-05T00:00:00Z', dueAllDay: true })
  const repeatOn = (day: string, p: Parameters<typeof occurrence>[0] = {}) =>
    occurrenceTask(
      occurrence({ key: `t2@${day}`, todoId: 't2', recurrenceId: day, due: day, dueAllDay: true, ...p }),
      watering,
    )!

  it('shows a held repeat of a task at the dates it was dropped at', () => {
    const current = repeatOn('2026-10-05T00:00:00Z')
    const next = repeatOn('2026-10-08T00:00:00Z', { state: 'upcoming' })
    const scope = {
      kind: 'task' as const,
      key: current.key,
      id: 't2',
      from: '2026-10-05T00:00:00Z',
      to: { start: null, startAllDay: false, due: '2026-10-06T00:00:00.000Z', dueAllDay: true },
      reach: 'this' as const,
    }
    const [moved, other, event] = withScopePreview([current, next, first], scope)
    expect(moved?.startsAt).toEqual(new Date(2026, 9, 6))
    expect(moved?.endsAt).toEqual(new Date(2026, 9, 7))
    // Still the same repeat of the series, only shown elsewhere.
    expect(moved?.key).toBe(current.key)
    expect(moved?.kind === 'task' && moved.occurrence?.state).toBe('current')
    expect(other).toBe(next)
    expect(event).toBe(first)
  })

  it('places a held repeat by its new times, a span as a span', () => {
    const timed = repeatOn('2026-10-05T07:00:00Z', { start: '2026-10-05T07:00:00Z', due: '2026-10-05T09:00:00Z', dueAllDay: false })
    const scope = {
      kind: 'task' as const,
      key: timed.key,
      id: 't2',
      from: '2026-10-05T07:00:00Z',
      to: { start: '2026-10-06T08:00:00.000Z', startAllDay: false, due: '2026-10-06T10:00:00.000Z', dueAllDay: false },
      reach: 'this' as const,
    }
    const [moved] = withScopePreview([timed], scope)
    expect(moved?.startsAt).toEqual(new Date('2026-10-06T08:00:00Z'))
    expect(moved?.endsAt).toEqual(new Date('2026-10-06T10:00:00Z'))
  })

  it('moves no event for a task of the same key, and no task for an event', () => {
    const current = repeatOn('2026-10-05T00:00:00Z')
    const items = [first, current]
    const taskScope = {
      kind: 'task' as const,
      key: first.key,
      id: 'e1',
      from: '2026-09-25T08:00:00Z',
      to: { start: null, startAllDay: false, due: '2026-10-06T00:00:00.000Z', dueAllDay: true },
      reach: null,
    }
    const eventScope = {
      kind: 'event' as const,
      key: current.key,
      id: 't2',
      from: '2026-10-05T00:00:00Z',
      start: '2026-10-06T00:00:00.000Z',
      end: '2026-10-07T00:00:00.000Z',
      reach: null,
    }
    expect(withScopePreview(items, taskScope)).toEqual(items)
    expect(withScopePreview(items, eventScope)).toEqual(items)
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
