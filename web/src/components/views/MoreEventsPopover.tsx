import { useVirtualizer } from '@tanstack/react-virtual'
import { format } from 'date-fns'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { EventBoundary } from '@/components/events/EventBoundary'
import { TaskChip } from '@/components/tasks/TaskItems'
import { type EventColors } from '@/hooks/useCalendarColors'
import { eventTitle, type CalEvent, type CalItem } from '@/lib/events'
import { formatShortTime, type FormatPrefs } from '@/lib/format'
import { useUi } from '@/stores/ui'

const ROW = 28
/** Lists with more entries than this are virtualized (NFR-25). */
export const VIRTUALIZE_THRESHOLD = 10

function Row({
  event,
  colors,
  prefs,
  onOpen,
}: {
  event: CalEvent
  colors: EventColors
  prefs: FormatPrefs
  onOpen: (e: CalEvent) => void
}) {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      data-event-key={event.key}
      onClick={() => {
        onOpen(event)
      }}
      className="flex h-6 w-full min-w-0 items-center gap-2 rounded-sm px-1.5 text-left text-xs outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
      style={event.allDay ? { backgroundColor: colors.solid, color: colors.onSolid } : undefined}
    >
      {!event.allDay && <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: colors.solid }} aria-hidden />}
      {!event.allDay && <span className="tabular shrink-0 text-muted-foreground">{formatShortTime(event.startsAt, prefs)}</span>}
      <span className="truncate font-medium">{eventTitle(event, t('event.untitled'))}</span>
    </button>
  )
}

/** An event row, or a task with its checkbox (FR-16). */
function Entry({
  item,
  colors,
  prefs,
  readOnly,
  onOpen,
}: {
  item: CalItem
  colors: EventColors
  prefs: FormatPrefs
  readOnly: boolean
  onOpen: (e: CalItem) => void
}) {
  if (item.kind === 'task') {
    return <TaskChip task={item} colors={colors} prefs={prefs} readOnly={readOnly} className="h-6" onOpen={onOpen} />
  }
  return <Row event={item} colors={colors} prefs={prefs} onOpen={onOpen} />
}

/** Virtualized list for busy days (NFR-25); mounted only while the popover is open. */
function VirtualList({
  events,
  prefs,
  colorsOf,
  readOnly,
  onOpen,
}: {
  events: CalItem[]
  prefs: FormatPrefs
  colorsOf: (calendarId: string) => EventColors
  readOnly: (calendarId: string) => boolean
  onOpen: (e: CalItem) => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual is not compiler-safe yet
  const virtualizer = useVirtualizer({
    count: events.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW,
    overscan: 6,
    initialRect: { width: 240, height: 288 },
  })
  return (
    <div ref={scrollRef} className="scrollbar-thin max-h-72 overflow-y-auto" data-testid="more-virtual">
      <ul className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const e = events[item.index]
          if (!e) return null
          return (
            <li
              key={e.key}
              className="absolute inset-x-0 top-0"
              style={{ height: item.size, transform: `translateY(${item.start}px)` }}
            >
              <EventBoundary>
                <Entry item={e} colors={colorsOf(e.calendarId)} prefs={prefs} readOnly={readOnly(e.calendarId)} onOpen={onOpen} />
              </EventBoundary>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** "+N more" button with a popover listing all events of a day. */
export function MoreEventsPopover({
  day,
  events,
  hidden,
  prefs,
  colorsOf,
  readOnly,
}: {
  day: Date
  events: CalItem[]
  hidden: number
  prefs: FormatPrefs
  colorsOf: (calendarId: string) => EventColors
  readOnly: (calendarId: string) => boolean
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const openDetail = useUi((s) => s.openDetail)
  const virtual = events.length > VIRTUALIZE_THRESHOLD

  const onOpen = (e: CalItem) => {
    setOpen(false)
    if (triggerRef.current) openDetail({ item: e, anchor: triggerRef.current })
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          onClick={(e) => {
            e.stopPropagation()
          }}
          className="h-5 w-full rounded-sm px-1.5 text-left text-xs font-semibold text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t('month.more', { count: hidden })}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-2" align="start" aria-label={format(day, 'PPPP', { locale: prefs.locale })}>
        <p className="px-1.5 pb-2 font-display text-sm font-semibold">{format(day, 'EEEE, PPP', { locale: prefs.locale })}</p>
        {virtual ? (
          <VirtualList events={events} prefs={prefs} colorsOf={colorsOf} readOnly={readOnly} onOpen={onOpen} />
        ) : (
          <ul className="flex flex-col gap-1">
            {events.map((e) => (
              <li key={e.key}>
                <EventBoundary>
                  <Entry item={e} colors={colorsOf(e.calendarId)} prefs={prefs} readOnly={readOnly(e.calendarId)} onOpen={onOpen} />
                </EventBoundary>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  )
}
