import { useEffect, useRef, useState, type ButtonHTMLAttributes, type MouseEvent, type PointerEvent } from 'react'
import { DRAG_DISTANCE } from '@/lib/dnd'

/** How long the hint stays after the release, so it can still be read. */
const LINGER_MS = 2000

/**
 * A press-and-drag on an upcoming repeat that can't move (FR-17): where the
 * hint shows, and the handlers for the item's title button.
 */
export interface RepeatDragHint {
  /** The item the hint shows at; null while it is hidden. */
  at: HTMLElement | null
  /** Still pressed after the pointer has travelled a drag's distance: the button shows `cursor-not-allowed`. */
  attempting: boolean
  /** Hides the hint right away, for the popover's own dismissal. */
  hide: () => void
  props: Pick<
    ButtonHTMLAttributes<HTMLButtonElement>,
    'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel' | 'onClickCapture'
  >
}

interface Gesture {
  pointerId: number
  x: number
  y: number
  /** `attempted`: travelled a drag's distance; the click that ends it is swallowed. */
  phase: 'pressed' | 'attempted'
}

/**
 * Explains why an upcoming repeat can't be dragged once someone tries (FR-17):
 * the same gesture as a drag (`DRAG_DISTANCE`, mouse or pen, primary button),
 * shown while pressed and for `LINGER_MS` after. The release opens nothing:
 * with the pointer captured, its click lands on the item, where it is
 * swallowed. Inert while `enabled` is false.
 */
export function useRepeatDragHint(enabled: boolean): RepeatDragHint {
  const [at, setAt] = useState<HTMLElement | null>(null)
  const [attempting, setAttempting] = useState(false)
  const gesture = useRef<Gesture | null>(null)
  const swallow = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => clearTimeout(timer.current), [])

  const hide = () => {
    clearTimeout(timer.current)
    setAt(null)
  }
  const reset = () => {
    gesture.current = null
    setAttempting(false)
  }

  if (!enabled) return { at: null, attempting: false, hide, props: {} }
  return {
    at,
    attempting,
    hide,
    props: {
      onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
        swallow.current = false
        if (e.pointerType === 'touch' || e.button !== 0) return
        // Keeps the moves and the release on the item while the pointer leaves it.
        e.currentTarget.setPointerCapture(e.pointerId)
        gesture.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, phase: 'pressed' }
      },
      onPointerMove: (e: PointerEvent<HTMLButtonElement>) => {
        const g = gesture.current
        if (g?.pointerId !== e.pointerId || g.phase === 'attempted') return
        if (Math.hypot(e.clientX - g.x, e.clientY - g.y) < DRAG_DISTANCE) return
        g.phase = 'attempted'
        clearTimeout(timer.current)
        setAt(e.currentTarget)
        setAttempting(true)
      },
      onPointerUp: (e: PointerEvent<HTMLButtonElement>) => {
        const g = gesture.current
        if (g?.pointerId !== e.pointerId) return
        if (g.phase === 'attempted') {
          swallow.current = true
          timer.current = setTimeout(() => {
            // A click that never came (released elsewhere) mustn't swallow a later one, e.g. by keyboard.
            swallow.current = false
            setAt(null)
          }, LINGER_MS)
        }
        reset()
      },
      onPointerCancel: () => {
        reset()
        hide()
      },
      onClickCapture: (e: MouseEvent<HTMLButtonElement>) => {
        if (!swallow.current) return
        swallow.current = false
        // Neither the details nor, further up, the cell's new entry.
        e.preventDefault()
        e.stopPropagation()
      },
    },
  }
}
