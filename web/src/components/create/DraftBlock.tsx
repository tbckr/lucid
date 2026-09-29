import { useDraggable } from '@dnd-kit/core'
import { useTranslation } from 'react-i18next'
import { useDndState } from '@/components/dnd/dndState'
import { ResizeHandle } from '@/components/events/EventItems'
import { type EventColors } from '@/hooks/useCalendarColors'
import { dayKey } from '@/lib/dates'
import { PX_PER_MINUTE, type DragData } from '@/lib/dnd'
import { type CalItem } from '@/lib/events'
import { formatShortTime, type FormatPrefs } from '@/lib/format'
import { timedSegments, type TimedSegment } from '@/lib/layout'
import { cn } from '@/lib/utils'

interface Props {
  /** The entry as the popover previews it. */
  item: CalItem
  day: Date
  colors: EventColors
  prefs: FormatPrefs
}

/**
 * The entry the create popover is about to add, drawn in a time-grid column
 * like the block it will become (FR-09, FR-16), and lifted like the popover
 * it belongs to. Only the part on `day`; nothing if it misses the day. It
 * moves like a block and an event's end draws out (FR-10); the popover takes
 * the new times.
 */
export function DraftBlock(props: Props) {
  const { resize } = useDndState()
  // While its end is drawn out, the draft shows the end a drop gives it.
  const shown = resize?.key === props.item.key ? resize : props.item
  const segment = timedSegments([shown], props.day)[0]
  if (!segment) return null
  return <DraftPart {...props} segment={segment} />
}

function DraftPart({ item, day, colors, prefs, segment }: Props & { segment: TimedSegment }) {
  const { t } = useTranslation()
  const { listeners, setNodeRef, isDragging } = useDraggable({
    id: `draft:${dayKey(day)}`,
    data: { type: 'timed', event: item, originDay: day, draft: true } satisfies DragData,
  })
  const shown = segment.event
  const task = shown.kind === 'task'
  const start = formatShortTime(shown.startsAt, prefs)
  const time = task && shown.point ? start : `${start} – ${formatShortTime(shown.endsAt, prefs)}`
  const height = Math.max(18, (segment.endMin - segment.startMin) * PX_PER_MINUTE - 2)
  // As in a short block, title and time share one line.
  const compact = height < 34

  return (
    <div
      ref={setNodeRef}
      data-draft=""
      {...listeners}
      // The focus stays in the popover, on the title being typed. Without a pointer, the times
      // are set there (NFR-27).
      onMouseDown={(e) => {
        e.preventDefault()
      }}
      className={cn(
        // Takes the pointer although the open popover leaves the rest of the page without it.
        'pointer-events-auto absolute inset-x-1 z-40 flex min-h-0 gap-1.5 overflow-hidden rounded-md border-l-[3px] px-1.5 text-xs leading-4 shadow-float',
        compact ? 'items-center py-0' : 'py-1',
        isDragging && 'opacity-40',
      )}
      style={{
        top: segment.startMin * PX_PER_MINUTE,
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
        <span className="truncate font-semibold">{shown.title.trim() || t('event.untitled')}</span>
        <span className={cn('tabular truncate opacity-90', compact && 'shrink-0')}>{time}</span>
      </span>
      {item.kind === 'event' && <ResizeHandle event={item} disabled={segment.clippedEnd} draft />}
    </div>
  )
}
