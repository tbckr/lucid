import { type ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * The ink pill that says why a repeating task can't move (FR-17): beneath the dragged task over a
 * day it can't reach, and at an upcoming repeat that someone tries to drag. Beneath a dragged event
 * of a series, it says which events the drop reaches when there is no choice. Styled like a tooltip.
 */
export const LIMIT_PILL =
  'w-max max-w-80 rounded-md border-0 bg-foreground px-2.5 py-1.5 text-xs font-medium text-background shadow-float'

/**
 * The limit, or the reach of the drop, beneath the drag overlay. Hidden from screen readers, which
 * hear the same words from the drag's announcements (NFR-27).
 */
export function LimitPill({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p aria-hidden className={cn(LIMIT_PILL, 'animate-in fade-in-0', className)}>
      {children}
    </p>
  )
}
