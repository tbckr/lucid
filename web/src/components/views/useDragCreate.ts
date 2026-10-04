import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react'
import { createRange, DRAG_DISTANCE, PX_PER_MINUTE } from '@/lib/dnd'

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
function minuteAt(hour: number, e: MouseEvent<HTMLElement>): number {
  return hour * 60 + (e.clientY - e.currentTarget.getBoundingClientRect().top) / PX_PER_MINUTE
}

/**
 * Create events from the hour slots of a time-grid column: a click starts a
 * one-hour event in the 15-minute slot under the pointer, a drag with mouse or
 * pen covers the slots it crosses (touch scrolls). `draft` is the span to
 * preview while dragging; Escape cancels. `onCreate` gets the slot the
 * gesture ended on and whether it was a drag.
 */
export function useDragCreate(
  onCreate: (startMin: number, endMin: number, source: { target: HTMLElement; ranged: boolean }) => void,
) {
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
        onCreate(startMin, endMin, { target: e.currentTarget, ranged: true })
      }
      g.phase = 'done'
      setDraft(null)
    },
    onPointerCancel: () => {
      gesture.current = null
      setDraft(null)
    },
    onClick: (e: MouseEvent<HTMLElement>) => {
      if (gesture.current?.phase === 'done') {
        gesture.current = null
        return
      }
      // Within the clicked hour: assistive tech clicks without a pointer position (clientY 0)
      // and gets the hour the slot's label names.
      const min = Math.min(hour * 60 + 59, Math.max(hour * 60, minuteAt(hour, e)))
      // The slot a drag from here would start in.
      const { startMin } = createRange(min, min)
      onCreate(startMin, startMin + 60, { target: e.currentTarget, ranged: false })
    },
  })

  return { draft, slotProps }
}
