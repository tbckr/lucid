import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
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
 * Whether a bundle's words fit it (FR-07): `sizer` holds its rings and words at full length out of sight, and is
 * measured against the button whenever either changes size, as the words do with the count and the language.
 */
function useWordsFit() {
  const button = useRef<HTMLButtonElement>(null)
  const sizer = useRef<HTMLSpanElement>(null)
  const [fits, setFits] = useState(true)
  useLayoutEffect(() => {
    const b = button.current
    const s = sizer.current
    if (!b || !s) return
    const ro = new ResizeObserver(() => {
      setFits(s.getBoundingClientRect().width <= b.getBoundingClientRect().width)
    })
    ro.observe(b)
    ro.observe(s)
    return () => {
      ro.disconnect()
    }
  }, [])
  return { button, sizer, fits }
}

/**
 * Several tasks of a day or time slot as one button (FR-07): their `TaskCheck` circles stacked in the colors of their
 * calendars, then their number. Like `MoreButton`, a click opens the list of `tasks` in `OverflowPopover`, a second
 * click closes it. `tile` is a square on the surface of the time grid and the all-day row; `chip` takes a month
 * cell's dot place and has none. Where its words don't fit, as measured, it is compact: two rings and the bare
 * number; `compact` makes it so for a column known to be too narrow. `label` names it for assistive technology, with
 * the day in it; the rings are decoration.
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
  const { button, sizer, fits } = useWordsFit()
  const narrow = compact === true || !fits
  const full = ringColors(tasks, (calendarId) => colorsOf(calendarId).solid, RINGS)
  const colors = narrow ? full.slice(0, COMPACT_RINGS) : full
  const words = t('bundle.count', { count: tasks.length })
  // Done, its rings and count dim like a done task; the button doesn't, so its focus ring keeps its strength (NFR-27).
  const dim = tasks.every(isDoneTask) && 'opacity-60'
  return (
    <button
      ref={button}
      type="button"
      aria-label={label}
      data-bundle-count={tasks.length}
      {...overflow}
      className={cn(
        'relative flex items-center gap-1.5 overflow-hidden px-1.5 text-xs font-semibold text-foreground tabular outline-none focus-visible:ring-2 focus-visible:ring-ring',
        // `--host` is the surface under the rings: they fill with it and are haloed in it, so the stack follows the hover.
        variant === 'tile'
          ? 'rounded-md bg-muted [--host:var(--muted)] hover:bg-border hover:[--host:var(--border)]'
          : 'h-5 w-full rounded-sm [--host:var(--surface)] hover:bg-muted hover:[--host:var(--muted)]',
        className,
      )}
      style={style}
    >
      <span aria-hidden className={cn('flex shrink-0 items-center', dim)}>
        {colors.map((color, i) => (
          <span
            key={i}
            data-ring
            className={cn('size-3.5 rounded-full border-[1.5px]', i > 0 && '-ml-1.5')}
            style={{ borderColor: color, backgroundColor: 'var(--host)', boxShadow: '0 0 0 1.5px var(--host)' }}
          />
        ))}
      </span>
      <span className={cn('truncate', dim)}>{narrow ? tasks.length : words}</span>
      {/* The full rings and words, out of sight, to measure them by; the words as generated content, out of its text. */}
      <span
        ref={sizer}
        aria-hidden
        data-sizer
        data-words={words}
        className="invisible absolute top-0 left-0 flex w-max items-center gap-1.5 px-1.5 after:content-[attr(data-words)]"
      >
        <span className="flex shrink-0 items-center">
          {full.map((_, i) => (
            <span key={i} className={cn('size-3.5 border-[1.5px]', i > 0 && '-ml-1.5')} />
          ))}
        </span>
      </span>
    </button>
  )
}
