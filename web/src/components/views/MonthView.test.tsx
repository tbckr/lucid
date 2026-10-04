import { DndContext, type DragStartEvent } from '@dnd-kit/core'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { enUS } from 'date-fns/locale/en-US'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DndStateContext } from '@/components/dnd/dndState'
import type * as EventItems from '@/components/events/EventItems'
import { TooltipProvider } from '@/components/ui/tooltip'
import { api } from '@/lib/api/client'
import { occurrenceTask, toCalTask, type MoveWindow } from '@/lib/calendarTasks'
import { eventColors } from '@/lib/color'
import { toCalEvent, type CalItem } from '@/lib/events'
import { type FormatPrefs } from '@/lib/format'
import { previewOf } from '@/lib/quickCreate'
import { useUi } from '@/stores/ui'
import { apiEvent, calendar, occurrence, todo } from '@/test/fixtures'
import { renderWithProviders } from '@/test/render'
import { MonthView } from './MonthView'

// Counts renders of the month's event chips; they keep their real behavior.
const chipRenders = vi.hoisted(() => ({ count: 0 }))
vi.mock('@/components/events/EventItems', async (importOriginal) => {
  const mod = await importOriginal<typeof EventItems>()
  return {
    ...mod,
    EventChip: (props: Parameters<typeof mod.EventChip>[0]) => {
      chipRenders.count++
      return mod.EventChip(props)
    },
  }
})

const prefs: FormatPrefs = { tag: 'en-US', locale: enUS, hourCycle: '12h', weekStartsOn: 0 }
const colors = eventColors('#3b82f6', false)
const cal = calendar()

function renderMonth(
  events: CalItem[] = [toCalEvent(apiEvent({ title: 'Standup' }))],
  { onDragStart, readOnly = false }: { onDragStart?: (e: DragStartEvent) => void; readOnly?: boolean } = {},
) {
  return renderWithProviders(
    <DndContext onDragStart={onDragStart}>
      <MonthView
        date={new Date(2026, 8, 25)}
        now={new Date(2026, 8, 25, 12)}
        events={events}
        corrupted={[
          { kind: 'corrupted', key: 'bad', calendarId: 'c1', start: new Date(2026, 8, 26, 9), reason: 'title: bad' },
        ]}
        prefs={prefs}
        colorsOf={() => colors}
        calendarOf={() => ({ ...cal, readOnly })}
      />
    </DndContext>,
  )
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { x: left, y: top, left, top, width, height, right: left + width, bottom: top + height, toJSON: () => ({}) }
}

describe('MonthView', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    act(() => {
      useUi.getState().openCreate(null)
    })
  })

  it('renders an accessible grid with weekday headers and events', () => {
    renderMonth()
    const grid = screen.getByRole('grid', { name: 'September 2026' })
    expect(within(grid).getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Sun',
      'Mon',
      'Tue',
      'Wed',
      'Thu',
      'Fri',
      'Sat',
    ])
    expect(within(grid).getAllByRole('gridcell')).toHaveLength(35)
    const today = screen.getByRole('gridcell', { name: /Friday, September 25th, 2026, 1 event/ })
    expect(today).toHaveAttribute('aria-current', 'date')
    expect(today).toHaveAttribute('tabindex', '0')
    expect(within(today).getByRole('button', { name: 'Standup, 10 AM' })).toBeInTheDocument()
    expect(screen.getByTestId('corrupted-event')).toBeInTheDocument()
  })

  it('opens the create popover from a cell and moves focus with arrows', async () => {
    const user = userEvent.setup()
    renderMonth()
    const today = screen.getByRole('gridcell', { name: /September 25th/ })
    today.focus()
    await user.keyboard('{ArrowLeft}')
    const thu = screen.getByRole('gridcell', { name: /September 24th/ })
    expect(thu).toHaveFocus()
    await user.keyboard('{Enter}')
    const create = useUi.getState().create
    expect(create?.origin).toMatchObject({ granularity: 'day', ranged: false })
    expect(create?.origin.start.getDate()).toBe(24)
    expect(create?.anchor).toBe(thu)
    expect(create?.returnFocus).toBe(thu)
    useUi.getState().openCreate(null)
  })

  it('highlights the day of the draft', () => {
    renderMonth()
    const thu = screen.getByRole('gridcell', { name: /September 24th/ })
    act(() => {
      fireEvent.click(thu)
      const due = { startDate: '', startTime: '', dueDate: '2026-09-24', dueTime: '' }
      useUi.getState().setCreatePreview(previewOf('task', due, 'c1', '', 'Europe/Berlin'))
    })
    expect(thu).toHaveAttribute('data-draft')
    expect(screen.getByRole('gridcell', { name: /September 25th/ })).not.toHaveAttribute('data-draft')
    // Typing the title builds a new preview on the same day: the grid stays as it is.
    const before = chipRenders.count
    act(() => {
      const p = useUi.getState().createPreview!
      useUi.getState().setCreatePreview({ ...p, startsAt: new Date(p.startsAt), endsAt: new Date(p.endsAt), title: 'Rent' })
    })
    expect(chipRenders.count).toBe(before)
    act(() => {
      useUi.getState().openCreate(null)
    })
  })

  it('opens event details on click', () => {
    renderMonth()
    fireEvent.click(screen.getByRole('button', { name: 'Standup, 10 AM' }))
    expect(useUi.getState().detail?.item.title).toBe('Standup')
    useUi.getState().openDetail(null)
  })

  it('renders tasks with a checkbox and does not create events from them', async () => {
    api.setCsrfToken('tok')
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => undefined))
    const rent = toCalTask(todo({ title: 'Pay rent', due: '2026-09-25T00:00:00Z', dueAllDay: true }))!
    const call = toCalTask(todo({ id: 't2', title: 'Call', due: '2026-09-25T08:00:00Z' }))!
    const user = userEvent.setup()
    renderMonth([toCalEvent(apiEvent()), rent, call])
    await user.click(screen.getByRole('checkbox', { name: 'Completed: Pay rent' }))
    await user.click(screen.getByRole('checkbox', { name: 'Completed: Call' }))
    expect(useUi.getState().create).toBeNull()
    // A plain click, as dnd-kit's default pointer sensor here would start a drag on press.
    fireEvent.click(screen.getByRole('button', { name: 'Call, 10 AM' }))
    expect(useUi.getState().create).toBeNull()
    expect(useUi.getState().detail?.item).toBe(call)
    useUi.getState().openDetail(null)
  })

  it('picks up a task by its title to move it to another day (FR-10)', () => {
    const call = toCalTask(todo({ id: 't2', title: 'Call', due: '2026-09-25T08:00:00Z' }))!
    const onDragStart = vi.fn<(e: DragStartEvent) => void>()
    renderMonth([call], { onDragStart })
    const title = screen.getByRole('button', { name: 'Call, 10 AM' })
    expect(title).toHaveAttribute('aria-roledescription', 'draggable')
    fireEvent.keyDown(title, { code: 'Space', key: ' ' })
    expect(onDragStart).toHaveBeenCalledTimes(1)
    expect(onDragStart.mock.calls[0]![0].active.data.current).toEqual({
      type: 'event',
      event: call,
      originDay: new Date(2026, 8, 25),
    })
  })

  describe('upcoming repeats (FR-17)', () => {
    // A repeat two days after the current one, on 09-27.
    const upcoming = (p: Parameters<typeof todo>[0]) =>
      occurrenceTask(
        occurrence({
          key: 't1@27',
          title: 'Water',
          recurrenceId: '2026-09-27T00:00:00Z',
          due: '2026-09-27T00:00:00Z',
          state: 'upcoming',
        }),
        todo({ title: 'Water', recurring: true, due: '2026-09-25T00:00:00Z', dueAllDay: true, ...p }),
      )!
    const name = 'Water, planned repeat on Sun, Sep 27'

    it('picks up an upcoming repeat of an interval series from its own day, to move the series', () => {
      const t = upcoming({ rrule: 'FREQ=DAILY' })
      const onDragStart = vi.fn<(e: DragStartEvent) => void>()
      renderMonth([t], { onDragStart })
      fireEvent.keyDown(screen.getByRole('button', { name }), { code: 'Space', key: ' ' })
      expect(onDragStart).toHaveBeenCalledTimes(1)
      expect(onDragStart.mock.calls[0]![0].active.data.current).toEqual({
        type: 'event',
        event: t,
        originDay: new Date(2026, 8, 27),
      })
    })

    it('keeps an upcoming repeat of a series on fixed days in place', () => {
      const onDragStart = vi.fn<(e: DragStartEvent) => void>()
      renderMonth([upcoming({ rrule: 'FREQ=WEEKLY;BYDAY=MO,TH,FR,SU', fixedDays: true })], { onDragStart })
      const title = screen.getByRole('button', { name })
      expect(title).not.toHaveAttribute('aria-roledescription')
      fireEvent.keyDown(title, { code: 'Space', key: ' ' })
      expect(onDragStart).not.toHaveBeenCalled()
    })
  })

  it('keeps a task of a read-only calendar in place', () => {
    const call = toCalTask(todo({ id: 't2', title: 'Call', due: '2026-09-25T08:00:00Z' }))!
    const onDragStart = vi.fn<(e: DragStartEvent) => void>()
    renderMonth([call], { onDragStart, readOnly: true })
    const title = screen.getByRole('button', { name: 'Call, 10 AM' })
    expect(title).not.toHaveAttribute('aria-roledescription')
    fireEvent.keyDown(title, { code: 'Space', key: ' ' })
    expect(onDragStart).not.toHaveBeenCalled()
  })

  it('opens the details of an event from "+N more" and creates nothing in the cell', async () => {
    const events = ['Standup', 'Review', 'Lunch', 'Gym', 'Call'].map((title, i) =>
      toCalEvent(apiEvent({ id: `e${i}`, key: `e${i}`, title })),
    )
    const user = userEvent.setup()
    renderMonth(events)
    await user.click(screen.getByRole('button', { name: /^\d+ more$/ }))
    // The list is portaled out of the cell, but React bubbles its clicks into the cell.
    const list = await screen.findByRole('dialog', { name: 'Friday, September 25th, 2026' })
    await user.click(within(list).getByText('Friday, September 25th, 2026'))
    expect(useUi.getState().create).toBeNull()
    await user.click(within(list).getByRole('button', { name: /Call/ }))
    expect(useUi.getState().create).toBeNull()
    expect(useUi.getState().detail?.item).toBe(events[4])
    useUi.getState().openDetail(null)
  })

  it('highlights the day under a drag, but not one outside the window of a dragged repeat (FR-17)', async () => {
    const call = toCalTask(todo({ id: 't2', title: 'Call', due: '2026-09-25T08:00:00Z' }))!
    // jsdom lays nothing out: only Friday's cell and the task in it share a box, so the task is over Friday.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.dataset.day === '2026-09-25' || this.dataset.taskKey ? rect(0, 0, 100, 100) : rect(1000, 1000, 10, 10)
    })
    const view = (moveWindow: MoveWindow | null) => (
      <DndContext>
        <DndStateContext
          value={{
            pendingKeys: new Set(),
            pendingTodos: new Set(),
            resize: null,
            moveWindow,
            activeId: null,
            scope: null,
            held: null,
            scopeAnchor: () => undefined,
            draggedTodo: null,
          }}
        >
          <MonthView
            date={new Date(2026, 8, 25)}
            now={new Date(2026, 8, 25, 12)}
            events={[call]}
            corrupted={[]}
            prefs={prefs}
            colorsOf={() => colors}
            calendarOf={() => cal}
          />
        </DndStateContext>
      </DndContext>
    )
    const { rerender, queryClient } = renderWithProviders(view(null))
    const friday = screen.getByRole('gridcell', { name: /September 25th/ })
    fireEvent.keyDown(screen.getByRole('button', { name: 'Call, 10 AM' }), { code: 'Space', key: ' ' })
    await waitFor(() => {
      expect(friday).toHaveClass('bg-primary/8')
    })

    // The same drag, with Friday past the window: blocked, and no promise of a drop.
    rerender(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>{view({ from: new Date(2026, 8, 28), until: new Date(2026, 9, 1) })}</TooltipProvider>
      </QueryClientProvider>,
    )
    expect(friday).toHaveClass('blocked')
    expect(friday).not.toHaveClass('bg-primary/8')
  })

  it('blocks only the days before the last repeat of a fixed-day series (FR-17)', () => {
    const w: MoveWindow = { from: new Date(2026, 8, 25), until: null }
    renderWithProviders(
      <DndContext>
        <DndStateContext
          value={{
            pendingKeys: new Set(),
            pendingTodos: new Set(),
            resize: null,
            moveWindow: w,
            activeId: null,
            scope: null,
            held: null,
            scopeAnchor: () => undefined,
            draggedTodo: null,
          }}
        >
          <MonthView
            date={new Date(2026, 8, 25)}
            now={new Date(2026, 8, 25, 12)}
            events={[]}
            corrupted={[]}
            prefs={prefs}
            colorsOf={() => colors}
            calendarOf={() => cal}
          />
        </DndStateContext>
      </DndContext>,
    )
    expect(screen.getByRole('gridcell', { name: /September 24th/ })).toHaveClass('blocked')
    expect(screen.getByRole('gridcell', { name: /September 25th/ })).not.toHaveClass('blocked')
    expect(screen.getByRole('gridcell', { name: /September 26th/ })).not.toHaveClass('blocked')
  })

  /** The month of 2026-09-25 while a bounded series is dragged: `moveWindow` and `draggedTodo` as `CalendarDnd` gives them. */
  function renderDragging(events: CalItem[], moveWindow: MoveWindow, draggedTodo: string | null) {
    renderWithProviders(
      <DndContext>
        <DndStateContext
          value={{
            pendingKeys: new Set(),
            pendingTodos: new Set(),
            resize: null,
            moveWindow,
            activeId: null,
            scope: null,
            held: null,
            scopeAnchor: () => undefined,
            draggedTodo,
          }}
        >
          <MonthView
            date={new Date(2026, 8, 25)}
            now={new Date(2026, 8, 25, 12)}
            events={events}
            corrupted={[]}
            prefs={prefs}
            colorsOf={() => colors}
            calendarOf={() => cal}
          />
        </DndStateContext>
      </DndContext>,
    )
  }

  it("dims what a blocked day shows but the dragged series' repeats (FR-17)", () => {
    const repeat = occurrenceTask(
      occurrence({
        todoId: 't1',
        title: 'Water the flowers',
        state: 'upcoming',
        due: '2026-09-28T00:00:00Z',
        key: 't1@2026-09-28T00:00:00Z',
        recurrenceId: '2026-09-28T00:00:00Z',
      }),
      todo({ id: 't1', title: 'Water the flowers', recurring: true, fixedDays: true, rrule: 'FREQ=WEEKLY;BYDAY=MO,TH' }),
    )!
    const other = toCalTask(todo({ id: 't2', title: 'Call', due: '2026-09-28T08:00:00Z' }))!
    renderDragging([repeat, other], { from: new Date(2026, 8, 24), until: new Date(2026, 8, 26) }, 't1')

    expect(screen.getByRole('gridcell', { name: /September 28th/ })).toHaveClass('blocked')
    expect(document.querySelector('[data-task-key="t1@2026-09-28T00:00:00Z"]')).toHaveAttribute('data-dragged-series')
    expect(document.querySelector('[data-task-key="task:t2"]')).not.toHaveAttribute('data-dragged-series')
  })

  it('washes a blocked day outside the month instead of greying it as outside', () => {
    renderDragging([], { from: new Date(2026, 8, 25), until: null }, null)

    const before = screen.getByRole('gridcell', { name: /August 30th/ })
    expect(before).toHaveClass('blocked')
    expect(before).not.toHaveClass('bg-outside')
    const after = screen.getByRole('gridcell', { name: /October 1st/ })
    expect(after).toHaveClass('bg-outside')
    expect(after).not.toHaveClass('blocked')
  })

  it('counts tasks apart from events in the cell label', () => {
    const rent = toCalTask(todo({ title: 'Pay rent', due: '2026-09-25T00:00:00Z', dueAllDay: true }))!
    renderMonth([toCalEvent(apiEvent()), rent])
    expect(screen.getByRole('gridcell', { name: 'Friday, September 25th, 2026, 1 event, 1 task' })).toBeInTheDocument()
    expect(screen.getByRole('gridcell', { name: 'Saturday, September 26th, 2026, no events' })).toBeInTheDocument()
  })
})

