import { useVirtualizer } from '@tanstack/react-virtual'
import { format, isSameDay } from 'date-fns'
import { CalendarPlusIcon, MapPinIcon, RepeatIcon } from 'lucide-react'
import { useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { CorruptedEvent } from '@/components/events/CorruptedEvent'
import { EventBoundary } from '@/components/events/EventBoundary'
import { TaskAgendaRow } from '@/components/tasks/TaskItems'
import { type EventColors } from '@/hooks/useCalendarColors'
import { type Calendar, type CorruptedItem } from '@/lib/api/schemas'
import { eachDay, type DateRange } from '@/lib/dates'
import { eventTitle, firstDay, lastDay, type CalItem } from '@/lib/events'
import { formatShortTime, type FormatPrefs } from '@/lib/format'
import { agendaRows } from '@/lib/layout'
import { cn } from '@/lib/utils'
import { useUi } from '@/stores/ui'
import { defaultCreateTimes } from './createDefaults'

interface Props {
  range: DateRange
  now: Date
  events: CalItem[]
  corrupted: CorruptedItem[]
  prefs: FormatPrefs
  colorsOf: (calendarId: string) => EventColors
  calendarOf: (calendarId: string) => Calendar | undefined
}

/** Virtualized list of upcoming events and tasks grouped by day (NFR-25, FR-16). */
export function AgendaView({ range, now, events, corrupted, prefs, colorsOf, calendarOf }: Props) {
  const { t } = useTranslation()
  const openDetail = useUi((s) => s.openDetail)
  const openEditor = useUi((s) => s.openEditor)
  const rows = useMemo(() => agendaRows(events, eachDay(range)), [events, range])
  const scrollRef = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual is not compiler-safe yet
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i]?.type === 'day' ? 52 : 44),
    overscan: 8,
    getItemKey: (i) => rows[i]?.key ?? i,
  })

  const timeLabel = (e: CalItem, day: Date): string => {
    if (e.allDay) return t('event.allDay')
    if (e.kind === 'task' && e.point) return formatShortTime(e.startsAt, prefs)
    const starts = isSameDay(firstDay(e), day)
    const ends = isSameDay(lastDay(e), day)
    if (starts && ends) return `${formatShortTime(e.startsAt, prefs)} – ${formatShortTime(e.endsAt, prefs)}`
    if (starts) return t('agenda.from', { time: formatShortTime(e.startsAt, prefs) })
    if (ends) return t('agenda.until', { time: formatShortTime(e.endsAt, prefs) })
    return t('event.allDay')
  }

  if (rows.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-surface p-8 text-center">
        <p className="font-display text-2xl font-semibold">{t('agenda.emptyTitle')}</p>
        <p className="max-w-sm text-sm text-muted-foreground">{t('agenda.empty', { count: eachDay(range).length })}</p>
        <Button
          onClick={() => {
            openEditor({ mode: 'create', defaults: defaultCreateTimes(range.start, now) })
          }}
        >
          <CalendarPlusIcon aria-hidden />
          {t('event.create')}
        </Button>
        {corrupted.length > 0 && <CorruptedEvent reason={corrupted.map((c) => c.reason).join('\n')} />}
      </div>
    )
  }

  return (
    <div ref={scrollRef} className="scrollbar-thin h-full overflow-y-auto bg-surface" data-testid="agenda">
      {corrupted.length > 0 && (
        <div className="mx-auto max-w-3xl px-4 pt-4">
          <CorruptedEvent reason={corrupted.map((c) => c.reason).join('\n')} />
        </div>
      )}
      <ul className="relative mx-auto w-full max-w-3xl" style={{ height: virtualizer.getTotalSize() }} aria-label={t('views.agenda')}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index]
          if (!row) return null
          const task = row.type === 'event' && row.event.kind === 'task' ? row.event : null
          const event = row.type === 'event' && row.event.kind === 'event' ? row.event : null
          return (
            <li
              key={item.key}
              data-index={item.index}
              ref={virtualizer.measureElement}
              className="absolute inset-x-0 top-0 px-4"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              {row.type === 'day' ? (
                <h2 className="flex items-baseline gap-3 border-t border-grid pt-4 pb-1.5 first:border-t-0">
                  <span
                    className={cn(
                      'tabular font-display text-2xl leading-none font-semibold',
                      isSameDay(row.day, now) && 'text-primary',
                    )}
                  >
                    {format(row.day, 'd', { locale: prefs.locale })}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {format(row.day, 'EEEE, LLLL yyyy', { locale: prefs.locale })}
                  </span>
                </h2>
              ) : task ? (
                <EventBoundary>
                  <TaskAgendaRow
                    task={task}
                    time={timeLabel(task, row.day)}
                    colors={colorsOf(task.calendarId)}
                    readOnly={calendarOf(task.calendarId)?.readOnly ?? true}
                  />
                </EventBoundary>
              ) : event ? (
                <EventBoundary>
                  <button
                    type="button"
                    data-event-key={event.key}
                    data-calendar-id={event.calendarId}
                    onClick={(e) => {
                      openDetail({ item: event, anchor: e.currentTarget })
                    }}
                    className="grid w-full grid-cols-[8.5rem_0.75rem_1fr] items-center gap-3 rounded-md px-2 py-2.5 text-left text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring max-sm:grid-cols-[6rem_0.75rem_1fr]"
                  >
                    <span className="tabular truncate text-muted-foreground">{timeLabel(event, row.day)}</span>
                    <span
                      className="size-3 rounded-full"
                      style={{ backgroundColor: colorsOf(event.calendarId).solid }}
                      aria-hidden
                    />
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-medium">{eventTitle(event, t('event.untitled'))}</span>
                      {event.recurring && (
                        <RepeatIcon className="size-3.5 shrink-0 text-muted-foreground" aria-label={t('event.recurring')} />
                      )}
                      {event.location && (
                        <span className="flex min-w-0 items-center gap-1 text-muted-foreground max-md:hidden">
                          <MapPinIcon className="size-3.5 shrink-0" aria-hidden />
                          <span className="truncate">{event.location}</span>
                        </span>
                      )}
                    </span>
                  </button>
                </EventBoundary>
              ) : null}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
