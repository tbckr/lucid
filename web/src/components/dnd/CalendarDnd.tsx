import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
  type Modifier,
} from '@dnd-kit/core'
import { useMutationState } from '@tanstack/react-query'
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ScopePopover } from '@/components/scope/ScopePopover'
import {
  MOVE_EVENT_KEY,
  UNDO_EVENT_KEY,
  usePendingSeries,
  useDetachTodo,
  useMoveEvent,
  useMoveFollowing,
  useMoveOccurrence,
  useTodoFollowing,
  useUpdateTodo,
  type MoveVars,
} from '@/hooks/queries'
import { useCalendarColors } from '@/hooks/useCalendarColors'
import { usePrefs } from '@/hooks/usePrefs'
import { type TodoInput } from '@/lib/api/schemas'
import { movedDates, repeatOf, type CalTask, type TaskDates, type TaskRepeat } from '@/lib/calendarTasks'
import {
  acceptsDrop,
  DRAG_DISTANCE,
  dropResult,
  SNAP_PX,
  withDrop,
  type DragData,
  type DropData,
  type DropResult,
  type ScopePreview,
} from '@/lib/dnd'
import { type CalEvent } from '@/lib/events'
import { formatEventSpan } from '@/lib/format'
import { timedSegments } from '@/lib/layout'
import { browserTimeZone } from '@/lib/locale'
import { draggedWhen } from '@/lib/quickCreate'
import { type ShiftReason } from '@/lib/seriesShift'
import {
  eventScopeHint,
  eventScopeItems,
  eventScopeMissing,
  scopeOptions,
  taskGlyphSlots,
  taskScopeHint,
  taskScopeItems,
  taskScopeMissing,
  type Scope,
  type ScopeHint,
  type ScopeResult,
} from '@/lib/scope'
import { todoToInput } from '@/lib/tasks'
import { useUi } from '@/stores/ui'
import { DndStateContext } from './dndState'

function dragData(data: unknown): DragData | null {
  return data && typeof data === 'object' && 'type' in data ? (data as DragData) : null
}
function dropData(data: unknown): DropData | null {
  return data && typeof data === 'object' && 'type' in data ? (data as DropData) : null
}

/** Whether two drops would save the same; a move gives both dates of a task one offset. */
function sameDrop(a: DropResult | null, b: DropResult | null): boolean {
  if (a?.kind === 'event' && b?.kind === 'event') return a.times.start === b.times.start && a.times.end === b.times.end
  if (a?.kind === 'task' && b?.kind === 'task') return a.input.start === b.input.start && a.input.due === b.input.due
  return a === b
}

/** A dropped event of a series waiting for the answer which events move (FR-17). */
interface EventAsking extends MoveVars {
  kind: 'event'
  /** Its length was changed rather than the event moved. */
  change: boolean
}

/**
 * A dropped repeat of a task series waiting for the answer which repeats move (FR-17): the
 * `repeat` of `task`, the dates `to` it was dropped on, and `input`, the series moved as far.
 */
interface TaskAsking extends TaskMove {
  kind: 'task'
}

/**
 * A dropped event or task's repeat of a series waiting for the answer which ones move (FR-17):
 * what the answer can be (`scopeOptions`, two options or more), what took an option away, for
 * the question to say, and where the drop ended, for the question to point at while the tile
 * isn't shown.
 */
type Asking = (EventAsking | TaskAsking) & ScopeResult & { at: DOMRect }

/**
 * A repeat of a task series dropped on new dates (FR-17): `repeat` of `task`, the dates `to` it
 * lands on, and `input`, the series' values moved as far as the repeat was, which "All repeats"
 * saves.
 */
interface TaskMove {
  task: CalTask
  repeat: TaskRepeat
  input: TodoInput
  to: TaskDates
}

/**
 * Which events of a series a drop of the dragged event onto `result` can reach (FR-17): a
 * resize changes the event, anything else moves it.
 */
function dropScopes(d: DragData, result: Extract<DropResult, { kind: 'event' }>, tz: string): ScopeResult {
  return scopeOptions({
    kind: 'event',
    action: d.type === 'resize' ? 'change' : 'move',
    item: result.event,
    to: new Date(result.times.start),
    tz,
  })
}

/**
 * Which repeats of its series a drop of a task's repeat onto `result` can move (FR-17), with
 * the dates the repeat lands on; null for a task that does not repeat. The drop moves the
 * series' own dates, which are its current repeat's, so those are the dates of a dropped
 * current repeat; a later one lands on its own dates moved as far. Never the dates of a drag
 * preview, which keeps the repeat's dates of the pick-up.
 */
function taskDrop(result: Extract<DropResult, { kind: 'task' }>): (TaskMove & ScopeResult) | null {
  const repeat = repeatOf(result.task)
  if (!repeat) return null
  const { input, delta } = result
  const to =
    repeat.at === 'current'
      ? { start: input.start, startAllDay: input.startAllDay, due: input.due, dueAllDay: input.dueAllDay }
      : movedDates(repeat.shown, delta.days, delta.minutes)
  return { task: result.task, repeat, input, to, ...scopeOptions({ kind: 'task', action: 'move', item: repeat, to }) }
}

/** What refused a move of a repeat that no option allows (FR-17); undefined while one does. */
function refusedBy(result: ScopeResult): ShiftReason | undefined {
  return result.options.length === 0 ? result.reason : undefined
}

/**
 * The tile of the event or task `key` in the views, to give the focus back to (NFR-27): an
 * event's tile is its button; a task's holds its checkbox and its title, which opens and drags it.
 */
function tileOf(key: string): HTMLElement | null | undefined {
  const tile = Array.from(document.querySelectorAll<HTMLElement>('[data-event-key], [data-task-key]')).find(
    (el) => (el.dataset.eventKey ?? el.dataset.taskKey) === key,
  )
  if (tile?.dataset.taskKey === undefined) return tile
  return tile.querySelector<HTMLElement>('button:not([role="checkbox"])')
}

/**
 * The question after dropping an event or task's repeat of a series (FR-10, FR-17): a popover
 * at its tile at its new place, with its calendar's color bar. Focus goes back to the tile once
 * it closes (NFR-27).
 */
function ScopeQuestion({
  asking,
  anchor,
  onChoose,
  onCancel,
  onPreview,
}: {
  asking: Asking
  anchor: HTMLElement | null
  onChoose: (scope: Scope) => void
  onCancel: () => void
  onPreview: (scope: Scope | null) => void
}) {
  const { t } = useTranslation()
  const prefs = usePrefs()
  const now = useMemo(() => new Date(), [])
  const colorsOf = useCalendarColors()
  const { options, at } = asking
  const question =
    asking.kind === 'task'
      ? {
          key: asking.task.key,
          color: colorsOf(asking.task.calendarId).solid,
          question: t('scope.task.move'),
          items: taskScopeItems(t, asking.repeat, options, prefs, now, 'change'),
          missing: taskScopeMissing(t, asking),
        }
      : {
          key: asking.event.key,
          color: colorsOf(asking.event.calendarId).solid,
          question: asking.change ? t('scope.event.change') : t('scope.event.move'),
          items: eventScopeItems(t, asking.event, options, prefs, now),
          missing: eventScopeMissing(t, asking),
        }
  return (
    <ScopePopover
      anchor={anchor}
      at={at}
      // Back to the event or repeat, wherever the answer put it.
      returnFocus={() => tileOf(question.key)}
      question={question.question}
      items={question.items}
      color={question.color}
      missing={question.missing}
      onChoose={onChoose}
      onCancel={onCancel}
      onPreview={onPreview}
    />
  )
}

/**
 * What the pill under a dragged event or task says before the drop (FR-17): which events or
 * repeats of its series the drop reaches with one option (`hint`), or why no option moves a
 * dragged repeat there (`limit`).
 */
interface DropSays {
  hint: ScopeHint | null
  limit: string | null
}

const NOTHING_SAID: DropSays = { hint: null, limit: null }

/** Snap vertical movement of time-grid items to 15 minutes. */
const snapTimed: Modifier = ({ transform, active }) => {
  const d = dragData(active?.data.current)
  if (d?.type === 'timed') return { ...transform, y: Math.round(transform.y / SNAP_PX) * SNAP_PX }
  if (d?.type === 'resize') return { ...transform, x: 0, y: Math.round(transform.y / SNAP_PX) * SNAP_PX }
  return transform
}

/** Pointer first; the keyboard sensor has no pointer, so fall back to rect overlap. */
const collision: CollisionDetection = (args) => {
  const d = dragData(args.active.data.current)
  const containers = args.droppableContainers.filter((c) => {
    const drop = dropData(c.data.current)
    return d && drop ? acceptsDrop(d.type, drop.type) : false
  })
  const scoped = { ...args, droppableContainers: containers }
  const byPointer = pointerWithin(scoped)
  return byPointer.length > 0 ? byPointer : rectIntersection(scoped)
}

const ARROWS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']

/**
 * Keyboard movement (NFR-27): arrows jump to the neighbouring day cell /
 * column; in the time grid, up/down move by 15 minutes.
 */
const keyboardCoordinates: KeyboardCoordinateGetter = (event, { context, currentCoordinates }) => {
  if (!ARROWS.includes(event.code)) return undefined
  event.preventDefault()
  const d = dragData(context.active?.data.current)
  if (!d) return undefined
  const vertical = event.code === 'ArrowUp' || event.code === 'ArrowDown'
  const sign = event.code === 'ArrowUp' || event.code === 'ArrowLeft' ? -1 : 1

  if ((d.type === 'timed' || d.type === 'resize') && vertical) {
    return { ...currentCoordinates, y: currentCoordinates.y + sign * SNAP_PX }
  }
  if (d.type === 'resize') return currentCoordinates

  const rect = context.collisionRect
  if (!rect) return undefined
  const cx = rect.left + rect.width / 2
  const cy = rect.top + rect.height / 2
  let best: { dx: number; dy: number; dist: number } | null = null
  for (const container of context.droppableContainers.getEnabled()) {
    const drop = dropData(container.data.current)
    if (!drop || !acceptsDrop(d.type, drop.type)) continue
    const r = context.droppableRects.get(container.id)
    if (!r) continue
    const rx = r.left + r.width / 2
    const ry = r.top + r.height / 2
    const dx = rx - cx
    const dy = ry - cy
    // The target must lie entirely beyond the dragged item's centre (not the current cell)
    // and overlap it on the other axis.
    const beyond = vertical
      ? sign > 0
        ? r.top >= cy
        : r.top + r.height <= cy
      : sign > 0
        ? r.left >= cx
        : r.left + r.width <= cx
    const aligned = vertical ? r.left <= cx && cx <= r.left + r.width : r.top <= cy && cy <= r.top + r.height
    const ahead = beyond && aligned
    if (!ahead) continue
    const dist = Math.hypot(dx, dy)
    if (!best || dist < best.dist) best = { dx, dy, dist }
  }
  if (!best) return currentCoordinates
  return {
    x: currentCoordinates.x + best.dx,
    y: d.type === 'timed' ? currentCoordinates.y : currentCoordinates.y + best.dy,
  }
}

/**
 * Drag & drop for all calendar views (FR-10). Renders a DragOverlay produced
 * by `renderOverlay` for the active item.
 */
export function CalendarDnd({
  children,
  renderOverlay,
}: {
  children: ReactNode
  /**
   * `limit`: why the dragged task's repeat can't land where it is (FR-17), as `scope.hint.none` says it with the
   * reason, when no option of its series moves it there; null while it can. `hint`: which events or repeats of its
   * series a drop of the dragged event or task right here reaches when there is no choice (FR-17); null with a
   * choice, which the question asks, for anything but an event or task's repeat of a series, and while a drop would
   * change nothing.
   */
  renderOverlay: (data: DragData, limit: string | null, hint: ScopeHint | null) => ReactNode
}) {
  const { t } = useTranslation()
  const prefs = usePrefs()
  const tz = useMemo(() => browserTimeZone(), [])
  const setCreateWhen = useUi((s) => s.setCreateWhen)
  const [active, setActive] = useState<{ id: string; data: DragData } | null>(null)
  /** What a drop right now would save; null while it would change nothing. */
  const [target, setTarget] = useState<DropResult | null>(null)
  /**
   * Which events or repeats of its series a drop of the dragged one right now reaches, when there is no choice, and
   * why a dragged repeat can't land right here, when no option moves it there (FR-17).
   */
  const [said, setSaid] = useState<DropSays>(NOTHING_SAID)
  // The same for the announcements, which dnd-kit calls right after our handlers, before
  // `target` re-renders. `moved`: the drag has had a target since the pick-up. `hint` and
  // `limit`: what the drop reaches without asking, and why a repeat can't land here (FR-17).
  // `asked`: the drop asks which events or repeats of a series move (FR-17).
  const latest = useRef<{ target: DropResult | null; moved: boolean; asked: boolean } & DropSays>({
    target: null,
    moved: false,
    asked: false,
    ...NOTHING_SAID,
  })

  // FR-17: a dropped event or task's repeat of a series waits for the answer which ones move,
  // shown at its new place meanwhile. `reach`: the option with the focus or the pointer; "All"
  // rings the series, "This and following" its events or repeats from the dropped one on.
  const [asking, setAsking] = useState<Asking | null>(null)
  const [reach, setReach] = useState<Scope | null>(null)
  // The moves of a series run one after another, each with the ETag the one before got
  // (FR-17): the series of the event the question asks about, or else of the dragged one.
  const moving =
    (asking?.kind === 'event' ? asking.event : undefined) ??
    (active?.data.event.kind === 'event' ? active.data.event : undefined)
  const series = moving?.recurring ? moving.id : undefined
  const move = useMoveEvent(series)
  const moveOccurrence = useMoveOccurrence(series)
  const moveFollowing = useMoveFollowing(series)
  // In line with the other updates of the task, so none conflicts with another (FR-16, FR-17):
  // the one the question asks about, or else the dragged one. The scope is the one of the last
  // render, which the pick-up, or the question, has caused.
  const todoId =
    (asking?.kind === 'task' ? asking.repeat.todo.id : undefined) ??
    (active?.data.event.kind === 'task' ? active.data.event.todo.id : undefined)
  const updateTodo = useUpdateTodo(todoId)
  const detachTodo = useDetachTodo(todoId)
  const todoFollowing = useTodoFollowing(todoId)
  // "Only this event" until its move settles: keeps the event at its new place until the
  // optimistic update is in, instead of jumping back for a moment (NFR-26). "Only this repeat"
  // the same until the detached task is in.
  const [held, setHeld] = useState<ScopePreview | null>(null)
  // The tile of the asking event or repeat, which the question points at; a tile that moves
  // takes over from the one it replaces.
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const scopeAnchor = useCallback((el: HTMLElement | null) => {
    if (el) setAnchor(el)
  }, [])

  // An event of a series is busy while a move of it is on its way: its tile, by key.
  const moves = useMutationState({
    filters: { mutationKey: MOVE_EVENT_KEY, status: 'pending' },
    select: (m) => (m.state.variables as MoveVars | undefined)?.event,
  })
  const pendingKeys = useMemo(
    () => new Set(moves.flatMap((e) => (e?.recurring ? [e.key] : []))),
    [moves],
  )
  // So are all events of a series while a change of it is undone (FR-17): by ID, since after "All
  // events" the series is reloaded with other keys than the undo's event has.
  const undoing = useMutationState({
    filters: { mutationKey: UNDO_EVENT_KEY, status: 'pending' },
    select: (m) => (m.state.variables as { event: CalEvent } | undefined)?.event.id,
  })
  const pendingSeries = useMemo(() => new Set(undoing.filter((id) => id !== undefined)), [undoing])
  // Recurring todos with a task update on the way (FR-17): busy and not draggable until reloaded.
  const pendingTodos = usePendingSeries()

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: DRAG_DISTANCE } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: keyboardCoordinates,
      keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space', 'Enter'] },
      // Past the middle of the grid, a move scrolls it instead. A smooth scroll would
      // swallow key presses (a held arrow key) that come before it has finished.
      scrollBehavior: 'auto',
    }),
  )

  const announcements: Announcements = useMemo(() => {
    // The target time for screen readers (NFR-27), like the preview shows it.
    const announceTarget: Announcements['onDragOver'] = ({ active: a, over }) => {
      const d = dragData(a.data.current)
      if (!d) return undefined
      const { target: next, moved, hint, limit } = latest.current
      // A repeat no option moves here (FR-17): say why instead of a time it won't get.
      if (limit) return limit
      if (next) {
        const over = t('dnd.over', { time: formatEventSpan(withDrop(d, next).event, prefs, t('event.allDay')) })
        // What the drop reaches without asking, like the pill under the event or task says it (FR-17).
        return hint ? `${over} ${hint.text}` : over
      }
      if (!over && d.type !== 'resize') return t('dnd.notOver')
      // Right after the pick-up nothing has changed yet: keep "Picked up …" audible.
      return moved ? t('dnd.unchanged') : undefined
    }
    return {
      onDragStart: ({ active: a }) => {
        const d = dragData(a.data.current)
        return d ? t('dnd.picked', { title: d.event.title || t('event.untitled') }) : ''
      },
      onDragMove: announceTarget,
      onDragOver: announceTarget,
      onDragEnd: ({ active: a, over }) => {
        if (!over) return t('dnd.cancelled')
        const { asked, limit } = latest.current
        // A repeat dropped where no option moves it saves nothing: say why, instead of falsely
        // announcing a move (FR-17, NFR-27).
        if (limit) return limit
        // Nothing has moved yet: the question asks first, about a change after a resize (FR-17, NFR-27).
        const d = dragData(a.data.current)
        if (asked) {
          if (d?.event.kind === 'task') return t('dnd.chooseRepeats')
          return d?.type === 'resize' ? t('dnd.chooseScopeChange') : t('dnd.chooseScope')
        }
        return d?.event.kind === 'task' ? t('dnd.taskDropped') : t('dnd.dropped')
      },
      onDragCancel: () => t('dnd.cancelled'),
    }
  }, [t, prefs])

  /**
   * What a drop onto `next` says beforehand (FR-17): which events or repeats of the series it
   * reaches with one option, and, for a repeat no option moves there, why not.
   */
  const dropSays = (d: DragData, next: DropResult | null): DropSays => {
    if (next?.kind === 'event') return { hint: eventScopeHint(t, dropScopes(d, next, tz), false), limit: null }
    const drop = next?.kind === 'task' ? taskDrop(next) : null
    if (!drop) return NOTHING_SAID
    return { hint: taskScopeHint(t, drop, 'move', false, drop.repeat.at), limit: refusal(drop) }
  }

  /** Why no option moves a dropped repeat (FR-17): `scope.hint.none` with the reason; null while one does. */
  const refusal = (result: ScopeResult): string | null => {
    const reason = refusedBy(result)
    return reason ? t('scope.hint.none', { reason: t(`scope.reason.${reason}`) }) : null
  }

  const onDragStart = (e: DragStartEvent) => {
    latest.current = { target: null, moved: false, asked: false, ...NOTHING_SAID }
    setSaid(NOTHING_SAID)
    const d = dragData(e.active.data.current)
    if (d) setActive({ id: String(e.active.id), data: d })
  }

  // Same computation as the drop, so the preview always shows what will be saved.
  // Also on drag over: the column under the pointer can change after the move event.
  const onDragMove = (e: DragMoveEvent | DragOverEvent) => {
    const d = dragData(e.active.data.current)
    if (!d) return
    const drop = dropData(e.over?.data.current)
    const next = dropResult(d, drop, e.delta.y)
    // FR-17: with one option, the drop of an event or repeat of a series won't ask; say
    // beforehand what it reaches, or why a repeat can't land here. Worked out again only for a
    // new target, not on every move of the pointer.
    const says = sameDrop(latest.current.target, next) ? latest.current : dropSays(d, next)
    latest.current = {
      ...latest.current,
      target: next,
      moved: latest.current.moved || next !== null,
      hint: says.hint,
      limit: says.limit,
    }
    setTarget((prev) => (sameDrop(prev, next) ? prev : next))
    setSaid((prev) => (prev.hint === says.hint && prev.limit === says.limit ? prev : { hint: says.hint, limit: says.limit }))
  }

  // The create popover's entry takes the times instead of saving them, and a move takes the
  // popover along to the entry's slot in the column it lands in (FR-09).
  const dropDraft = (d: DragData, result: DropResult, drop: DropData | null) => {
    const moved = withDrop(d, result).event
    const column = d.type === 'timed' && drop?.type === 'column' ? drop : null
    const anchor = column?.ref?.current
    const segment = column && timedSegments([moved], column.day)[0]
    setCreateWhen(
      draggedWhen(moved, tz),
      anchor && segment ? { anchor, span: { startMin: segment.startMin, endMin: segment.endMin } } : undefined,
    )
  }

  const onDragEnd = (e: DragEndEvent) => {
    setActive(null)
    setTarget(null)
    setSaid(NOTHING_SAID)
    const d = dragData(e.active.data.current)
    if (!d) return
    const drop = dropData(e.over?.data.current)
    const result = dropResult(d, drop, e.delta.y)
    if (d.type !== 'event' && d.draft) {
      if (result) dropDraft(d, result, drop)
      return
    }
    // Where the drop ended, for the question to point at while the tile isn't shown.
    const r = e.active.rect.current.translated ?? e.active.rect.current.initial
    const at = r ? new DOMRect(r.left, r.top, r.width, r.height) : new DOMRect()
    if (result?.kind === 'event') {
      // FR-17: an event of a series asks which events move before anything is saved, but only
      // when there is a choice; the one thing it can do, it does right away. An invitation to one
      // event of a series (an override without its series) is a single event to Lucid.
      const change = d.type === 'resize'
      const scopes = dropScopes(d, result, tz)
      const [only] = scopes.options
      if (scopes.options.length > 1) {
        latest.current.asked = true
        setAnchor(null)
        setReach(null)
        setAsking({ kind: 'event', event: result.event, ...result.times, change, ...scopes, at })
      } else if (only) {
        saveScope(only, { event: result.event, ...result.times, change })
      } else {
        move.mutate({ event: result.event, ...result.times })
        // Detached like a task's update below, so a series' scope can't change under it.
        move.reset()
      }
    }
    if (result?.kind === 'task') {
      // FR-17: a repeat of a task series asks the same, where there is a choice. A repeat no
      // option moves here stays where it was and says why; a task that does not repeat, and the
      // last repeat, move as they are.
      const taskMove = taskDrop(result)
      const refused = taskMove && refusedBy(taskMove)
      latest.current.limit = taskMove && refusal(taskMove)
      const [only] = taskMove?.options ?? []
      if (refused) {
        toast.message(t('dnd.notMoved'), { description: t(`scope.reason.${refused}`) })
      } else if (taskMove && taskMove.options.length > 1) {
        latest.current.asked = true
        setAnchor(null)
        setReach(null)
        setAsking({ kind: 'task', ...taskMove, at })
      } else if (taskMove && only) {
        saveTaskScope(only, taskMove)
      } else {
        updateTodo.mutate({ todo: result.task.todo, input: result.input })
        // A pending mutation takes over its hook's next options, which lose the scope once
        // `active` is cleared; detached, it stays in line. Errors still reach the hook's handler.
        updateTodo.reset()
      }
    }
  }

  // Closing the question cancels it: by Cancel, Escape or a press beside it. Calling it twice
  // (the question's own Escape and the popover's) changes nothing more.
  const cancelScope = () => {
    setAsking(null)
    setReach(null)
  }

  // "Only this event" moves the event optimistically (NFR-26); "This and following events" splits
  // the series there and "All events" moves it, both showing its saving state until it is
  // reloaded. Each is detached from its hook right away, like a task's drop: the series' scope
  // goes with the question.
  function saveScope(scope: Scope, vars: MoveVars) {
    const { event, start, end } = vars
    switch (scope) {
      case 'this': {
        const key = event.key
        setHeld({ kind: 'event', key, id: event.id, from: event.recurrenceId ?? '', start, end, reach: 'this' })
        // A detached mutation tells only its own promise that it has settled.
        const release = () => {
          setHeld((h) => (h?.key === key ? null : h))
        }
        moveOccurrence.mutateAsync(vars).then(release, release)
        moveOccurrence.reset()
        break
      }
      case 'following':
        moveFollowing.mutate(vars)
        moveFollowing.reset()
        break
      case 'all':
        move.mutate(vars)
        move.reset()
        break
    }
  }

  // "Only this repeat" detaches the repeat, held at its drop until the detached task is in
  // (NFR-26); "This and following repeats" splits the series at it with its new dates, and "All
  // repeats" moves the series as far as the repeat moved. Neither of these is optimistic for the
  // repeats: the series shows its saving state until it is reloaded. Each is detached from its
  // hook right away, like the events' (FR-17).
  function saveTaskScope(scope: Scope, { task, repeat, input, to }: TaskMove) {
    const { todo } = repeat
    // The series' values with the repeat's new dates.
    const moved = todoToInput(todo, {
      start: to.start ?? null,
      startAllDay: to.startAllDay,
      due: to.due ?? null,
      dueAllDay: to.dueAllDay,
    })
    switch (scope) {
      case 'this': {
        const key = task.key
        setHeld({ kind: 'task', key, id: todo.id, from: repeat.recurrenceId, to, reach: 'this' })
        const release = () => {
          setHeld((h) => (h?.key === key ? null : h))
        }
        detachTodo.mutateAsync({ todo, repeat, input: moved, moved: true }).then(release, release)
        detachTodo.reset()
        break
      }
      case 'following':
        todoFollowing.mutate({ todo, repeat, input: moved, moved: true })
        todoFollowing.reset()
        break
      case 'all':
        updateTodo.mutate({
          todo,
          input,
          byUpcoming: repeat.at === 'upcoming',
          look: { slots: taskGlyphSlots('all', repeat.at) },
        })
        updateTodo.reset()
        break
    }
  }

  const chooseScope = (scope: Scope) => {
    if (!asking) return
    if (asking.kind === 'task') {
      saveTaskScope(scope, asking)
    } else {
      const { event, start, end, change } = asking
      saveScope(scope, { event, start, end, change })
    }
    cancelScope()
  }

  const preview = useMemo(
    () => (active && target ? withDrop(active.data, target) : (active?.data ?? null)),
    [active, target],
  )
  // Stays null while moving, so the context (read by every event) only changes on resize.
  const resize = preview?.type === 'resize' ? preview.event : null
  const scope = useMemo((): ScopePreview | null => {
    if (!asking) return null
    if (asking.kind === 'task') {
      const { task, repeat, to } = asking
      return { kind: 'task', key: task.key, id: repeat.todo.id, from: repeat.recurrenceId, to, reach }
    }
    const { event, start, end } = asking
    return { kind: 'event', key: event.key, id: event.id, from: event.recurrenceId ?? '', start, end, reach }
  }, [asking, reach])
  const state = useMemo(
    () => ({
      pendingKeys,
      pendingSeries,
      pendingTodos,
      resize,
      activeId: active?.id ?? null,
      scope,
      held,
      scopeAnchor,
    }),
    [pendingKeys, pendingSeries, pendingTodos, resize, active, scope, held, scopeAnchor],
  )

  return (
    <DndStateContext value={state}>
      <DndContext
        sensors={sensors}
        collisionDetection={collision}
        modifiers={[snapTimed]}
        accessibility={{ announcements, screenReaderInstructions: { draggable: t('dnd.instructions') } }}
        onDragStart={onDragStart}
        onDragMove={onDragMove}
        onDragOver={onDragMove}
        onDragEnd={onDragEnd}
        onDragCancel={() => {
          setActive(null)
          setTarget(null)
          setSaid(NOTHING_SAID)
        }}
      >
        {children}
        <DragOverlay dropAnimation={null}>
          {preview && preview.type !== 'resize' ? renderOverlay(preview, said.limit, said.hint) : null}
        </DragOverlay>
      </DndContext>
      {asking && (
        <ScopeQuestion asking={asking} anchor={anchor} onChoose={chooseScope} onCancel={cancelScope} onPreview={setReach} />
      )}
    </DndStateContext>
  )
}
