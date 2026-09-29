import { addDays, startOfDay } from 'date-fns'
import { useTranslation } from 'react-i18next'
import { type EventColors } from '@/hooks/useCalendarColors'
import { minutesOfDay } from '@/lib/dates'
import { PX_PER_MINUTE } from '@/lib/dnd'
import { formatShortTime, type FormatPrefs } from '@/lib/format'
import { type CreatePreview } from '@/lib/quickCreate'
import { cn } from '@/lib/utils'

const DAY_MINUTES = 24 * 60

/**
 * The entry the create popover is about to add, drawn in a time-grid column
 * like the block it will become (FR-09, FR-16), and lifted like the popover
 * it belongs to. Only the part on `day`; nothing if it misses the day.
 */
export function DraftBlock({
  preview,
  day,
  colors,
  prefs,
}: {
  preview: CreatePreview
  day: Date
  colors: EventColors
  prefs: FormatPrefs
}) {
  const { t } = useTranslation()
  const dayStart = startOfDay(day)
  const dayEnd = addDays(dayStart, 1)
  if (preview.allDay || preview.start >= dayEnd || preview.end <= dayStart) return null

  const startMin = preview.start < dayStart ? 0 : minutesOfDay(preview.start)
  const endMin = preview.end >= dayEnd ? DAY_MINUTES : minutesOfDay(preview.end)
  const task = preview.kind === 'task'
  const start = formatShortTime(preview.start, prefs)
  const time = task && preview.point ? start : `${start} – ${formatShortTime(preview.end, prefs)}`
  const height = Math.max(18, (endMin - startMin) * PX_PER_MINUTE - 2)
  // As in a short block, title and time share one line.
  const compact = height < 34

  return (
    <div
      data-draft=""
      className={cn(
        'pointer-events-none absolute inset-x-1 z-40 flex min-h-0 gap-1.5 overflow-hidden rounded-md border-l-[3px] px-1.5 text-xs leading-4 shadow-float',
        compact ? 'items-center py-0' : 'py-1',
      )}
      style={{
        top: startMin * PX_PER_MINUTE,
        height,
        backgroundColor: colors.tint,
        color: colors.onTint,
        borderLeftColor: colors.solid,
      }}
      aria-hidden
    >
      {task && (
        <span
          className={cn('size-3.5 shrink-0 rounded-full border-[1.5px]', !compact && 'mt-px')}
          style={{ borderColor: colors.solid }}
        />
      )}
      <span className={cn('flex min-w-0', compact ? 'items-center gap-1' : 'flex-col')}>
        <span className="truncate font-semibold">{preview.title.trim() || t('event.untitled')}</span>
        <span className={cn('tabular truncate opacity-90', compact && 'shrink-0')}>{time}</span>
      </span>
    </div>
  )
}
