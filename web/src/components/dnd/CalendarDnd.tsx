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
  type DragStartEvent,
  type KeyboardCoordinateGetter,
  type Modifier,
} from '@dnd-kit/core'
import { useMutationState } from '@tanstack/react-query'
import { useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { MOVE_EVENT_KEY, useMoveEvent, type MoveVars } from '@/hooks/queries'
import { acceptsDrop, dropResult, SNAP_PX, type DragData, type DropData } from '@/lib/dnd'
import { snapMinutes } from '@/lib/dates'
import { PX_PER_MINUTE } from '@/lib/dnd'
import { DndStateContext, type DndState } from './dndState'

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
  const move = useMoveEvent()
  const [active, setActive] = useState<{ id: string; data: DragData } | null>(null)
  const [resize, setResize] = useState<DndState['resize']>(null)

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
    }),
  )

  const announcements: Announcements = useMemo(
    () => ({
      onDragStart: ({ active: a }) => {
        const d = dragData(a.data.current)
        return d ? t('dnd.picked', { title: d.event.title || t('event.untitled') }) : ''
      },
      onDragOver: ({ over }) => (over ? t('dnd.over') : t('dnd.notOver')),
      onDragEnd: ({ over }) => (over ? t('dnd.dropped') : t('dnd.cancelled')),
      onDragCancel: () => t('dnd.cancelled'),
    }),
    [t],
  )

  const onDragStart = (e: DragStartEvent) => {
    const d = dragData(e.active.data.current)
    if (d) setActive({ id: String(e.active.id), data: d })
  }

  const onDragMove = (e: DragMoveEvent) => {
    const d = dragData(e.active.data.current)
    if (d?.type === 'resize') setResize({ key: d.event.key, minutes: snapMinutes(e.delta.y / PX_PER_MINUTE) })
  }

  const onDragEnd = (e: DragEndEvent) => {
    setActive(null)
    setResize(null)
    const d = dragData(e.active.data.current)
    if (!d) return
    const result = dropResult(d, dropData(e.over?.data.current), e.delta.y)
    if (result) move.mutate({ event: d.event, ...result })
  }

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
        onDragEnd={onDragEnd}
        onDragCancel={() => {
          setActive(null)
          setResize(null)
        }}
      >
        {children}
        <DragOverlay dropAnimation={null}>
          {active && active.data.type !== 'resize' ? renderOverlay(active.data) : null}
        </DragOverlay>
      </DndContext>
    </DndStateContext>
  )
}
