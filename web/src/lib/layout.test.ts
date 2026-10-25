import { describe, expect, it } from 'vitest'
import { TASK_POINT_MINUTES, toCalTask } from './calendarTasks'
import { dayKey, eachDay } from './dates'
import { compareEvents, toCalEvent, type CalItem } from './events'
import { apiEvent, todo } from '@/test/fixtures'
import {
  agendaRows,
  cellCapacity,
  cellRowsUsed,
  columnCapacity,
  layoutDay,
  layoutDayWithin,
  layoutWeekRow,
  timedSegments,
  type CellLayout,
  type DayLayout,
  type TimedSegment,
} from './layout'

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

describe('columnCapacity', () => {
  it('fits columns of at least MIN_COLUMN_PX, unlimited before measurement', () => {
    expect(columnCapacity(0)).toBe(Infinity)
    expect(columnCapacity(NaN)).toBe(Infinity)
    expect(columnCapacity(43)).toBe(1)
    expect(columnCapacity(44)).toBe(1)
    expect(columnCapacity(90)).toBe(2)
    expect(columnCapacity(170)).toBe(3)
  })
})

describe('layoutDayWithin', () => {
  const day = new Date(2026, 8, 25)
  /** A timed task point on Sept 25. */
  const pt = (key: string, h: number, m = 0) => toCalTask(todo({ id: key, title: key, due: local(25, h, m) }))!
  const overlap = (a: { from: number; to: number }, b: { from: number; to: number }) => a.from < b.to && b.from < a.to
  const extent = (s: TimedSegment) => ({ from: s.startMin, to: Math.max(s.endMin, s.startMin + 20) })

  /** The rules every layout within a width keeps (FR-07), checked on every case. */
  function expectRules(segments: TimedSegment[], capacity: number, layout: DayLayout, note = '') {
    const boxes = [
      ...layout.placed.map((p) => ({ name: p.event.title, ...extent(p), col: p.col, span: p.span, cols: p.cols })),
      ...layout.overflow.map((e) => ({
        name: `${e.kind}@${e.startMin}`,
        from: e.topMin,
        to: e.topMin + TASK_POINT_MINUTES,
        col: e.col,
        span: 1,
        cols: e.cols,
      })),
    ]
    for (const b of boxes) {
      expect(b.col >= 0 && b.span >= 1 && b.col + b.span <= b.cols && b.cols <= capacity, `${note} ${b.name} in its columns`).toBe(
        true,
      )
    }
    // Nothing drawn at the same time shares a column, and all of it shares one column count.
    for (const [i, a] of boxes.entries()) {
      for (const b of boxes.slice(i + 1)) {
        if (!overlap(a, b)) continue
        expect(a.col + a.span <= b.col || b.col + b.span <= a.col, `${note} ${a.name} and ${b.name} share a column`).toBe(true)
        expect(a.cols, `${note} ${a.name} and ${b.name} differ in columns`).toBe(b.cols)
      }
    }
    // At no minute do placed segments plus entries drawn there take more than `capacity` columns.
    const last = Math.max(0, ...boxes.map((b) => b.to))
    for (let m = 0; m < last; m++) {
      const used = boxes.filter((b) => b.from <= m && m < b.to).reduce((n, b) => n + b.span, 0)
      expect(used, `${note} columns at minute ${m}`).toBeLessThanOrEqual(capacity)
    }
    // Every item is placed or in exactly one entry, of its own kind, in display order, at its earliest start.
    const segOf = new Map<CalItem, TimedSegment>(segments.map((s) => [s.event, s]))
    const shown = [...layout.placed.map((p) => p.event), ...layout.overflow.flatMap((e) => e.items)]
    expect(shown, `${note} shown once each`).toHaveLength(segments.length)
    expect(new Set(shown), `${note} shown once each`).toEqual(new Set(segments.map((s) => s.event)))
    for (const e of layout.overflow) {
      expect(e.items.length, `${note} ${e.kind}@${e.startMin} is empty`).toBeGreaterThan(0)
      expect(
        e.items.every((i) => i.kind === (e.kind === 'tasks' ? 'task' : 'event')),
        `${note} ${e.kind}@${e.startMin} mixes kinds`,
      ).toBe(true)
      expect(titles(e.items), `${note} ${e.kind}@${e.startMin} order`).toEqual(titles([...e.items].sort(compareEvents)))
      expect(e.startMin, `${note} ${e.kind}@${e.startMin} start`).toBe(Math.min(...e.items.map((i) => segOf.get(i)!.startMin)))
      expect(e.topMin, `${note} ${e.kind}@${e.startMin} above its start`).toBeGreaterThanOrEqual(e.startMin)
    }
    // No event is hidden at a minute where a task is placed as itself.
    const hidden = layout.overflow.filter((e) => e.kind === 'events').flatMap((e) => e.items.map((i) => segOf.get(i)!))
    for (const p of layout.placed.filter((x) => x.event.kind === 'task')) {
      for (const h of hidden) {
        expect(overlap(extent(p), extent(h)), `${note} ${p.event.title} placed beside hidden ${h.event.title}`).toBe(false)
      }
    }
  }

  const within = (items: CalItem[], capacity: number, on = day) => {
    const segments = timedSegments(items, on)
    const layout = layoutDayWithin(segments, capacity)
    expectRules(segments, capacity, layout)
    return layout
  }
  /** Placed items by title: [col, cols, span]. */
  const placedOf = (l: DayLayout) => Object.fromEntries(l.placed.map((p) => [p.event.title, [p.col, p.cols, p.span]]))
  const overflowOf = (l: DayLayout) =>
    l.overflow.map((e) => ({
      kind: e.kind,
      items: titles(e.items),
      startMin: e.startMin,
      topMin: e.topMin,
      col: e.col,
      cols: e.cols,
    }))

  it('equals layoutDay when it fits', () => {
    const segments = timedSegments([timed('a', 25, 9, 0, 10, 0), timed('b', 25, 9, 0, 9, 30), pt('t', 9)], day)
    const layout = layoutDayWithin(segments, 3)
    expectRules(segments, 3, layout)
    expect(layout.placed).toEqual(layoutDay(segments))
    expect(layout.overflow).toEqual([])
  })

  it('bundles tasks first', () => {
    const l = within([timed('a', 25, 9, 0, 10, 0), timed('b', 25, 9, 30, 11, 0), pt('t1', 9), pt('t2', 9), pt('t3', 9)], 3)
    expect(placedOf(l)).toEqual({ a: [0, 3, 1], b: [1, 3, 2] })
    expect(overflowOf(l)).toEqual([{ kind: 'tasks', items: ['t1', 't2', 't3'], startMin: 540, topMin: 540, col: 2, cols: 3 }])
  })

  it("hides events only when they still don't fit", () => {
    const events = [timed('a', 25, 9, 0, 10, 0), timed('b', 25, 9, 0, 10, 30), timed('c', 25, 9, 15, 11, 0)]
    const tasks = [1, 2, 3, 4, 5, 6].map((i) => pt(`t${i}`, 9))
    const l = within([...tasks, ...events], 2)
    expect(placedOf(l)).toEqual({ b: [0, 2, 1] })
    expect(overflowOf(l)).toEqual([
      { kind: 'tasks', items: ['t1', 't2', 't3', 't4', 't5', 't6'], startMin: 540, topMin: 540, col: 1, cols: 2 },
      { kind: 'events', items: ['a', 'c'], startMin: 540, topMin: 570, col: 1, cols: 2 },
    ])
  })

  it("decides at the item's own time", () => {
    const l = within([timed('e', 25, 8, 0, 12, 0), pt('t1', 9), pt('t2', 9), pt('t3', 10, 30)], 2)
    // The 10:30 task has room beside the event: it stays itself, below the bundle.
    expect(placedOf(l)).toEqual({ e: [0, 2, 1], t3: [1, 2, 1] })
    expect(overflowOf(l)).toEqual([{ kind: 'tasks', items: ['t1', 't2'], startMin: 540, topMin: 540, col: 1, cols: 2 }])
  })

  it('groups by point, not by cluster', () => {
    const l = within([timed('e', 25, 8, 0, 12, 0), pt('t1', 9), pt('t2', 9, 20), pt('t3', 10, 30)], 2)
    expect(placedOf(l)).toEqual({ e: [0, 2, 1], t3: [1, 2, 1] })
    expect(overflowOf(l)).toEqual([{ kind: 'tasks', items: ['t1', 't2'], startMin: 540, topMin: 540, col: 1, cols: 2 }])
  })

  it('keeps a lone task as itself in the overflow column', () => {
    const l = within([timed('a', 25, 9, 0, 10, 0), timed('b', 25, 9, 0, 10, 0), pt('t', 9)], 2)
    expect(placedOf(l)).toEqual({ a: [0, 2, 1] })
    expect(overflowOf(l)).toEqual([
      { kind: 'tasks', items: ['t'], startMin: 540, topMin: 540, col: 1, cols: 2 },
      { kind: 'events', items: ['b'], startMin: 540, topMin: 570, col: 1, cols: 2 },
    ])
  })

  it('+N counts only its group', () => {
    const morning = [1, 2, 3].map((i) => timed(`a${i}`, 25, 9, 0, 10, 0))
    const afternoon = [1, 2, 3].map((i) => timed(`b${i}`, 25, 14, 0, 15, 0))
    const l = within([...morning, ...afternoon], 2)
    expect(placedOf(l)).toEqual({ a1: [0, 2, 1], b1: [0, 2, 1] })
    expect(overflowOf(l)).toEqual([
      { kind: 'events', items: ['a2', 'a3'], startMin: 540, topMin: 540, col: 1, cols: 2 },
      { kind: 'events', items: ['b2', 'b3'], startMin: 840, topMin: 840, col: 1, cols: 2 },
    ])
  })

  it('lays out an hour with room as layoutDay does', () => {
    const busy = [1, 2, 3].map((i) => timed(`a${i}`, 25, 9, 0, 10, 0))
    const calm = [timed('x', 25, 12, 0, 13, 0), timed('y', 25, 12, 30, 13, 30)]
    const l = within([...busy, ...calm], 2)
    expect(l.placed.filter((p) => p.event.title === 'x' || p.event.title === 'y')).toEqual(layoutDay(timedSegments(calm, day)))
  })

  it('stacks a bundle and +N in a single column', () => {
    const l = within([timed('e', 25, 9, 0, 10, 0), pt('t1', 9), pt('t2', 9)], 1)
    expect(l.placed).toEqual([])
    expect(overflowOf(l)).toEqual([
      { kind: 'tasks', items: ['t1', 't2'], startMin: 540, topMin: 540, col: 0, cols: 1 },
      { kind: 'events', items: ['e'], startMin: 540, topMin: 570, col: 0, cols: 1 },
    ])
  })

  it('groups a clipped task by its segment on the day', () => {
    // A point due at 23:50 ends at midnight (pointEnd), so a task from 23:50 to 0:20 is what reaches into Sept 25.
    const late = toCalTask(todo({ id: 'late', title: 'late', start: local(24, 23, 50), due: local(25, 0, 20) }))!
    const l = within([late, pt('early', 0, 5), timed('e', 25, 0, 0, 1, 0)], 2)
    expect(placedOf(l)).toEqual({ e: [0, 2, 1] })
    expect(overflowOf(l)).toEqual([{ kind: 'tasks', items: ['late', 'early'], startMin: 0, topMin: 0, col: 1, cols: 2 }])
  })

  it('yields a task at the time of a hidden event', () => {
    // long has no column over all its time (the 11:00 bundle takes the last one), so it is hidden; the 10:00 task,
    // with room of its own, must not take a column beside it.
    const items = [timed('early', 25, 8, 0, 9, 30), timed('long', 25, 9, 0, 12, 0), pt('t', 10), pt('b1', 11), pt('b2', 11)]
    const l = within(items, 2)
    expect(placedOf(l)).toEqual({ early: [0, 2, 1] })
    expect(overflowOf(l)).toEqual([
      { kind: 'events', items: ['long'], startMin: 540, topMin: 540, col: 1, cols: 2 },
      { kind: 'tasks', items: ['t'], startMin: 600, topMin: 600, col: 0, cols: 1 },
      { kind: 'tasks', items: ['b1', 'b2'], startMin: 660, topMin: 660, col: 0, cols: 1 },
    ])
  })

  it('moves a task pushed out by a stacked entry into the overflow column', () => {
    // The "+1" for short stacks below the 9:00 bundle, onto 9:30, where the 9:35 task had its column.
    const items = [timed('day', 25, 8, 0, 12, 0), pt('t1', 9), pt('t2', 9), timed('short', 25, 9, 10, 9, 20), pt('t3', 9, 35)]
    const l = within(items, 2)
    expect(placedOf(l)).toEqual({ day: [0, 2, 1] })
    expect(overflowOf(l)).toEqual([
      { kind: 'tasks', items: ['t1', 't2'], startMin: 540, topMin: 540, col: 1, cols: 2 },
      { kind: 'events', items: ['short'], startMin: 550, topMin: 570, col: 1, cols: 2 },
      { kind: 'tasks', items: ['t3'], startMin: 575, topMin: 600, col: 1, cols: 2 },
    ])
  })

  it('keeps its rules on seeded random days', () => {
    /** Park-Miller: the same cases on every run. */
    const random = (seed: number) => {
      let s = seed
      return (n: number) => {
        s = (s * 16807) % 2147483647
        return s % n
      }
    }
    for (let seed = 1; seed <= 300; seed++) {
      const r = random(seed)
      const items: CalItem[] = []
      const count = 3 + r(12)
      for (let i = 0; i < count; i++) {
        const start = 8 * 60 + 5 * r(48) // 8:00-11:55
        const length = [5, 15, 30, 45, 60, 90, 180][r(7)]!
        const end = start + length
        const at = (m: number) => local(25, Math.floor(m / 60), m % 60)
        const key = `i${i}`
        if (r(5) < 3) items.push(timed(key, 25, Math.floor(start / 60), start % 60, Math.floor(end / 60), end % 60))
        else if (r(3) > 0) items.push(toCalTask(todo({ id: key, title: key, due: at(start) }))!)
        else items.push(toCalTask(todo({ id: key, title: key, start: at(start), due: at(end) }))!)
      }
      const capacity = 1 + r(4)
      const segments = timedSegments(items, day)
      expectRules(segments, capacity, layoutDayWithin(segments, capacity), `seed ${seed}, capacity ${capacity}:`)
    }
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
