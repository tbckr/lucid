export interface Box {
  x: number
  y: number
  width: number
  height: number
}

// Width of the details popover: 24rem, at most the view less 1rem on each side.
const detailWidth = (viewWidth: number) => Math.min(384, viewWidth - 32)

// Side offset (6) and collision padding (12) of the popover.
const GAP = 18
// About the first line of a block or an agenda row.
const FIRST_LINE = 40

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))

/**
 * Where the details popover opens (FR-09). Beside the event when there is
 * room on either side (Radix picks the side). An event as wide as the view
 * (day view, agenda, phones) leaves no room beside it: the popover opens
 * below its first line then, or above it near the bottom, and the event's
 * title stays visible.
 */
export function detailPlacement(
  anchor: Box,
  view: { width: number; height: number },
): { side: 'right' | 'bottom'; rect: Box } {
  const need = detailWidth(view.width) + GAP
  if (view.width - (anchor.x + anchor.width) >= need || anchor.x >= need) return { side: 'right', rect: anchor }
  const top = clamp(anchor.y, 0, view.height)
  const bottom = clamp(Math.min(anchor.y + anchor.height, top + FIRST_LINE), top, view.height)
  const left = clamp(anchor.x, 0, view.width)
  const right = clamp(anchor.x + anchor.width, left, view.width)
  return { side: 'bottom', rect: { x: left, y: top, width: right - left, height: bottom - top } }
}

/**
 * The anchor's box, or the last one it had once it has left the page: a task
 * completed while completed tasks are hidden in the calendar, or an event gone
 * after a reload. The popover stays where it was instead of jumping to the corner.
 */
export function lastKnownBox(anchor: { isConnected: boolean; getBoundingClientRect: () => Box }): () => Box {
  let last: Box | null = null
  return () => {
    if (anchor.isConnected || !last) last = anchor.getBoundingClientRect()
    return last
  }
}
