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
import { useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { MOVE_EVENT_KEY, useMoveEvent, type MoveVars } from '@/hooks/queries'
import { usePrefs } from '@/hooks/usePrefs'
import { acceptsDrop, dropResult, SNAP_PX, type DragData, type DropData } from '@/lib/dnd'
import { withTimes } from '@/lib/events'
import { formatEventSpan } from '@/lib/format'
import { DndStateContext } from './dndState'

function dragData(data: unknown): DragData | null {
  return data && typeof data === 'object' && 'type' in data ? (data as DragData) : null
}
function dropData(data: unknown): DropData | null {
  return data && typeof data === 'object' && 'type' in data ? (data as DropData) : null
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
  const move = useMoveEvent()
  const [active, setActive] = useState<{ id: string; data: DragData } | null>(null)
  /** What a drop right now would save; null while it would change nothing. */
  const [target, setTarget] = useState<{ start: string; end: string } | null>(null)
  // The same for the announcements, which dnd-kit calls right after our handlers, before
  // `target` re-renders. `moved`: the drag has had a target since the pick-up.
  const latest = useRef<{ target: { start: string; end: string } | null; moved: boolean }>({ target: null, moved: false })

  const pending = useMutationState({
    filters: { mutationKey: MOVE_EVENT_KEY, status: 'pending' },
    select: (m) => (m.state.variables as MoveVars | undefined)?.event,
  })
  const pendingKeys = useMemo(
    () => new Set(pending.flatMap((e) => (e?.recurring ? [e.key] : []))),
    [pending],
  )

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
    // The target time for screen readers (NFR-27), like the preview shows it.
    const announceTarget: Announcements['onDragOver'] = ({ active: a, over }) => {
      const d = dragData(a.data.current)
      if (!d) return undefined
      const { target: next, moved } = latest.current
      if (next) return t('dnd.over', { time: formatEventSpan(withTimes(d.event, next), prefs, t('event.allDay')) })
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
      onDragEnd: ({ over }) => (over ? t('dnd.dropped') : t('dnd.cancelled')),
      onDragCancel: () => t('dnd.cancelled'),
    }
  }, [t, prefs])

  const onDragStart = (e: DragStartEvent) => {
    latest.current = { target: null, moved: false }
    const d = dragData(e.active.data.current)
    if (d) setActive({ id: String(e.active.id), data: d })
  }

  // Same computation as the drop, so the preview always shows what will be saved.
  // Also on drag over: the column under the pointer can change after the move event.
  const onDragMove = (e: DragMoveEvent | DragOverEvent) => {
    const d = dragData(e.active.data.current)
    if (!d) return
    const next = dropResult(d, dropData(e.over?.data.current), e.delta.y)
    latest.current = { target: next, moved: latest.current.moved || next !== null }
    setTarget((prev) => (prev?.start === next?.start && prev?.end === next?.end ? prev : next))
  }

  const onDragEnd = (e: DragEndEvent) => {
    setActive(null)
    setTarget(null)
    const d = dragData(e.active.data.current)
    if (!d) return
    const result = dropResult(d, dropData(e.over?.data.current), e.delta.y)
    if (result) move.mutate({ event: d.event, ...result })
  }

  const preview = useMemo(
    () => (active && target ? { ...active.data, event: withTimes(active.data.event, target) } : (active?.data ?? null)),
    [active, target],
  )
  // Stays null while moving, so the context (read by every event) only changes on resize.
  const resize = preview?.type === 'resize' ? preview.event : null
  const state = useMemo(() => ({ pendingKeys, resize, activeId: active?.id ?? null }), [pendingKeys, resize, active])

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
    </DndStateContext>
  )
}
