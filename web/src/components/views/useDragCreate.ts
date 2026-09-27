import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { createRange, PX_PER_MINUTE } from '@/lib/dnd'

/** Pointer travel before a press becomes a drag, as for moving events. */
const DRAG_DISTANCE = 6

interface Gesture {
  pointerId: number
  x: number
  y: number
  anchorMin: number
  /** `done`: dragged, then released or cancelled; the click that follows is swallowed. */
  phase: 'pressed' | 'dragging' | 'done'
}

export interface Draft {
  startMin: number
  endMin: number
}

/** Minutes since midnight under the pointer, for a handler on the slot of `hour`. */
function minuteAt(hour: number, e: PointerEvent<HTMLElement>): number {
  return hour * 60 + (e.clientY - e.currentTarget.getBoundingClientRect().top) / PX_PER_MINUTE
}

/**
 * Create events from the hour slots of a time-grid column: a click takes the
 * whole hour, a drag with mouse or pen the slots it covers (touch scrolls).
 * `draft` is the span to preview while dragging; Escape cancels.
 */
export function useDragCreate(onCreate: (startMin: number, endMin: number) => void) {
  const gesture = useRef<Gesture | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const dragging = draft !== null

  useEffect(() => {
    if (!dragging) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !gesture.current) return
      gesture.current.phase = 'done'
      setDraft(null)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [dragging])

  const slotProps = (hour: number) => ({
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      gesture.current = null
      if (e.pointerType === 'touch' || e.button !== 0) return
      // Keeps the moves coming while the pointer crosses events or leaves the column.
      e.currentTarget.setPointerCapture(e.pointerId)
      gesture.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, anchorMin: minuteAt(hour, e), phase: 'pressed' }
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      const g = gesture.current
      if (g?.pointerId !== e.pointerId || g.phase === 'done') return
      if (g.phase === 'pressed' && Math.hypot(e.clientX - g.x, e.clientY - g.y) < DRAG_DISTANCE) return
      g.phase = 'dragging'
      const next = createRange(g.anchorMin, minuteAt(hour, e))
      setDraft((prev) => (prev?.startMin === next.startMin && prev.endMin === next.endMin ? prev : next))
    },
    onPointerUp: (e: PointerEvent<HTMLElement>) => {
      const g = gesture.current
      if (g?.pointerId !== e.pointerId) return
      if (g.phase === 'pressed') {
        gesture.current = null
        return
      }
      if (g.phase === 'dragging') {
        const { startMin, endMin } = createRange(g.anchorMin, minuteAt(hour, e))
        onCreate(startMin, endMin)
      }
      g.phase = 'done'
      setDraft(null)
    },
    onPointerCancel: () => {
      gesture.current = null
      setDraft(null)
    },
    onClick: () => {
      if (gesture.current?.phase === 'done') {
        gesture.current = null
        return
      }
      onCreate(hour * 60, hour * 60 + 60)
    },
  })

  return { draft, slotProps }
}
