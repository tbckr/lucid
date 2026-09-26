import { describe, expect, it } from 'vitest'
import { dayKey, eachDay } from './dates'
import { toCalEvent } from './events'
import { apiEvent } from '@/test/fixtures'
import { agendaRows, cellCapacity, layoutDay, layoutWeekRow, timedSegments } from './layout'

const local = (d: number, h: number, m = 0) => new Date(2026, 8, d, h, m).toISOString()
const timed = (key: string, d: number, h1: number, m1: number, h2: number, m2: number, d2 = d) =>
  toCalEvent(apiEvent({ key, id: key, title: key, start: local(d, h1, m1), end: local(d2, h2, m2) }))
const allDay = (key: string, from: number, toExclusive: number) =>
  toCalEvent(
    apiEvent({
      key,
      id: key,
      title: key,
      allDay: true,
      start: new Date(Date.UTC(2026, 8, from)).toISOString(),
      end: new Date(Date.UTC(2026, 8, toExclusive)).toISOString(),
    }),
  )

describe('timedSegments', () => {
  it('clips events to the day and marks continuation', () => {
    const e = timed('night', 25, 22, 0, 2, 0, 26)
    const [first] = timedSegments([e], new Date(2026, 8, 25))
    expect(first).toMatchObject({ startMin: 22 * 60, endMin: 1440, clippedStart: false, clippedEnd: true })
    const [second] = timedSegments([e], new Date(2026, 8, 26))
    expect(second).toMatchObject({ startMin: 0, endMin: 120, clippedStart: true, clippedEnd: false })
  })

  it('ignores all-day events and other days', () => {
    expect(timedSegments([allDay('a', 25, 26), timed('x', 24, 9, 0, 10, 0)], new Date(2026, 8, 25))).toEqual([])
  })

  it('events ending at midnight end at the bottom of the day', () => {
    const [s] = timedSegments([timed('late', 25, 23, 0, 0, 0, 26)], new Date(2026, 8, 25))
    expect(s?.endMin).toBe(1440)
  })
})

describe('layoutDay', () => {
  const day = new Date(2026, 8, 25)
  const layout = (...events: ReturnType<typeof timed>[]) =>
    Object.fromEntries(layoutDay(timedSegments(events, day)).map((p) => [p.event.key, [p.col, p.cols, p.span]]))

  it('places non-overlapping events in one full-width column', () => {
    expect(layout(timed('a', 25, 9, 0, 10, 0), timed('b', 25, 10, 0, 11, 0))).toEqual({ a: [0, 1, 1], b: [0, 1, 1] })
  })

  it('puts overlapping events side by side', () => {
    expect(layout(timed('a', 25, 9, 0, 11, 0), timed('b', 25, 10, 0, 12, 0))).toEqual({ a: [0, 2, 1], b: [1, 2, 1] })
  })

  it('reuses freed columns and expands into free space', () => {
    // a: 9-12, b: 9-10, c: 10-11 (reuses b's column), d: 9:30-10 → third column
    const r = layout(
      timed('a', 25, 9, 0, 12, 0),
      timed('b', 25, 9, 0, 10, 0),
      timed('c', 25, 10, 0, 11, 0),
      timed('d', 25, 9, 30, 10, 0),
    )
    expect(r.a).toEqual([0, 3, 1])
    expect(r.b).toEqual([1, 3, 1])
    expect(r.d).toEqual([2, 3, 1])
    expect(r.c).toEqual([1, 3, 2]) // column 2 is free from 10:00
  })

  it('treats very short events as minDuration long', () => {
    const r = layout(timed('a', 25, 9, 0, 9, 5), timed('b', 25, 9, 10, 9, 30))
    expect(r.a?.[1]).toBe(2)
  })
})

describe('layoutWeekRow', () => {
  const days = eachDay({ start: new Date(2026, 8, 20), end: new Date(2026, 8, 27) }) // Sun 20 .. Sat 26

  it('assigns lanes to spanning events and keeps singles below', () => {
    const trip = allDay('trip', 21, 24) // Mon-Wed
    const off = allDay('off', 23, 25) // Wed-Thu → second lane
    const lunch = timed('lunch', 23, 12, 0, 13, 0)
    const { bars, cells } = layoutWeekRow(days, [lunch, off, trip], Infinity)
    expect(bars.map((b) => [b.event.key, b.startCol, b.span, b.lane])).toEqual([
      ['trip', 1, 3, 0],
      ['off', 3, 2, 1],
    ])
    const wed = cells[3]!
    expect(wed.barRows).toBe(2)
    expect(wed.singles.map((e) => e.key)).toEqual(['lunch'])
    expect(wed.hidden).toBe(0)
    expect(cells[0]!.barRows).toBe(0)
  })

  it('marks bars continuing beyond the row', () => {
    const long = allDay('long', 18, 30)
    const [bar] = layoutWeekRow(days, [long], Infinity).bars
    expect(bar).toMatchObject({ startCol: 0, span: 7, continuesBefore: true, continuesAfter: true })
  })

  it('hides overflow behind "+N more" and splits bars at hidden lanes', () => {
    const a = allDay('a', 21, 23) // Mon-Tue lane 0
    const b = allDay('b', 21, 23) // Mon-Tue lane 1
    const singles = [9, 10, 11].map((h) => timed(`s${h}`, 22, h, 0, h + 1, 0)) // Tue
    const { bars, cells } = layoutWeekRow(days, [a, b, ...singles], 3)
    const mon = cells[1]!
    const tue = cells[2]!
    // Monday: 2 bars fit in 3 rows.
    expect(mon.hidden).toBe(0)
    // Tuesday: 2 bars + 3 singles > 3 → keep 2 rows, hide the rest.
    expect(tue.hidden).toBe(3)
    expect(tue.singles).toHaveLength(0)
    expect(tue.all).toHaveLength(5)
    // Bar b (lane 1) is still visible on Tuesday because limit is 2.
    expect(bars.filter((x) => x.event.key === 'b').map((x) => [x.startCol, x.span])).toEqual([[1, 2]])
  })

  it('splits a bar where its lane is hidden', () => {
    const top = allDay('top', 21, 22) // Mon lane 0
    const wide = allDay('wide', 20, 24) // Sun-Wed lane? sorted first → lane 0
    const other = allDay('other', 21, 23) // Mon-Tue lane 1
    const tueSingles = [9, 10].map((h) => timed(`t${h}`, 22, h, 0, h + 1, 0))
    const res = layoutWeekRow(days, [top, wide, other, ...tueSingles], 2)
    // capacity 2 → overflowing days only show lane 0.
    expect(res.bars.find((b) => b.event.key === 'wide')).toMatchObject({ startCol: 0, span: 4, lane: 0 })
    expect(res.cells[2]!.hidden).toBeGreaterThan(0)
  })

  it('handles empty input', () => {
    expect(layoutWeekRow([], [], 3)).toEqual({ bars: [], cells: [] })
  })
})

describe('cellCapacity', () => {
  it('computes rows and falls back before measurement', () => {
    expect(cellCapacity(0, 30, 22)).toBe(3)
    expect(cellCapacity(140, 30, 22)).toBe(5)
    expect(cellCapacity(40, 30, 22)).toBe(1)
  })
})

describe('agendaRows', () => {
  it('lists days with events only, headers first', () => {
    const days = eachDay({ start: new Date(2026, 8, 24), end: new Date(2026, 8, 27) })
    const rows = agendaRows([timed('a', 25, 9, 0, 10, 0), allDay('b', 25, 27)], days)
    expect(rows.map((r) => (r.type === 'day' ? `day ${dayKey(r.day)}` : r.event.key))).toEqual([
      'day 2026-09-25',
      'b',
      'a',
      'day 2026-09-26',
      'b',
    ])
  })
})
