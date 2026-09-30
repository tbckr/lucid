import { differenceInCalendarDays } from 'date-fns'
import { type RefObject } from 'react'
import { type TodoInput } from './api/schemas'
import { anchorOf, lastAllowedDay, movedTodo, moveWindow, toCalTask, withinWindow, type CalTask } from './calendarTasks'
import { movedTimes, withTimes, type CalEvent, type CalItem } from './events'
import { snapMinutes } from './dates'

/** Pixel height of one hour in the time grid. */
export const HOUR_HEIGHT = 48
export const PX_PER_MINUTE = HOUR_HEIGHT / 60
export const SNAP_MINUTES = 15
export const SNAP_PX = SNAP_MINUTES * PX_PER_MINUTE

/**
 * Data attached to draggables. Events and tasks move alike (FR-16); only events
 * resize. `draft`: the create popover's entry, which a drop gives the new times
 * instead of saving them (FR-09).
 */
export type DragData =
  | { type: 'event'; event: CalItem; originDay: Date }
  | { type: 'timed'; event: CalItem; originDay: Date; draft?: true }
  | { type: 'resize'; event: CalEvent; draft?: true }

/** How a view makes one of its items draggable. */
export interface DragBinding {
  id: string
  data: DragData
  disabled: boolean
}

/** What a drop saves: new times for an event, new dates for a task. */
export type DropResult =
  | { kind: 'event'; event: CalEvent; times: { start: string; end: string } }
  | { kind: 'task'; task: CalTask; input: TodoInput }

/** Data attached to droppables; a time-grid column also refers to its element, for the create popover to point at. */
export type DropData = { type: 'day'; day: Date } | { type: 'column'; day: Date; ref?: RefObject<HTMLElement | null> }

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

/** Non-resize drag data, which alone carries an `originDay` to measure a move from. */
type MoveDrag = Exclude<DragData, { type: 'resize' }>

/** The day/minute offset a drop would apply, or null for a no-op or an incompatible target. */
function movedDelta(drag: MoveDrag, drop: DropData | null, deltaY: number): { days: number; minutes: number } | null {
  if (!drop || !acceptsDrop(drag.type, drop.type)) return null
  const days = differenceInCalendarDays(drop.day, drag.originDay)
  const minutes = drag.type === 'timed' ? snapMinutes(deltaY / PX_PER_MINUTE, SNAP_MINUTES) : 0
  if (days === 0 && minutes === 0) return null
  return { days, minutes }
}

/**
 * What a finished drag saves. Returns null when nothing changes, the drop
 * target is incompatible, or a bounded series (FR-17) would move onto or past
 * its next occurrence.
 */
export function dropResult(drag: DragData, drop: DropData | null, deltaY: number): DropResult | null {
  if (drag.type === 'resize') {
    const minutes = snapMinutes(deltaY / PX_PER_MINUTE, SNAP_MINUTES)
    if (minutes === 0) return null
    const e = drag.event
    const minEnd = e.startsAt.getTime() + SNAP_MINUTES * 60_000
    const end = Math.max(minEnd, e.endsAt.getTime() + minutes * 60_000)
    if (end === e.endsAt.getTime()) return null
    return { kind: 'event', event: e, times: { start: e.start, end: new Date(end).toISOString() } }
  }
  const delta = movedDelta(drag, drop, deltaY)
  if (!delta) return null
  const e = drag.event
  if (e.kind === 'task') {
    const input = movedTodo(e.todo, delta.days, delta.minutes)
    if (!withinWindow(e.todo, input)) return null
    return { kind: 'task', task: e, input }
  }
  return { kind: 'event', event: e, times: movedTimes(e, delta.days, delta.minutes) }
}

/** Which edge of a bounded series' move window (FR-17) a blocked drop hit, and the day it names. */
export interface DropBlocked {
  edge: 'from' | 'until'
  date: Date
}

/**
 * Which edge of the move window a drop of a bounded series (FR-17) would
 * cross, so the UI can explain why nothing was saved: `from` when the drop
 * lands before the series' own day, `until` when it reaches or passes the
 * next occurrence. Null when the drag isn't a bounded task, or the drop is
 * within reach.
 */
export function dropBlocked(drag: DragData, drop: DropData | null, deltaY: number): DropBlocked | null {
  if (drag.type === 'resize' || drag.event.kind !== 'task') return null
  const w = moveWindow(drag.event.todo)
  if (!w) return null
  const delta = movedDelta(drag, drop, deltaY)
  if (!delta) return null
  const input = movedTodo(drag.event.todo, delta.days, delta.minutes)
  if (withinWindow(drag.event.todo, input)) return null
  const anchor = anchorOf(input)
  if (anchor && anchor < w.from) return { edge: 'from', date: w.from }
  const last = lastAllowedDay(w)
  return last ? { edge: 'until', date: last } : null
}

/** `drag` with its item where `result` puts it, to preview a drop before it is saved. */
export function withDrop(drag: DragData, result: DropResult): DragData {
  if (result.kind === 'event') return { ...drag, event: withTimes(result.event, result.times) }
  if (drag.type === 'resize') return drag
  return { ...drag, event: toCalTask({ ...result.task.todo, ...result.input }) ?? result.task }
}
