import { useDraggable } from '@dnd-kit/core'
import { RepeatIcon } from 'lucide-react'
import { type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Spinner } from '@/components/ui/spinner'
import { useDndState } from '@/components/dnd/dndState'
import { type EventColors } from '@/hooks/useCalendarColors'
import { type DragBinding, type DragData } from '@/lib/dnd'
import { eventTitle, type CalEvent } from '@/lib/events'
import { formatShortTime, type FormatPrefs } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useUi } from '@/stores/ui'

/**
 * Draggable + clickable wrapper shared by all event renderings. Enter opens
 * the details popover; Space starts a keyboard drag (dnd-kit).
 */
function useEventInteraction(event: CalEvent, drag: DragBinding) {
  const openDetail = useUi((s) => s.openDetail)
  const { pendingKeys } = useDndState()
  const pending = pendingKeys.has(event.key)
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: drag.id,
    data: drag.data,
    disabled: drag.disabled || pending,
  })
  const onClick = (e: MouseEvent<HTMLElement>) => {
    e.stopPropagation()
    openDetail({ item: event, anchor: e.currentTarget })
  }
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    // While a keyboard drag is active, Enter drops (handled by dnd-kit).
    if (e.key === 'Enter' && !isDragging) {
      e.preventDefault()
      e.stopPropagation()
      openDetail({ item: event, anchor: e.currentTarget })
      return
    }
    listeners?.onKeyDown?.(e)
  }
  return {
    ref: setNodeRef,
    props: {
      ...attributes,
      ...listeners,
      // dnd-kit sets role="button"; we render real buttons.
      role: undefined,
      'aria-roledescription': drag.disabled ? undefined : attributes['aria-roledescription'],
      onClick,
      onKeyDown,
      'aria-busy': pending || undefined,
      'data-event-key': event.key,
      'data-calendar-id': event.calendarId,
    },
    isDragging,
    pending,
  }
}

function RecurringMark({ event }: { event: CalEvent }) {
  const { t } = useTranslation()
  if (!event.recurring) return null
  return <RepeatIcon className="size-3 shrink-0 opacity-70" aria-label={t('event.recurring')} />
}

/** Single-day timed event in the month grid: dot, time, title. */
export function EventChip({
  event,
  colors,
  prefs,
  drag,
  className,
}: {
  event: CalEvent
  colors: EventColors
  prefs: FormatPrefs
  drag: DragBinding
  className?: string
}) {
  const { t } = useTranslation()
  const { ref, props, isDragging, pending } = useEventInteraction(event, drag)
  const title = eventTitle(event, t('event.untitled'))
  return (
    <button
      ref={ref}
      type="button"
      {...props}
      aria-label={t('event.chipLabel', { title, time: formatShortTime(event.startsAt, prefs) })}
      className={cn(
        'group flex h-5 w-full min-w-0 items-center gap-1.5 rounded-sm px-1.5 text-left text-xs leading-none outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring',
        isDragging && 'opacity-40',
        className,
      )}
    >
      {pending ? (
        <Spinner className="size-3" />
      ) : (
        <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: colors.solid }} aria-hidden />
      )}
      <span className="tabular shrink-0 text-muted-foreground max-sm:hidden">{formatShortTime(event.startsAt, prefs)}</span>
      <span className="truncate font-medium">{title}</span>
    </button>
  )
}

/** All-day / multi-day bar. */
export function EventBar({
  event,
  colors,
  drag,
  continuesBefore = false,
  continuesAfter = false,
  className,
  style,
  prefs,
}: {
  event: CalEvent
  colors: EventColors
  drag: DragBinding
  continuesBefore?: boolean
  continuesAfter?: boolean
  className?: string
  style?: CSSProperties
  prefs: FormatPrefs
}) {
  const { t } = useTranslation()
  const { ref, props, isDragging, pending } = useEventInteraction(event, drag)
  const title = eventTitle(event, t('event.untitled'))
  return (
    <button
      ref={ref}
      type="button"
      {...props}
      aria-label={
        event.allDay ? t('event.allDayLabel', { title }) : t('event.chipLabel', { title, time: formatShortTime(event.startsAt, prefs) })
      }
      className={cn(
        'flex h-5 min-w-0 items-center gap-1 px-1.5 text-left text-xs leading-none font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-surface',
        continuesBefore ? 'rounded-l-none' : 'rounded-l-sm',
        continuesAfter ? 'rounded-r-none' : 'rounded-r-sm',
        isDragging && 'opacity-40',
        className,
      )}
      style={{ backgroundColor: colors.solid, color: colors.onSolid, ...style }}
    >
      {pending && <Spinner className="size-3" />}
      {!event.allDay && !continuesBefore && (
        <span className="tabular shrink-0 opacity-85">{formatShortTime(event.startsAt, prefs)}</span>
      )}
      <span className="truncate">{title}</span>
      <RecurringMark event={event} />
    </button>
  )
}

/** Timed event block in the week/day grid. */
export function TimedBlock({
  event,
  colors,
  prefs,
  drag,
  style,
  size,
  children,
}: {
  event: CalEvent
  colors: EventColors
  prefs: FormatPrefs
  drag: DragBinding
  style?: CSSProperties
  /** Available height decides how much text fits. */
  size: 'xs' | 'sm' | 'md'
  children?: ReactNode
}) {
  const compact = size === 'xs'
  const { t } = useTranslation()
  const { ref, props, isDragging, pending } = useEventInteraction(event, drag)
  const title = eventTitle(event, t('event.untitled'))
  const time = `${formatShortTime(event.startsAt, prefs)} – ${formatShortTime(event.endsAt, prefs)}`
  return (
    <div
      className={cn('absolute px-px', isDragging && 'opacity-40')}
      style={{ ...style, color: colors.onTint }}
    >
      <button
        ref={ref}
        type="button"
        {...props}
        aria-label={t('event.chipLabel', { title, time })}
        className={cn(
          'relative flex size-full min-h-0 flex-col overflow-hidden rounded-md border-l-[3px] px-1.5 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-surface',
          compact ? 'flex-row items-center gap-1 py-0' : 'py-1',
          pending && 'animate-pulse',
        )}
        style={{ backgroundColor: colors.tint, color: colors.onTint, borderLeftColor: colors.solid }}
      >
        <span className="flex min-w-0 items-center gap-1 font-semibold">
          {pending && <Spinner className="size-3" />}
          <span className="truncate">{title}</span>
          <RecurringMark event={event} />
        </span>
        <span className={cn('tabular truncate opacity-90', compact && 'shrink-0')}>
          {compact ? formatShortTime(event.startsAt, prefs) : time}
        </span>
        {size === 'md' && event.location && <span className="truncate opacity-80">{event.location}</span>}
      </button>
      {children}
    </div>
  )
}

/** Handle at the bottom of a timed block to change its end (15-min steps); `draft`: of the create popover's entry. */
export function ResizeHandle({ event, disabled, draft }: { event: CalEvent; disabled: boolean; draft?: true }) {
  const { t } = useTranslation()
  const { attributes, listeners, setNodeRef } = useDraggable({
    id: `resize:${event.key}`,
    data: { type: 'resize', event, ...(draft && { draft }) } satisfies DragData,
    disabled,
  })
  if (disabled) return null
  return (
    <button
      ref={setNodeRef}
      type="button"
      {...attributes}
      {...listeners}
      role={undefined}
      tabIndex={-1}
      aria-label={t('event.resize')}
      className="absolute inset-x-1 bottom-0 h-2 cursor-ns-resize rounded-b-md outline-none after:mx-auto after:block after:h-0.5 after:w-6 after:rounded-full after:bg-current after:opacity-0 hover:after:opacity-50"
    />
  )
}
