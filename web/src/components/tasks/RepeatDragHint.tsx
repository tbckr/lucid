import { useMemo, type ReactNode } from 'react'
import { LIMIT_PILL } from '@/components/dnd/LimitPill'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { type RepeatDragHint } from './useRepeatDragHint'

/** The hint itself: the ink pill beneath the item, announced as a status (NFR-27). */
export function RepeatDragHintPopover({ hint, text }: { hint: RepeatDragHint; text: string }): ReactNode {
  const { at, hide } = hint
  const virtualRef = useMemo(() => ({ current: at }), [at])
  if (!at) return null
  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) hide()
      }}
    >
      <PopoverAnchor virtualRef={virtualRef} />
      <PopoverContent
        role="status"
        side="bottom"
        align="start"
        sideOffset={4}
        className={LIMIT_PILL}
        // The focus stays where it is: the hint is something to read, not to use.
        onOpenAutoFocus={(e) => {
          e.preventDefault()
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault()
        }}
        // A portal still bubbles through React: a click on the hint dismisses it, and stops there
        // instead of creating an entry in the cell around the item.
        onClick={(e) => {
          e.stopPropagation()
          hide()
        }}
      >
        {text}
      </PopoverContent>
    </Popover>
  )
}
