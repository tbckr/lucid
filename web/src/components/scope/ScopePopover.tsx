import { useMemo, type ComponentProps } from 'react'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { ScopeChoice } from './ScopeChoice'

/**
 * The scope question (`ScopeChoice`) in a popover at what it is about (FR-10,
 * FR-17): a dropped event or task's repeat, or a field being edited. It
 * points at `anchor`; while that is not on the page (a full month cell hides
 * the dropped tile), at `at`. Its color bar is the series' calendar color.
 *
 * Accessibility (NFR-27): the question itself is the alertdialog, and picks
 * its own initial focus. A press beside it, Escape or Cancel cancel it; the
 * focus then goes to `returnFocus()`, wherever the answer put that, unless a
 * press beside the question has given the focus to something else.
 */
export function ScopePopover({
  anchor,
  at,
  returnFocus,
  ...choice
}: ComponentProps<typeof ScopeChoice> & {
  anchor: HTMLElement | null
  /** Where to point while `anchor` is not on the page. */
  at?: DOMRect
  /** The element to give the focus back to once the question closes. */
  returnFocus?: () => HTMLElement | null | undefined
}) {
  // floating-ui follows the scrolling of the anchor's ancestors through `contextElement`.
  const virtualRef = useMemo(
    () => ({
      current: {
        getBoundingClientRect: () => (anchor?.isConnected ? anchor.getBoundingClientRect() : (at ?? new DOMRect())),
        contextElement: anchor ?? undefined,
      },
    }),
    [anchor, at],
  )
  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) choice.onCancel()
      }}
    >
      <PopoverAnchor virtualRef={virtualRef} />
      <PopoverContent
        // The question itself is the alertdialog (NFR-27); the popover around it is no second, unnamed dialog.
        role={undefined}
        align="start"
        className="w-[min(26rem,calc(100vw-2rem))] border-l-4"
        style={{ borderLeftColor: choice.color }}
        // ScopeChoice focuses its default choice itself.
        onOpenAutoFocus={(e) => {
          e.preventDefault()
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault()
          const focused = document.activeElement
          if (focused && focused !== document.body) return
          returnFocus?.()?.focus()
        }}
      >
        <ScopeChoice {...choice} />
      </PopoverContent>
    </Popover>
  )
}
