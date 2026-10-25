import { type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { type CalItem } from '@/lib/events'
import { useOverflowButton } from '@/hooks/useOverflowButton'
import { type OverflowState } from '@/stores/ui'

/**
 * The "+N" or "N more" button of what a day's cell or column has no room for (FR-07): a click opens the list of
 * `items` in `OverflowPopover`, a second click on it closes the list again. `text` is the month's line under its
 * entries, `tile` the grids' square on Paper. `label` is its name for assistive technology, with the day in it.
 */
export function MoreButton({
  id,
  day,
  items,
  drag,
  home,
  count,
  label,
  variant,
  className,
  style,
}: {
  /** Names the button among its kind, e.g. by its day: the list is open for the button whose `id` it has. */
  id: string
  day: Date
  /** What the button stands for, in display order. */
  items: CalItem[]
  drag: OverflowState['drag']
  /** Its cell or column, which the list points at and gives the focus to once the button is gone. */
  home: () => HTMLElement | null
  count: number
  label: string
  variant: 'text' | 'tile'
  className?: string
  style?: CSSProperties
}) {
  const { t } = useTranslation()
  const overflow = useOverflowButton({ id, day, items, drag, home })
  return (
    <button
      type="button"
      aria-label={label}
      {...overflow}
      className={cn(
        'text-xs font-semibold text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
        variant === 'text'
          ? 'h-5 w-full rounded-sm px-1.5 text-left hover:bg-muted'
          : 'tabular flex items-center justify-center rounded-sm bg-surface ring-1 ring-border',
        className,
      )}
      style={style}
    >
      {variant === 'text' ? t('month.more', { count }) : t('more.short', { count })}
    </button>
  )
}
