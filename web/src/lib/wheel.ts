/** The parts of a wheel event the month view reads. */
export interface WheelLike {
  deltaX: number
  deltaY: number
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
  timeStamp: number
}

/** Which ways the view's scroll container can still scroll. */
export interface ScrollRoom {
  up: boolean
  down: boolean
}

/** The months to step by, and whether to keep the browser from scrolling. */
export interface WheelStep {
  step: -1 | 0 | 1
  swallow: boolean
}

/**
 * A pause longer than this ends a gesture. A trackpad's momentum sends an
 * event every frame until it has run out, and a mouse wheel turned in one go
 * ticks well within it.
 */
const GESTURE_GAP_MS = 200

const none: WheelStep = { step: 0, swallow: false }

/**
 * Turns wheel events into month steps (FR-08): one step per gesture, so a
 * trackpad's momentum never skips a month. A month taller than its window
 * scrolls first; a gesture that scrolled it never steps, the next one at its
 * edge does. Zooming (Ctrl/Cmd), sideways scrolling and the other modifiers
 * stay the browser's.
 */
export function monthWheel(): (e: WheelLike, room: ScrollRoom) => WheelStep {
  let last = -Infinity
  let gesture: 'new' | 'scrolled' | 'stepped' = 'new'
  return (e, room) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return none
    if (e.timeStamp - last > GESTURE_GAP_MS) gesture = 'new'
    last = e.timeStamp
    // Sideways, it may be the browser's swipe back or forward.
    if (Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return none
    // The momentum of a step must not scroll the new month.
    if (gesture === 'stepped') return { step: 0, swallow: true }
    const dir = e.deltaY > 0 ? 1 : -1
    if (gesture === 'scrolled' || (dir > 0 ? room.down : room.up)) {
      gesture = 'scrolled'
      return none
    }
    gesture = 'stepped'
    return { step: dir, swallow: true }
  }
}

/** Zoomed displays scroll by fractions of a pixel and may stop just short of an end. */
export function scrollRoom(el: HTMLElement | null): ScrollRoom {
  if (!el) return { up: false, down: false }
  return { up: el.scrollTop >= 1, down: el.scrollHeight - el.clientHeight - el.scrollTop >= 1 }
}

/** The nearest ancestor of `el` that scrolls vertically, if any. */
export function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p)
    if (overflowY === 'auto' || overflowY === 'scroll') return p
  }
  return null
}
