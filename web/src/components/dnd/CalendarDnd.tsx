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
import { ScopeChoice, type Scope } from '@/components/events/ScopeChoice'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import {
  MOVE_EVENT_KEY,
  usePendingSeries,
  useMoveEvent,
  useMoveOccurrence,
  useUpdateTodo,
  type MoveVars,
} from '@/hooks/queries'
import { useCalendarColors } from '@/hooks/useCalendarColors'
import { usePrefs } from '@/hooks/usePrefs'
import { moveWindow as windowOfTask } from '@/lib/calendarTasks'
import {
  acceptsDrop,
  dropBlocked,
  dropResult,
  SNAP_PX,
  withDrop,
  type DragData,
  type DropBlocked,
  type DropData,
  type DropResult,
  type ScopePreview,
} from '@/lib/dnd'
import { type CalEvent } from '@/lib/events'
import { formatEventSpan, formatPickerDate } from '@/lib/format'
import { timedSegments } from '@/lib/layout'
import { browserTimeZone } from '@/lib/locale'
import { draggedWhen } from '@/lib/quickCreate'
import { canMoveAll } from '@/lib/seriesShift'
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

/**
 * Whether a drop of `e` asks which events move first (FR-17): an event of a
 * series does. An invitation to one event of a series (an override without
 * its series) is a single event to Lucid and moves right away.
 */
function asksScope(e: CalEvent): boolean {
  return e.recurring && !!e.recurrenceId
}

/** A dropped event of a series waiting for the answer which events move (FR-17). */
interface Asking extends MoveVars {
  /** Its length was changed rather than the event moved. */
  change: boolean
  /** Where the drop ended, for the question to point at while the event's tile isn't shown. */
  at: DOMRect
}

/** The tile of the event `key` in the views, to give the focus back to (NFR-27). */
function tileOf(key: string): HTMLElement | undefined {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-event-key]')).find((el) => el.dataset.eventKey === key)
}

/**
 * The question after dropping an event of a series (FR-10, FR-17): a
 * popover at the event's tile at its new place, with its calendar's color
 * bar. Focus goes back to the tile once it closes (NFR-27).
 */
function ScopeQuestion({
  asking,
  anchor,
  tz,
  onChoose,
  onCancel,
  onPreview,
}: {
  asking: Asking
  anchor: HTMLElement | null
  /** The browser's time zone, for a series without one of its own. */
  tz: string
  onChoose: (scope: Scope) => void
  onCancel: () => void
  onPreview: (scope: Scope | null) => void
}) {
  const { t } = useTranslation()
  const colorsOf = useCalendarColors()
  const { event, start, change, at } = asking
  // The tile at the event's new place; while none is on the page (a full month cell), where the
  // drop ended. floating-ui follows the scrolling of the tile's ancestors through `contextElement`.
  const virtualRef = useMemo(
    () => ({
      current: {
        getBoundingClientRect: () => (anchor?.isConnected ? anchor.getBoundingClientRect() : at),
        contextElement: anchor ?? undefined,
      },
    }),
    [anchor, at],
  )
  return (
    <>
      <PopoverAnchor virtualRef={virtualRef} />
      <PopoverContent
        // The question itself is the alertdialog (NFR-27); the popover around it is no second, unnamed dialog.
        role={undefined}
        align="start"
        className="w-[min(24rem,calc(100vw-2rem))] border-l-4"
        style={{ borderLeftColor: colorsOf(event.calendarId).solid }}
        // ScopeChoice focuses its default choice itself.
        onOpenAutoFocus={(e) => {
          e.preventDefault()
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault()
          // Back to the event, wherever the answer put it, unless a press beside the question
          // has given the focus to something else.
          const focused = document.activeElement
          if (focused && focused !== document.body) return
          tileOf(event.key)?.focus()
        }}
      >
        <ScopeChoice
          question={change ? t('event.scope.change') : t('event.scope.move')}
          note={t('event.scope.pastIncluded')}
          allowAll={canMoveAll(event, new Date(start), tz)}
          onChoose={onChoose}
          onCancel={onCancel}
          onPreview={onPreview}
        />
      </PopoverContent>
    </>
  )
}

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
  renderOverlay: (data: DragData) => ReactNode
}) {
  const { t } = useTranslation()
  const prefs = usePrefs()
  const now = useMemo(() => new Date(), [])
  const tz = useMemo(() => browserTimeZone(), [])
  const setCreateWhen = useUi((s) => s.setCreateWhen)
  const [active, setActive] = useState<{ id: string; data: DragData } | null>(null)
  // In line with the other updates of the dragged task, so none conflicts with another
  // (FR-16). The scope is the one of the last render, which the pick-up has caused.
  const draggedTask = active?.data.event.kind === 'task' ? active.data.event.todo.id : undefined
  const updateTodo = useUpdateTodo(draggedTask)
  // The move window of the dragged task, fixed for the whole drag (FR-17): blocks days
  // outside it and bounds the drop, regardless of where the pointer currently is. Memoized so
  // the context below only changes on an actual pick-up/drop, not on every render.
  const moveWindow = useMemo(
    () => (active?.data.event.kind === 'task' ? windowOfTask(active.data.event.todo) : null),
    [active],
  )
  /** What a drop right now would save; null while it would change nothing. */
  const [target, setTarget] = useState<DropResult | null>(null)
  // The same for the announcements, which dnd-kit calls right after our handlers, before
  // `target` re-renders. `moved`: the drag has had a target since the pick-up. `blocked`: which
  // edge of a bounded series' window the current drop would cross (FR-17). `asked`: the drop
  // asks which events of a series move (FR-17).
  const latest = useRef<{ target: DropResult | null; moved: boolean; blocked: DropBlocked | null; asked: boolean }>({
    target: null,
    moved: false,
    blocked: null,
    asked: false,
  })

  // FR-17: a dropped event of a series waits for the answer which events move, shown at its new
  // place meanwhile. `all`: "All events" has the focus or the pointer, which rings the series.
  const [asking, setAsking] = useState<Asking | null>(null)
  const [all, setAll] = useState(false)
  // The moves of a series run one after another, each with the ETag the one before got
  // (FR-17): the series of the event the question asks about, or else of the dragged one.
  const moving = asking?.event ?? (active?.data.event.kind === 'event' ? active.data.event : undefined)
  const series = moving?.recurring ? moving.id : undefined
  const move = useMoveEvent(series)
  const moveOccurrence = useMoveOccurrence(series)
  // "Only this event" until its move settles: keeps the event at its new place until the
  // optimistic update is in, instead of jumping back for a moment (NFR-26).
  const [held, setHeld] = useState<ScopePreview | null>(null)
  // The tile of the asking event, which the question points at; a tile that moves takes over
  // from the one it replaces.
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const scopeAnchor = useCallback((el: HTMLElement | null) => {
    if (el) setAnchor(el)
  }, [])

  const pending = useMutationState({
    filters: { mutationKey: MOVE_EVENT_KEY, status: 'pending' },
    select: (m) => (m.state.variables as MoveVars | undefined)?.event,
  })
  const pendingKeys = useMemo(
    () => new Set(pending.flatMap((e) => (e?.recurring ? [e.key] : []))),
    [pending],
  )
  // Recurring todos with a task update on the way (FR-17): busy and not draggable until reloaded.
  const pendingTodos = usePendingSeries()

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: keyboardCoordinates,
      keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space', 'Enter'] },
      // Past the middle of the grid, a move scrolls it instead. A smooth scroll would
      // swallow key presses (a held arrow key) that come before it has finished.
      scrollBehavior: 'auto',
    }),
  )

  const announcements: Announcements = useMemo(() => {
    // Which edge of a bounded series' move window (FR-17) blocked the drop, in words.
    const limitMessage = (blocked: DropBlocked) =>
      blocked.edge === 'until'
        ? t('dnd.limit', { date: formatPickerDate(blocked.date, prefs, now) })
        : t('dnd.limitFrom', { date: formatPickerDate(blocked.date, prefs, now) })
    // The target time for screen readers (NFR-27), like the preview shows it.
    const announceTarget: Announcements['onDragOver'] = ({ active: a, over }) => {
      const d = dragData(a.data.current)
      if (!d) return undefined
      const { target: next, moved, blocked } = latest.current
      if (next) return t('dnd.over', { time: formatEventSpan(withDrop(d, next).event, prefs, t('event.allDay')) })
      // A bounded series (FR-17) can't move here: say why instead of "unchanged".
      if (blocked) return limitMessage(blocked)
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
        // A bounded series (FR-17) dropped past its next occurrence saves nothing: say why,
        // instead of falsely announcing a move (NFR-27).
        const { blocked, asked } = latest.current
        if (blocked) return limitMessage(blocked)
        // Nothing has moved yet: the question asks first, about a change after a resize (FR-17, NFR-27).
        const d = dragData(a.data.current)
        if (asked) return d?.type === 'resize' ? t('dnd.chooseScopeChange') : t('dnd.chooseScope')
        return d?.event.kind === 'task' ? t('dnd.taskDropped') : t('dnd.dropped')
      },
      onDragCancel: () => t('dnd.cancelled'),
    }
  }, [t, prefs, now])

  const onDragStart = (e: DragStartEvent) => {
    latest.current = { target: null, moved: false, blocked: null, asked: false }
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
    const blocked = dropBlocked(d, drop, e.delta.y)
    latest.current = { ...latest.current, target: next, moved: latest.current.moved || next !== null, blocked }
    setTarget((prev) => (sameDrop(prev, next) ? prev : next))
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
    const d = dragData(e.active.data.current)
    if (!d) return
    const drop = dropData(e.over?.data.current)
    const result = dropResult(d, drop, e.delta.y)
    if (d.type !== 'event' && d.draft) {
      if (result) dropDraft(d, result, drop)
      return
    }
    if (result?.kind === 'event') {
      if (asksScope(result.event)) {
        // FR-17: asks which events move before anything is saved.
        const r = e.active.rect.current.translated ?? e.active.rect.current.initial
        latest.current.asked = true
        setAnchor(null)
        setAll(false)
        setAsking({
          event: result.event,
          ...result.times,
          change: d.type === 'resize',
          at: r ? new DOMRect(r.left, r.top, r.width, r.height) : new DOMRect(),
        })
      } else {
        move.mutate({ event: result.event, ...result.times })
        // Detached like a task's update below, so a series' scope can't change under it.
        move.reset()
      }
    }
    if (result?.kind === 'task') {
      const byUpcoming = result.task.occurrence?.state === 'upcoming'
      updateTodo.mutate({ todo: result.task.todo, input: result.input, byUpcoming })
      // A pending mutation takes over its hook's next options, which lose the scope once
      // `active` is cleared; detached, it stays in line. Errors still reach the hook's handler.
      updateTodo.reset()
    }
  }

  // Closing the question cancels it: by Cancel, Escape or a press beside it. Calling it twice
  // (the question's own Escape and the popover's) changes nothing more.
  const cancelScope = () => {
    setAsking(null)
    setAll(false)
  }

  // "Only this event" moves the event optimistically (NFR-26); "All events" moves the series and
  // shows its saving state until it is reloaded. Either is detached from its hook right away, like
  // a task's drop: the series' scope goes with the question.
  const chooseScope = (scope: Scope) => {
    if (!asking) return
    const { event, start, end } = asking
    if (scope === 'this') {
      const key = event.key
      setHeld({ key, id: event.id, start, end, all: false })
      // A detached mutation tells only its own promise that it has settled.
      const release = () => {
        setHeld((h) => (h?.key === key ? null : h))
      }
      moveOccurrence.mutateAsync({ event, start, end }).then(release, release)
      moveOccurrence.reset()
    } else {
      move.mutate({ event, start, end })
      move.reset()
    }
    cancelScope()
  }

  const preview = useMemo(
    () => (active && target ? withDrop(active.data, target) : (active?.data ?? null)),
    [active, target],
  )
  // Stays null while moving, so the context (read by every event) only changes on resize.
  const resize = preview?.type === 'resize' ? preview.event : null
  const scope = useMemo(
    () =>
      asking ? { key: asking.event.key, id: asking.event.id, start: asking.start, end: asking.end, all } : null,
    [asking, all],
  )
  const state = useMemo(
    () => ({
      pendingKeys,
      pendingTodos,
      resize,
      moveWindow,
      activeId: active?.id ?? null,
      scope,
      held,
      scopeAnchor,
      draggedTodo: draggedTask ?? null,
    }),
    [pendingKeys, pendingTodos, resize, moveWindow, active, scope, held, scopeAnchor, draggedTask],
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
        }}
      >
        {children}
        <DragOverlay dropAnimation={null}>
          {preview && preview.type !== 'resize' ? renderOverlay(preview) : null}
        </DragOverlay>
      </DndContext>
      <Popover
        open={asking !== null}
        onOpenChange={(open) => {
          if (!open) cancelScope()
        }}
      >
        {asking && (
          <ScopeQuestion
            asking={asking}
            anchor={anchor}
            tz={tz}
            onChoose={chooseScope}
            onCancel={cancelScope}
            onPreview={(s) => {
              setAll(s === 'all')
            }}
          />
        )}
      </Popover>
    </DndStateContext>
  )
}
