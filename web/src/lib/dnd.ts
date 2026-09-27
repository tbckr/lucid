import { differenceInCalendarDays } from 'date-fns'
import { movedTimes, type CalEvent } from './events'
import { snapMinutes } from './dates'

/** Pixel height of one hour in the time grid. */
export const HOUR_HEIGHT = 48
export const PX_PER_MINUTE = HOUR_HEIGHT / 60
export const SNAP_MINUTES = 15
export const SNAP_PX = SNAP_MINUTES * PX_PER_MINUTE

/** Data attached to draggables. */
export type DragData =
  | { type: 'event'; event: CalEvent; originDay: Date }
  | { type: 'timed'; event: CalEvent; originDay: Date }
  | { type: 'resize'; event: CalEvent }

/** Data attached to droppables. */
export type DropData = { type: 'day'; day: Date } | { type: 'column'; day: Date }

const SLOTS_PER_DAY = (24 * 60) / SNAP_MINUTES

/**
 * The span a drag in the empty time grid creates, in minutes since midnight:
 * every 15-minute slot from the pressed one to the one under the pointer, in
 * either direction and within the day.
 */
export function createRange(anchorMin: number, pointerMin: number): { startMin: number; endMin: number } {
  const slot = (min: number) => Math.min(SLOTS_PER_DAY - 1, Math.max(0, Math.floor(min / SNAP_MINUTES)))
  const a = slot(anchorMin)
  const b = slot(pointerMin)
  return { startMin: Math.min(a, b) * SNAP_MINUTES, endMin: (Math.max(a, b) + 1) * SNAP_MINUTES }
}

/** Which droppable type a draggable may land on. */
export function acceptsDrop(drag: DragData['type'], drop: DropData['type']): boolean {
  if (drag === 'event') return drop === 'day'
  if (drag === 'timed') return drop === 'column'
  return drop === 'column'
}

/**
 * Compute the new start/end for a finished drag. Returns null when nothing
 * changes or the drop target is incompatible.
 */
export function dropResult(
  drag: DragData,
  drop: DropData | null,
  deltaY: number,
): { start: string; end: string } | null {
  if (drag.type === 'resize') {
    const minutes = snapMinutes(deltaY / PX_PER_MINUTE, SNAP_MINUTES)
    if (minutes === 0) return null
    const e = drag.event
    const minEnd = e.startsAt.getTime() + SNAP_MINUTES * 60_000
    const end = Math.max(minEnd, e.endsAt.getTime() + minutes * 60_000)
    if (end === e.endsAt.getTime()) return null
    return { start: e.start, end: new Date(end).toISOString() }
  }
  if (!drop || !acceptsDrop(drag.type, drop.type)) return null
  const dayDelta = differenceInCalendarDays(drop.day, drag.originDay)
  const minuteDelta = drag.type === 'timed' ? snapMinutes(deltaY / PX_PER_MINUTE, SNAP_MINUTES) : 0
  if (dayDelta === 0 && minuteDelta === 0) return null
  return movedTimes(drag.event, dayDelta, minuteDelta)
}
