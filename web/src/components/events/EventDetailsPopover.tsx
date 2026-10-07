import { AlignLeftIcon, GlobeIcon, LockIcon, MapPinIcon } from 'lucide-react'
import { useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Popover } from '@/components/ui/popover'
import { useDeleteEvent, useDeleteOccurrence, useVisibleCalendars } from '@/hooks/queries'
import { useCalendarColors } from '@/hooks/useCalendarColors'
import { usePrefs } from '@/hooks/usePrefs'
import { eventTitle, type CalEvent } from '@/lib/events'
import { formatEventWhen, type FormatPrefs } from '@/lib/format'
import { browserTimeZone } from '@/lib/locale'
import { describeRRule } from '@/lib/rrule'
import { eventScopeItems, scopeOptions, type Scope } from '@/lib/scope'
import { useUi } from '@/stores/ui'
import { DetailActions, DetailClose, DetailContent, DetailRow, Linked } from './DetailParts'
import { RepeatGlyph } from './EventItems'

/** Popover with the details of the selected event (read, edit, delete; FR-09). */
export function EventDetailsPopover() {
  const detail = useUi((s) => s.detail)
  const openDetail = useUi((s) => s.openDetail)
  if (detail?.item.kind !== 'event') return null
  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) openDetail(null)
      }}
    >
      <Details key={detail.item.key} event={detail.item} anchor={detail.anchor} />
    </Popover>
  )
}

// The event's times in its own zone, when that is another one than the browser's.
function zoneTimes(event: CalEvent, tz: string, prefs: FormatPrefs, now: Date): string | null {
  if (event.allDay || !event.timezone || event.timezone === tz) return null
  try {
    return `${formatEventWhen(event, prefs, now, event.timezone)} (${event.timezone})`
  } catch {
    return null // not an IANA zone, e.g. a Windows name
  }
}

function Details({ event, anchor }: { event: CalEvent; anchor: HTMLElement }) {
  const { t } = useTranslation()
  const prefs = usePrefs()
  const { byId } = useVisibleCalendars()
  const colorsOf = useCalendarColors()
  const openDetail = useUi((s) => s.openDetail)
  const openEditor = useUi((s) => s.openEditor)
  // A delete of a series waits for its other writes, and takes the ETag they got (FR-17).
  const series = event.recurring ? event.id : undefined
  const del = useDeleteEvent(series)
  const deleteOccurrence = useDeleteOccurrence(series)
  const closeRef = useRef<HTMLButtonElement>(null)
  const editRef = useRef<HTMLButtonElement>(null)
  // Holds how to cancel the delete scope question while it is open, for the Escape handler below.
  const cancelScope = useRef<(() => void) | null>(null)
  const calendar = byId.get(event.calendarId)
  const readOnly = calendar?.readOnly ?? true
  const colors = colorsOf(event.calendarId)
  const tz = useMemo(() => browserTimeZone(), [])
  const now = useMemo(() => new Date(), [])
  const title = eventTitle(event, t('event.untitled'))
  const repeats = event.rrule
    ? (describeRRule(event.rrule, event.startsAt, prefs, now, t) ?? t('recurrence.customRule', { rule: event.rrule }))
    : t('event.recurring')
  const inZone = zoneTimes(event, tz, prefs, now)
  const hasDetails = [event.recurring, inZone, event.location, event.description].some(Boolean)
  // An event of a series asks which events to delete (FR-17); a single event only whether.
  const deleteOptions = scopeOptions({ kind: 'event', action: 'delete', item: event, tz }).options
  const deleteScoped = (scope: Scope) => {
    switch (scope) {
      case 'this':
        deleteOccurrence.mutate(event)
        break
      case 'all':
        del.mutate(event)
        break
      case 'following':
        throw new Error('"This and following events" is not offered for events yet')
    }
    openDetail(null)
  }

  return (
    <DetailContent
      anchor={anchor}
      label={title}
      initialFocus={() => editRef.current ?? closeRef.current}
      onEscapeKeyDown={(e) => {
        // While the delete scope question is open, Escape cancels it instead of closing the
        // popover (NFR-27): Radix would otherwise dismiss this popover before the question's own
        // handler ever ran.
        if (cancelScope.current) {
          e.preventDefault()
          cancelScope.current()
        }
      }}
    >
      {/* The event's block from the calendar, whole: its calendar's tint and bar, the title, then the time. */}
      <div
        className="relative grid gap-1 border-l-4 pt-4 pr-12 pb-3.5 pl-11"
        style={{ backgroundColor: colors.tint, color: colors.onTint, borderLeftColor: colors.solid }}
      >
        <h2 className="font-display text-2xl leading-tight font-semibold tracking-tight [overflow-wrap:anywhere]">
          {title}
        </h2>
        <p className="tabular font-medium">{formatEventWhen(event, prefs, now)}</p>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 text-sm font-medium">
          <span className="size-2.5 rounded-full" style={{ backgroundColor: colors.solid }} aria-hidden />
          <span className="sr-only">{t('event.calendar')}: </span>
          {calendar?.name ?? t('event.unknownCalendar')}
          {readOnly && (
            <span className="inline-flex items-center gap-1 font-normal">
              <LockIcon className="size-3.5" aria-hidden />
              {t('calendars.readOnly')}
            </span>
          )}
        </p>
        <DetailClose
          ref={closeRef}
          onClose={() => {
            openDetail(null)
          }}
        />
      </div>

      <div className="grid gap-4 p-4 empty:hidden">
        {hasDetails && (
          <div className="grid gap-3 text-sm">
            {event.recurring && (
              <DetailRow icon={<RepeatGlyph modified={event.modified} />}>
                <p>{repeats}</p>
                {event.modified && <p className="mt-0.5 text-muted-foreground">{t('event.modifiedNotice')}</p>}
              </DetailRow>
            )}
            {inZone && (
              <DetailRow icon={<GlobeIcon />}>
                <span className="text-muted-foreground">{inZone}</span>
              </DetailRow>
            )}
            {event.location && (
              <DetailRow icon={<MapPinIcon />}>
                <span className="[overflow-wrap:anywhere]">
                  <Linked text={event.location} />
                </span>
              </DetailRow>
            )}
            {event.description && (
              <DetailRow icon={<AlignLeftIcon />}>
                <p className="scrollbar-thin max-h-48 overflow-y-auto whitespace-pre-wrap [overflow-wrap:anywhere]">
                  <Linked text={event.description} />
                </p>
              </DetailRow>
            )}
          </div>
        )}

        {!readOnly && (
          <DetailActions
            editRef={editRef}
            editLabel={t('event.edit')}
            deleteLabel={t('event.delete')}
            confirm={t('event.confirmDelete')}
            onEdit={() => {
              openEditor({ mode: 'edit', event })
            }}
            onDelete={() => {
              del.mutate(event)
              openDetail(null)
            }}
            deleteScope={
              deleteOptions.length > 1
                ? {
                    items: eventScopeItems(t, event, deleteOptions, prefs, now),
                    color: colors.solid,
                    onChoose: deleteScoped,
                  }
                : undefined
            }
            onScopeOpenChange={(cancel) => {
              cancelScope.current = cancel
            }}
          />
        )}
      </div>
    </DetailContent>
  )
}
