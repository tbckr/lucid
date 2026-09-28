import { AlignLeftIcon, GlobeIcon, LockIcon, MapPinIcon, PencilIcon, RepeatIcon, Trash2Icon, XIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { useDeleteEvent, useVisibleCalendars } from '@/hooks/queries'
import { useCalendarColors } from '@/hooks/useCalendarColors'
import { usePrefs } from '@/hooks/usePrefs'
import { eventTitle, type CalEvent } from '@/lib/events'
import { formatEventWhen, type FormatPrefs } from '@/lib/format'
import { splitLinks } from '@/lib/links'
import { browserTimeZone } from '@/lib/locale'
import { detailPlacement } from '@/lib/placement'
import { describeRRule } from '@/lib/rrule'
import { useUi, type DetailState } from '@/stores/ui'

/** Popover with the details of the selected event (read, edit, delete; FR-09). */
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

const viewport = () => ({ width: window.innerWidth, height: window.innerHeight })

// The event's times in its own zone, when that is another one than the browser's.
function zoneTimes(event: CalEvent, tz: string, prefs: FormatPrefs, now: Date): string | null {
  if (event.allDay || !event.timezone || event.timezone === tz) return null
  try {
    return `${formatEventWhen(event, prefs, now, event.timezone)} (${event.timezone})`
  } catch {
    return null // not an IANA zone, e.g. a Windows name
  }
}

function Details({ detail }: { detail: DetailState }) {
  const { t } = useTranslation()
  const prefs = usePrefs()
  const { byId } = useVisibleCalendars()
  const colorsOf = useCalendarColors()
  const openDetail = useUi((s) => s.openDetail)
  const openEditor = useUi((s) => s.openEditor)
  const del = useDeleteEvent()
  const [confirming, setConfirming] = useState(false)
  const closeRef = useRef<HTMLButtonElement>(null)
  const editRef = useRef<HTMLButtonElement>(null)
  const deleteRef = useRef<HTMLButtonElement>(null)
  const keepRef = useRef<HTMLButtonElement>(null)
  const asked = useRef(false)
  const { event, anchor } = detail
  const calendar = byId.get(event.calendarId)
  const readOnly = calendar?.readOnly ?? true
  const colors = colorsOf(event.calendarId)
  const tz = useMemo(() => browserTimeZone(), [])
  const now = useMemo(() => new Date(), [])
  const title = eventTitle(event, t('event.untitled'))
  // Radix measures the anchor again on scroll and resize; the side stays the one it opened on.
  const side = useMemo(() => detailPlacement(anchor.getBoundingClientRect(), viewport()).side, [anchor])
  const virtualRef = useMemo(
    () => ({
      current: {
        getBoundingClientRect: () => DOMRect.fromRect(detailPlacement(anchor.getBoundingClientRect(), viewport()).rect),
      },
    }),
    [anchor],
  )
  const repeats = event.rrule
    ? (describeRRule(event.rrule, event.startsAt, prefs, now, t) ?? t('recurrence.customRule', { rule: event.rrule }))
    : t('event.recurring')
  const inZone = zoneTimes(event, tz, prefs, now)
  const hasDetails = [event.recurring, inZone, event.location, event.description].some(Boolean)

  useEffect(() => {
    // The footer asks in place: focus its "Cancel", and "Delete event" again once it is back (NFR-27).
    if (confirming) keepRef.current?.focus()
    else if (asked.current) deleteRef.current?.focus()
    asked.current = confirming
  }, [confirming])

  return (
    <>
      <PopoverAnchor virtualRef={virtualRef} />
      <PopoverContent
        className="w-[min(24rem,calc(100vw-2rem))] overflow-hidden p-0"
        side={side}
        align="start"
        aria-label={title}
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          ;(editRef.current ?? closeRef.current)?.focus()
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault()
          if (anchor.isConnected) anchor.focus()
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
          <button
            ref={closeRef}
            type="button"
            aria-label={t('common.close')}
            onClick={() => {
              openDetail(null)
            }}
            className="absolute top-3 right-3 rounded-md p-1.5 transition-colors outline-none hover:bg-current/10 focus-visible:ring-[3px] focus-visible:ring-current/50 [&_svg]:size-4"
          >
            <XIcon aria-hidden />
          </button>
        </div>

        <div className="grid gap-4 p-4 empty:hidden">
          {hasDetails && (
            <div className="grid gap-3 text-sm">
              {event.recurring && <Row icon={<RepeatIcon />}>{repeats}</Row>}
              {inZone && (
                <Row icon={<GlobeIcon />}>
                  <span className="text-muted-foreground">{inZone}</span>
                </Row>
              )}
              {event.location && (
                <Row icon={<MapPinIcon />}>
                  <span className="[overflow-wrap:anywhere]">
                    <Linked text={event.location} />
                  </span>
                </Row>
              )}
              {event.description && (
                <Row icon={<AlignLeftIcon />}>
                  <p className="scrollbar-thin max-h-48 overflow-y-auto whitespace-pre-wrap [overflow-wrap:anywhere]">
                    <Linked text={event.description} />
                  </p>
                </Row>
              )}
            </div>
          )}

          {!readOnly &&
            (confirming ? (
              <div role="alert" className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium">
                  {event.recurring ? t('event.confirmDeleteSeries') : t('event.confirmDelete')}
                </p>
                <div className="ml-auto flex gap-2">
                  <Button
                    ref={keepRef}
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
                    onClick={() => {
                      del.mutate(event)
                      openDetail(null)
                    }}
                  >
                    {t('event.delete')}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-2">
                {/* The trash hangs in the icon column of the rows above. */}
                <Button
                  ref={deleteRef}
                  size="sm"
                  variant="ghost"
                  className="-ml-2.5 text-destructive"
                  onClick={() => {
                    setConfirming(true)
                  }}
                >
                  <Trash2Icon aria-hidden />
                  {t('event.delete')}
                </Button>
                <Button
                  ref={editRef}
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    openEditor({ mode: 'edit', event })
                  }}
                >
                  <PencilIcon aria-hidden />
                  {t('event.edit')}
                </Button>
              </div>
            ))}
        </div>
      </PopoverContent>
    </>
  )
}

function Row({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[1.25rem_1fr] items-start gap-3">
      <span className="mt-0.5 text-muted-foreground [&_svg]:size-4" aria-hidden>
        {icon}
      </span>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

/** Plain text whose web addresses are links: elements, never HTML (NFR-29). */
function Linked({ text }: { text: string }) {
  return splitLinks(text).map((part, i) =>
    part.href ? (
      <a
        key={i}
        href={part.href}
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
      >
        {part.text}
      </a>
    ) : (
      part.text
    ),
  )
}
