import { describe, expect, it } from 'vitest'
import { apiEvent } from '@/test/fixtures'
import { dayKey, eachDay } from './dates'
import {
  compareEvents,
  eventTitle,
  firstDay,
  groupByDay,
  isSpanning,
  lastDay,
  movedTimes,
  overlapsDay,
  overlapsRange,
  toCalEvent,
} from './events'


describe('toCalEvent', () => {
  it('keeps instants for timed events', () => {
    const e = toCalEvent(apiEvent())
    expect(e.startsAt.toISOString()).toBe('2026-09-25T08:00:00.000Z')
    expect(e.kind).toBe('event')
  })

  it('maps all-day dates to local midnight and fixes empty ranges', () => {
    const e = toCalEvent(apiEvent({ allDay: true, start: '2026-09-25T00:00:00Z', end: '2026-09-25T00:00:00Z' }))
    expect(dayKey(e.startsAt)).toBe('2026-09-25')
    expect(dayKey(e.endsAt)).toBe('2026-09-26')
    expect(lastDay(e)).toEqual(new Date(2026, 8, 25))
  })
})

describe('day span', () => {
  it('treats end as exclusive', () => {
    const e = toCalEvent(apiEvent({ start: '2026-09-25T20:00:00Z', end: '2026-09-25T22:00:00Z' })) // 22:00-00:00 local
    expect(dayKey(firstDay(e))).toBe('2026-09-25')
    expect(dayKey(lastDay(e))).toBe('2026-09-25')
    expect(isSpanning(e)).toBe(false)
  })

  it('detects events crossing midnight', () => {
    const e = toCalEvent(apiEvent({ start: '2026-09-25T20:00:00Z', end: '2026-09-25T23:00:00Z' }))
    expect(isSpanning(e)).toBe(true)
    expect(overlapsDay(e, new Date(2026, 8, 26))).toBe(true)
    expect(overlapsDay(e, new Date(2026, 8, 27))).toBe(false)
  })

  it('zero-length events occupy their start day', () => {
    const e = toCalEvent(apiEvent({ end: '2026-09-25T08:00:00Z' }))
    expect(lastDay(e)).toEqual(firstDay(e))
  })

  it('overlapsRange', () => {
    const e = toCalEvent(apiEvent())
    expect(overlapsRange(e, { start: new Date(2026, 8, 25), end: new Date(2026, 8, 26) })).toBe(true)
    expect(overlapsRange(e, { start: new Date(2026, 8, 26), end: new Date(2026, 8, 27) })).toBe(false)
  })
})

describe('ordering and grouping', () => {
  it('sorts all-day first, then start, longer first, then title', () => {
    const a = toCalEvent(apiEvent({ key: 'a', title: 'B', start: '2026-09-25T08:00:00Z', end: '2026-09-25T09:00:00Z' }))
    const b = toCalEvent(apiEvent({ key: 'b', title: 'A', start: '2026-09-25T08:00:00Z', end: '2026-09-25T09:00:00Z' }))
    const c = toCalEvent(apiEvent({ key: 'c', start: '2026-09-25T08:00:00Z', end: '2026-09-25T11:00:00Z' }))
    const d = toCalEvent(apiEvent({ key: 'd', allDay: true, start: '2026-09-25T00:00:00Z', end: '2026-09-26T00:00:00Z' }))
    expect([a, b, c, d].sort(compareEvents).map((e) => e.key)).toEqual(['d', 'c', 'b', 'a'])
  })

  it('groups multi-day events into every day', () => {
    const e = toCalEvent(apiEvent({ allDay: true, start: '2026-09-25T00:00:00Z', end: '2026-09-27T00:00:00Z' }))
    const days = eachDay({ start: new Date(2026, 8, 24), end: new Date(2026, 8, 28) })
    const g = groupByDay([e], days)
    expect([...g.entries()].map(([k, v]) => [k, v.length])).toEqual([
      ['2026-09-24', 0],
      ['2026-09-25', 1],
      ['2026-09-26', 1],
      ['2026-09-27', 0],
    ])
  })

  it('eventTitle falls back for blank titles', () => {
    expect(eventTitle({ title: '  ' }, '(No title)')).toBe('(No title)')
    expect(eventTitle({ title: 'Hi' }, '(No title)')).toBe('Hi')
  })
})

describe('movedTimes', () => {
  it('moves timed events by days and minutes keeping duration', () => {
    const e = toCalEvent(apiEvent())
    expect(movedTimes(e, 1, 30)).toEqual({ start: '2026-09-26T08:30:00.000Z', end: '2026-09-26T09:30:00.000Z' })
  })

  it('keeps local wall time when moving across DST', () => {
    const e = toCalEvent(apiEvent({ start: '2026-10-24T07:00:00Z', end: '2026-10-24T08:00:00Z' })) // 09:00 CEST
    expect(movedTimes(e, 1, 0)).toEqual({ start: '2026-10-25T08:00:00.000Z', end: '2026-10-25T09:00:00.000Z' }) // 09:00 CET
  })

  it('moves all-day events by whole UTC dates', () => {
    const e = toCalEvent(apiEvent({ allDay: true, start: '2026-09-25T00:00:00Z', end: '2026-09-27T00:00:00Z' }))
    expect(movedTimes(e, -2, 0)).toEqual({ start: '2026-09-23T00:00:00.000Z', end: '2026-09-25T00:00:00.000Z' })
  })
})
