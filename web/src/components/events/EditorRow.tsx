import { type ReactNode } from 'react'
import { cn } from '@/lib/utils'

// Optional text fields read as plain text until hovered or focused, like the details popover.
export const quietField = '-ml-2 w-[calc(100%+0.5rem)] border-transparent bg-transparent px-2 hover:border-input'

/**
 * Fields on a calendar's tint (the create popover): text in the tint's color
 * with an outline on hover and focus, always faintly where there is no hover.
 */
export const onTint =
  'h-8 border-transparent bg-transparent px-1.5 text-base font-medium text-current shadow-none hover:border-current/25 hover:bg-transparent focus-visible:border-current/50 focus-visible:ring-current/30 pointer-coarse:border-current/15 dark:bg-transparent'

/**
 * Texts a typed field is at least as wide as, unseen below its text in a
 * column (`inline-flex flex-col`) the text stretches across (FR-09).
 * `className` gives them what the text's width depends on: its font, side
 * padding and side borders.
 */
export function FieldSizer({ texts, className }: { texts: string[]; className: string }) {
  return [...new Set(texts)].filter(Boolean).map((text) => (
    <span key={text} aria-hidden className={cn('invisible h-0 overflow-hidden whitespace-pre', className)}>
      {text}
    </span>
  ))
}

/** A row of the event and task editors, with its icon hanging in the left column as in the details popover. */
export function EditorRow({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[1.25rem_1fr] items-start gap-x-3">
      <span className="flex h-9 items-center text-muted-foreground [&_svg]:size-4" aria-hidden>
        {icon}
      </span>
      <div className="min-w-0">{children}</div>
    </div>
  )
}
