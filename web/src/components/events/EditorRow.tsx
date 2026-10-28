import { ChevronDownIcon, XIcon } from 'lucide-react'
import { useRef, type ReactNode, type RefObject } from 'react'
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

/**
 * The end of a typed field that holds a value (FR-09): with `clearLabel`, a ✕
 * that removes the optional value; else the chevron of a required one, and on
 * the tint nothing. Both are targets of the pointer only, as the chevron of a
 * select is: the text beside them has the focus and takes the keyboard, which
 * opens with ArrowDown and removes by emptying the text (NFR-27). The ✕ is a
 * named button all the same, for screen readers; on the tint it shows with the
 * field's outline, on hover or focus, and always where there is no hover. A
 * press keeps the focus where it is, and neither acts while a prop or a
 * fieldset around disables the field (FR-17). The field's anchor is
 * `group/field`.
 *
 * The ✕ removes, then hands the focus to the text, which says the value is
 * gone, unless a touch or a pen pressed it: a focus from a tap raises the
 * on-screen keyboard, which a removal doesn't need.
 */
export function FieldEnd({
  input,
  clearLabel,
  onClear,
  onOpen,
  tint,
}: {
  /** The field's text, checked for `:disabled` and focused after a removal. */
  input: RefObject<HTMLInputElement | null>
  /** Name of the ✕, e.g. "Remove due date"; without it the end is the chevron. */
  clearLabel?: string | undefined
  /** Removes the value; the ✕'s click, before the focus goes to the text. */
  onClear: () => void
  /** Opens the popup; the chevron's click. */
  onOpen: () => void
  tint?: boolean
}) {
  // How the ✕ was pressed, for its click: none for a click assistive technology sends without a press.
  const pressedBy = useRef<string | null>(null)
  if (clearLabel !== undefined) {
    return (
      <button
        type="button"
        tabIndex={-1}
        aria-label={clearLabel}
        title={clearLabel}
        className={cn(
          'group/clear absolute inset-y-0 right-0 flex items-center justify-center peer-disabled:hidden',
          tint
            ? 'invisible w-7 text-current group-focus-within/field:visible group-hover/field:visible pointer-coarse:visible'
            : 'w-8 text-muted-foreground',
        )}
        onPointerDown={(e) => {
          pressedBy.current = e.pointerType
        }}
        onMouseDown={(e) => {
          e.preventDefault()
        }}
        onClick={() => {
          const by = pressedBy.current
          pressedBy.current = null
          if (input.current?.matches(':disabled')) return
          if (by !== 'touch' && by !== 'pen') input.current?.focus()
          onClear()
        }}
      >
        <span
          className={cn(
            'flex size-6 items-center justify-center rounded-full transition-colors',
            tint
              ? 'opacity-70 group-hover/clear:bg-current/10 group-hover/clear:opacity-100'
              : 'group-hover/clear:bg-muted group-hover/clear:text-foreground',
          )}
        >
          <XIcon className="size-4" aria-hidden />
        </span>
      </button>
    )
  }
  if (tint) return null
  return (
    // Dimmed with the text while it is disabled: it opens nothing then.
    <span
      aria-hidden
      className="absolute inset-y-0 right-0 flex w-8 items-center justify-center text-muted-foreground peer-disabled:cursor-not-allowed peer-disabled:opacity-50"
      onMouseDown={(e) => {
        e.preventDefault()
      }}
      onClick={onOpen}
    >
      <ChevronDownIcon className="size-4 opacity-60" />
    </span>
  )
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
