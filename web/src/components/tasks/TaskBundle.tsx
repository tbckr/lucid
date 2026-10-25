import { type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { useOverflowButton } from '@/hooks/useOverflowButton'
import { type EventColors } from '@/hooks/useCalendarColors'
import { ringColors } from '@/lib/bundle'
import { isDoneTask, type CalTask } from '@/lib/calendarTasks'
import { cn } from '@/lib/utils'
import { type OverflowState } from '@/stores/ui'

/** Rings of a bundle: as many as `TaskCheck`'s circles can overlap in the width a compact bundle has (FR-07). */
const RINGS = 3
const COMPACT_RINGS = 2

/**
 * Several tasks of a day or time slot as one button (FR-07): their `TaskCheck` circles stacked in the colors of their
 * calendars, then their number. Like `MoreButton`, a click opens the list of `tasks` in `OverflowPopover`, a second
 * click closes it. `tile` is a square on the surface of the time grid and the all-day row; `chip` takes a month
 * cell's dot place and has none. `compact` is for a column too narrow for the words: two rings and the bare number.
 * `label` names it for assistive technology, with the day in it; the rings are decoration.
 */
export function TaskBundle({
  id,
  day,
  tasks,
  drag,
  home,
  colorsOf,
  variant,
  compact,
  label,
  className,
  style,
}: {
  /** Names the button among its kind, e.g. by its day or slot: the list is open for the button whose `id` it has. */
  id: string
  day: Date
  /** What the bundle stands for, in display order. */
  tasks: CalTask[]
  drag: OverflowState['drag']
  /** Its cell or column, which the list points at and gives the focus to once the button is gone. */
  home: () => HTMLElement | null
  colorsOf: (calendarId: string) => EventColors
  variant: 'tile' | 'chip'
  compact?: boolean
  label: string
  className?: string
  style?: CSSProperties
}) {
  const { t } = useTranslation()
  const overflow = useOverflowButton({ id, day, items: tasks, drag, home })
  const colors = ringColors(tasks, (calendarId) => colorsOf(calendarId).solid, compact ? COMPACT_RINGS : RINGS)
  return (
    <button
      type="button"
      aria-label={label}
      data-bundle-count={tasks.length}
      {...overflow}
      className={cn(
        'flex items-center gap-1.5 px-1.5 text-xs font-semibold text-foreground tabular outline-none focus-visible:ring-2 focus-visible:ring-ring',
        // `--host` is the surface under the rings: they fill with it and are haloed in it, so the stack follows the hover.
        variant === 'tile'
          ? 'overflow-hidden rounded-md bg-muted [--host:var(--muted)] hover:bg-border hover:[--host:var(--border)]'
          : 'h-5 w-full rounded-sm [--host:var(--surface)] hover:bg-muted hover:[--host:var(--muted)]',
        tasks.every(isDoneTask) && 'opacity-60',
        className,
      )}
      style={style}
    >
      <span aria-hidden className="flex shrink-0 items-center">
        {colors.map((color, i) => (
          <span
            key={i}
            data-ring
            className={cn('size-3.5 rounded-full border-[1.5px]', i > 0 && '-ml-1.5')}
            style={{ borderColor: color, backgroundColor: 'var(--host)', boxShadow: '0 0 0 1.5px var(--host)' }}
          />
        ))}
      </span>
      <span className="truncate">{compact ? tasks.length : t('bundle.count', { count: tasks.length })}</span>
    </button>
  )
}
