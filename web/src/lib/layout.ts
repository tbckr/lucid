import { differenceInCalendarDays, startOfDay } from 'date-fns'
import { dayKey, minutesOfDay } from './dates'
import { compareEvents, firstDay, groupByDay, isSpanning, lastDay, overlapsDay, type CalEvent } from './events'

/* ------------------------------------------------------------------------ */
/* Time grid (week/day): overlapping events side by side                    */
/* ------------------------------------------------------------------------ */

export interface TimedSegment {
  event: CalEvent
  /** Minutes after local midnight, clamped to the day. */
  startMin: number
  endMin: number
  /** The event continues from the previous / into the next day. */
  clippedStart: boolean
  clippedEnd: boolean
}

export interface PositionedSegment extends TimedSegment {
  /** Column index inside the overlap cluster. */
  col: number
  /** Number of columns of the cluster. */
  cols: number
  /** Columns this segment may extend over (>= 1). */
  span: number
}

const DAY_MINUTES = 24 * 60

/** Timed (non-spanning-bar) portions of events on `day`. */
export function timedSegments(events: CalEvent[], day: Date): TimedSegment[] {
  const d = startOfDay(day)
  const out: TimedSegment[] = []
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
export function layoutDay(segments: TimedSegment[], minDuration = 20): PositionedSegment[] {
  const sorted = [...segments].sort(
    (a, b) => a.startMin - b.startMin || b.endMin - a.endMin || compareEvents(a.event, b.event),
  )
  const visualEnd = (s: TimedSegment) => Math.max(s.endMin, s.startMin + minDuration)
  const result: PositionedSegment[] = []

  let cluster: { seg: TimedSegment; col: number }[] = []
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
/* Week rows (month view, all-day row): spanning bars in lanes + "+N more"  */
/* ------------------------------------------------------------------------ */

export interface BarSegment {
  event: CalEvent
  startCol: number
  /** Number of columns covered (>= 1). */
  span: number
  lane: number
  /** The event continues before/after this segment. */
  continuesBefore: boolean
  continuesAfter: boolean
}

export interface CellLayout {
  day: Date
  /** Every event on this day (for the "+N more" popover). */
  all: CalEvent[]
  /** Visible single-day events, rendered below the bar lanes. */
  singles: CalEvent[]
  /** Rows occupied by visible bars above the singles. */
  barRows: number
  /** Events hidden behind "+N more". */
  hidden: number
}

export interface WeekRowLayout {
  bars: BarSegment[]
  cells: CellLayout[]
}

/**
 * Lay out one week row. `capacity` is the number of event rows that fit into
 * a cell (Infinity = unlimited). When a day overflows, one row is reserved
 * for the "+N more" button and everything beyond is hidden.
 */
export function layoutWeekRow(days: Date[], events: CalEvent[], capacity: number): WeekRowLayout {
  const n = days.length
  const first = days[0]
  if (n === 0 || first === undefined) return { bars: [], cells: [] }
  const rowStart = startOfDay(first)

  const byDay = groupByDay(events, days)
  const spanning = events
    .filter((e) => isSpanning(e) && days.some((d) => overlapsDay(e, d)))
    .sort(
      (a, b) =>
        firstDay(a).getTime() - firstDay(b).getTime() ||
        differenceInCalendarDays(lastDay(b), firstDay(b)) - differenceInCalendarDays(lastDay(a), firstDay(a)) ||
        compareEvents(a, b),
    )

  // Greedy lane assignment.
  const laneEnds: number[] = []
  const placed: { event: CalEvent; sc: number; ec: number; lane: number }[] = []
  for (const e of spanning) {
    const sc = Math.max(0, differenceInCalendarDays(firstDay(e), rowStart))
    const ec = Math.min(n - 1, differenceInCalendarDays(lastDay(e), rowStart))
    let lane = laneEnds.findIndex((end) => end < sc)
    if (lane === -1) {
      lane = laneEnds.length
      laneEnds.push(ec)
    } else {
      laneEnds[lane] = ec
    }
    placed.push({ event: e, sc, ec, lane })
  }

  const limits: number[] = []
  const cells: CellLayout[] = days.map((day, c) => {
    const all = byDay.get(dayKey(day)) ?? []
    const covering = placed.filter((p) => p.sc <= c && p.ec >= c)
    const singles = all.filter((e) => !isSpanning(e))
    const topRows = covering.reduce((m, p) => Math.max(m, p.lane + 1), 0)
    if (topRows + singles.length <= capacity) {
      limits[c] = Number.POSITIVE_INFINITY
      return { day, all, singles, barRows: topRows, hidden: 0 }
    }
    const limit = Math.max(0, capacity - 1)
    limits[c] = limit
    const visibleBars = covering.filter((p) => p.lane < limit)
    const barRows = visibleBars.reduce((m, p) => Math.max(m, p.lane + 1), 0)
    const singleSlots = Math.max(0, limit - barRows)
    const shown = singles.slice(0, singleSlots)
    const hidden = covering.length - visibleBars.length + singles.length - shown.length
    return { day, all, singles: shown, barRows, hidden }
  })

  // Split bars into runs of columns where their lane is visible.
  const bars: BarSegment[] = []
  for (const p of placed) {
    let runStart = -1
    for (let c = p.sc; c <= p.ec + 1; c++) {
      const visible = c <= p.ec && p.lane < (limits[c] ?? Number.POSITIVE_INFINITY)
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


/** How many event rows fit into a month cell of the given pixel height. */
export function cellCapacity(cellHeight: number, headerHeight: number, rowHeight: number): number {
  if (!Number.isFinite(cellHeight) || cellHeight <= 0) return 3
  return Math.max(1, Math.floor((cellHeight - headerHeight) / rowHeight))
}

/* ------------------------------------------------------------------------ */
/* Agenda                                                                   */
/* ------------------------------------------------------------------------ */

export type AgendaRow = { type: 'day'; day: Date; key: string } | { type: 'event'; day: Date; event: CalEvent; key: string }

/** Flatten events into day headers + event rows, skipping empty days. */
export function agendaRows(events: CalEvent[], days: Date[]): AgendaRow[] {
  const byDay = groupByDay(events, days)
  const rows: AgendaRow[] = []
  for (const day of days) {
    const list = byDay.get(dayKey(day)) ?? []
    if (list.length === 0) continue
    const dk = dayKey(day)
    rows.push({ type: 'day', day, key: `d:${dk}` })
    for (const e of list) rows.push({ type: 'event', day, event: e, key: `e:${dk}:${e.key}` })
  }
  return rows
}
