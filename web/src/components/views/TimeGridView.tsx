import { useDroppable } from '@dnd-kit/core'
import { addDays, format, isSameDay } from 'date-fns'
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { DraftBlock } from '@/components/create/DraftBlock'
import { useDndState, useScopePreview } from '@/components/dnd/dndState'
import { CorruptedEvent } from '@/components/events/CorruptedEvent'
import { EventBoundary } from '@/components/events/EventBoundary'
import { EventBar, ResizeHandle, TimedBlock } from '@/components/events/EventItems'
import { TaskBundle } from '@/components/tasks/TaskBundle'
import { TaskBar, TaskBlock } from '@/components/tasks/TaskItems'
import { type EventColors } from '@/hooks/useCalendarColors'
import { type Calendar, type CorruptedItem } from '@/lib/api/schemas'
import { canDrag, TASK_POINT_MINUTES, type CalTask } from '@/lib/calendarTasks'
import { atMinutes, dayKey, minutesOfDay } from '@/lib/dates'
import { HOUR_HEIGHT, PX_PER_MINUTE, type DragBinding, type DropData } from '@/lib/dnd'
import { type CalItem } from '@/lib/events'
import { formatHour, formatShortTime, formatTime, type FormatPrefs } from '@/lib/format'
import {
  cellRowsUsed,
  columnBox,
  columnCapacity,
  layoutDayWithin,
  layoutWeekRow,
  overflowColumnPx,
  timedSegments,
  type BarSegment,
  type CellLayout,
  type OverflowEntry,
} from '@/lib/layout'
import { cn } from '@/lib/utils'
import { useUi, type CreateState } from '@/stores/ui'
import { MoreButton } from './MoreButton'
import { useDragCreate } from './useDragCreate'

const HOURS = Array.from({ length: 24 }, (_, h) => h)
/** Width of the hour gutter left of the day columns (`3.5rem`). */
const GUTTER_PX = 56
/** Below this width a bundle in the time grid shows two rings and the bare number (FR-07). */
const COMPACT_BUNDLE_PX = 72
/** Rows of the all-day row at most: it never pushes the time grid away (FR-07). */
const ALL_DAY_ROWS = 3
const ROW_PX = 22
/** Top of a row of the all-day row, below its 3 px padding. */
const rowTop = (row: number) => 3 + row * ROW_PX
/** The box of an entry of the all-day row `span` days wide from `row`; its bundle and "N more" line up with its bars. */
const rowBox = (row: number, span = 1): CSSProperties => ({
  top: rowTop(row),
  left: 2,
  width: `calc(${span * 100}% + ${span - 1}px - 4px)`,
})
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
  const setDate = useUi((s) => s.setDate)
  const setView = useUi((s) => s.setView)
  const openCreate = useUi((s) => s.openCreate)
  // Times, not the preview: typing its title must not re-render the grid, only the draft (ColumnDraft).
  const allDayStart = useUi((s) => (s.createPreview?.allDay ? s.createPreview.startsAt.getTime() : null))
  const allDayEnd = useUi((s) => (s.createPreview?.allDay ? s.createPreview.endsAt.getTime() : null))
  const scrollRef = useRef<HTMLDivElement>(null)

  // Measure the day columns to know how many columns of entries fit side by side in each (FR-07).
  const gridRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = gridRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width)
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
    }
  }, [])
  const colWidth = Math.max(0, (width - GUTTER_PX) / days.length)
  const capacity = columnCapacity(colWidth)

  // A dropped event of a series shows at its new place while it waits for its answer (FR-17).
  const shown = useScopePreview(events)
  const allDayEvents = useMemo(() => shown.filter(inAllDayRow), [shown])
  const timedEvents = useMemo(() => shown.filter((e) => !inAllDayRow(e)), [shown])
  const allDay = useMemo(() => layoutWeekRow(days, allDayEvents, ALL_DAY_ROWS), [days, allDayEvents])
  const allDayHeight = Math.max(1, ...allDay.cells.map(cellRowsUsed)) * ROW_PX + 6

  // Scroll to ~08:00 on first render (and when switching between week/day).
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = 8 * HOUR_HEIGHT - 8
  }, [days.length])

  const cols = `3.5rem repeat(${days.length}, minmax(0, 1fr))`
  const readOnly = (id: string) => calendarOf(id)?.readOnly ?? true

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
        <div className="py-1 pr-2 text-right text-[0.6875rem] text-muted-foreground">{t('event.allDay')}</div>
        {allDay.cells.map((cell, c) => (
          <AllDayCell
            key={dayKey(cell.day)}
            cell={cell}
            bars={allDay.bars.filter((b) => b.startCol === c)}
            height={allDayHeight}
            draft={allDayStart !== null && allDayEnd !== null && allDayStart < addDays(cell.day, 1).getTime() && allDayEnd > cell.day.getTime()}
            prefs={prefs}
            colorsOf={colorsOf}
            readOnly={readOnly}
            onCreate={(day, target) => {
              const start = atMinutes(day, 0)
              openCreate({
                origin: { start, end: start, allDay: true, granularity: 'day', ranged: false },
                anchor: target,
                returnFocus: target,
              })
            }}
          />
        ))}
      </div>

      {/* Time grid */}
      <div ref={scrollRef} className="scrollbar-thin relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]">
        <div ref={gridRef} className="grid" style={{ gridTemplateColumns: cols, height: 24 * HOUR_HEIGHT }}>
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
              capacity={capacity}
              colWidth={colWidth}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * A day of the all-day row: its bars, below them its single-day tasks, bundled where they don't fit, and "N more" for
 * the events that still don't (FR-07).
 */
function AllDayCell({
  cell,
  bars,
  height,
  draft,
  prefs,
  colorsOf,
  readOnly,
  onCreate,
}: {
  cell: CellLayout
  /** The bars starting in this cell. */
  bars: BarSegment[]
  height: number
  /** The create popover's all-day entry covers this day. */
  draft: boolean
  prefs: FormatPrefs
  colorsOf: (id: string) => EventColors
  readOnly: (calendarId: string) => boolean
  onCreate: (day: Date, target: HTMLElement) => void
}) {
  const { t } = useTranslation()
  const { pendingTodos } = useDndState()
  const { day } = cell
  const key = dayKey(day)
  const { setNodeRef, isOver } = useDroppable({
    id: `alldaycell:${key}`,
    data: { type: 'day', day } satisfies DropData,
  })
  // The cell's create button, which covers it, is where the lists of its bundle and "N more" point and give the focus
  // to once their button is gone (NFR-27): it takes the focus, which the cell itself does not.
  const createRef = useRef<HTMLButtonElement | null>(null)
  const date = format(day, 'PPPP', { locale: prefs.locale })
  // A task's own eligibility (FR-17), on top of its calendar's, decides whether it can be dragged.
  const taskDisabled = (task: CalTask) => readOnly(task.calendarId) || !canDrag(task) || pendingTodos.has(task.todo.id)
  const drag = (e: CalItem, disabled: boolean): DragBinding => ({
    id: `allday:${e.key}:${key}`,
    data: { type: 'event', event: e, originDay: day },
    disabled,
  })
  /** An entry of the cell, as a bar `span` columns wide from `row`. */
  const entry = (e: CalItem, row: number, span = 1, continuesBefore = false, continuesAfter = false) => {
    const style = rowBox(row, span)
    return (
      <EventBoundary key={e.key} item={e} className="absolute inset-x-1">
        {e.kind === 'task' ? (
          <TaskBar
            task={e}
            colors={colorsOf(e.calendarId)}
            prefs={prefs}
            readOnly={readOnly(e.calendarId)}
            drag={drag(e, taskDisabled(e))}
            continuesBefore={continuesBefore}
            continuesAfter={continuesAfter}
            className="absolute z-10"
            style={style}
          />
        ) : (
          <EventBar
            event={e}
            colors={colorsOf(e.calendarId)}
            prefs={prefs}
            continuesBefore={continuesBefore}
            continuesAfter={continuesAfter}
            drag={drag(e, readOnly(e.calendarId))}
            className="absolute z-10"
            style={style}
          />
        )}
      </EventBoundary>
    )
  }

  return (
    <div
      ref={setNodeRef}
      data-draft={draft ? '' : undefined}
      className={cn('relative border-l border-grid', (isOver || draft) && 'bg-primary/8')}
      style={{ height }}
    >
      <button
        ref={createRef}
        type="button"
        tabIndex={-1}
        aria-label={t('week.newAllDay', { date })}
        onClick={(e) => {
          onCreate(day, e.currentTarget)
        }}
        className="absolute inset-0 cursor-default outline-none"
      />
      {bars.map((b) => entry(b.event, b.lane, b.span, b.continuesBefore, b.continuesAfter))}
      {cell.rows.map((row, i) => {
        if (row.type === 'item') return entry(row.item, cell.barRows + i)
        const tasks = row.items.filter((e): e is CalTask => e.kind === 'task')
        return (
          <TaskBundle
            key="bundle"
            variant="tile"
            id={`bundle:allday:${key}`}
            day={day}
            tasks={tasks}
            drag="event"
            home={() => createRef.current}
            colorsOf={colorsOf}
            label={t('bundle.label', { count: tasks.length, date })}
            // Rounded like the bars around it.
            className="absolute z-10 h-5 rounded-sm"
            style={rowBox(cell.barRows + i)}
          />
        )
      })}
      {cell.more.length > 0 && (
        <MoreButton
          variant="text"
          id={`more:allday:${key}`}
          day={day}
          items={cell.more}
          count={cell.more.length}
          drag="event"
          home={() => createRef.current}
          label={t('more.label', { count: cell.more.length, date })}
          className="absolute z-10"
          style={rowBox(cellRowsUsed(cell) - 1)}
        />
      )}
    </div>
  )
}

/**
 * A day of the time grid: its entries side by side in at most `capacity` columns, and where more meet than fit, the
 * overflow column with its tasks bundled and "+N" for the events that still don't fit (FR-07).
 */
function DayColumn({
  day,
  now,
  events,
  corrupted,
  prefs,
  colorsOf,
  readOnly,
  onCreate,
  capacity,
  colWidth,
}: {
  day: Date
  now: Date
  events: CalItem[]
  corrupted: CorruptedItem[]
  prefs: FormatPrefs
  colorsOf: (id: string) => EventColors
  readOnly: (calendarId: string) => boolean
  onCreate: (state: CreateState) => void
  /** Columns of entries that fit side by side (`columnCapacity`). */
  capacity: number
  /** The column's width in px, 0 before it is measured. */
  colWidth: number
}) {
  const { t } = useTranslation()
  const { resize, pendingTodos } = useDndState()
  const column = useRef<HTMLDivElement>(null)
  const key = dayKey(day)
  const { setNodeRef, isOver } = useDroppable({
    id: `col:${key}`,
    data: { type: 'column', day, ref: column } satisfies DropData,
  })
  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      column.current = el
      setNodeRef(el)
    },
    [setNodeRef],
  )
  const layout = useMemo(() => layoutDayWithin(timedSegments(events, day), capacity), [events, day, capacity])
  // Where a cluster has an overflow column, it is drawn slim and the cluster's other columns share the rest (FR-07).
  const overflowPx = overflowColumnPx(layout.overflow)
  const across = (col: number, span: number, cols: number, withOverflow: boolean) =>
    columnBox({ col, span, cols }, withOverflow, colWidth, overflowPx)
  const today = isSameDay(day, now)
  const date = format(day, 'PPPP', { locale: prefs.locale })
  // The column is where the lists of its bundles and "+N" point and give the focus to once their button is gone
  // (NFR-27); it takes the focus without being a tab stop.
  const home = () => column.current
  const taskBlock = (e: CalTask, size: 'xs' | 'sm' | 'md', style: CSSProperties) => {
    const ro = readOnly(e.calendarId)
    return (
      <TaskBlock
        task={e}
        colors={colorsOf(e.calendarId)}
        prefs={prefs}
        readOnly={ro}
        drag={{
          id: `timed:${e.key}:${key}`,
          data: { type: 'timed', event: e, originDay: day },
          // A task's own eligibility (FR-17), on top of its calendar's, decides whether it can be dragged.
          disabled: ro || !canDrag(e) || pendingTodos.has(e.todo.id),
        }}
        size={size}
        style={style}
      />
    )
  }
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
    <div ref={ref} tabIndex={-1} className={cn('relative border-l border-grid outline-none', isOver && 'bg-primary/5')}>
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

      {layout.placed.map((p) => {
        const e = p.event
        const resized = e.kind === 'event' && resize?.key === e.key ? resize : null
        // A segment continuing into the next day keeps its height; only the last one grows.
        const preview = resized && !p.clippedEnd ? (resized.endsAt.getTime() - e.endsAt.getTime()) / 60_000 : 0
        const top = p.startMin * PX_PER_MINUTE
        const height = Math.max(18, (p.endMin - p.startMin + preview) * PX_PER_MINUTE - 2)
        const box = across(p.col, p.span, p.cols, p.withOverflow === true)
        const ro = readOnly(e.calendarId)
        const size = height < 34 ? 'xs' : height < 58 ? 'sm' : 'md'
        const style = { top, height, left: `${box.left}%`, width: `calc(${box.width}% - 4px)`, zIndex: 10 + p.col }
        return (
          <EventBoundary key={e.key} item={e} className="absolute inset-x-1">
            {e.kind === 'task' ? (
              taskBlock(e, size, style)
            ) : (
              <TimedBlock
                event={resized ?? e}
                colors={colorsOf(e.calendarId)}
                prefs={prefs}
                size={size}
                drag={{ id: `timed:${e.key}:${key}`, data: { type: 'timed', event: e, originDay: day }, disabled: ro }}
                style={style}
              >
                <ResizeHandle event={e} disabled={ro || p.clippedEnd} />
              </TimedBlock>
            )}
          </EventBoundary>
        )
      })}

      {layout.overflow.map((entry) => {
        // One point high, at its stack's place in the overflow column (FR-07).
        const box = across(entry.col, 1, entry.cols, true)
        const style: CSSProperties = {
          top: entry.topMin * PX_PER_MINUTE,
          height: TASK_POINT_MINUTES * PX_PER_MINUTE - 2,
          left: `${box.left}%`,
          width: `calc(${box.width}% - 4px)`,
          zIndex: 10 + entry.col,
        }
        const [only] = entry.items
        // A bundle of one is the task itself.
        if (entry.kind === 'tasks' && entry.items.length === 1 && only?.kind === 'task') {
          return (
            <EventBoundary key={only.key} item={only} className="absolute inset-x-1">
              {taskBlock(only, 'xs', style)}
            </EventBoundary>
          )
        }
        return (
          <OverflowTile
            key={`${entry.kind}:${entry.topMin}`}
            entry={entry}
            day={day}
            date={date}
            columnPx={(box.width / 100) * colWidth}
            prefs={prefs}
            colorsOf={colorsOf}
            home={home}
            style={style}
          />
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

/**
 * An entry of a day column's overflow column (FR-07): a bundle of its tasks, compact where the column has no room for
 * the words, or "+N" for its events. Both open their list, whose rows land at the time they are dropped at.
 */
function OverflowTile({
  entry,
  day,
  date,
  columnPx,
  prefs,
  colorsOf,
  home,
  style,
}: {
  entry: OverflowEntry
  day: Date
  /** The day as the labels name it. */
  date: string
  /** Width of the overflow column it is drawn in, px. */
  columnPx: number
  prefs: FormatPrefs
  colorsOf: (id: string) => EventColors
  home: () => HTMLElement | null
  style: CSSProperties
}) {
  const { t } = useTranslation()
  const id = `${dayKey(day)}:${entry.topMin}`
  const count = entry.items.length
  const time = formatTime(atMinutes(day, entry.startMin), prefs)
  if (entry.kind === 'events') {
    return (
      <MoreButton
        variant="tile"
        id={`more:col:${id}`}
        day={day}
        items={entry.items}
        count={count}
        drag="listed"
        home={home}
        label={t('more.eventsAt', { count, time, date })}
        className="absolute"
        style={style}
      />
    )
  }
  const compact = columnPx < COMPACT_BUNDLE_PX
  return (
    <TaskBundle
      variant="tile"
      compact={compact}
      id={`bundle:col:${id}`}
      day={day}
      tasks={entry.items.filter((e): e is CalTask => e.kind === 'task')}
      drag="listed"
      home={home}
      colorsOf={colorsOf}
      label={t('bundle.labelAt', { count, time, date })}
      // Centred like "+N" below it; compact, the number keeps close to its rings, so a 40 px tile holds two digits.
      className={cn('absolute justify-center', compact && 'gap-0.5 px-0')}
      style={style}
    />
  )
}

/** The create popover's entry in a day column: the only part of the grid that follows each keystroke of its title. */
function ColumnDraft({ day, colorsOf, prefs }: { day: Date; colorsOf: (id: string) => EventColors; prefs: FormatPrefs }) {
  const preview = useUi((s) => s.createPreview)
  if (!preview) return null
  return <DraftBlock item={preview} day={day} colors={colorsOf(preview.calendarId)} prefs={prefs} />
}
