import { type ReactNode } from 'react'

// Optional text fields read as plain text until hovered or focused, like the details popover.
export const quietField = '-ml-2 w-[calc(100%+0.5rem)] border-transparent bg-transparent px-2 hover:border-input'

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
