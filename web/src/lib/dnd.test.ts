import { describe, expect, it } from 'vitest'
import { apiEvent } from '@/test/fixtures'
import { acceptsDrop, dropResult, PX_PER_MINUTE } from './dnd'
import { toCalEvent } from './events'

const timed = toCalEvent(apiEvent()) // 10:00-11:00 local on 2026-09-25
const allDay = toCalEvent(apiEvent({ allDay: true, start: '2026-09-25T00:00:00Z', end: '2026-09-26T00:00:00Z' }))
const day = (d: number) => new Date(2026, 8, d)

describe('dropResult', () => {
  it('moves month chips by days, keeping the time', () => {
    expect(dropResult({ type: 'event', event: timed, originDay: day(25) }, { type: 'day', day: day(27) }, 999)).toEqual({
      start: '2026-09-27T08:00:00.000Z',
      end: '2026-09-27T09:00:00.000Z',
    })
    expect(dropResult({ type: 'event', event: allDay, originDay: day(25) }, { type: 'day', day: day(24) }, 0)).toEqual({
      start: '2026-09-24T00:00:00.000Z',
      end: '2026-09-25T00:00:00.000Z',
    })
  })

  it('moves time-grid items in 15-minute steps', () => {
    const drag = { type: 'timed' as const, event: timed, originDay: day(25) }
    expect(dropResult(drag, { type: 'column', day: day(25) }, 40 * PX_PER_MINUTE)).toEqual({
      start: '2026-09-25T08:45:00.000Z',
      end: '2026-09-25T09:45:00.000Z',
    })
    expect(dropResult(drag, { type: 'column', day: day(26) }, -60 * PX_PER_MINUTE)?.start).toBe('2026-09-26T07:00:00.000Z')
  })

  it('returns null for no-ops and incompatible targets', () => {
    expect(dropResult({ type: 'event', event: timed, originDay: day(25) }, { type: 'day', day: day(25) }, 0)).toBeNull()
    expect(dropResult({ type: 'timed', event: timed, originDay: day(25) }, { type: 'day', day: day(26) }, 0)).toBeNull()
    expect(dropResult({ type: 'event', event: timed, originDay: day(25) }, null, 0)).toBeNull()
    expect(dropResult({ type: 'timed', event: timed, originDay: day(25) }, { type: 'column', day: day(25) }, 3)).toBeNull()
  })

  it('resizes the end, never below 15 minutes', () => {
    expect(dropResult({ type: 'resize', event: timed }, null, 30 * PX_PER_MINUTE)).toEqual({
      start: timed.start,
      end: '2026-09-25T09:30:00.000Z',
    })
    expect(dropResult({ type: 'resize', event: timed }, null, -300 * PX_PER_MINUTE)?.end).toBe('2026-09-25T08:15:00.000Z')
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
