import { describe, expect, it } from 'vitest'
import { toCalTask } from './calendarTasks'
import { dayKey, eachDay } from './dates'
import { compareEvents, toCalEvent } from './events'
import { apiEvent, todo } from '@/test/fixtures'
import { agendaRows, cellCapacity, cellRowsUsed, layoutDay, layoutWeekRow, timedSegments, type CellLayout } from './layout'

const local = (d: number, h: number, m = 0) => new Date(2026, 8, d, h, m).toISOString()
const timed = (key: string, d: number, h1: number, m1: number, h2: number, m2: number, d2 = d) =>
  toCalEvent(apiEvent({ key, id: key, title: key, start: local(d, h1, m1), end: local(d2, h2, m2) }))
const utc = (d: number) => new Date(Date.UTC(2026, 8, d)).toISOString()
/** A task due at `due`, a date where `dueAllDay`. */
const task = (key: string, due: string, dueAllDay = false) =>
  toCalTask(todo({ id: key, title: key, due, dueAllDay }))!
/** An all-day task from `from` through `through`. */
const taskSpan = (key: string, from: number, through: number) =>
  toCalTask(todo({ id: key, title: key, start: utc(from), startAllDay: true, due: utc(through), dueAllDay: true }))!
/** A cell's rows by title, a bundle as `bundle(<titles>)`. */
const rowsOf = (cell: CellLayout) =>
  cell.rows.map((r) => (r.type === 'item' ? r.item.title : `bundle(${r.items.map((i) => i.title).join(',')})`))
const titles = (items: { title: string }[]) => items.map((i) => i.title)
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
  /** The bars shown over column `c`, by title, with their lanes. */
  const barsOver = (bars: ReturnType<typeof layoutWeekRow>['bars'], c: number) =>
    bars.filter((b) => b.startCol <= c && b.startCol + b.span > c).map((b) => [b.event.title, b.lane])

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
    expect(rowsOf(wed)).toEqual(['lunch'])
    expect(wed.more).toEqual([])
    expect(cells[0]!.barRows).toBe(0)
  })

  it('marks bars continuing beyond the row', () => {
    const long = allDay('long', 18, 30)
    const [bar] = layoutWeekRow(days, [long], Infinity).bars
    expect(bar).toMatchObject({ startCol: 0, span: 7, continuesBefore: true, continuesAfter: true })
  })

  it('keeps everything when it fits', () => {
    const off = allDay('off', 25, 26)
    const { bars, cells } = layoutWeekRow(days, [task('t1', local(25, 11)), timed('e1', 25, 9, 0, 10, 0), off], 4)
    const fri = cells[5]!
    expect(cellRowsUsed(fri)).toBe(3)
    expect(fri.more).toEqual([])
    expect(rowsOf(fri)).toEqual(['e1', 't1'])
    expect(barsOver(bars, 5)).toEqual([['off', 0]])
  })

  it('bundles tasks before hiding events', () => {
    const events = [timed('e1', 25, 9, 0, 10, 0), timed('e2', 25, 10, 0, 11, 0)]
    const tasks = [11, 12, 13].map((h, i) => task(`t${i + 1}`, local(25, h)))
    const fri = layoutWeekRow(days, [...tasks, ...events], 4).cells[5]!
    expect(rowsOf(fri)).toEqual(['e1', 'e2', 'bundle(t1,t2,t3)'])
    expect(fri.more).toEqual([])
    expect(cellRowsUsed(fri)).toBe(3)
  })

  it('sorts a bundle among the events by its earliest task', () => {
    const events = [timed('e1', 25, 9, 0, 10, 0), timed('e2', 25, 10, 0, 11, 0)]
    const tasks = [task('t1', local(25, 12)), task('t2', local(25, 9, 30))]
    const fri = layoutWeekRow(days, [...tasks, ...events], 3).cells[5]!
    expect(rowsOf(fri)).toEqual(['e1', 'bundle(t2,t1)', 'e2'])
  })

  it('a single task is not bundled', () => {
    const events = [9, 10, 11].map((h) => timed(`e${h}`, 25, h, 0, h + 1, 0))
    const fri = layoutWeekRow(days, [...events, task('t1', local(25, 12))], 3).cells[5]!
    expect(rowsOf(fri)).toEqual(['e9', 't1'])
    expect(titles(fri.more)).toEqual(['e10', 'e11'])
    expect(cellRowsUsed(fri)).toBe(3)
  })

  it('single-day all-day tasks are rows, not bars', () => {
    const rent = task('rent', utc(25), true)
    const chore = taskSpan('chore', 22, 23)
    const { bars, cells } = layoutWeekRow(days, [rent, chore], Infinity)
    expect(bars.map((b) => [b.event.title, b.startCol, b.span])).toEqual([['chore', 2, 2]])
    expect(rowsOf(cells[5]!)).toEqual(['rent'])
    expect(cells[5]!.barRows).toBe(0)
  })

  it('lanes go to events first', () => {
    const chore = taskSpan('chore', 22, 23) // Tue-Wed
    const trip = allDay('trip', 23, 26) // Wed-Fri
    const { bars } = layoutWeekRow(days, [chore, trip], Infinity)
    expect(Object.fromEntries(bars.map((b) => [b.event.title, b.lane]))).toEqual({ trip: 0, chore: 1 })
  })

  it('gives a task bar a lane an event leaves free', () => {
    const early = taskSpan('early', 20, 21) // Sun-Mon
    const trip = allDay('trip', 23, 26) // Wed-Fri
    const { bars } = layoutWeekRow(days, [early, trip], Infinity)
    expect(Object.fromEntries(bars.map((b) => [b.event.title, b.lane]))).toEqual({ trip: 0, early: 0 })
  })

  it('bundles a task bar to keep every event bar', () => {
    const events = [allDay('a', 24, 27), allDay('b', 24, 27), allDay('c', 25, 26)] // lanes 0, 1, 2 over Friday
    const chore = taskSpan('chore', 25, 26) // Fri-Sat, lane 3
    const tasks = [task('t1', local(25, 9)), task('t2', local(25, 10))]
    const { bars, cells } = layoutWeekRow(days, [...tasks, chore, ...events], 4)
    const fri = cells[5]!
    expect(barsOver(bars, 5)).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
    ])
    expect(fri.barRows).toBe(3)
    expect(rowsOf(fri)).toEqual(['bundle(chore,t1,t2)'])
    expect(fri.more).toEqual([])
    expect(cellRowsUsed(fri)).toBe(4)
    // Saturday has room: the task bar shows there, as a run of its own.
    expect(bars.filter((b) => b.event.title === 'chore').map((b) => [b.startCol, b.span, b.lane])).toEqual([[6, 1, 3]])
    expect(cells[6]!.more).toEqual([])
  })

  it('bundles task bars before reserving a row for more', () => {
    const tasks = [taskSpan('x', 24, 25), taskSpan('y', 24, 25)] // Thu-Fri, lanes 0, 1
    const events = [timed('e9', 25, 9, 0, 10, 0), timed('e10', 25, 10, 0, 11, 0)]
    const { bars, cells } = layoutWeekRow(days, [...tasks, ...events], 3)
    const fri = cells[5]!
    expect(barsOver(bars, 5)).toEqual([])
    expect(fri.barRows).toBe(0)
    expect(rowsOf(fri)).toEqual(['bundle(x,y)', 'e9', 'e10'])
    expect(fri.more).toEqual([])
    // Thursday has room: both bars show there.
    expect(barsOver(bars, 4)).toEqual([
      ['x', 0],
      ['y', 1],
    ])
  })

  it('makes room for a bundle when only a task bar needs one', () => {
    const events = [allDay('a', 25, 26), allDay('b', 25, 26)] // lanes 0, 1
    const chore = taskSpan('chore', 25, 26) // lane 2
    const lunch = timed('lunch', 25, 12, 0, 13, 0)
    const { bars, cells } = layoutWeekRow(days, [chore, lunch, ...events], 3)
    const fri = cells[5]!
    expect(barsOver(bars, 5)).toEqual([['a', 0]])
    expect(rowsOf(fri)).toEqual(['chore'])
    expect(titles(fri.more)).toEqual(['b', 'lunch'])
  })

  it("hides a busy day's task bars in its bundle before its events", () => {
    // As seeded: an event bar in lane 0, a task bar in lane 1 that reaches into a day whose events overflow.
    const offsite = allDay('offsite', 24, 26) // Thu-Fri, lane 0
    const report = taskSpan('report', 23, 24) // Wed-Thu, lane 1
    const events = [9, 10, 11].map((h) => timed(`e${h}`, 24, h, 0, h + 1, 0))
    const tasks = [task('t1', local(24, 13)), task('t2', local(24, 14))]
    const { bars, cells } = layoutWeekRow(days, [report, ...tasks, ...events, offsite], 4)
    const thu = cells[4]!
    expect(barsOver(bars, 4)).toEqual([['offsite', 0]])
    expect(thu.barRows).toBe(1)
    // The task bar takes no row of its own while events are hidden: an event shows where it was.
    expect(rowsOf(thu)).toEqual(['bundle(report,t1,t2)', 'e9'])
    expect(titles(thu.more)).toEqual(['e10', 'e11'])
    expect(cellRowsUsed(thu)).toBe(4)
    // Wednesday has room: the task bar shows there, in its lane.
    expect(bars.filter((b) => b.event.title === 'report').map((b) => [b.startCol, b.span, b.lane])).toEqual([[3, 1, 1]])
  })

  it('shows a lone task bar of a busy day as its row', () => {
    const report = taskSpan('report', 24, 25) // Thu-Fri, lane 0
    const events = [9, 10, 11].map((h) => timed(`e${h}`, 25, h, 0, h + 1, 0))
    const { bars, cells } = layoutWeekRow(days, [report, ...events], 3)
    const fri = cells[5]!
    expect(barsOver(bars, 5)).toEqual([])
    expect(fri.barRows).toBe(0)
    expect(rowsOf(fri)).toEqual(['report', 'e9'])
    expect(titles(fri.more)).toEqual(['e10', 'e11'])
    expect(bars.filter((b) => b.event.title === 'report').map((b) => [b.startCol, b.span, b.lane])).toEqual([[4, 1, 0]])
  })

  it('leaves the lane of a hidden task bar empty above an event bar', () => {
    const a = allDay('a', 22, 25) // Tue-Thu, lane 0
    const b = allDay('b', 23, 27) // Wed-Sat, lane 1
    const late = taskSpan('late', 25, 26) // Fri-Sat: lane 0, free once a ends
    const events = [9, 10, 11].map((h) => timed(`e${h}`, 25, h, 0, h + 1, 0))
    const { bars, cells } = layoutWeekRow(days, [late, a, b, ...events], 4)
    const fri = cells[5]!
    // An accepted edge: lanes are shared across the week, so b stays in lane 1 over the empty lane 0.
    expect(barsOver(bars, 5)).toEqual([['b', 1]])
    expect(fri.barRows).toBe(2)
    expect(rowsOf(fri)).toEqual(['late'])
    expect(titles(fri.more)).toEqual(['e9', 'e10', 'e11'])
    // Saturday has room: the task bar shows there.
    expect(bars.filter((x) => x.event.title === 'late').map((x) => [x.startCol, x.span, x.lane])).toEqual([[6, 1, 0]])
  })

  it('falls back to one more for everything in a one-row cell', () => {
    const off = allDay('off', 25, 26)
    const { bars, cells } = layoutWeekRow(days, [task('t1', local(25, 9)), off], 1)
    const fri = cells[5]!
    expect(fri.rows).toEqual([])
    expect(fri.barRows).toBe(0)
    expect(titles(fri.more)).toEqual(['off', 't1'])
    expect(barsOver(bars, 5)).toEqual([])
    expect(cellRowsUsed(fri)).toBe(1)
  })

  it('bundles a one-row cell that has only tasks', () => {
    const fri = layoutWeekRow(days, [task('t1', local(25, 9)), task('t2', local(25, 10))], 1).cells[5]!
    expect(rowsOf(fri)).toEqual(['bundle(t1,t2)'])
    expect(fri.more).toEqual([])
    // A task bar over it joins the bundle too.
    const { bars, cells } = layoutWeekRow(days, [taskSpan('x', 25, 26), task('t1', local(25, 9))], 1)
    expect(rowsOf(cells[5]!)).toEqual(['bundle(x,t1)'])
    expect(barsOver(bars, 5)).toEqual([])
  })

  it('cellRowsUsed counts the more row', () => {
    const e = timed('e', 25, 9, 0, 10, 0)
    const cell = (more: ReturnType<typeof timed>[]): CellLayout => ({
      day: new Date(2026, 8, 25),
      all: [e],
      rows: [
        { type: 'item', item: e },
        { type: 'bundle', items: [e, e] },
      ],
      barRows: 1,
      more,
    })
    expect(cellRowsUsed(cell([e]))).toBe(4)
    expect(cellRowsUsed(cell([]))).toBe(3)
  })

  it('hides overflow behind "+N more" and splits bars at hidden lanes', () => {
    const a = allDay('a', 21, 23) // Mon-Tue lane 0
    const b = allDay('b', 21, 23) // Mon-Tue lane 1
    const singles = [9, 10, 11].map((h) => timed(`s${h}`, 22, h, 0, h + 1, 0)) // Tue
    const { bars, cells } = layoutWeekRow(days, [a, b, ...singles], 3)
    const mon = cells[1]!
    const tue = cells[2]!
    // Monday: 2 bars fit in 3 rows.
    expect(mon.more).toEqual([])
    // Tuesday: 2 bars + 3 singles > 3 → keep 2 rows, hide the rest.
    expect(titles(tue.more)).toEqual(['s9', 's10', 's11'])
    expect(tue.rows).toHaveLength(0)
    expect(tue.all).toHaveLength(5)
    // Bar b (lane 1) is still visible on Tuesday because limit is 2.
    expect(bars.filter((x) => x.event.key === 'b').map((x) => [x.startCol, x.span])).toEqual([[1, 2]])
  })

  it('splits a bar where its lane is hidden', () => {
    const top = allDay('top', 21, 22) // Mon, lane 2
    const wide = allDay('wide', 20, 24) // Sun-Wed, sorted first → lane 0
    const other = allDay('other', 21, 23) // Mon-Tue, lane 1
    const tueSingles = [9, 10].map((h) => timed(`t${h}`, 22, h, 0, h + 1, 0))
    const res = layoutWeekRow(days, [top, wide, other, ...tueSingles], 2)
    // capacity 2 → overflowing days only show lane 0.
    expect(res.bars.find((b) => b.event.key === 'wide')).toMatchObject({ startCol: 0, span: 4, lane: 0 })
    expect(titles(res.cells[1]!.more)).toEqual(['other', 'top'])
    expect(titles(res.cells[2]!.more)).toEqual(['other', 't9', 't10'])
    // Wednesday has room again: other ends Tuesday, so nothing of it shows.
    expect(res.bars.filter((b) => b.event.key !== 'wide')).toEqual([])
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

describe('tasks among events', () => {
  it('puts events before tasks with the same start and length', () => {
    const event = timed('B', 23, 12, 0, 12, 30)
    const sorted = [task('A', local(23, 12)), event].sort(compareEvents)
    expect(sorted.map((e) => e.title)).toEqual(['B', 'A'])
  })

  it('bundles tasks instead of counting them in more', () => {
    const days = eachDay({ start: new Date(2026, 8, 20), end: new Date(2026, 8, 27) })
    const tasks = [task('rent', local(23, 12)), task('call', local(23, 14))]
    const { cells } = layoutWeekRow(days, [...tasks, timed('a', 23, 9, 0, 9, 30), timed('b', 23, 10, 0, 10, 30)], 2)
    const wed = cells[3]!
    expect(titles(wed.more)).toEqual(['a', 'b'])
    expect(rowsOf(wed)).toEqual(['bundle(rent,call)'])
  })
})
