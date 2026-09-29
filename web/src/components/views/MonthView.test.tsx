import { DndContext, type DragStartEvent } from '@dnd-kit/core'
import { act, fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { enUS } from 'date-fns/locale/en-US'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as EventItems from '@/components/events/EventItems'
import { api } from '@/lib/api/client'
import { toCalTask } from '@/lib/calendarTasks'
import { eventColors } from '@/lib/color'
import { toCalEvent, type CalItem } from '@/lib/events'
import { type FormatPrefs } from '@/lib/format'
import { previewOf } from '@/lib/quickCreate'
import { useUi } from '@/stores/ui'
import { apiEvent, calendar, todo } from '@/test/fixtures'
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

describe('MonthView', () => {
  afterEach(() => {
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

  it('counts tasks apart from events in the cell label', () => {
    const rent = toCalTask(todo({ title: 'Pay rent', due: '2026-09-25T00:00:00Z', dueAllDay: true }))!
    renderMonth([toCalEvent(apiEvent()), rent])
    expect(screen.getByRole('gridcell', { name: 'Friday, September 25th, 2026, 1 event, 1 task' })).toBeInTheDocument()
    expect(screen.getByRole('gridcell', { name: 'Saturday, September 26th, 2026, no events' })).toBeInTheDocument()
  })
})

