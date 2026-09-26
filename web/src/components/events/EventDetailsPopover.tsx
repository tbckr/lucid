import { formatInTimeZone } from 'date-fns-tz'
import {
  AlignLeftIcon,
  CalendarIcon,
  ClockIcon,
  LockIcon,
  MapPinIcon,
  PencilIcon,
  RepeatIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { useDeleteEvent, useVisibleCalendars } from '@/hooks/queries'
import { usePrefs } from '@/hooks/usePrefs'
import { eventTitle } from '@/lib/events'
import { formatEventSpan, timePattern } from '@/lib/format'
import { browserTimeZone } from '@/lib/locale'
import { recurrenceFromRRule } from '@/lib/rrule'
import { useUi, type DetailState } from '@/stores/ui'

/** Popover with the details of the selected event (read, edit, delete). */
export function EventDetailsPopover() {
  const detail = useUi((s) => s.detail)
  const openDetail = useUi((s) => s.openDetail)
  if (!detail) return null
  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) openDetail(null)
      }}
    >
      <Details key={detail.event.key} detail={detail} />
    </Popover>
  )
}

function Details({ detail }: { detail: DetailState }) {
  const { t } = useTranslation()
  const prefs = usePrefs()
  const { byId } = useVisibleCalendars()
  const openDetail = useUi((s) => s.openDetail)
  const openEditor = useUi((s) => s.openEditor)
  const del = useDeleteEvent()
  const [confirming, setConfirming] = useState(false)
  const { event, anchor } = detail
  const calendar = byId.get(event.calendarId)
  const readOnly = calendar?.readOnly ?? true
  const tz = useMemo(() => browserTimeZone(), [])
  const virtualRef = useMemo(() => ({ current: anchor }), [anchor])
  const title = eventTitle(event, t('event.untitled'))
  const recurrence = recurrenceFromRRule(event.rrule)

  const otherZone =
    !event.allDay && event.timezone && event.timezone !== tz
      ? `${formatInTimeZone(event.startsAt, event.timezone, timePattern(prefs.hourCycle), { locale: prefs.locale })} – ${formatInTimeZone(event.endsAt, event.timezone, timePattern(prefs.hourCycle), { locale: prefs.locale })} (${event.timezone})`
      : null

  return (
    <>
      <PopoverAnchor virtualRef={virtualRef} />
      <PopoverContent
        className="w-[min(24rem,calc(100vw-2rem))] p-0"
        side="right"
        align="start"
        aria-label={title}
        onCloseAutoFocus={(e) => {
          e.preventDefault()
          if (anchor.isConnected) anchor.focus()
        }}
      >
        <div className="flex items-center justify-end gap-1 px-2 pt-2">
          {!readOnly && (
            <>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('event.edit')}
                onClick={() => {
                  openEditor({ mode: 'edit', event })
                }}
              >
                <PencilIcon aria-hidden />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('event.delete')}
                onClick={() => {
                  setConfirming(true)
                }}
              >
                <Trash2Icon aria-hidden />
              </Button>
            </>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('common.close')}
            onClick={() => {
              openDetail(null)
            }}
          >
            <XIcon aria-hidden />
          </Button>
        </div>
        <div className="grid gap-3 px-5 pt-1 pb-5">
          <div className="flex items-start gap-3">
            <span className="mt-1.5 size-3.5 shrink-0 rounded-sm" style={{ backgroundColor: calendar?.color }} aria-hidden />
            <h2 className="font-display text-lg leading-snug font-semibold [overflow-wrap:anywhere]">{title}</h2>
          </div>
          <Row icon={<ClockIcon aria-hidden />}>
            <span className="tabular">{formatEventSpan(event, prefs, t('event.allDay'))}</span>
            {otherZone && <span className="block text-xs text-muted-foreground">{otherZone}</span>}
          </Row>
          {event.recurring && (
            <Row icon={<RepeatIcon aria-hidden />}>
              {recurrence === 'custom' ? t('recurrence.customRule', { rule: event.rrule }) : t(`recurrence.${recurrence}`)}
            </Row>
          )}
          {event.location && (
            <Row icon={<MapPinIcon aria-hidden />}>
              <span className="[overflow-wrap:anywhere]">{event.location}</span>
            </Row>
          )}
          {event.description && (
            <Row icon={<AlignLeftIcon aria-hidden />}>
              {/* Plain text only (NFR-29): never interpret as HTML. */}
              <p className="scrollbar-thin max-h-48 overflow-y-auto whitespace-pre-wrap [overflow-wrap:anywhere]">
                {event.description}
              </p>
            </Row>
          )}
          <Row icon={<CalendarIcon aria-hidden />}>
            {calendar?.name ?? t('event.unknownCalendar')}
            {readOnly && (
              <span className="ml-2 inline-flex items-center gap-1 text-xs text-muted-foreground">
                <LockIcon className="size-3" aria-hidden />
                {t('calendars.readOnly')}
              </span>
            )}
          </Row>

          {confirming && (
            <div role="alertdialog" aria-label={t('event.delete')} className="grid gap-3 rounded-md bg-muted p-3">
              <p className="text-sm">{event.recurring ? t('event.confirmDeleteSeries') : t('event.confirmDelete')}</p>
              <div className="flex justify-end gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setConfirming(false)
                  }}
                >
                  {t('common.cancel')}
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  autoFocus
                  onClick={() => {
                    del.mutate(event)
                    openDetail(null)
                  }}
                >
                  {t('event.delete')}
                </Button>
              </div>
            </div>
          )}
        </div>
      </PopoverContent>
    </>
  )
}

function Row({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[1.25rem_1fr] items-start gap-3 text-sm">
      <span className="mt-0.5 text-muted-foreground [&_svg]:size-4">{icon}</span>
      <div className="min-w-0">{children}</div>
    </div>
  )
}
