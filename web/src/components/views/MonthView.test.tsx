import { DndContext, type DragStartEvent } from '@dnd-kit/core'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { enUS } from 'date-fns/locale/en-US'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as EventItems from '@/components/events/EventItems'
import { DndStateContext, type DndState } from '@/components/dnd/dndState'
import { api } from '@/lib/api/client'
import { occurrenceTask, toCalTask } from '@/lib/calendarTasks'
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
          {
            kind: 'corrupted',
            key: 'bad',
            calendarId: 'c1',
            start: new Date(2026, 8, 26, 9),
            reason: 'title: bad',
            issues: [{ path: 'title', code: 'invalid_type' }],
          },
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

    it('picks up an upcoming repeat of a series on fixed days from its own day, too', () => {
      const t = upcoming({ rrule: 'FREQ=WEEKLY;BYDAY=MO,TH,FR,SU', fixedDays: true })
      const onDragStart = vi.fn<(e: DragStartEvent) => void>()
      renderMonth([t], { onDragStart })
      const title = screen.getByRole('button', { name })
      expect(title).toHaveAttribute('aria-roledescription', 'draggable')
      fireEvent.keyDown(title, { code: 'Space', key: ' ' })
      expect(onDragStart).toHaveBeenCalledTimes(1)
      expect(onDragStart.mock.calls[0]![0].active.data.current).toEqual({
        type: 'event',
        event: t,
        originDay: new Date(2026, 8, 27),
      })
    })

    it('keeps an upcoming repeat of a series whose rule is unsupported in place', () => {
      const onDragStart = vi.fn<(e: DragStartEvent) => void>()
      renderMonth([upcoming({ rrule: 'FREQ=SOMETIMES', ruleUnsupported: true })], { onDragStart })
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

  it('highlights the day under a drag', async () => {
    const call = toCalTask(todo({ id: 't2', title: 'Call', due: '2026-09-25T08:00:00Z' }))!
    // jsdom lays nothing out: only Friday's cell and the task in it share a box, so the task is over Friday.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.dataset.day === '2026-09-25' || this.dataset.taskKey ? rect(0, 0, 100, 100) : rect(1000, 1000, 10, 10)
    })
    renderMonth([call])
    const friday = screen.getByRole('gridcell', { name: /September 25th/ })
    fireEvent.keyDown(screen.getByRole('button', { name: 'Call, 10 AM' }), { code: 'Space', key: ' ' })
    await waitFor(() => {
      expect(friday).toHaveClass('bg-primary/8')
    })
  })

  it('counts tasks apart from events in the cell label', () => {
    const rent = toCalTask(todo({ title: 'Pay rent', due: '2026-09-25T00:00:00Z', dueAllDay: true }))!
    renderMonth([toCalEvent(apiEvent()), rent])
    expect(screen.getByRole('gridcell', { name: 'Friday, September 25th, 2026, 1 event, 1 task' })).toBeInTheDocument()
    expect(screen.getByRole('gridcell', { name: 'Saturday, September 26th, 2026, no events' })).toBeInTheDocument()
  })

  describe('scrolling (FR-08)', () => {
    // As on the calendar page: the month the store has, in its scroll container.
    function ConnectedMonth() {
      const date = useUi((s) => s.date)
      return (
        <div data-testid="scroller" style={{ overflowY: 'auto' }}>
          <MonthView
            date={date}
            now={new Date(2026, 8, 25, 12)}
            events={[]}
            corrupted={[]}
            prefs={prefs}
            colorsOf={() => colors}
            calendarOf={() => cal}
          />
        </div>
      )
    }

    function renderConnected(dnd: Partial<DndState> = {}) {
      act(() => {
        useUi.getState().setDate(new Date(2026, 8, 25))
      })
      renderWithProviders(
        <DndContext>
          <DndStateContext
            value={{
              pendingKeys: new Set(),
              pendingSeries: new Set(),
              pendingTodos: new Set(),
              resize: null,
              activeId: null,
              scope: null,
              held: null,
              scopeAnchor: () => undefined,
              ...dnd,
            }}
          >
            <ConnectedMonth />
          </DndStateContext>
        </DndContext>,
      )
    }

    /**
     * Lays out the scroll container `clientHeight` tall, scrolled to `scrollTop`, around a month 100 px per row: a
     * month of six weeks is taller than one of five. Like a browser, it scrolls no further than the month's end.
     */
    function layOut(scrollTop: number, clientHeight: number) {
      const el = screen.getByTestId('scroller')
      const scrollHeight = () => 100 * within(el).getAllByRole('row').length
      let top = scrollTop
      Object.defineProperties(el, {
        scrollTop: {
          get: () => top,
          set: (v: number) => {
            top = Math.max(0, Math.min(v, scrollHeight() - clientHeight))
          },
        },
        clientHeight: { value: clientHeight },
        scrollHeight: { get: scrollHeight },
      })
      return el
    }

    /** Scrolls over the month; false when the month kept the browser from scrolling. */
    function scroll(deltaY: number, timeStamp: number): boolean {
      const e = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true })
      Object.defineProperty(e, 'timeStamp', { value: timeStamp })
      return fireEvent(screen.getByRole('grid'), e)
    }

    afterEach(() => {
      act(() => {
        useUi.getState().setSettingsOpen(false)
      })
    })

    it('steps a month per gesture: down to the next, up to the previous', () => {
      renderConnected()
      expect(scroll(100, 0)).toBe(false)
      expect(screen.getByRole('grid', { name: 'October 2026' })).toBeInTheDocument()
      // Its momentum does not skip a month.
      scroll(60, 16)
      scroll(20, 32)
      expect(screen.getByRole('grid', { name: 'October 2026' })).toBeInTheDocument()
      scroll(-100, 1000)
      expect(screen.getByRole('grid', { name: 'September 2026' })).toBeInTheDocument()
    })

    it('steps neither while a dialog nor while the create popover is open', () => {
      renderConnected()
      act(() => {
        useUi.getState().setSettingsOpen(true)
      })
      scroll(100, 0)
      expect(useUi.getState().date.getMonth()).toBe(8)
      act(() => {
        useUi.getState().setSettingsOpen(false)
      })
      fireEvent.keyDown(screen.getByRole('gridcell', { name: /September 25th/ }), { key: 'Enter' })
      expect(useUi.getState().create).not.toBeNull()
      scroll(100, 1000)
      expect(useUi.getState().date.getMonth()).toBe(8)
      expect(useUi.getState().create).not.toBeNull()
    })

    it.each<[string, Partial<DndState>]>([
      ['an event is dragged', { activeId: 'e1' }],
      ['an event is resized', { resize: toCalEvent(apiEvent()) }],
      [
        'a move asks which events it reaches',
        { scope: { kind: 'event', key: 'k', id: 'e1', from: '2026-09-25', reach: null, start: '', end: '' } },
      ],
    ])('steps not while %s', (_, dnd) => {
      renderConnected(dnd)
      scroll(100, 0)
      expect(useUi.getState().date.getMonth()).toBe(8)
    })

    it('scrolls a month taller than its window first and shows a stepped-to month from where it goes on', () => {
      renderConnected()
      // September 2026 has five weeks: with its header, 600 px in a 450 px window.
      const scroller = layOut(0, 450)
      expect(scroll(100, 0)).toBe(true)
      expect(useUi.getState().date.getMonth()).toBe(8)
      scroller.scrollTop = 150
      expect(scroll(100, 400)).toBe(false)
      expect(screen.getByRole('grid', { name: 'October 2026' })).toBeInTheDocument()
      expect(scroller.scrollTop).toBe(0)
      expect(scroll(-100, 800)).toBe(false)
      expect(screen.getByRole('grid', { name: 'September 2026' })).toBeInTheDocument()
      expect(scroller.scrollTop).toBe(150)
      // August 2026 has six weeks, so its end lies further down than September's.
      scroller.scrollTop = 0
      expect(scroll(-100, 1200)).toBe(false)
      expect(screen.getByRole('grid', { name: 'August 2026' })).toBeInTheDocument()
      expect(scroller.scrollTop).toBe(250)
    })
  })
})

