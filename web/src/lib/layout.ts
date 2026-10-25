import { differenceInCalendarDays, startOfDay } from 'date-fns'
import { TASK_POINT_MINUTES } from './calendarTasks'
import { dayKey, minutesOfDay } from './dates'
import { compareEvents, firstDay, groupByDay, isSpanning, lastDay, overlapsDay, type CalItem } from './events'

/* ------------------------------------------------------------------------ */
/* Time grid (week/day): overlapping events side by side                    */
/* ------------------------------------------------------------------------ */

export interface TimedSegment<T extends CalItem = CalItem> {
  event: T
  /** Minutes after local midnight, clamped to the day. */
  startMin: number
  endMin: number
  /** The event continues from the previous / into the next day. */
  clippedStart: boolean
  clippedEnd: boolean
}

export interface PositionedSegment<T extends CalItem = CalItem> extends TimedSegment<T> {
  /** Column index inside the overlap cluster. */
  col: number
  /** Number of columns of the cluster. */
  cols: number
  /** Columns this segment may extend over (>= 1). */
  span: number
  /**
   * Its cluster's last column is the overflow column and holds nothing but its entries (FR-07): that column is drawn
   * slim and the cluster's other columns share the rest (`columnBox`).
   */
  slimOverflow?: true
}

const DAY_MINUTES = 24 * 60

/** Timed (non-spanning-bar) portions of events on `day`. */
export function timedSegments<T extends CalItem>(events: T[], day: Date): TimedSegment<T>[] {
  const d = startOfDay(day)
  const out: TimedSegment<T>[] = []
  for (const e of events) {
    if (e.allDay || !overlapsDay(e, d)) continue
    const clippedStart = firstDay(e) < d
    const clippedEnd = lastDay(e) > d
    const startMin = clippedStart ? 0 : minutesOfDay(e.startsAt)
    let endMin = clippedEnd ? DAY_MINUTES : minutesOfDay(e.endsAt)
    // An event ending exactly at midnight ends at the bottom of this day.
    if (!clippedEnd && endMin <= startMin && e.endsAt > e.startsAt) endMin = DAY_MINUTES
    out.push({ event: e, startMin, endMin: Math.max(endMin, startMin), clippedStart, clippedEnd })
  }
  return out
}

/** The order columns are handed out in: by start, longer first, then as displayed. */
function segmentOrder<T extends CalItem>(a: TimedSegment<T>, b: TimedSegment<T>): number {
  return a.startMin - b.startMin || b.endMin - a.endMin || compareEvents(a.event, b.event)
}

/**
 * Assign overlap columns (classic calendar layout): events are grouped into
 * clusters of transitively overlapping events; each event takes the first
 * free column; every event of a cluster shares the cluster's column count and
 * extends to the right over free columns.
 *
 * `minDuration` keeps very short events from visually colliding.
 */
export function layoutDay<T extends CalItem>(segments: TimedSegment<T>[], minDuration = 20): PositionedSegment<T>[] {
  const sorted = [...segments].sort(segmentOrder)
  const visualEnd = (s: TimedSegment<T>) => Math.max(s.endMin, s.startMin + minDuration)
  const result: PositionedSegment<T>[] = []

  let cluster: { seg: TimedSegment<T>; col: number }[] = []
  let columnsEnd: number[] = []
  let clusterEnd = -1

  const flush = () => {
    const cols = columnsEnd.length
    for (const item of cluster) {
      let span = 1
      for (let c = item.col + 1; c < cols; c++) {
        const blocked = cluster.some(
          (o) => o.col === c && o.seg.startMin < visualEnd(item.seg) && visualEnd(o.seg) > item.seg.startMin,
        )
        if (blocked) break
        span++
      }
      result.push({ ...item.seg, col: item.col, cols, span })
    }
    cluster = []
    columnsEnd = []
    clusterEnd = -1
  }

  for (const seg of sorted) {
    if (cluster.length > 0 && seg.startMin >= clusterEnd) flush()
    let col = columnsEnd.findIndex((end) => end <= seg.startMin)
    if (col === -1) {
      col = columnsEnd.length
      columnsEnd.push(visualEnd(seg))
    } else {
      columnsEnd[col] = visualEnd(seg)
    }
    cluster.push({ seg, col })
    clusterEnd = Math.max(clusterEnd, visualEnd(seg))
  }
  if (cluster.length > 0) flush()
  return result
}

/* ------------------------------------------------------------------------ */
/* Time grid within its width (FR-07): task bundles and "+N"                */
/* ------------------------------------------------------------------------ */

/** Narrowest readable column in the time grid (FR-07): a block's checkbox or color bar and about three letters. */
export const MIN_COLUMN_PX = 44

/** Columns that fit a day column of `width` px; Infinity before it is measured (width 0 or not finite). */
export function columnCapacity(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return Infinity
  return Math.max(1, Math.floor(width / MIN_COLUMN_PX))
}

/** An entry of the overflow column (FR-07): what stands for the items that don't get a column of their own. */
export interface OverflowEntry<T extends CalItem = CalItem> {
  /** 'tasks': a bundle, or one task shown as itself; 'events': "+N". */
  kind: 'tasks' | 'events'
  /** In compareEvents order. */
  items: T[]
  /** Earliest start of its items, minutes after midnight (clipped to the day). */
  startMin: number
  /**
   * Where it is drawn, one point (TASK_POINT_MINUTES) high: at the top of its stack, the "+N" below a bundle; a stack
   * late in the evening is raised to end at midnight.
   */
  topMin: number
  col: number
  cols: number
  /** Its column holds nothing but overflow entries in its cluster, so it is drawn slim (`columnBox`). */
  slimOverflow?: true
}

export interface DayLayout<T extends CalItem = CalItem> {
  placed: PositionedSegment<T>[]
  overflow: OverflowEntry<T>[]
}

/** Minutes of a day, end exclusive. */
interface Interval {
  from: number
  to: number
}

const overlaps = (a: Interval, b: Interval) => a.from < b.to && b.from < a.to

/** The times where more than `capacity` of the intervals meet. */
function overfull(intervals: Interval[], capacity: number): Interval[] {
  // At the same minute, ends come first: an interval ending where another starts does not meet it.
  const edges = intervals.flatMap((i) => [
    { at: i.from, step: 1 },
    { at: i.to, step: -1 },
  ])
  edges.sort((a, b) => a.at - b.at || a.step - b.step)
  const out: Interval[] = []
  let meeting = 0
  let from: number | null = null
  for (const { at, step } of edges) {
    meeting += step
    if (from === null && meeting > capacity) {
      from = at
    } else if (from !== null && meeting <= capacity) {
      out.push({ from, to: at })
      from = null
    }
  }
  return out
}

/** Groups of `xs` whose intervals overlap, transitively, in order of their starts. */
function chains<X>(xs: X[], interval: (x: X) => Interval): X[][] {
  const out: X[][] = []
  let group: X[] = []
  let end = -Infinity
  for (const x of [...xs].sort((a, b) => interval(a).from - interval(b).from)) {
    const at = interval(x)
    if (at.from >= end) {
      group = []
      out.push(group)
    }
    group.push(x)
    end = Math.max(end, at.to)
  }
  return out
}

/** An item in a column of its own. */
interface Column<T extends CalItem> {
  seg: TimedSegment<T>
  col: number
}

/**
 * A stack of the overflow column (FR-07): at most one point of tasks (a bundle, or one task shown as itself) on top at
 * `top`, and one point of "+N" for events below it.
 */
interface Stack<T extends CalItem> {
  top: number
  tasks: TimedSegment<T>[]
  events: TimedSegment<T>[]
}

/** Where a stack is drawn: one point per kind it holds, from its top, raised late in the evening to end at midnight. */
const stackAt = (s: Stack<CalItem>): Interval => {
  const height = TASK_POINT_MINUTES * (Number(s.tasks.length > 0) + Number(s.events.length > 0))
  const from = Math.min(s.top, DAY_MINUTES - height)
  return { from, to: from + height }
}

/** The entry standing for `segs`, drawn at `topMin`; placed later. */
function overflowEntry<T extends CalItem>(kind: OverflowEntry['kind'], segs: TimedSegment<T>[], topMin: number): OverflowEntry<T> {
  const startMin = Math.min(...segs.map((s) => s.startMin))
  return { kind, items: segs.map((s) => s.event).sort(compareEvents), startMin, topMin, col: 0, cols: 1 }
}

/** A stack's entries, top to bottom where it is drawn: its tasks, then "+N" for its events. */
function stackEntries<T extends CalItem>(s: Stack<T>): OverflowEntry<T>[] {
  const out: OverflowEntry<T>[] = []
  const { from } = stackAt(s)
  if (s.tasks.length > 0) out.push(overflowEntry('tasks', s.tasks, from))
  if (s.events.length > 0) out.push(overflowEntry('events', s.events, from + (s.tasks.length > 0 ? TASK_POINT_MINUTES : 0)))
  return out
}

/**
 * Hand out columns `0..capacity-1` in layoutDay's order, each item the first one free over its whole time; the last
 * column is taken wherever the overflow column draws a stack. Stops at the first item that finds no column.
 */
function firstFit<T extends CalItem>(
  order: TimedSegment<T>[],
  capacity: number,
  stacks: Interval[],
  extent: (s: TimedSegment<T>) => Interval,
): { columns: Column<T>[]; failed?: TimedSegment<T> } {
  const ends = Array.from({ length: capacity }, () => -Infinity)
  const columns: Column<T>[] = []
  for (const seg of order) {
    const at = extent(seg)
    const col = ends.findIndex((end, c) => end <= at.from && (c < capacity - 1 || !stacks.some((s) => overlaps(s, at))))
    if (col === -1) return { columns, failed: seg }
    ends[col] = at.to
    columns.push({ seg, col })
  }
  return { columns }
}

type Drawn<T extends CalItem> = { at: Interval; column: Column<T> } | { at: Interval; stack: OverflowEntry<T>[] }

/**
 * Column counts per cluster of everything drawn: the overflow column sits right of the cluster's items, as the last
 * column at most, a stack's entries in one column, and items extend right over free columns as in layoutDay.
 */
function place<T extends CalItem>(
  columns: Column<T>[],
  stacks: Stack<T>[],
  capacity: number,
  extent: (s: TimedSegment<T>) => Interval,
): DayLayout<T> {
  const drawn: Drawn<T>[] = [
    ...columns.map((column) => ({ at: extent(column.seg), column })),
    ...stacks.map((s) => ({ at: stackAt(s), stack: stackEntries(s) })),
  ]
  const layout: DayLayout<T> = { placed: [], overflow: [] }
  for (const cluster of chains(drawn, (d) => d.at)) {
    const items = cluster.flatMap((d) => ('column' in d ? [{ at: d.at, ...d.column }] : []))
    const stacked = cluster.flatMap((d) => ('stack' in d ? [d] : []))
    const last = Math.max(-1, ...items.map((i) => i.col))
    const entryCol = Math.min(last + 1, capacity - 1)
    const cols = stacked.length > 0 ? Math.max(last + 1, entryCol + 1) : last + 1
    const spans = items.map((item) => {
      let span = 1
      for (let c = item.col + 1; c < cols; c++) {
        const blocked =
          items.some((o) => o.col === c && overlaps(o.at, item.at)) ||
          (c === entryCol && stacked.some((s) => overlaps(s.at, item.at)))
        if (blocked) break
        span++
      }
      return span
    })
    // The overflow column is drawn slim where it holds nothing but its entries; an item of its own there keeps the
    // cluster's columns even.
    const slim = stacked.length > 0 && items.every((item, i) => item.col + (spans[i] ?? 1) <= entryCol)
    const mark = slim ? { slimOverflow: true as const } : {}
    items.forEach((item, i) => layout.placed.push({ ...item.seg, col: item.col, cols, span: spans[i] ?? 1, ...mark }))
    for (const { stack } of stacked) layout.overflow.push(...stack.map((e) => ({ ...e, col: entryCol, cols, ...mark })))
  }
  return layout
}

/**
 * Lay out a day of the time grid in `capacity` columns (FR-07). Where no more items meet than fit, this is layoutDay.
 *
 * What yields is decided at each item's own time, and tasks yield first: tasks whose points overlap yield together
 * where more items meet than fit, and the tasks in an event's way yield before it is hidden. An event is hidden only
 * where it then finds no column over its whole time, and a task where an event is hidden yields too, so tasks never
 * take a column while events are hidden. An item with room keeps its column, even beside a busy hour; once all of
 * this settles, what has room after all gets its column back.
 *
 * What yields goes into the overflow column, the last one, as stacks: what would overlap there is one stack, at most
 * a point of tasks on top and a point of "+N" below. An item goes into the stack its own entry, at its start, would
 * overlap, else into a new one there, so its count stays at its place. What a stack pushes out of the last column thus
 * joins it, unless it held that column from well before; then it starts its own stack at its start, where nothing
 * else needs that column. A stack is at most two points tall and never pushes the next item out in turn; where stacks
 * still meet, they become one, and what that counts away from its place is decided again. A stack late in the evening
 * is raised to end at midnight, so the day's column holds it.
 */
export function layoutDayWithin<T extends CalItem>(
  segments: TimedSegment<T>[],
  capacity: number,
  minDuration = 20,
): DayLayout<T> {
  const cap = Math.max(1, Math.floor(capacity))
  const extent = (s: TimedSegment<T>): Interval => ({ from: s.startMin, to: Math.max(s.endMin, s.startMin + minDuration) })
  const full = overfull(segments.map(extent), cap)
  if (full.length === 0) return { placed: layoutDay(segments, minDuration), overflow: [] }

  // Tasks group by their points: a 10:30 task stays out of a 9:00 bundle, and a long task groups by its start.
  const groups = chains(
    segments.filter((s) => s.event.kind === 'task'),
    (s) => ({ from: s.startMin, to: s.startMin + TASK_POINT_MINUTES }),
  )
  const yielding = groups.filter((g) => g.some((s) => full.some((f) => overlaps(f, extent(s)))))
  let stacks: Stack<T>[] = yielding.map((g) => ({ top: Math.min(...g.map((s) => s.startMin)), tasks: [...g], events: [] }))
  const bundled = new Set(yielding.flat())
  const away = new Set(bundled)
  const order = [...segments].sort(segmentOrder)
  /** Where an item's count belongs: over its time, or the point at its start. */
  const placeOf = (x: TimedSegment<T>): Interval => ({
    from: x.startMin,
    to: Math.max(extent(x).to, x.startMin + TASK_POINT_MINUTES),
  })
  const decidedAgain = new Set<TimedSegment<T>>()

  /**
   * Stacks that would overlap become one, at the earlier top. What that leaves counted away from its place leaves the
   * stack and is decided again, once (a bundle's tasks stay with it).
   */
  const settle = () => {
    const out: Stack<T>[] = []
    for (const s of [...stacks].sort((a, b) => a.top - b.top)) {
      const above = out.at(-1)
      if (!above || !overlaps(stackAt(above), stackAt(s))) {
        out.push(s)
        continue
      }
      above.tasks.push(...s.tasks)
      above.events.push(...s.events)
      for (;;) {
        const lost = [...above.tasks, ...above.events].filter(
          (x) => !bundled.has(x) && !decidedAgain.has(x) && !overlaps(placeOf(x), stackAt(above)),
        )
        if (lost.length === 0) break
        for (const x of lost) {
          decidedAgain.add(x)
          away.delete(x)
        }
        above.tasks = above.tasks.filter((x) => !lost.includes(x))
        above.events = above.events.filter((x) => !lost.includes(x))
      }
    }
    stacks = out.filter((s) => s.tasks.length + s.events.length > 0)
  }

  /** Moves `seg` into `stack`. */
  const join = (seg: TimedSegment<T>, stack: Stack<T>) => {
    if (seg.event.kind === 'task') stack.tasks.push(seg)
    else stack.events.push(seg)
    away.add(seg)
  }
  /** Moves `seg` into the stack an entry of its own, at its start, would overlap, else into a new stack there. */
  const yieldAtStart = (seg: TimedSegment<T>) => {
    const top = seg.startMin
    let stack = stacks.find((s) => overlaps(stackAt(s), { from: top, to: top + TASK_POINT_MINUTES }))
    if (!stack) {
      stack = { top, tasks: [], events: [] }
      stacks.push(stack)
    }
    join(seg, stack)
  }
  /** The tasks holding the first column `seg` could take if they yielded: no event and no stack in its way there. */
  const tasksInTheWay = (seg: TimedSegment<T>, columns: Column<T>[]) => {
    const at = extent(seg)
    for (let c = 0; c < cap; c++) {
      if (c === cap - 1 && stacks.some((s) => overlaps(stackAt(s), at))) break
      const holders = columns.filter((x) => x.col === c && overlaps(extent(x.seg), at)).map((x) => x.seg)
      if (holders.every((h) => h.event.kind === 'task')) return holders
    }
    return []
  }

  // Each round moves at least one item into the overflow column, and only what a merge counts away from its place
  // leaves it again, once, so this settles.
  for (;;) {
    settle()
    const { columns, failed } = firstFit(
      order.filter((s) => !away.has(s)),
      cap,
      stacks.map(stackAt),
      extent,
    )
    if (failed) {
      // Tasks yield first: the tasks in an event's way go into the overflow column before the event does.
      const blocking = failed.event.kind === 'event' ? tasksInTheWay(failed, columns) : []
      for (const task of blocking) yieldAtStart(task)
      if (blocking.length === 0) yieldAtStart(failed)
      continue
    }
    const hiddenAt = stacks.flatMap((s) => s.events.map(extent))
    const crowded = columns.find(({ seg }) => seg.event.kind === 'task' && hiddenAt.some((h) => overlaps(h, extent(seg))))
    if (!crowded) return place(release(columns), stacks, cap, extent)
    yieldAtStart(crowded.seg)
  }

  /** `stack` without `seg`, as it can be drawn: where its tasks go, its "+N" moves up to its top, or stays where it is. */
  function without(stack: Stack<T>, seg: TimedSegment<T>): Stack<T>[] {
    const tasks = stack.tasks.filter((x) => x !== seg)
    const events = stack.events.filter((x) => x !== seg)
    const rest = { top: stack.top, tasks, events }
    if (tasks.length > 0 || stack.tasks.length === 0 || events.length === 0) return [rest]
    return [rest, { ...rest, top: stack.top + TASK_POINT_MINUTES }]
  }

  /**
   * Gives a column back to what has room once everything settled (a task that yielded for an event the next round
   * placed elsewhere, or an event a stack pushed out that has room after all): an item the overflow column holds for
   * no reason of its own, where every other item of its stack is still counted at its place without it.
   */
  function release(columns: Column<T>[]): Column<T>[] {
    const drawnAt = (s: Stack<T>) => [stackAt(s)].filter((at) => at.to > at.from)
    /** The column `seg` of `stack` can take, and its stack without it. */
    const room = (seg: TimedSegment<T>, stack: Stack<T>) => {
      if (bundled.has(seg)) return undefined
      const at = extent(seg)
      const hidden = stacks.flatMap((s) => s.events)
      if (seg.event.kind === 'task' && hidden.some((h) => overlaps(extent(h), at))) return undefined
      const others = stacks.filter((s) => s !== stack).flatMap(drawnAt)
      const rests = without(stack, seg).filter((rest) =>
        [...rest.tasks, ...rest.events].every((x) => bundled.has(x) || overlaps(placeOf(x), stackAt(rest))),
      )
      for (let col = 0; col < cap; col++) {
        if (columns.some((x) => x.col === col && overlaps(extent(x.seg), at))) continue
        const rest = rests.find((r) => col < cap - 1 || ![...others, ...drawnAt(r)].some((s) => overlaps(s, at)))
        if (rest) return { col, rest }
      }
      return undefined
    }
    for (;;) {
      const [first] = stacks
        .flatMap((stack) => [...stack.tasks, ...stack.events].map((seg) => ({ seg, stack, room: room(seg, stack) })))
        .filter((x) => x.room !== undefined)
        .sort((a, b) => segmentOrder(a.seg, b.seg))
      if (!first?.room) return columns.sort((a, b) => segmentOrder(a.seg, b.seg))
      const { rest, col } = first.room
      columns = [...columns, { seg: first.seg, col }]
      stacks = stacks.map((s) => (s === first.stack ? rest : s)).filter((s) => s.tasks.length + s.events.length > 0)
    }
  }
}

/**
 * Width of a day column's overflow column where it is drawn slim (FR-07): the compact bundle of its busiest entry
 * (two 14 px rings overlapping by 6, a 2 px gap and 7.2 px per tabular figure of the 12 px count, as measured, and a
 * pixel to spare), which also holds "+N", and the 4 px gap every block keeps to its right. 0 without entries.
 */
export function overflowColumnPx(overflow: OverflowEntry[]): number {
  if (overflow.length === 0) return 0
  const figures = String(Math.max(...overflow.map((e) => e.items.length))).length
  return Math.ceil(14 + 8 + 2 + 7.2 * figures) + 1 + 4
}

/**
 * Where an entry is drawn across a day column `width` px wide (FR-07), in % of it: its columns `col` to `col + span`
 * of `cols`. In a cluster `slim`, the overflow column, its last, is drawn `overflowPx` wide, and the cluster's
 * other columns share the rest, so the items beside a bundle or "+N" keep more of their titles. Elsewhere, and where
 * the slim column would be no narrower than an even share, the columns are even.
 */
export function columnBox(
  { col, span, cols }: { col: number; span: number; cols: number },
  slim: boolean,
  width: number,
  overflowPx: number,
): { left: number; width: number } {
  if (!slim || cols < 2 || overflowPx <= 0 || overflowPx >= width / cols) {
    return { left: (col / cols) * 100, width: (span / cols) * 100 }
  }
  const content = (1 - overflowPx / width) / (cols - 1)
  const end = col + span >= cols ? 1 : (col + span) * content
  return { left: col * content * 100, width: (end - col * content) * 100 }
}

/* ------------------------------------------------------------------------ */
/* Week rows (month view, all-day row): bars in lanes, rows, bundle, "N more" */
/* ------------------------------------------------------------------------ */

export interface BarSegment<T extends CalItem = CalItem> {
  event: T
  startCol: number
  /** Number of columns covered (>= 1). */
  span: number
  lane: number
  /** The event continues before/after this segment. */
  continuesBefore: boolean
  continuesAfter: boolean
}

/** A row below a cell's bar lanes: an item, or the day's tasks bundled into one entry (FR-07). */
export type CellRow<T extends CalItem = CalItem> = { type: 'item'; item: T } | { type: 'bundle'; items: T[] }

export interface CellLayout<T extends CalItem = CalItem> {
  day: Date
  /** Every event and task on this day, in display order. */
  all: T[]
  /** Rows below the bar lanes, in display order; a bundle sorts by its earliest task (compareEvents). */
  rows: CellRow<T>[]
  /** Rows occupied by visible bars above the rows. */
  barRows: number
  /** Behind "N more": events that don't fit; in a one-row cell, everything of the day. */
  more: T[]
}

export interface WeekRowLayout<T extends CalItem = CalItem> {
  bars: BarSegment<T>[]
  cells: CellLayout<T>[]
}

/** Drawn as a bar in a lane: spanning, except a task on a single day, which is a row like a timed one (FR-07). */
function isBar(e: CalItem): boolean {
  return isSpanning(e) && !(e.kind === 'task' && firstDay(e).getTime() === lastDay(e).getTime())
}

/** Lane order: events before tasks, so hiding by lane hides task bars first (FR-07); then by first day, longer first. */
function compareBars(a: CalItem, b: CalItem): number {
  if (a.kind !== b.kind) return a.kind === 'event' ? -1 : 1
  return (
    firstDay(a).getTime() - firstDay(b).getTime() ||
    differenceInCalendarDays(lastDay(b), firstDay(b)) - differenceInCalendarDays(lastDay(a), firstDay(a)) ||
    compareEvents(a, b)
  )
}

/** A row with the item it sorts by: a bundle by its earliest task. */
interface Sorted<T extends CalItem> {
  row: CellRow<T>
  head: T
}

const itemRow = <T extends CalItem>(item: T): CellRow<T> => ({ type: 'item', item })
const sortedItem = <T extends CalItem>(item: T): Sorted<T> => ({ row: itemRow(item), head: item })

/** The row of the day's tasks: two or more bundle, one stays itself (FR-07). */
function taskRow<T extends CalItem>(tasks: T[]): Sorted<T>[] {
  const [head] = tasks
  if (head === undefined) return []
  return [{ row: tasks.length === 1 ? itemRow(head) : { type: 'bundle', items: tasks }, head }]
}

function sortedRows<T extends CalItem>(rows: Sorted<T>[]): CellRow<T>[] {
  return rows.sort((a, b) => compareEvents(a.head, b.head)).map((r) => r.row)
}

/** Rows the bars take: up to the lowest lane among them. */
const maxLane = (bars: { lane: number }[]) => bars.reduce((m, p) => Math.max(m, p.lane + 1), 0)

/** A bar placed in a lane of the week row, over columns `sc` through `ec`. */
interface Placed<T extends CalItem> {
  event: T
  sc: number
  ec: number
  lane: number
}

/**
 * Lay out one week row (FR-07). `capacity` is the number of rows that fit into a cell (Infinity = unlimited).
 * Bars take lanes, events first; below them each cell shows its items. Where a day has more than fit, its single-day
 * tasks become one bundle row first, then its task bars join that bundle; only if the events still don't fit, one row
 * is kept for "N more", for the hidden event bars and the events beyond. A one-row cell shows only "N more".
 */
export function layoutWeekRow<T extends CalItem>(days: Date[], events: T[], capacity: number): WeekRowLayout<T> {
  const n = days.length
  const first = days[0]
  if (n === 0 || first === undefined) return { bars: [], cells: [] }
  const rowStart = startOfDay(first)

  const byDay = groupByDay(events, days)
  const spanning = events.filter((e) => isBar(e) && days.some((d) => overlapsDay(e, d))).sort(compareBars)

  // Each bar takes the first lane free over all its columns: tasks fill the gaps the events leave.
  const lanes: boolean[][] = []
  const placed: Placed<T>[] = []
  for (const e of spanning) {
    const sc = Math.max(0, differenceInCalendarDays(firstDay(e), rowStart))
    const ec = Math.min(n - 1, differenceInCalendarDays(lastDay(e), rowStart))
    const cols = Array.from({ length: ec - sc + 1 }, (_, i) => sc + i)
    let taken = lanes.find((t) => cols.every((c) => !t[c]))
    if (!taken) {
      taken = []
      lanes.push(taken)
    }
    for (const c of cols) taken[c] = true
    placed.push({ event: e, sc, ec, lane: lanes.indexOf(taken) })
  }

  // Per column: which of the bars over it show.
  const shows: ((p: Placed<T>) => boolean)[] = []
  const cells = days.map((day, c): CellLayout<T> => {
    const all = byDay.get(dayKey(day)) ?? []
    const covering = placed.filter((p) => p.sc <= c && p.ec >= c)
    const items = all.filter((e) => !isBar(e))
    const eventItems = items.filter((e) => e.kind === 'event')
    const taskItems = items.filter((e) => e.kind === 'task')
    const topRows = maxLane(covering)
    shows[c] = () => true

    // Everything fits.
    if (topRows + items.length <= capacity) {
      return { day, all, rows: items.map(itemRow), barRows: topRows, more: [] }
    }
    // The tasks yield: they share one row.
    if (topRows + eventItems.length + (taskItems.length > 0 ? 1 : 0) <= capacity) {
      return { day, all, rows: sortedRows([...eventItems.map(sortedItem), ...taskRow(taskItems)]), barRows: topRows, more: [] }
    }
    // From here, all the day's tasks share one row, its task bars too, so tasks never take more than that row while an
    // event could take their place.
    const tasks = all.filter((e) => e.kind === 'task')
    const bundleRow = tasks.length > 0 ? 1 : 0
    const isEventBar = (p: Placed<T>) => p.event.kind === 'event'
    // The task bars yield too, and then every event fits.
    const eventRows = maxLane(covering.filter(isEventBar))
    if (eventRows + eventItems.length + bundleRow <= capacity) {
      shows[c] = isEventBar
      return { day, all, rows: sortedRows([...eventItems.map(sortedItem), ...taskRow(tasks)]), barRows: eventRows, more: [] }
    }
    // The events overflow: one row for "N more".
    const limit = capacity - 1 - bundleRow
    // A one-row cell: "N more" for everything.
    if (limit < 0) {
      shows[c] = () => false
      return { day, all, rows: [], barRows: 0, more: all }
    }
    // Event bars keep their lanes, also over a lane a hidden task bar leaves empty.
    const visible = (p: Placed<T>) => isEventBar(p) && p.lane < limit
    shows[c] = visible
    const onTop = covering.filter(visible)
    const barRows = maxLane(onTop)
    const shown = eventItems.slice(0, limit - barRows)
    // The events not in view go behind "N more".
    const kept = new Set([...onTop.map((p) => p.event), ...shown])
    const more = all.filter((e) => e.kind === 'event' && !kept.has(e))
    return { day, all, rows: sortedRows([...shown.map(sortedItem), ...taskRow(tasks)]), barRows, more }
  })

  // Split bars into runs of columns where they show.
  const bars: BarSegment<T>[] = []
  for (const p of placed) {
    let runStart = -1
    for (let c = p.sc; c <= p.ec + 1; c++) {
      const visible = c <= p.ec && (shows[c]?.(p) ?? true)
      if (visible && runStart === -1) runStart = c
      if (!visible && runStart !== -1) {
        const runEnd = c - 1
        bars.push({
          event: p.event,
          startCol: runStart,
          span: runEnd - runStart + 1,
          lane: p.lane,
          continuesBefore: runStart === 0 && firstDay(p.event) < rowStart,
          continuesAfter: runEnd === n - 1 && differenceInCalendarDays(lastDay(p.event), rowStart) > n - 1,
        })
        runStart = -1
      }
    }
  }
  return { bars, cells }
}

/** Rows a cell fills: its bars, its rows, and one for "N more". */
export function cellRowsUsed(cell: CellLayout): number {
  return cell.barRows + cell.rows.length + (cell.more.length > 0 ? 1 : 0)
}

/** How many event rows fit into a month cell of the given pixel height. */
export function cellCapacity(cellHeight: number, headerHeight: number, rowHeight: number): number {
  if (!Number.isFinite(cellHeight) || cellHeight <= 0) return 3
  return Math.max(1, Math.floor((cellHeight - headerHeight) / rowHeight))
}

/* ------------------------------------------------------------------------ */
/* Agenda                                                                   */
/* ------------------------------------------------------------------------ */

export type AgendaRow<T extends CalItem = CalItem> =
  | { type: 'day'; day: Date; key: string }
  | { type: 'event'; day: Date; event: T; key: string }

/** Flatten events into day headers + event rows, skipping empty days. */
export function agendaRows<T extends CalItem>(events: T[], days: Date[]): AgendaRow<T>[] {
  const byDay = groupByDay(events, days)
  const rows: AgendaRow<T>[] = []
  for (const day of days) {
    const list = byDay.get(dayKey(day)) ?? []
    if (list.length === 0) continue
    const dk = dayKey(day)
    rows.push({ type: 'day', day, key: `d:${dk}` })
    for (const e of list) rows.push({ type: 'event', day, event: e, key: `e:${dk}:${e.key}` })
  }
  return rows
}
