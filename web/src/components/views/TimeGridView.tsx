import { useDroppable } from '@dnd-kit/core'
import { addDays, format, isSameDay } from 'date-fns'
import { ChevronDownIcon, ChevronUpIcon } from 'lucide-react'
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DraftBlock } from '@/components/create/DraftBlock'
import { useDndState } from '@/components/dnd/dndState'
import { CorruptedEvent } from '@/components/events/CorruptedEvent'
import { EventBoundary } from '@/components/events/EventBoundary'
import { EventBar, ResizeHandle, TimedBlock } from '@/components/events/EventItems'
import { TaskBar, TaskBlock } from '@/components/tasks/TaskItems'
import { type EventColors } from '@/hooks/useCalendarColors'
import { type Calendar, type CorruptedItem } from '@/lib/api/schemas'
import { canDrag, outsideWindow, type CalTask } from '@/lib/calendarTasks'
import { atMinutes, dayKey, minutesOfDay } from '@/lib/dates'
import { HOUR_HEIGHT, PX_PER_MINUTE, type DropData } from '@/lib/dnd'
import { type CalItem } from '@/lib/events'
import { formatHour, formatShortTime, type FormatPrefs } from '@/lib/format'
import { layoutDay, layoutWeekRow, timedSegments } from '@/lib/layout'
import { cn } from '@/lib/utils'
import { useUi, type CreateState } from '@/stores/ui'
import { useDragCreate } from './useDragCreate'

const HOURS = Array.from({ length: 24 }, (_, h) => h)
const ALL_DAY_ROWS = 3
const DAY_MS = 24 * 3600 * 1000

/** Events shown in the all-day row: all-day or at least 24 hours long. */
function inAllDayRow(e: CalItem): boolean {
  return e.allDay || e.endsAt.getTime() - e.startsAt.getTime() >= DAY_MS
}

interface Props {
  days: Date[]
  now: Date
  events: CalItem[]
  corrupted: CorruptedItem[]
  prefs: FormatPrefs
  colorsOf: (calendarId: string) => EventColors
  calendarOf: (calendarId: string) => Calendar | undefined
}

export function TimeGridView({ days, now, events, corrupted, prefs, colorsOf, calendarOf }: Props) {
  const { t } = useTranslation()
  const { pendingTodos } = useDndState()
  const setDate = useUi((s) => s.setDate)
  const setView = useUi((s) => s.setView)
  const openCreate = useUi((s) => s.openCreate)
  // Times, not the preview: typing its title must not re-render the grid, only the draft (ColumnDraft).
  const allDayStart = useUi((s) => (s.createPreview?.allDay ? s.createPreview.startsAt.getTime() : null))
  const allDayEnd = useUi((s) => (s.createPreview?.allDay ? s.createPreview.endsAt.getTime() : null))
  const [expanded, setExpanded] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  const allDayEvents = useMemo(() => events.filter(inAllDayRow), [events])
  const timedEvents = useMemo(() => events.filter((e) => !inAllDayRow(e)), [events])
  const allDay = useMemo(
    () => layoutWeekRow(days, allDayEvents, expanded ? Number.POSITIVE_INFINITY : ALL_DAY_ROWS),
    [days, allDayEvents, expanded],
  )
  const overflowing = allDay.cells.some((c) => c.hidden > 0)
  const lanes = Math.max(
    1,
    allDay.bars.reduce((m, b) => Math.max(m, b.lane + 1), 0) + (overflowing ? 1 : 0),
  )

  // Scroll to ~08:00 on first render (and when switching between week/day).
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = 8 * HOUR_HEIGHT - 8
  }, [days.length])

  const cols = `3.5rem repeat(${days.length}, minmax(0, 1fr))`
  const readOnly = (id: string) => calendarOf(id)?.readOnly ?? true
  // A task's own eligibility (FR-17), on top of its calendar's, decides whether it can be dragged.
  const taskDisabled = (task: CalTask) => readOnly(task.calendarId) || !canDrag(task) || pendingTodos.has(task.todo.id)

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      {/* Day headers */}
      <div className="grid shrink-0 overflow-y-hidden border-b border-grid [scrollbar-gutter:stable]" style={{ gridTemplateColumns: cols }}>
        <div aria-hidden />
        {days.map((d) => {
          const today = isSameDay(d, now)
          return (
            <div key={dayKey(d)} className="flex flex-col items-center gap-0.5 border-l border-grid py-2">
              <span className={cn('text-xs font-medium', today ? 'text-primary' : 'text-muted-foreground')}>
                {format(d, 'EEE', { locale: prefs.locale })}
              </span>
              <button
                type="button"
                onClick={() => {
                  setDate(d)
                  setView('day')
                }}
                aria-label={t('month.openDay', { date: format(d, 'PPPP', { locale: prefs.locale }) })}
                aria-current={today ? 'date' : undefined}
                className={cn(
                  'tabular inline-flex size-9 items-center justify-center rounded-full font-display text-xl font-semibold outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring',
                  today && 'bg-primary text-primary-foreground hover:bg-primary/90',
                )}
              >
                {format(d, 'd', { locale: prefs.locale })}
              </button>
            </div>
          )
        })}
      </div>

      {/* All-day row */}
      <div className="grid shrink-0 overflow-y-hidden border-b border-grid [scrollbar-gutter:stable]" style={{ gridTemplateColumns: cols }}>
        <div className="flex flex-col items-end justify-between gap-1 py-1 pr-2 text-[0.6875rem] text-muted-foreground">
          <span>{t('event.allDay')}</span>
          {(overflowing || expanded) && (
            <button
              type="button"
              onClick={() => {
                setExpanded((v) => !v)
              }}
              aria-expanded={expanded}
              aria-label={expanded ? t('week.collapseAllDay') : t('week.expandAllDay')}
              className="rounded-sm p-0.5 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
            >
              {expanded ? <ChevronUpIcon className="size-3.5" aria-hidden /> : <ChevronDownIcon className="size-3.5" aria-hidden />}
            </button>
          )}
        </div>
        {allDay.cells.map(({ day: d, hidden }, c) => (
          <AllDayCell
            key={dayKey(d)}
            day={d}
            height={lanes * 22 + 6}
            label={t('week.newAllDay', { date: format(d, 'PPPP', { locale: prefs.locale }) })}
            draft={allDayStart !== null && allDayEnd !== null && allDayStart < addDays(d, 1).getTime() && allDayEnd > d.getTime()}
            onCreate={(day, target) => {
              const start = atMinutes(day, 0)
              openCreate({
                origin: { start, end: start, allDay: true, granularity: 'day', ranged: false },
                anchor: target,
                returnFocus: target,
              })
            }}
          >
            {allDay.bars
              .filter((b) => b.startCol === c)
              .map((b) => {
                const e = b.event
                const style = { top: 3 + b.lane * 22, left: 2, width: `calc(${b.span * 100}% + ${b.span - 1}px - 4px)` }
                return (
                  <EventBoundary key={e.key} className="absolute inset-x-1">
                    {e.kind === 'task' ? (
                      <TaskBar
                        task={e}
                        colors={colorsOf(e.calendarId)}
                        prefs={prefs}
                        readOnly={readOnly(e.calendarId)}
                        drag={{
                          id: `allday:${e.key}:${dayKey(d)}`,
                          data: { type: 'event', event: e, originDay: d },
                          disabled: taskDisabled(e),
                        }}
                        continuesBefore={b.continuesBefore}
                        continuesAfter={b.continuesAfter}
                        className="absolute z-10"
                        style={style}
                      />
                    ) : (
                      <EventBar
                        event={e}
                        colors={colorsOf(e.calendarId)}
                        prefs={prefs}
                        continuesBefore={b.continuesBefore}
                        continuesAfter={b.continuesAfter}
                        drag={{
                          id: `allday:${e.key}:${dayKey(d)}`,
                          data: { type: 'event', event: e, originDay: d },
                          disabled: readOnly(e.calendarId),
                        }}
                        className="absolute z-10"
                        style={style}
                      />
                    )}
                  </EventBoundary>
                )
              })}
            {hidden > 0 && (
              <button
                type="button"
                onClick={() => {
                  setExpanded(true)
                }}
                className="absolute inset-x-1 z-10 h-5 rounded-sm px-1 text-left text-xs font-semibold text-muted-foreground hover:bg-muted"
                style={{ top: 3 + (ALL_DAY_ROWS - 1) * 22 }}
              >
                {t('month.more', { count: hidden })}
              </button>
            )}
          </AllDayCell>
        ))}
      </div>

      {/* Time grid */}
      <div ref={scrollRef} className="scrollbar-thin relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]">
        <div className="grid" style={{ gridTemplateColumns: cols, height: 24 * HOUR_HEIGHT }}>
          <div className="relative" aria-hidden>
            {HOURS.slice(1).map((h) => (
              <span
                key={h}
                className="tabular absolute right-2 -translate-y-1/2 text-[0.6875rem] text-muted-foreground"
                style={{ top: h * HOUR_HEIGHT }}
              >
                {formatHour(h, prefs)}
              </span>
            ))}
          </div>
          {days.map((d) => (
            <DayColumn
              key={dayKey(d)}
              day={d}
              now={now}
              events={timedEvents}
              corrupted={corrupted.filter((c) => c.start && isSameDay(c.start, d))}
              prefs={prefs}
              colorsOf={colorsOf}
              readOnly={readOnly}
              onCreate={openCreate}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function AllDayCell({
  day,
  height,
  label,
  draft,
  onCreate,
  children,
}: {
  day: Date
  height: number
  label: string
  /** The create popover's all-day entry covers this day. */
  draft: boolean
  onCreate: (day: Date, target: HTMLElement) => void
  children: React.ReactNode
}) {
  const { moveWindow } = useDndState()
  const { setNodeRef, isOver } = useDroppable({
    id: `alldaycell:${dayKey(day)}`,
    data: { type: 'day', day } satisfies DropData,
  })
  // Past the move window of a bounded series being dragged (FR-17): hatch to show it's out of reach,
  // and take no drop highlight, as a drop there changes nothing.
  const hatched = moveWindow != null && outsideWindow(moveWindow, day)
  return (
    <div
      ref={setNodeRef}
      data-draft={draft ? '' : undefined}
      className={cn('relative border-l border-grid', ((isOver && !hatched) || draft) && 'bg-primary/8', hatched && 'hatched')}
      style={{ height }}
    >
      <button
        type="button"
        tabIndex={-1}
        aria-label={label}
        onClick={(e) => {
          onCreate(day, e.currentTarget)
        }}
        className="absolute inset-0 cursor-default outline-none"
      />
      {children}
    </div>
  )
}

function DayColumn({
  day,
  now,
  events,
  corrupted,
  prefs,
  colorsOf,
  readOnly,
  onCreate,
}: {
  day: Date
  now: Date
  events: CalItem[]
  corrupted: CorruptedItem[]
  prefs: FormatPrefs
  colorsOf: (id: string) => EventColors
  readOnly: (calendarId: string) => boolean
  onCreate: (state: CreateState) => void
}) {
  const { t } = useTranslation()
  const { resize, pendingTodos, moveWindow } = useDndState()
  const column = useRef<HTMLDivElement>(null)
  const { setNodeRef, isOver } = useDroppable({
    id: `col:${dayKey(day)}`,
    data: { type: 'column', day, ref: column } satisfies DropData,
  })
  // Past the move window of a bounded series being dragged (FR-17): hatch to show it's out of reach,
  // and take no drop highlight, as a drop there changes nothing.
  const hatched = moveWindow != null && outsideWindow(moveWindow, day)
  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      column.current = el
      setNodeRef(el)
    },
    [setNodeRef],
  )
  const positioned = useMemo(() => layoutDay(timedSegments(events, day)), [events, day])
  const today = isSameDay(day, now)
  const { draft, slotProps } = useDragCreate((startMin, endMin, { target, ranged }) => {
    // The popover points at the new entry's slots in this column (FR-09, FR-16).
    onCreate({
      origin: { start: atMinutes(day, startMin), end: atMinutes(day, endMin), allDay: false, granularity: 'time', ranged },
      anchor: column.current ?? target,
      span: { startMin, endMin },
      returnFocus: target,
    })
  })

  return (
    <div ref={ref} className={cn('relative border-l border-grid', isOver && !hatched && 'bg-primary/5', hatched && 'hatched')}>
      {HOURS.map((h) => (
        <button
          key={h}
          type="button"
          tabIndex={-1}
          {...slotProps(h)}
          aria-label={t('week.newAt', { time: format(atMinutes(day, h * 60), 'PPPP p', { locale: prefs.locale }) })}
          className="block w-full cursor-default border-t border-grid outline-none first:border-t-0"
          style={{ height: HOUR_HEIGHT }}
        />
      ))}

      {positioned.map((p) => {
        const e = p.event
        const resized = e.kind === 'event' && resize?.key === e.key ? resize : null
        // A segment continuing into the next day keeps its height; only the last one grows.
        const preview = resized && !p.clippedEnd ? (resized.endsAt.getTime() - e.endsAt.getTime()) / 60_000 : 0
        const top = p.startMin * PX_PER_MINUTE
        const height = Math.max(18, (p.endMin - p.startMin + preview) * PX_PER_MINUTE - 2)
        const width = (p.span / p.cols) * 100
        const left = (p.col / p.cols) * 100
        const ro = readOnly(e.calendarId)
        const size = height < 34 ? 'xs' : height < 58 ? 'sm' : 'md'
        const style = { top, height, left: `${left}%`, width: `calc(${width}% - 4px)`, zIndex: 10 + p.col }
        return (
          <EventBoundary key={e.key} className="absolute inset-x-1">
            {e.kind === 'task' ? (
              <TaskBlock
                task={e}
                colors={colorsOf(e.calendarId)}
                prefs={prefs}
                readOnly={ro}
                drag={{
                  id: `timed:${e.key}:${dayKey(day)}`,
                  data: { type: 'timed', event: e, originDay: day },
                  // A task's own eligibility (FR-17), on top of its calendar's, decides whether it can be dragged.
                  disabled: ro || !canDrag(e) || pendingTodos.has(e.todo.id),
                }}
                size={size}
                style={style}
              />
            ) : (
              <TimedBlock
                event={resized ?? e}
                colors={colorsOf(e.calendarId)}
                prefs={prefs}
                size={size}
                drag={{ id: `timed:${e.key}:${dayKey(day)}`, data: { type: 'timed', event: e, originDay: day }, disabled: ro }}
                style={style}
              >
                <ResizeHandle event={e} disabled={ro || p.clippedEnd} />
              </TimedBlock>
            )}
          </EventBoundary>
        )
      })}

      {corrupted.map((c) => (
        <CorruptedEvent
          key={c.key}
          reason={c.reason}
          className="absolute inset-x-1 z-20"
          style={{ top: c.start ? minutesOfDay(c.start) * PX_PER_MINUTE : 0 }}
        />
      ))}

      {today && (
        <div
          className="pointer-events-none absolute inset-x-0 z-30 flex items-center"
          style={{ top: minutesOfDay(now) * PX_PER_MINUTE }}
          aria-hidden
        >
          <span className="-ml-1.5 size-3 rounded-full bg-now" />
          <span className="h-0.5 flex-1 bg-now" />
        </div>
      )}

      {draft && (
        <div
          className="tabular pointer-events-none absolute inset-x-1 z-40 overflow-hidden rounded-md border-l-[3px] border-primary bg-primary/15 px-1.5 py-0.5 text-xs leading-4 font-semibold text-primary"
          style={{
            top: draft.startMin * PX_PER_MINUTE,
            height: Math.max(18, (draft.endMin - draft.startMin) * PX_PER_MINUTE - 2),
          }}
          aria-hidden
        >
          {/* Narrow columns wrap between the two times, never inside one ("2:30 PM"). */}
          {[draft.startMin, draft.endMin]
            .map((m) => formatShortTime(atMinutes(day, m), prefs).replaceAll(' ', '\u00a0'))
            .join(' – ')}
        </div>
      )}

      <ColumnDraft day={day} colorsOf={colorsOf} prefs={prefs} />
    </div>
  )
}

/** The create popover's entry in a day column: the only part of the grid that follows each keystroke of its title. */
function ColumnDraft({ day, colorsOf, prefs }: { day: Date; colorsOf: (id: string) => EventColors; prefs: FormatPrefs }) {
  const preview = useUi((s) => s.createPreview)
  if (!preview) return null
  return <DraftBlock item={preview} day={day} colors={colorsOf(preview.calendarId)} prefs={prefs} />
}
