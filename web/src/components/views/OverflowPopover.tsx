import { useDndMonitor, type UniqueIdentifier } from '@dnd-kit/core'
import { useVirtualizer } from '@tanstack/react-virtual'
import { format } from 'date-fns'
import { useMemo, useRef, useState } from 'react'
import { useDndState } from '@/components/dnd/dndState'
import { EventBoundary } from '@/components/events/EventBoundary'
import { EventBar, EventChip } from '@/components/events/EventItems'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { TaskChip } from '@/components/tasks/TaskItems'
import { type EventColors } from '@/hooks/useCalendarColors'
import { canDrag } from '@/lib/calendarTasks'
import { type DragBinding } from '@/lib/dnd'
import { isSpanning, type CalItem } from '@/lib/events'
import { type FormatPrefs } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useUi, type OverflowState } from '@/stores/ui'

const ROW = 28
/** Lists with more entries than this are virtualized (NFR-25). */
export const VIRTUALIZE_THRESHOLD = 10
/** Starts the drag IDs of the list's rows, which tell a drag out of the list from any other (FR-10). */
const DRAG_ID = 'overflow:'

function isRow(id: UniqueIdentifier): boolean {
  return String(id).startsWith(DRAG_ID)
}

/** A row as its tile in the month is: a task with its checkbox (FR-16), an event as a chip, or a bar for a long one. */
function Entry({
  item,
  day,
  colors,
  prefs,
  readOnly,
  onOpen,
}: {
  item: CalItem
  day: Date
  colors: EventColors
  prefs: FormatPrefs
  readOnly: boolean
  onOpen: (item: CalItem) => void
}) {
  const { pendingTodos } = useDndState()
  const bind = (disabled: boolean): DragBinding => ({
    id: `${DRAG_ID}${item.key}`,
    data: { type: 'event', event: item, originDay: day },
    disabled,
  })
  if (item.kind === 'task') {
    // A task's own eligibility (FR-17), on top of its calendar's, decides whether it can be dragged.
    const disabled = readOnly || !canDrag(item) || pendingTodos.has(item.todo.id)
    return <TaskChip task={item} colors={colors} prefs={prefs} readOnly={readOnly} className="h-6" onOpen={onOpen} drag={bind(disabled)} />
  }
  return isSpanning(item) ? (
    <EventBar event={item} colors={colors} prefs={prefs} className="h-6 w-full" onOpen={onOpen} drag={bind(readOnly)} />
  ) : (
    <EventChip event={item} colors={colors} prefs={prefs} className="h-6" onOpen={onOpen} drag={bind(readOnly)} />
  )
}

interface RowsProps {
  items: CalItem[]
  day: Date
  prefs: FormatPrefs
  colorsOf: (calendarId: string) => EventColors
  readOnly: (calendarId: string) => boolean
  onOpen: (item: CalItem) => void
}

function Rows({ items, day, prefs, colorsOf, readOnly, onOpen }: RowsProps) {
  return (
    <ul className="flex flex-col gap-1">
      {items.map((e) => (
        <li key={e.key}>
          <EventBoundary item={e}>
            <Entry item={e} day={day} colors={colorsOf(e.calendarId)} prefs={prefs} readOnly={readOnly(e.calendarId)} onOpen={onOpen} />
          </EventBoundary>
        </li>
      ))}
    </ul>
  )
}

/** Virtualized list for busy days (NFR-25); mounted only while the popover is open. */
function VirtualList({ items, day, prefs, colorsOf, readOnly, onOpen }: RowsProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual is not compiler-safe yet
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW,
    overscan: 6,
    initialRect: { width: 240, height: 288 },
  })
  return (
    <div ref={scrollRef} className="scrollbar-thin max-h-72 overflow-y-auto" data-testid="more-virtual">
      <ul className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((v) => {
          const e = items[v.index]
          if (!e) return null
          return (
            <li
              key={e.key}
              className="absolute inset-x-0 top-0"
              style={{ height: v.size, transform: `translateY(${v.start}px)` }}
            >
              <EventBoundary item={e}>
                <Entry item={e} day={day} colors={colorsOf(e.calendarId)} prefs={prefs} readOnly={readOnly(e.calendarId)} onOpen={onOpen} />
              </EventBoundary>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/**
 * The list behind a "+N" or "N more" button (FR-07), open while the store says so. It keeps the entries the button
 * stood for until it is closed, each row live (`lookup` finds its entry as the calendar has it now, a task that
 * has been ticked off or left the calendar included), so ticking off several tasks in a row does not close it. It
 * points at its button, or where the button was once it is gone. Rows drag like their tiles in the grid (FR-10):
 * the list hides while one is dragged out of it and closes when the drag ends.
 */
export function OverflowPopover({
  prefs,
  colorsOf,
  readOnly,
  lookup,
}: {
  prefs: FormatPrefs
  colorsOf: (calendarId: string) => EventColors
  readOnly: (calendarId: string) => boolean
  lookup: (key: string) => CalItem | undefined
}) {
  const overflow = useUi((s) => s.overflow)
  const openOverflow = useUi((s) => s.openOverflow)
  // What was open last: the list fades out as it was, and the focus finds its way back from it.
  const [shown, setShown] = useState(overflow)
  // Hidden for a drag out of the list, and until the list opens again: it closes with the drop and fades out unseen.
  const [dragging, setDragging] = useState(false)
  if (overflow && overflow !== shown) {
    setShown(overflow)
    setDragging(false)
  }

  useDndMonitor({
    onDragStart: ({ active }) => {
      if (isRow(active.id)) setDragging(true)
    },
    onDragEnd: ({ active }) => {
      if (isRow(active.id)) openOverflow(null)
    },
    onDragCancel: ({ active }) => {
      if (isRow(active.id)) openOverflow(null)
    },
  })

  return (
    <Popover
      open={overflow !== null}
      onOpenChange={(open) => {
        if (!open) openOverflow(null)
      }}
    >
      {shown && (
        <OverflowList
          state={shown}
          dragging={dragging}
          prefs={prefs}
          colorsOf={colorsOf}
          readOnly={readOnly}
          lookup={lookup}
        />
      )}
    </Popover>
  )
}

function OverflowList({
  state,
  dragging,
  prefs,
  colorsOf,
  readOnly,
  lookup,
}: {
  state: OverflowState
  dragging: boolean
  prefs: FormatPrefs
  colorsOf: (calendarId: string) => EventColors
  readOnly: (calendarId: string) => boolean
  lookup: (key: string) => CalItem | undefined
}) {
  const openOverflow = useUi((s) => s.openOverflow)
  const openDetail = useUi((s) => s.openDetail)
  const { anchor, home, rect, day, items } = state
  // A row stays when its entry has left the calendar; it shows the entry as it was.
  const rows = useMemo(() => items.map((item) => lookup(item.key) ?? item), [items, lookup])
  // Points at the button, or where it was while it is not on the page; floating-ui follows the scrolling of `home`.
  const virtualRef = useMemo(
    () => ({
      current: {
        getBoundingClientRect: () => (anchor.isConnected ? anchor.getBoundingClientRect() : rect),
        contextElement: home,
      },
    }),
    [anchor, home, rect],
  )
  const place = () => (anchor.isConnected ? anchor : home)

  // The list closes with the row, and the details stay at the button (FR-09).
  const onOpen = (item: CalItem) => {
    openOverflow(null)
    openDetail({ item, anchor: place() })
  }

  const props = { items: rows, day, prefs, colorsOf, readOnly, onOpen }
  return (
    <>
      <PopoverAnchor virtualRef={virtualRef} />
      {/* Keyed by its button: the list of another one opens as a popover of its own and takes the focus. */}
      <PopoverContent
        key={state.id}
        className={cn('w-64 p-2', dragging && 'invisible')}
        align="start"
        aria-label={format(day, 'PPPP', { locale: prefs.locale })}
        onCloseAutoFocus={(e) => {
          e.preventDefault()
          // The details a row opens, or the question a drop asks, have taken the focus: leave it there.
          const focused = document.activeElement
          if (focused && focused !== document.body) return
          const target = place()
          if (target.isConnected) target.focus()
        }}
        // Portaled out of the cell, but React bubbles its clicks into the cell, which would create an event.
        onClick={(e) => {
          e.stopPropagation()
        }}
      >
        <p className="px-1.5 pb-2 font-display text-sm font-semibold">{format(day, 'EEEE, PPP', { locale: prefs.locale })}</p>
        {rows.length > VIRTUALIZE_THRESHOLD ? <VirtualList {...props} /> : <Rows {...props} />}
      </PopoverContent>
    </>
  )
}
