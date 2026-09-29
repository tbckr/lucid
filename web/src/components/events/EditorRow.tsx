import { type ReactNode } from 'react'

// Optional text fields read as plain text until hovered or focused, like the details popover.
export const quietField = '-ml-2 w-[calc(100%+0.5rem)] border-transparent bg-transparent px-2 hover:border-input'

/**
 * Fields on a calendar's tint (the create popover): text in the tint's color
 * with an outline on hover and focus, always faintly where there is no hover.
 */
export const onTint =
  'h-8 border-transparent bg-transparent px-1.5 text-base font-medium text-current shadow-none hover:border-current/25 hover:bg-transparent focus-visible:border-current/50 focus-visible:ring-current/30 pointer-coarse:border-current/15 dark:bg-transparent'

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
