import { useDroppable } from '@dnd-kit/core'
import { addDays, addMonths, format, isSameDay, isSameMonth, startOfDay } from 'date-fns'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { CorruptedEvent } from '@/components/events/CorruptedEvent'
import { EventBoundary } from '@/components/events/EventBoundary'
import { EventBar, EventChip } from '@/components/events/EventItems'
import { TaskBar, TaskChip } from '@/components/tasks/TaskItems'
import { type EventColors } from '@/hooks/useCalendarColors'
import { type CorruptedItem, type Calendar } from '@/lib/api/schemas'
import { dayKey, monthGrid } from '@/lib/dates'
import { type DropData } from '@/lib/dnd'
import { type CalItem } from '@/lib/events'
import { weekdayNames, type FormatPrefs } from '@/lib/format'
import { cellCapacity, layoutWeekRow, type CellLayout, type WeekRowLayout } from '@/lib/layout'
import { cn } from '@/lib/utils'
import { useUi } from '@/stores/ui'
import { MoreEventsPopover } from './MoreEventsPopover'
import { defaultCreateTimes } from './createDefaults'

const HEADER_PX = 30
const ROW_PX = 22

interface Props {
  date: Date
  now: Date
  events: CalItem[]
  corrupted: CorruptedItem[]
  prefs: FormatPrefs
  colorsOf: (calendarId: string) => EventColors
  calendarOf: (calendarId: string) => Calendar | undefined
}

export function MonthView({ date, now, events, corrupted, prefs, colorsOf, calendarOf }: Props) {
  const { t } = useTranslation()
  const setDate = useUi((s) => s.setDate)
  const setView = useUi((s) => s.setView)
  const openCreate = useUi((s) => s.openCreate)
  // The day, not the preview: typing its title must not re-render the month.
  const draftDay = useUi((s) => (s.createPreview ? dayKey(s.createPreview.startsAt) : null))
  const weeks = useMemo(() => monthGrid(date, prefs.weekStartsOn), [date, prefs.weekStartsOn])
  const names = weekdayNames(prefs)

  // Measure a week row to know how many event rows fit per cell.
  const firstRowRef = useRef<HTMLDivElement>(null)
  const [rowHeight, setRowHeight] = useState(0)
  useLayoutEffect(() => {
    const el = firstRowRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setRowHeight(entry.contentRect.height)
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
    }
  }, [])
  const capacity = cellCapacity(rowHeight, HEADER_PX, ROW_PX)

  const layouts = useMemo(
    () => weeks.map((days) => layoutWeekRow(days, events, capacity)),
    [weeks, events, capacity],
  )

  const corruptedByDay = useMemo(() => {
    const m = new Map<string, CorruptedItem[]>()
    for (const c of corrupted) {
      if (!c.start) continue
      const k = dayKey(c.start)
      m.set(k, [...(m.get(k) ?? []), c])
    }
    return m
  }, [corrupted])

  // Roving focus for the grid (WAI-ARIA grid pattern).
  const [focusKey, setFocusKey] = useState<string>(() => dayKey(isSameMonth(now, date) ? now : date))
  const allDays = weeks.flat()
  const focusInGrid = allDays.some((d) => dayKey(d) === focusKey)
  const effectiveFocus = focusInGrid ? focusKey : dayKey(isSameMonth(now, date) ? now : startOfDay(date))
  const gridRef = useRef<HTMLDivElement>(null)
  const pendingFocus = useRef(false)
  useEffect(() => {
    if (!pendingFocus.current) return
    pendingFocus.current = false
    gridRef.current?.querySelector<HTMLElement>(`[data-day="${effectiveFocus}"]`)?.focus()
  }, [effectiveFocus])

  const moveFocus = (target: Date) => {
    pendingFocus.current = true
    setFocusKey(dayKey(target))
    if (!isSameMonth(target, date)) setDate(target)
  }

  // The popover points at the cell; a day's new entry starts like the "Create" button's (FR-09, FR-16).
  const create = (day: Date, cell: HTMLElement) => {
    openCreate({
      origin: { ...defaultCreateTimes(day, now), granularity: 'day', ranged: false },
      anchor: cell,
      returnFocus: cell,
    })
  }

  const onCellKeyDown = (e: KeyboardEvent<HTMLElement>, day: Date) => {
    if (e.target !== e.currentTarget) return
    const map: Record<string, () => Date> = {
      ArrowLeft: () => addDays(day, -1),
      ArrowRight: () => addDays(day, 1),
      ArrowUp: () => addDays(day, -7),
      ArrowDown: () => addDays(day, 7),
      PageUp: () => addMonths(day, -1),
      PageDown: () => addMonths(day, 1),
      Home: () => addDays(day, -((day.getDay() - prefs.weekStartsOn + 7) % 7)),
      End: () => addDays(day, 6 - ((day.getDay() - prefs.weekStartsOn + 7) % 7)),
    }
    const fn = map[e.key]
    if (fn) {
      e.preventDefault()
      moveFocus(fn())
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      create(day, e.currentTarget)
    }
  }

  return (
    <div
      ref={gridRef}
      role="grid"
      aria-label={format(date, 'LLLL yyyy', { locale: prefs.locale })}
      aria-readonly="true"
      className="flex h-full min-h-[36rem] flex-col bg-surface"
    >
      <div role="row" className="grid shrink-0 grid-cols-7 border-b border-grid">
        {names.map((n) => (
          <div
            role="columnheader"
            key={n}
            className="px-2 py-2 text-xs font-medium text-muted-foreground"
          >
            {n}
          </div>
        ))}
      </div>
      <div className="grid flex-1" style={{ gridTemplateRows: `repeat(${weeks.length}, minmax(6.25rem, 1fr))` }}>
        {layouts.map((layout, w) => (
          <WeekRow
            key={layout.cells[0] ? dayKey(layout.cells[0].day) : w}
            rowRef={w === 0 ? firstRowRef : undefined}
            layout={layout}
            date={date}
            now={now}
            prefs={prefs}
            colorsOf={colorsOf}
            calendarOf={calendarOf}
            focusKey={effectiveFocus}
            corruptedByDay={corruptedByDay}
            onCellKeyDown={onCellKeyDown}
            onCreate={create}
            draftDay={draftDay}
            onFocusDay={(d) => {
              setFocusKey(dayKey(d))
            }}
            onOpenDay={(d) => {
              setDate(d)
              setView('day')
            }}
            labelFor={(d, items) => {
              const date = format(d, 'PPPP', { locale: prefs.locale })
              const tasks = items.filter((e) => e.kind === 'task').length
              const events = items.length - tasks
              if (tasks === 0) return t('month.cellLabel', { date, count: events })
              return t('month.cellLabelTasks', { date, events: t('month.eventCount', { count: events }), count: tasks })
            }}
          />
        ))}
      </div>
    </div>
  )
}

function WeekRow({
  rowRef,
  layout,
  date,
  now,
  prefs,
  colorsOf,
  calendarOf,
  focusKey,
  corruptedByDay,
  onCellKeyDown,
  onCreate,
  draftDay,
  onFocusDay,
  onOpenDay,
  labelFor,
}: {
  rowRef: React.Ref<HTMLDivElement> | undefined
  layout: WeekRowLayout
  date: Date
  now: Date
  prefs: FormatPrefs
  colorsOf: (id: string) => EventColors
  calendarOf: (id: string) => Calendar | undefined
  focusKey: string
  corruptedByDay: Map<string, CorruptedItem[]>
  onCellKeyDown: (e: KeyboardEvent<HTMLElement>, day: Date) => void
  onCreate: (day: Date, cell: HTMLElement) => void
  /** Day (key) of the create popover's entry. */
  draftDay: string | null
  onFocusDay: (day: Date) => void
  onOpenDay: (day: Date) => void
  labelFor: (day: Date, items: CalItem[]) => string
}) {
  return (
    <div ref={rowRef} role="row" className="relative grid min-h-0 grid-cols-7 border-b border-grid last:border-b-0">
      {layout.cells.map((cell, c) => (
        <DayCell
          key={dayKey(cell.day)}
          day={cell.day}
          cell={cell}
          bars={layout.bars.filter((b) => b.startCol === c)}
          inMonth={isSameMonth(cell.day, date)}
          isToday={isSameDay(cell.day, now)}
          prefs={prefs}
          colorsOf={colorsOf}
          calendarOf={calendarOf}
          focused={focusKey === dayKey(cell.day)}
          corrupted={corruptedByDay.get(dayKey(cell.day)) ?? []}
          onKeyDown={onCellKeyDown}
          onCreate={onCreate}
          draft={draftDay === dayKey(cell.day)}
          onFocusDay={onFocusDay}
          onOpenDay={onOpenDay}
          label={labelFor(cell.day, cell.all)}
        />
      ))}
    </div>
  )
}

function DayCell({
  day,
  cell,
  bars,
  inMonth,
  isToday,
  prefs,
  colorsOf,
  calendarOf,
  focused,
  corrupted,
  onKeyDown,
  onCreate,
  draft,
  onFocusDay,
  onOpenDay,
  label,
}: {
  day: Date
  cell: CellLayout
  bars: WeekRowLayout['bars']
  inMonth: boolean
  isToday: boolean
  prefs: FormatPrefs
  colorsOf: (id: string) => EventColors
  calendarOf: (id: string) => Calendar | undefined
  focused: boolean
  corrupted: CorruptedItem[]
  onKeyDown: (e: KeyboardEvent<HTMLElement>, day: Date) => void
  onCreate: (day: Date, cell: HTMLElement) => void
  draft: boolean
  onFocusDay: (day: Date) => void
  onOpenDay: (day: Date) => void
  label: string
}) {
  const { t } = useTranslation()
  const key = dayKey(day)
  const { setNodeRef, isOver } = useDroppable({ id: `day:${key}`, data: { type: 'day', day } satisfies DropData })
  const first = day.getDate() === 1
  const readOnly = (id: string) => calendarOf(id)?.readOnly ?? true

  return (
    <div
      ref={setNodeRef}
      role="gridcell"
      tabIndex={focused ? 0 : -1}
      data-day={key}
      aria-label={label}
      aria-current={isToday ? 'date' : undefined}
      data-draft={draft ? '' : undefined}
      onKeyDown={(e) => {
        onKeyDown(e, day)
      }}
      onFocus={(e) => {
        if (e.target === e.currentTarget) onFocusDay(day)
      }}
      onClick={(e) => {
        onCreate(day, e.currentTarget)
      }}
      className={cn(
        'relative min-w-0 cursor-default border-r border-grid outline-none last:border-r-0 focus-visible:z-20 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
        !inMonth && 'bg-outside',
        (isOver || draft) && 'bg-primary/8',
      )}
    >
      <div className="flex h-[30px] items-center justify-between px-1.5 pt-1">
        <button
          type="button"
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation()
            onOpenDay(day)
          }}
          aria-label={t('month.openDay', { date: format(day, 'PPPP', { locale: prefs.locale }) })}
          className={cn(
            'tabular inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1.5 font-display text-[0.8125rem] font-semibold outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring',
            !inMonth && 'text-muted-foreground font-medium',
            isToday && 'bg-primary text-primary-foreground hover:bg-primary/90',
          )}
        >
          {first ? format(day, 'd MMM', { locale: prefs.locale }) : format(day, 'd', { locale: prefs.locale })}
        </button>
      </div>

      {bars.map((b) => {
        const e = b.event
        const style = { top: 30 + b.lane * 22, left: 4, width: `calc(${b.span * 100}% + ${b.span - 1}px - 8px)` }
        return (
          <EventBoundary key={`${e.key}:${b.startCol}`} className="absolute inset-x-1">
            {e.kind === 'task' ? (
              <TaskBar
                task={e}
                colors={colorsOf(e.calendarId)}
                prefs={prefs}
                readOnly={readOnly(e.calendarId)}
                drag={{
                  id: `bar:${e.key}:${key}`,
                  data: { type: 'event', event: e, originDay: day },
                  disabled: readOnly(e.calendarId),
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
                  id: `bar:${e.key}:${key}`,
                  data: { type: 'event', event: e, originDay: day },
                  disabled: readOnly(e.calendarId),
                }}
                className="absolute z-10"
                style={style}
              />
            )}
          </EventBoundary>
        )
      })}

      <div className="flex flex-col gap-0.5 px-1" style={{ paddingTop: cell.barRows * 22 }}>
        {cell.singles.map((e) => (
          <EventBoundary key={e.key}>
            {e.kind === 'task' ? (
              <TaskChip
                task={e}
                colors={colorsOf(e.calendarId)}
                prefs={prefs}
                readOnly={readOnly(e.calendarId)}
                drag={{
                  id: `chip:${e.key}:${key}`,
                  data: { type: 'event', event: e, originDay: day },
                  disabled: readOnly(e.calendarId),
                }}
              />
            ) : (
              <EventChip
                event={e}
                colors={colorsOf(e.calendarId)}
                prefs={prefs}
                drag={{
                  id: `chip:${e.key}:${key}`,
                  data: { type: 'event', event: e, originDay: day },
                  disabled: readOnly(e.calendarId),
                }}
              />
            )}
          </EventBoundary>
        ))}
        {corrupted.length > 0 && <CorruptedEvent reason={corrupted.map((c) => c.reason).join('\n')} />}
        {cell.hidden > 0 && (
          <MoreEventsPopover
            day={day}
            events={cell.all}
            hidden={cell.hidden}
            prefs={prefs}
            colorsOf={colorsOf}
            readOnly={readOnly}
          />
        )}
      </div>
    </div>
  )
}
