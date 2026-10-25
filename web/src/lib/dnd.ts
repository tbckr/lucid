import { addDays, differenceInCalendarDays } from 'date-fns'
import { type RefObject } from 'react'
import { type TodoInput } from './api/schemas'
import { movedTodo, placedOn, shiftedTask, toCalTask, type CalTask, type TaskDates } from './calendarTasks'
import { atMinutes, minutesOfDay, snapMinutes } from './dates'
import { firstDay, movedTimes, withTimes, type CalEvent, type CalItem } from './events'
import { type Scope } from './scope'

/** Pixel height of one hour in the time grid. */
/** Pointer travel before a press becomes a drag (FR-10): for moving entries and drawing new ones. */
export const DRAG_DISTANCE = 6

export const HOUR_HEIGHT = 48
export const PX_PER_MINUTE = HOUR_HEIGHT / 60
export const SNAP_MINUTES = 15
export const SNAP_PX = SNAP_MINUTES * PX_PER_MINUTE

/**
 * Data attached to draggables. Events and tasks move alike (FR-16); only events
 * resize. `draft`: the create popover's entry, which a drop gives the new times
 * instead of saving them (FR-09). `listed`: a row of a time-grid list (FR-07),
 * which has no tile to measure a move from: on a column it lands at the time it
 * is dropped at, on a day it moves like an `event`; `originDay` is the day its
 * item starts on. `offset`: minutes a `timed` tile is drawn after its item's
 * start (before it, if negative), as a task in the overflow column at its
 * stack's place (FR-07); a move lands the item where the tile's top lands.
 */
export type DragData =
  | { type: 'event'; event: CalItem; originDay: Date }
  | { type: 'listed'; event: CalItem; originDay: Date }
  | { type: 'timed'; event: CalItem; originDay: Date; draft?: true; offset?: number }
  | { type: 'resize'; event: CalEvent; draft?: true }

/** How a view makes one of its items draggable. */
export interface DragBinding {
  id: string
  data: DragData
  disabled: boolean
}

/**
 * What a drop saves: new times for an event, new dates for a task, with the
 * distance the task moved, which places an upcoming occurrence (FR-17).
 */
export type DropResult =
  | { kind: 'event'; event: CalEvent; times: { start: string; end: string } }
  | { kind: 'task'; task: CalTask; input: TodoInput; delta: { days: number; minutes: number } }

/** Data attached to droppables; a time-grid column also refers to its element, for the create popover to point at. */
export type DropData = { type: 'day'; day: Date } | { type: 'column'; day: Date; ref?: RefObject<HTMLElement | null> }

const MINUTES_PER_DAY = 24 * 60
const SLOTS_PER_DAY = MINUTES_PER_DAY / SNAP_MINUTES

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
  if (drag === 'listed') return true
  if (drag === 'timed') return drop === 'column'
  return drop === 'column'
}

/** Non-resize drag data, which alone carries an `originDay` to measure a move from. */
type MoveDrag = Exclude<DragData, { type: 'resize' }>

/**
 * The offset that puts `item` where a row dropped on the column of `day` with its top `top` px below the column's top
 * lands (FR-07, FR-10): its start at the 15-minute slot there, within the day. The minutes are the ones between
 * where the item starts on that day and the slot on the day's wall clock, so a change of the UTC offset between the
 * two, on the days clocks go back or forward, doesn't shift the landing by an hour.
 */
function landedDelta(item: CalItem, day: Date, top: number): { days: number; minutes: number } {
  const days = differenceInCalendarDays(day, firstDay(item))
  const slot = Math.min(MINUTES_PER_DAY - SNAP_MINUTES, Math.max(0, snapMinutes(top / PX_PER_MINUTE, SNAP_MINUTES)))
  const start = addDays(item.startsAt, days)
  const at = atMinutes(day, slot)
  return { days, minutes: slot - minutesOfDay(start) + at.getTimezoneOffset() - start.getTimezoneOffset() }
}

/**
 * The day/minute offset a drop would apply, or null for a no-op or an incompatible target. `top`: for a `listed`
 * row on a column, the dragged tile's top below the column's top, in px; without it that drop is not placed.
 */
function movedDelta(
  drag: MoveDrag,
  drop: DropData | null,
  deltaY: number,
  top?: number,
): { days: number; minutes: number } | null {
  if (!drop || !acceptsDrop(drag.type, drop.type)) return null
  let delta: { days: number; minutes: number }
  if (drag.type === 'listed' && drop.type === 'column') {
    if (top === undefined) return null
    delta = landedDelta(drag.event, drop.day, top)
  } else {
    const moved = drag.type === 'timed' ? snapMinutes(deltaY / PX_PER_MINUTE, SNAP_MINUTES) : 0
    const days = differenceInCalendarDays(drop.day, drag.originDay)
    // A tile drawn away from its item's start puts the item where the tile lands, once it moves (FR-07).
    const offset = drag.type === 'timed' && (moved !== 0 || days !== 0) ? (drag.offset ?? 0) : 0
    delta = { days, minutes: moved + offset }
  }
  if (delta.days === 0 && delta.minutes === 0) return null
  return delta
}

/**
 * What a finished drag saves. Returns null when nothing changes or the drop target is incompatible. `top`: where a
 * dragged `listed` row's tile starts below the top of the column it is over, in px (see `movedDelta`).
 */
export function dropResult(drag: DragData, drop: DropData | null, deltaY: number, top?: number): DropResult | null {
  if (drag.type === 'resize') {
    const minutes = snapMinutes(deltaY / PX_PER_MINUTE, SNAP_MINUTES)
    if (minutes === 0) return null
    const e = drag.event
    const minEnd = e.startsAt.getTime() + SNAP_MINUTES * 60_000
    const end = Math.max(minEnd, e.endsAt.getTime() + minutes * 60_000)
    if (end === e.endsAt.getTime()) return null
    return { kind: 'event', event: e, times: { start: e.start, end: new Date(end).toISOString() } }
  }
  const delta = movedDelta(drag, drop, deltaY, top)
  if (!delta) return null
  const e = drag.event
  if (e.kind === 'task') {
    return { kind: 'task', task: e, input: movedTodo(e.todo, delta.days, delta.minutes), delta }
  }
  return { kind: 'event', event: e, times: movedTimes(e, delta.days, delta.minutes) }
}

/** `drag` with its item where `result` puts it, to preview a drop before it is saved. */
export function withDrop(drag: DragData, result: DropResult): DragData {
  if (result.kind === 'event') return { ...drag, event: withTimes(result.event, result.times) }
  if (drag.type === 'resize') return drag
  // An upcoming occurrence shows where it lands itself; which repeats move with it, the question after the drop
  // decides (FR-17).
  const { task, delta } = result
  if (task.occurrence?.state === 'upcoming') return { ...drag, event: shiftedTask(task, delta.days, delta.minutes) }
  return { ...drag, event: toCalTask({ ...task.todo, ...result.input }) ?? task }
}

/**
 * An event of a series, or a repeat of a task series, dropped at new times
 * or dates while the user picks which ones move (FR-10, FR-17): `key` is the
 * dropped occurrence, `id` its series, `from` its `recurrenceId`, where "This
 * and following" starts, and `reach` the option that has the focus or the
 * pointer, null while none has. An event lands on `start` and `end`, a
 * task's repeat on `to`.
 */
export type ScopePreview = {
  key: string
  id: string
  from: string
  reach: Scope | null
} & ({ kind: 'event'; start: string; end: string } | { kind: 'task'; to: TaskDates })

/**
 * `items` with the event or task's repeat of `scope.key` where it was dropped,
 * so it shows only at its new place until the answer, like a resize preview.
 */
export function withScopePreview(items: CalItem[], scope: ScopePreview | null): CalItem[] {
  if (!scope) return items
  if (scope.kind === 'task') {
    return items.map((e) => (e.kind === 'task' && e.key === scope.key ? placedOn(e, scope.to) : e))
  }
  const times = { start: scope.start, end: scope.end }
  return items.map((e) => (e.kind === 'event' && e.key === scope.key ? withTimes(e, times) : e))
}
