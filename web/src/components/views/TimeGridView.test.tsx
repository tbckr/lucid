import { DndContext, type DragStartEvent } from '@dnd-kit/core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { enUS } from 'date-fns/locale/en-US'
import { type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DndStateContext } from '@/components/dnd/dndState'
import type * as EventItems from '@/components/events/EventItems'
import { TooltipProvider } from '@/components/ui/tooltip'
import { toCalTask } from '@/lib/calendarTasks'
import { eventColors } from '@/lib/color'
import { toCalEvent, type CalEvent, type CalItem } from '@/lib/events'
import { type FormatPrefs } from '@/lib/format'
import { previewOf, type CreateKind, type EventWhen, type TaskWhen } from '@/lib/quickCreate'
import { useUi } from '@/stores/ui'
import { apiEvent, calendar, todo } from '@/test/fixtures'
import { renderWithProviders } from '@/test/render'
import { OverflowPopover } from './OverflowPopover'
import { TimeGridView } from './TimeGridView'

// Counts renders of the grid's event blocks; they keep their real behavior.
const blockRenders = vi.hoisted(() => ({ count: 0 }))
vi.mock('@/components/events/EventItems', async (importOriginal) => {
  const mod = await importOriginal<typeof EventItems>()
  return {
    ...mod,
    TimedBlock: (props: Parameters<typeof mod.TimedBlock>[0]) => {
      blockRenders.count++
      return mod.TimedBlock(props)
    },
  }
})

const prefs: FormatPrefs = { tag: 'en-US', locale: enUS, hourCycle: '12h', weekStartsOn: 0 }
const colors = eventColors('#3b82f6', false)
const cal = calendar()

function renderDay(events: CalItem[] = [], onDragStart?: (e: DragStartEvent) => void) {
  return renderWithProviders(
    <DndContext onDragStart={onDragStart}>
      <TimeGridView
        days={[new Date(2026, 8, 25)]}
        now={new Date(2026, 8, 25, 12)}
        events={events}
        corrupted={[]}
        prefs={prefs}
        colorsOf={() => colors}
        calendarOf={() => cal}
      />
    </DndContext>,
  )
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { x: left, y: top, left, top, width, height, right: left + width, bottom: top + height, toJSON: () => ({}) }
}

/** Lays the time grid out `width` px wide: the ResizeObserver reports it once, as the browser does on observe. */
function measured(width: number) {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      readonly callback: ResizeObserverCallback
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback
      }
      observe(target: Element) {
        this.callback([{ target, contentRect: { width } } as unknown as ResizeObserverEntry], this)
      }
      unobserve() {
        // nothing to stop
      }
      disconnect() {
        // nothing to stop
      }
    },
  )
}

describe('TimeGridView', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    useUi.getState().openCreate(null)
    useUi.getState().openOverflow(null)
  })

  // jsdom lays nothing out, so every slot's top is 0 and clientY is the offset in the slot
  // (0.8 px per minute): 4 px = 09:05, 24 px = 09:30, 44 px = 09:55, 64 px = 10:20.

  it.each([
    ['at the top of the slot', 0, 0],
    ['just before the half hour', 22, 0],
    ['half-way down', 24, 30],
    ['near the bottom', 44, 30],
    // Assistive tech clicks at clientY 0, above the slot.
    ['without a pointer position', -100, 0],
  ])('starts a 30-minute event in the half hour under a click %s', (_, clientY, minute) => {
    renderDay()
    const slot = screen.getByRole('button', { name: /9:00 AM$/ })
    fireEvent.click(slot, { clientY })
    const create = useUi.getState().create
    expect(create).toMatchObject({
      origin: {
        start: new Date(2026, 8, 25, 9, minute),
        end: new Date(2026, 8, 25, 9, minute + 30),
        allDay: false,
        granularity: 'time',
        ranged: false,
      },
      span: { startMin: 540 + minute, endMin: 570 + minute },
    })
    expect(create?.returnFocus).toBe(slot)
    expect(create?.anchor).toBe(slot.parentElement)
  })

  function pressAndMove(slot: HTMLElement, pointerType: string, fromY: number, toY: number) {
    fireEvent.pointerDown(slot, { pointerId: 1, pointerType, button: 0, clientX: 10, clientY: fromY })
    fireEvent.pointerMove(slot, { pointerId: 1, pointerType, clientX: 10, clientY: toY })
  }

  it('creates an event over the dragged slots and shows their time while dragging', () => {
    renderDay()
    const slot = screen.getByRole('button', { name: /9:00 AM$/ })
    pressAndMove(slot, 'mouse', 4, 64)
    expect(screen.getByText('9 AM – 10:30 AM')).toBeInTheDocument()
    fireEvent.pointerUp(slot, { pointerId: 1, pointerType: 'mouse', clientX: 10, clientY: 64 })
    // The browser follows up with a click on the pressed slot; it must not replace the range.
    fireEvent.click(slot, { clientY: 64 })
    expect(screen.queryByText('9 AM – 10:30 AM')).not.toBeInTheDocument()
    expect(useUi.getState().create).toMatchObject({
      origin: { start: new Date(2026, 8, 25, 9), end: new Date(2026, 8, 25, 10, 30), allDay: false, ranged: true },
      span: { startMin: 540, endMin: 630 },
    })
  })

  it.each([
    ['a mouse press that moves less than 6 px', 'mouse', 8, 0],
    // Touch scrolls the grid, so it never drags.
    ['a moving touch', 'touch', 30, 30],
  ])('treats %s as a click', (_, pointerType, toY, minute) => {
    renderDay()
    const slot = screen.getByRole('button', { name: /9:00 AM$/ })
    pressAndMove(slot, pointerType, 4, toY)
    fireEvent.pointerUp(slot, { pointerId: 1, pointerType, clientX: 10, clientY: toY })
    fireEvent.click(slot, { clientY: toY })
    expect(useUi.getState().create?.origin).toMatchObject({
      start: new Date(2026, 8, 25, 9, minute),
      end: new Date(2026, 8, 25, 9, minute + 30),
      ranged: false,
    })
  })

  it('cancels the drag on Escape', () => {
    renderDay()
    const slot = screen.getByRole('button', { name: /9:00 AM$/ })
    pressAndMove(slot, 'mouse', 4, 64)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByText('9 AM – 10:30 AM')).not.toBeInTheDocument()
    fireEvent.pointerUp(slot, { pointerId: 1, pointerType: 'mouse', clientX: 10, clientY: 64 })
    fireEvent.click(slot, { clientY: 64 })
    expect(useUi.getState().create).toBeNull()
  })

  it('renders a point task in the grid', () => {
    const { container } = renderDay([toCalTask(todo({ id: 't1', title: 'Call', due: '2026-09-25T08:00:00Z' }))!])
    const block = container.querySelector('[data-task-key="task:t1"]')
    expect(block).not.toBeNull()
    expect(within(block as HTMLElement).getByRole('checkbox', { name: 'Completed: Call' })).toBeInTheDocument()
    expect(within(block as HTMLElement).getByRole('button', { name: 'Call, 10 AM' })).toBeInTheDocument()
  })

  it('renders an all-day task in the all-day row', () => {
    renderDay([toCalTask(todo({ id: 't1', title: 'Pay rent', due: '2026-09-25T00:00:00Z', dueAllDay: true }))!])
    const cell = screen.getByRole('button', { name: /New all-day event/ }).parentElement!
    expect(within(cell).getByRole('checkbox', { name: 'Completed: Pay rent' })).toBeInTheDocument()
  })

  /** An all-day event on Sept 25. */
  const allDayEvent = (title: string) =>
    toCalEvent(apiEvent({ id: title, key: title, title, allDay: true, start: '2026-09-25T00:00:00Z', end: '2026-09-26T00:00:00Z' }))
  /** The all-day row's cell of Sept 25. */
  const allDayCell = () => screen.getByRole('button', { name: /^New all-day event/ }).parentElement!

  it('caps the all-day row at three rows without expanding (FR-07)', () => {
    const events = ['A', 'B', 'C', 'D'].map(allDayEvent)
    renderDay(events)
    const cell = allDayCell()
    expect(cell).toHaveStyle({ height: `${3 * 22 + 6}px` })
    expect(Array.from(cell.querySelectorAll<HTMLElement>('[data-event-key]')).map((el) => el.dataset.eventKey)).toEqual(['A', 'B'])
    // Nothing expands the row any more: its label column has no toggle.
    expect(screen.getByText('All day').closest('div')?.querySelector('button[aria-expanded]')).toBeNull()
    const more = within(cell).getByRole('button', { name: '2 more events, Friday, September 25th, 2026' })
    expect(more).toHaveTextContent('2 more')
    expect(more).toHaveStyle({ top: `${3 + 2 * 22}px` })
    // In line with the bars above it.
    const bar = cell.querySelector<HTMLElement>('[data-event-key="A"]')!
    expect(more.style.left).toBe(bar.style.left)
    expect(more.style.width).toBe(bar.style.width)
    fireEvent.click(more)
    const overflow = useUi.getState().overflow
    expect(overflow?.items.map((i) => i.key)).toEqual(['C', 'D'])
    // Home is the cell's create button, which covers the cell and takes the focus.
    expect(overflow?.home).toBe(within(cell).getByRole('button', { name: /^New all-day event/ }))
    act(() => {
      useUi.getState().openOverflow(null)
    })
  })

  it('returns the focus to the all-day cell once the button of its list is gone (NFR-27)', async () => {
    const user = userEvent.setup()
    const events = ['A', 'B', 'C', 'D'].map(allDayEvent)
    const queryClient = new QueryClient()
    const view = (shown: CalItem[]) => (
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <DndContext>
            <TimeGridView
              days={[new Date(2026, 8, 25)]}
              now={new Date(2026, 8, 25, 12)}
              events={shown}
              corrupted={[]}
              prefs={prefs}
              colorsOf={() => colors}
              calendarOf={() => cal}
            />
            {/* The list of a bundle or "N more" lives beside the views (FR-07). */}
            <OverflowPopover
              prefs={prefs}
              colorsOf={() => colors}
              readOnly={() => false}
              lookup={(key) => events.find((e) => e.key === key)}
            />
          </DndContext>
        </TooltipProvider>
      </QueryClientProvider>
    )
    const { rerender } = render(view(events))
    fireEvent.click(screen.getByRole('button', { name: '2 more events, Friday, September 25th, 2026' }))
    await screen.findByRole('dialog', { name: 'Friday, September 25th, 2026' })
    // An event dragged out of the list leaves the day with room: its "N more" goes away while the list stays open.
    rerender(view(events.slice(0, 2)))
    expect(screen.queryByRole('button', { name: /^\d+ more/ })).toBeNull()
    await user.keyboard('{Escape}')
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'New all-day event on Friday, September 25th, 2026' }))
    })
  })

  it('bundles all-day tasks in the all-day row (FR-07)', () => {
    // By title, as they show on one day.
    const tasks = ['Call', 'Mail', 'Rent'].map(
      (title, i) => toCalTask(todo({ id: `t${i}`, title, due: '2026-09-25T00:00:00Z', dueAllDay: true }))!,
    )
    renderDay([...tasks, allDayEvent('A'), allDayEvent('B')])
    const cell = allDayCell()
    expect(cell).toHaveStyle({ height: `${3 * 22 + 6}px` })
    expect(cell.querySelectorAll('[data-event-key]')).toHaveLength(2)
    expect(cell.querySelector('[data-task-key]')).toBeNull()
    const bundle = within(cell).getByRole('button', { name: '3 tasks, Friday, September 25th, 2026' })
    // A row on Mist, in the third row, in line with the bars above it (FR-07).
    expect(bundle).toHaveClass('bg-muted')
    expect(bundle).toHaveStyle({ top: `${3 + 2 * 22}px` })
    const bar = cell.querySelector<HTMLElement>('[data-event-key="A"]')!
    expect(bundle.style.left).toBe(bar.style.left)
    expect(bundle.style.width).toBe(bar.style.width)
    expect(within(cell).queryByRole('button', { name: /^\d+ more/ })).toBeNull()
    fireEvent.click(bundle)
    expect(useUi.getState().overflow?.items.map((i) => i.key)).toEqual(tasks.map((t) => t.key))
    act(() => {
      useUi.getState().openOverflow(null)
    })
  })

  it('grows the all-day row with its rows when there is room', () => {
    renderDay([toCalTask(todo({ id: 't1', title: 'Rent', due: '2026-09-25T00:00:00Z', dueAllDay: true }))!, allDayEvent('A')])
    const cell = allDayCell()
    expect(cell).toHaveStyle({ height: `${2 * 22 + 6}px` })
    expect(cell.querySelector('[data-task-key="task:t1"]')).toHaveStyle({ top: `${3 + 22}px` })
  })

  describe('a busy hour (FR-07)', () => {
    const week = Array.from({ length: 7 }, (_, i) => new Date(2026, 8, 20 + i))
    /** Sept 25, 9–10 and 9:15–11 (CEST, UTC+2). */
    const events = [
      toCalEvent(apiEvent({ id: 'sync', key: 'sync', title: 'Sync', start: '2026-09-25T07:00:00Z', end: '2026-09-25T08:00:00Z' })),
      toCalEvent(apiEvent({ id: 'panel', key: 'panel', title: 'Panel', start: '2026-09-25T07:15:00Z', end: '2026-09-25T09:00:00Z' })),
    ]
    /** `n` tasks due on Sept 25 at 9:00. */
    const tasksAtNine = (n: number) =>
      Array.from({ length: n }, (_, i) => toCalTask(todo({ id: `t${i}`, title: `Task ${i}`, due: '2026-09-25T07:00:00Z' }))!)
    const grid = (days: Date[], items: CalItem[], beside?: ReactNode) => (
      <DndContext>
        <TimeGridView
          days={days}
          now={new Date(2026, 8, 25, 12)}
          events={items}
          corrupted={[]}
          prefs={prefs}
          colorsOf={() => colors}
          calendarOf={() => cal}
        />
        {beside}
      </DndContext>
    )
    /** The day column of Sept 25. */
    const friday = () => screen.getByRole('button', { name: /^New event at Friday, September 25th, 2026 9:00 AM$/ }).parentElement!
    /** A box's `left` and `width` in % (its width without the 4 px gap every block keeps), rounded. */
    const across = (el: HTMLElement) => {
      const width = /^calc\(([\d.]+)% - 4px\)$/.exec(el.style.width)?.[1]
      return [Math.round(parseFloat(el.style.left) * 100) / 100, Math.round(parseFloat(width ?? 'NaN') * 100) / 100]
    }
    const keys = (container: HTMLElement, attr: 'event' | 'task') =>
      Array.from(container.querySelectorAll<HTMLElement>(`[data-${attr}-key]`)).map((el) => el.getAttribute(`data-${attr}-key`))

    it('bundles a busy hour in a narrow week column', () => {
      measured(56 + 7 * 90)
      const { container } = renderWithProviders(grid(week, [...events, ...tasksAtNine(3)]))
      // One event per time stays readable (FR-07).
      expect(keys(container, 'event')).toEqual(['sync'])
      expect(keys(container, 'task')).toEqual([])
      const bundle = within(friday()).getByRole('button', { name: '3 tasks at 9:00 AM, Friday, September 25th, 2026' })
      // Compact in a 45 px half of the column: the bare number, centred and close to its rings so a 40 px tile holds it.
      expect(bundle).toHaveTextContent(/^3$/)
      expect(bundle).toHaveClass('justify-center', 'gap-0.5', 'px-0')
      expect(bundle).toHaveStyle({ top: `${540 * 0.8}px`, height: '22px' })
      const more = within(friday()).getByRole('button', { name: '1 more event at 9:15 AM, Friday, September 25th, 2026' })
      expect(more).toHaveTextContent('+1')
      // Below the bundle, in its column.
      expect(more).toHaveStyle({ top: `${570 * 0.8}px`, height: '22px' })
      // The overflow column is slim, 37 of the 90 px; the event beside it gets the rest.
      expect(across(bundle)).toEqual([58.89, 41.11])
      expect(across(more)).toEqual([58.89, 41.11])
      expect(across(container.querySelector<HTMLElement>('[data-event-key="sync"]')!.parentElement!)).toEqual([0, 58.89])
    })

    it("keeps the columns of a busy hour even where its overflow column also holds an entry of its own", () => {
      measured(56 + 7 * 90)
      // Sync runs 9–12 beside the bundle; a 10:30 event has room below it, in the same column.
      const long = toCalEvent(apiEvent({ id: 'sync', key: 'sync', title: 'Sync', start: '2026-09-25T07:00:00Z', end: '2026-09-25T10:00:00Z' }))
      const later = toCalEvent(apiEvent({ id: 'call', key: 'call', title: 'Call', start: '2026-09-25T08:30:00Z', end: '2026-09-25T09:30:00Z' }))
      const { container } = renderWithProviders(grid(week, [long, later, ...tasksAtNine(3)]))
      const bundle = within(friday()).getByRole('button', { name: /^3 tasks at 9:00 AM/ })
      expect(across(bundle)).toEqual([50, 50])
      expect(across(container.querySelector<HTMLElement>('[data-event-key="sync"]')!.parentElement!)).toEqual([0, 50])
      expect(across(container.querySelector<HTMLElement>('[data-event-key="call"]')!.parentElement!)).toEqual([50, 50])
    })

    it('shows everything in the wide day view', () => {
      measured(56 + 400)
      const { container } = renderWithProviders(grid([new Date(2026, 8, 25)], [...events, ...tasksAtNine(3)]))
      expect(keys(container, 'event').sort()).toEqual(['panel', 'sync'])
      expect(keys(container, 'task')).toEqual(['task:t0', 'task:t1', 'task:t2'])
      expect(container.querySelector('[data-bundle-count]')).toBeNull()
      expect(screen.queryByRole('button', { name: /more events? at/ })).toBeNull()
    })

    it('opens the bundle\'s tasks with listed drags', () => {
      measured(56 + 7 * 90)
      const tasks = tasksAtNine(3)
      renderWithProviders(grid(week, [...events, ...tasks]))
      fireEvent.click(screen.getByRole('button', { name: /^3 tasks at 9:00 AM/ }))
      const overflow = useUi.getState().overflow
      expect(overflow?.items.map((i) => i.key)).toEqual(tasks.map((t) => t.key))
      expect(overflow?.drag).toBe('listed')
      expect(overflow?.home).toBe(friday())
    })

    it('draws a lone task of a busy hour as itself, in the overflow column', () => {
      measured(56 + 7 * 90)
      const { container } = renderWithProviders(grid(week, [...events, ...tasksAtNine(1)]))
      expect(container.querySelector('[data-bundle-count]')).toBeNull()
      const task = container.querySelector<HTMLElement>('[data-task-key="task:t0"]')!
      expect(task).toHaveStyle({ top: `${540 * 0.8}px`, height: '22px' })
      expect(across(task)).toEqual([58.89, 41.11])
      expect(within(task).getByRole('button', { name: 'Task 0, 9 AM' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: '1 more event at 9:15 AM, Friday, September 25th, 2026' })).toBeInTheDocument()
    })

    it('drags a lone task drawn above its time from where its tile is (FR-07)', () => {
      measured(56 + 7 * 90)
      // Sync 9–12 beside two short events at 9:00: "+N" stacks at 9:00, and the 9:20 task, which finds no column, joins
      // it on top, drawn at 9:00.
      const items = [
        toCalEvent(apiEvent({ id: 'sync', key: 'sync', title: 'Sync', start: '2026-09-25T07:00:00Z', end: '2026-09-25T10:00:00Z' })),
        toCalEvent(apiEvent({ id: 'b', key: 'b', title: 'B', start: '2026-09-25T07:00:00Z', end: '2026-09-25T07:20:00Z' })),
        toCalEvent(apiEvent({ id: 'c', key: 'c', title: 'C', start: '2026-09-25T07:00:00Z', end: '2026-09-25T07:10:00Z' })),
        toCalTask(todo({ id: 't9', title: 'Call', due: '2026-09-25T07:20:00Z' }))!,
      ]
      const onDragStart = vi.fn<(e: DragStartEvent) => void>()
      const { container } = renderWithProviders(
        <DndContext onDragStart={onDragStart}>
          <TimeGridView
            days={week}
            now={new Date(2026, 8, 25, 12)}
            events={items}
            corrupted={[]}
            prefs={prefs}
            colorsOf={() => colors}
            calendarOf={() => cal}
          />
        </DndContext>,
      )
      expect(container.querySelector('[data-task-key="task:t9"]')).toHaveStyle({ top: `${540 * 0.8}px` })
      fireEvent.keyDown(screen.getByRole('button', { name: 'Call, 9:20 AM' }), { code: 'Space', key: ' ' })
      expect(onDragStart.mock.calls[0]![0].active.data.current).toEqual({
        type: 'timed',
        event: items[3],
        originDay: new Date(2026, 8, 25),
        offset: -20,
      })
    })

    it('opens the hidden events from "+N" with listed drags', () => {
      measured(56 + 7 * 90)
      renderWithProviders(grid(week, [...events, ...tasksAtNine(3)]))
      fireEvent.click(screen.getByRole('button', { name: /^1 more event at 9:15 AM/ }))
      const overflow = useUi.getState().overflow
      expect(overflow?.items.map((i) => i.key)).toEqual(['panel'])
      expect(overflow?.drag).toBe('listed')
      expect(overflow?.home).toBe(friday())
    })

    it('returns the focus to the day column once the bundle of its list is gone (NFR-27)', async () => {
      const user = userEvent.setup()
      measured(56 + 7 * 90)
      const tasks = tasksAtNine(3)
      const queryClient = new QueryClient()
      const view = (shown: CalItem[]) => (
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            {grid(
              week,
              shown,
              // The list of a bundle or "+N" lives beside the views (FR-07).
              <OverflowPopover prefs={prefs} colorsOf={() => colors} readOnly={() => false} lookup={(key) => tasks.find((e) => e.key === key)} />,
            )}
          </TooltipProvider>
        </QueryClientProvider>
      )
      const { rerender } = render(view([...events, ...tasks]))
      fireEvent.click(screen.getByRole('button', { name: /^3 tasks at 9:00 AM/ }))
      await screen.findByRole('dialog', { name: 'Friday, September 25th, 2026' })
      // Two tasks dragged out of the list leave the hour with room: the bundle goes away while the list stays open.
      rerender(view([...events, ...tasks.slice(0, 1)]))
      expect(screen.queryByRole('button', { name: /tasks at/ })).toBeNull()
      await user.keyboard('{Escape}')
      await waitFor(() => {
        expect(document.activeElement).toBe(friday())
      })
    })
  })

  it('picks up a timed task to move it in the grid (FR-10)', () => {
    const call = toCalTask(todo({ id: 't1', title: 'Call', due: '2026-09-25T08:00:00Z' }))!
    const onDragStart = vi.fn<(e: DragStartEvent) => void>()
    renderDay([call], onDragStart)
    fireEvent.keyDown(screen.getByRole('button', { name: 'Call, 10 AM' }), { code: 'Space', key: ' ' })
    expect(onDragStart.mock.calls[0]![0].active.data.current).toEqual({
      type: 'timed',
      event: call,
      originDay: new Date(2026, 8, 25),
    })
  })

  it('picks up an all-day task to move it by days', () => {
    const rent = toCalTask(todo({ id: 't1', title: 'Pay rent', due: '2026-09-25T00:00:00Z', dueAllDay: true }))!
    const onDragStart = vi.fn<(e: DragStartEvent) => void>()
    renderDay([rent], onDragStart)
    fireEvent.keyDown(screen.getByRole('button', { name: 'Pay rent, all day' }), { code: 'Space', key: ' ' })
    expect(onDragStart.mock.calls[0]![0].active.data.current).toEqual({
      type: 'event',
      event: rent,
      originDay: new Date(2026, 8, 25),
    })
  })

  it.each([
    [
      'the all-day row',
      toCalTask(todo({ id: 't1', title: 'Pay rent', due: '2026-09-25T00:00:00Z', dueAllDay: true }))!,
      'Pay rent, all day',
      () => screen.getByRole('button', { name: /^New all-day event/ }).parentElement!,
      'bg-primary/8',
    ],
    [
      'the day column',
      toCalTask(todo({ id: 't1', title: 'Call', due: '2026-09-25T08:00:00Z' }))!,
      'Call, 10 AM',
      () => screen.getByRole('button', { name: /9:00 AM$/ }).parentElement!,
      'bg-primary/5',
    ],
  ])('highlights %s under a drag', async (_, task, name, target, tint) => {
    // jsdom lays nothing out: only the target and the task in it share a box, so the task is over the target.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return 'box' in this.dataset || this.dataset.taskKey ? rect(0, 0, 100, 100) : rect(1000, 1000, 10, 10)
    })
    renderWithProviders(
      <DndContext>
        <TimeGridView
          days={[new Date(2026, 8, 25)]}
          now={new Date(2026, 8, 25, 12)}
          events={[task]}
          corrupted={[]}
          prefs={prefs}
          colorsOf={() => colors}
          calendarOf={() => cal}
        />
      </DndContext>,
    )
    const day = target()
    day.dataset.box = ''
    fireEvent.keyDown(screen.getByRole('button', { name }), { code: 'Space', key: ' ' })
    await waitFor(() => {
      expect(day).toHaveClass(tint)
    })
  })

  it('opens the popover for an all-day event from the all-day row', () => {
    renderDay()
    const cell = screen.getByRole('button', { name: /New all-day event/ })
    fireEvent.click(cell)
    const create = useUi.getState().create
    expect(create?.origin).toMatchObject({ start: new Date(2026, 8, 25), allDay: true, granularity: 'day', ranged: false })
    expect(create?.anchor).toBe(cell)
    expect(create?.returnFocus).toBe(cell)
  })

  /** Open the popover at 09:00 and give it the preview of `when`, as the popover does. */
  function withPreview(kind: CreateKind, when: EventWhen | TaskWhen, title = 'Review') {
    const slot = screen.getByRole('button', { name: /9:00 AM$/ })
    act(() => {
      fireEvent.click(slot, { clientY: 0 })
      useUi.getState().setCreatePreview(previewOf(kind, when, 'c1', title, 'Europe/Berlin'))
    })
  }
  const at = (startTime: string, endTime: string, endDate = '2026-09-25'): EventWhen => ({
    allDay: false,
    startDate: '2026-09-25',
    startTime,
    endDate,
    endTime,
  })

  it('draws the draft where the entry will land', () => {
    const { container } = renderDay()
    withPreview('event', at('10:00', '11:00'))
    const draft = container.querySelector<HTMLElement>('[data-draft]')!
    expect(draft).toHaveTextContent('Review')
    expect(draft).toHaveTextContent('10 AM – 11 AM')
    expect(draft.style.top).toBe('480px')
  })

  it('draws a task draft with its time only', () => {
    const { container } = renderDay()
    withPreview('task', { startDate: '', startTime: '', dueDate: '2026-09-25', dueTime: '10:00' }, '')
    const draft = container.querySelector<HTMLElement>('[data-draft]')!
    expect(draft).toHaveTextContent('(No title)')
    expect(draft).toHaveTextContent(/10 AM$/)
  })

  // As in a one-line block, a narrow one-line draft lets its title win over its time (FR-07).
  it('lets the title of a one-line draft win over its time, but not in a draft with a line for each', () => {
    const { container } = renderDay()
    withPreview('task', { startDate: '', startTime: '', dueDate: '2026-09-25', dueTime: '10:00' })
    const draft = () => container.querySelector<HTMLElement>('[data-draft]')!
    expect(draft()).toHaveClass('@container')
    expect(within(draft()).getByText('10 AM')).toHaveClass('@max-[6rem]:hidden')
    withPreview('event', at('10:00', '10:30'))
    expect(draft()).toHaveClass('@container')
    expect(within(draft()).getByText('10 AM – 10:30 AM')).toHaveClass('@max-[6rem]:hidden')
    withPreview('event', at('10:00', '11:00'))
    expect(draft()).not.toHaveClass('@container')
    expect(within(draft()).getByText('10 AM – 11 AM')).not.toHaveClass('@max-[6rem]:hidden')
  })

  it('clips a draft that runs past midnight', () => {
    const { container } = renderDay()
    withPreview('event', at('23:30', '00:30', '2026-09-26'))
    const draft = container.querySelector<HTMLElement>('[data-draft]')!
    expect(draft.style.top).toBe('1128px')
    expect(draft.style.height).toBe('22px')
  })

  /** Let go of what a press picked up: dnd-kit swallows clicks until 50 ms after a pointer drag. */
  async function release() {
    fireEvent.pointerUp(document)
    await act(() => new Promise((resolve) => setTimeout(resolve, 60)))
  }

  it('picks up the draft to move it, keeping the focus in the popover (FR-10)', async () => {
    const onDragStart = vi.fn<(e: DragStartEvent) => void>()
    const { container } = renderDay([], onDragStart)
    withPreview('event', at('10:00', '11:00'))
    const draft = container.querySelector<HTMLElement>('[data-draft]')!
    // Hidden from assistive tech, whose users set the times in the popover (NFR-27).
    expect(draft).not.toHaveAttribute('tabindex')
    // A press that took the focus would take it from the popover's title.
    expect(fireEvent.mouseDown(draft)).toBe(false)
    fireEvent.pointerDown(draft, { isPrimary: true, button: 0 })
    expect(onDragStart.mock.calls[0]![0].active.data.current).toEqual({
      type: 'timed',
      event: useUi.getState().createPreview,
      originDay: new Date(2026, 8, 25),
      draft: true,
    })
    await release()
  })

  it('draws out the end of an event draft (FR-10)', async () => {
    const onDragStart = vi.fn<(e: DragStartEvent) => void>()
    const { container } = renderDay([], onDragStart)
    withPreview('event', at('10:00', '11:00'))
    const draft = container.querySelector<HTMLElement>('[data-draft]')!
    fireEvent.pointerDown(within(draft).getByRole('button', { name: 'Change end time', hidden: true }), { isPrimary: true, button: 0 })
    expect(onDragStart.mock.calls[0]![0].active.data.current).toEqual({
      type: 'resize',
      event: useUi.getState().createPreview,
      draft: true,
    })
    await release()
  })

  it('has no end to draw out on a task draft or on the part of a draft before midnight', () => {
    const { container } = renderDay()
    withPreview('task', { startDate: '2026-09-25', startTime: '10:00', dueDate: '2026-09-25', dueTime: '12:00' })
    const draft = () => container.querySelector<HTMLElement>('[data-draft]')!
    expect(within(draft()).queryByRole('button', { hidden: true })).toBeNull()
    withPreview('event', at('23:30', '00:30', '2026-09-26'))
    expect(within(draft()).queryByRole('button', { hidden: true })).toBeNull()
  })

  it('grows the draft while its end is drawn out', () => {
    const draft = previewOf('event', at('10:00', '11:00'), 'c1', 'Review', 'Europe/Berlin')!
    const { container } = renderWithProviders(
      <DndContext>
        <DndStateContext
          value={{
            pendingKeys: new Set(),
            pendingSeries: new Set(),
            pendingTodos: new Set(),
            resize: { ...draft, endsAt: new Date(2026, 8, 25, 12) } as CalEvent,
            activeId: null,
            scope: null,
            held: null,
            scopeAnchor: () => undefined,
          }}
        >
          <TimeGridView
            days={[new Date(2026, 8, 25)]}
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
    withPreview('event', at('10:00', '11:00'))
    expect(container.querySelector<HTMLElement>('[data-draft]')!.style.height).toBe('94px')
  })

  it('highlights the day of an all-day draft', () => {
    renderDay()
    withPreview('event', { ...at('09:00', '10:00'), allDay: true })
    expect(screen.getByRole('button', { name: /New all-day event/ }).parentElement).toHaveAttribute('data-draft')
  })
  it('re-draws only the draft while its title is typed', () => {
    const { container } = renderDay([toCalEvent(apiEvent({ start: '2026-09-25T12:00:00Z', end: '2026-09-25T13:00:00Z' }))])
    withPreview('event', at('10:00', '11:00'), 'R')
    const before = blockRenders.count
    act(() => {
      // The popover builds a new preview, with new dates, on every keystroke.
      const p = useUi.getState().createPreview!
      useUi.getState().setCreatePreview({ ...p, startsAt: new Date(p.startsAt), endsAt: new Date(p.endsAt), title: 'Re' })
    })
    expect(container.querySelector('[data-draft]')).toHaveTextContent('Re')
    expect(blockRenders.count).toBe(before)
  })
})
