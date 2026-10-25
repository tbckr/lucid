import { differenceInCalendarDays, startOfDay } from 'date-fns'
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

/**
 * Assign overlap columns (classic calendar layout): events are grouped into
 * clusters of transitively overlapping events; each event takes the first
 * free column; every event of a cluster shares the cluster's column count and
 * extends to the right over free columns.
 *
 * `minDuration` keeps very short events from visually colliding.
 */
export function layoutDay<T extends CalItem>(segments: TimedSegment<T>[], minDuration = 20): PositionedSegment<T>[] {
  const sorted = [...segments].sort(
    (a, b) => a.startMin - b.startMin || b.endMin - a.endMin || compareEvents(a.event, b.event),
  )
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
