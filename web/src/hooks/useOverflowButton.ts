import { type ButtonHTMLAttributes, type MouseEvent } from 'react'
import { type CalItem } from '@/lib/events'
import { useUi, type OverflowState } from '@/stores/ui'

/**
 * What a button needs that stands for entries a day's cell or column has no room for (FR-07), such as `MoreButton`
 * and `TaskBundle`: spread it on the `<button>`. A click opens the list of `items` in `OverflowPopover` at the button,
 * a second click on it closes the list again.
 */
export function useOverflowButton({
  id,
  day,
  items,
  drag,
  home,
}: {
  /** Names the button among its kind, e.g. by its day: the list is open for the button whose `id` it has. */
  id: string
  day: Date
  /** What the button stands for, in display order. */
  items: CalItem[]
  drag: OverflowState['drag']
  /** Its cell or column, which the list points at and gives the focus to once the button is gone. */
  home: () => HTMLElement | null
}): Pick<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-haspopup' | 'aria-expanded' | 'onClick'> & { 'data-holds': string } {
  const open = useUi((s) => s.overflow?.id === id)
  const openOverflow = useUi((s) => s.openOverflow)
  return {
    'aria-haspopup': 'dialog',
    'aria-expanded': open,
    'data-holds': items.map((i) => i.key).join(' '),
    onClick: (e: MouseEvent<HTMLButtonElement>) => {
      // The list is not an entry of the cell around the button, which a click would create.
      e.stopPropagation()
      if (open) {
        openOverflow(null)
        return
      }
      const button = e.currentTarget
      openOverflow({ id, day, items, drag, anchor: button, home: home() ?? button, rect: button.getBoundingClientRect() })
    },
  }
}
