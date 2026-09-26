import { describe, expect, it } from 'vitest'
import {
  AGENDA_DAYS,
  atMinutes,
  dayKey,
  eachDay,
  fetchRange,
  localDateToUtc,
  minutesOfDay,
  monthGrid,
  parseDayKey,
  shiftInterval,
  snapMinutes,
  stepDate,
  utcDateToLocal,
  utcToZoned,
  visibleRange,
  weekDays,
  zonedToUtc,
} from './dates'

// Tests run with TZ=Europe/Berlin (see vite.config.ts): DST starts 2026-03-29, ends 2026-10-25.

describe('visibleRange', () => {
  const fri = new Date(2026, 8, 25, 15, 30) // Friday 25 Sep 2026

  it('month view covers whole weeks for Monday start', () => {
    const r = visibleRange('month', fri, 1)
    expect(dayKey(r.start)).toBe('2026-08-31') // Monday
    expect(dayKey(r.end)).toBe('2026-10-05') // exclusive, a Monday
    expect(eachDay(r)).toHaveLength(35)
  })

  it('month view respects Sunday and Saturday week starts', () => {
    expect(dayKey(visibleRange('month', fri, 0).start)).toBe('2026-08-30')
    expect(dayKey(visibleRange('month', fri, 6).start)).toBe('2026-08-29')
  })

  it('week, day and agenda ranges', () => {
    const w = visibleRange('week', fri, 1)
    expect(dayKey(w.start)).toBe('2026-09-21')
    expect(dayKey(w.end)).toBe('2026-09-28')
    const d = visibleRange('day', fri, 1)
    expect(d.start).toEqual(new Date(2026, 8, 25))
    expect(dayKey(d.end)).toBe('2026-09-26')
    const a = visibleRange('agenda', fri, 1)
    expect(eachDay(a)).toHaveLength(AGENDA_DAYS)
  })

  it('fetchRange pads a day on both sides', () => {
    const r = fetchRange(visibleRange('day', fri, 1))
    expect(dayKey(r.start)).toBe('2026-09-24')
    expect(dayKey(r.end)).toBe('2026-09-27')
  })
})

describe('DST safety', () => {
  it('each day starts at local midnight across the spring-forward change', () => {
    const days = eachDay({ start: new Date(2026, 2, 28), end: new Date(2026, 2, 31) })
    expect(days.map(dayKey)).toEqual(['2026-03-28', '2026-03-29', '2026-03-30'])
    for (const d of days) expect(d.getHours()).toBe(0)
  })

  it('month grid for October 2026 (fall back) has 7 days per row and midnight days', () => {
    const weeks = monthGrid(new Date(2026, 9, 10), 1)
    expect(weeks.every((w) => w.length === 7)).toBe(true)
    expect(weeks.flat().every((d) => d.getHours() === 0 && d.getMinutes() === 0)).toBe(true)
    expect(weeks.flat().map(dayKey)).toContain('2026-10-25')
  })

  it('weekDays of the DST week contains 7 distinct days', () => {
    const days = weekDays(new Date(2026, 9, 25), 1)
    expect(new Set(days.map(dayKey)).size).toBe(7)
  })

  it('shiftInterval keeps wall-clock time across DST', () => {
    const start = new Date(2026, 2, 28, 9, 0)
    const end = new Date(2026, 2, 28, 10, 0)
    const moved = shiftInterval(start, end, 1, 0)
    expect(moved.start.getHours()).toBe(9)
    expect(moved.end.getTime() - moved.start.getTime()).toBe(3600_000)
  })

  it('zonedToUtc converts wall time in a zone to UTC', () => {
    expect(zonedToUtc('2026-01-15', '09:00', 'Europe/Berlin').toISOString()).toBe('2026-01-15T08:00:00.000Z')
    expect(zonedToUtc('2026-07-15', '09:00', 'Europe/Berlin').toISOString()).toBe('2026-07-15T07:00:00.000Z')
    expect(zonedToUtc('2026-07-15', '09:00', 'America/New_York').toISOString()).toBe('2026-07-15T13:00:00.000Z')
  })

  it('utcToZoned is the inverse', () => {
    expect(utcToZoned(new Date('2026-10-25T00:30:00Z'), 'Europe/Berlin')).toEqual({ date: '2026-10-25', time: '02:30' })
    expect(utcToZoned(new Date('2026-10-25T01:30:00Z'), 'Europe/Berlin')).toEqual({ date: '2026-10-25', time: '02:30' })
  })
})

describe('stepDate', () => {
  const d = new Date(2026, 0, 31)
  it('moves by the period of the view', () => {
    expect(dayKey(stepDate('month', d, 1))).toBe('2026-02-28')
    expect(dayKey(stepDate('week', d, -1))).toBe('2026-01-24')
    expect(dayKey(stepDate('day', d, 1))).toBe('2026-02-01')
    expect(dayKey(stepDate('agenda', d, 1))).toBe('2026-03-02')
  })
})

describe('all-day conversion', () => {
  it('maps UTC midnight to the same local calendar date', () => {
    const local = utcDateToLocal('2026-03-29T00:00:00Z')
    expect(dayKey(local)).toBe('2026-03-29')
    expect(local.getHours()).toBe(0)
    expect(localDateToUtc(local).toISOString()).toBe('2026-03-29T00:00:00.000Z')
    expect(dayKey(utcDateToLocal(new Date('2026-12-31T00:00:00Z')))).toBe('2026-12-31')
  })
})

describe('small helpers', () => {
  it('parseDayKey and dayKey round-trip', () => {
    expect(dayKey(parseDayKey('2026-02-03'))).toBe('2026-02-03')
    expect(dayKey(parseDayKey('garbage'))).toBe('1970-01-01')
  })

  it('minutes and snapping', () => {
    expect(minutesOfDay(new Date(2026, 0, 1, 13, 45))).toBe(825)
    expect(snapMinutes(7)).toBe(0)
    expect(snapMinutes(8)).toBe(15)
    expect(snapMinutes(-22)).toBe(-15)
    expect(snapMinutes(44, 30)).toBe(30)
    const at = atMinutes(new Date(2026, 2, 29, 18), 9 * 60 + 30)
    expect(at.getHours()).toBe(9)
    expect(at.getMinutes()).toBe(30)
    expect(dayKey(at)).toBe('2026-03-29')
  })
})
