import { type ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * The ink pill beneath a drag overlay (FR-17): it says which events or repeats of a series a drop reaches when there
 * is no choice, and, beneath a dragged task's repeat, why no option moves it where it is. Styled like a tooltip.
 */
export const LIMIT_PILL =
  'w-max max-w-80 rounded-md border-0 bg-foreground px-2.5 py-1.5 text-xs font-medium text-background shadow-float'

/**
 * The reason or the reach of the drop beneath the drag overlay. Hidden from screen readers, which
 * hear the same words from the drag's announcements (NFR-27).
 */
export function LimitPill({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p aria-hidden className={cn(LIMIT_PILL, 'animate-in fade-in-0', className)}>
      {children}
    </p>
  )
}
