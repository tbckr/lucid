import { DndContext } from '@dnd-kit/core'
import { act, fireEvent, screen, within } from '@testing-library/react'
import { enUS } from 'date-fns/locale/en-US'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as EventItems from '@/components/events/EventItems'
import { toCalTask } from '@/lib/calendarTasks'
import { eventColors } from '@/lib/color'
import { toCalEvent, type CalItem } from '@/lib/events'
import { type FormatPrefs } from '@/lib/format'
import { type CreatePreview } from '@/lib/quickCreate'
import { useUi } from '@/stores/ui'
import { apiEvent, calendar, todo } from '@/test/fixtures'
import { renderWithProviders } from '@/test/render'
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

function renderDay(events: CalItem[] = []) {
  return renderWithProviders(
    <DndContext>
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

describe('TimeGridView', () => {
  afterEach(() => {
    useUi.getState().openCreate(null)
  })

  // jsdom lays nothing out, so every slot's top is 0 and clientY is the offset in the slot
  // (0.8 px per minute): 4 px = 09:05, 24 px = 09:30, 44 px = 09:55, 64 px = 10:20.

  it.each([
    ['at the top of the slot', 0, 0],
    ['half-way down', 24, 30],
    ['near the bottom', 44, 45],
    // Assistive tech clicks at clientY 0, above the slot.
    ['without a pointer position', -100, 0],
  ])('starts a one-hour event in the 15-minute block under a click %s', (_, clientY, minute) => {
    renderDay()
    const slot = screen.getByRole('button', { name: /9:00 AM$/ })
    fireEvent.click(slot, { clientY })
    const create = useUi.getState().create
    expect(create).toMatchObject({
      origin: {
        start: new Date(2026, 8, 25, 9, minute),
        end: new Date(2026, 8, 25, 10, minute),
        allDay: false,
        granularity: 'time',
        ranged: false,
      },
      span: { startMin: 540 + minute, endMin: 600 + minute },
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
      end: new Date(2026, 8, 25, 10, minute),
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
  it('opens the popover for an all-day event from the all-day row', () => {
    renderDay()
    const cell = screen.getByRole('button', { name: /New all-day event/ })
    fireEvent.click(cell)
    const create = useUi.getState().create
    expect(create?.origin).toMatchObject({ start: new Date(2026, 8, 25), allDay: true, granularity: 'day', ranged: false })
    expect(create?.anchor).toBe(cell)
    expect(create?.returnFocus).toBe(cell)
  })

  /** Open the popover at 09:00 and give it `preview`, as the popover does. */
  function withPreview(preview: Partial<CreatePreview>) {
    const slot = screen.getByRole('button', { name: /9:00 AM$/ })
    act(() => {
      fireEvent.click(slot, { clientY: 0 })
      useUi.getState().setCreatePreview({
        kind: 'event',
        calendarId: 'c1',
        title: 'Review',
        start: new Date(2026, 8, 25, 10),
        end: new Date(2026, 8, 25, 11),
        allDay: false,
        point: false,
        ...preview,
      })
    })
  }

  it('draws the draft where the entry will land', () => {
    const { container } = renderDay()
    withPreview({})
    const draft = container.querySelector<HTMLElement>('[data-draft]')!
    expect(draft).toHaveTextContent('Review')
    expect(draft).toHaveTextContent('10 AM – 11 AM')
    expect(draft.style.top).toBe('480px')
  })

  it('draws a task draft with its time only', () => {
    const { container } = renderDay()
    withPreview({ kind: 'task', title: '', point: true, end: new Date(2026, 8, 25, 10, 30) })
    const draft = container.querySelector<HTMLElement>('[data-draft]')!
    expect(draft).toHaveTextContent('(No title)')
    expect(draft).toHaveTextContent(/10 AM$/)
  })

  it('clips a draft that runs past midnight', () => {
    const { container } = renderDay()
    withPreview({ start: new Date(2026, 8, 25, 23, 30), end: new Date(2026, 8, 26, 0, 30) })
    const draft = container.querySelector<HTMLElement>('[data-draft]')!
    expect(draft.style.top).toBe('1128px')
    expect(draft.style.height).toBe('22px')
  })

  it('highlights the day of an all-day draft', () => {
    renderDay()
    withPreview({ allDay: true, start: new Date(2026, 8, 25), end: new Date(2026, 8, 26) })
    expect(screen.getByRole('button', { name: /New all-day event/ }).parentElement).toHaveAttribute('data-draft')
  })
  it('re-draws only the draft while its title is typed', () => {
    const { container } = renderDay([toCalEvent(apiEvent({ start: '2026-09-25T12:00:00Z', end: '2026-09-25T13:00:00Z' }))])
    withPreview({ title: 'R' })
    const before = blockRenders.count
    act(() => {
      // The popover builds a new preview, with new dates, on every keystroke.
      const p = useUi.getState().create!.preview!
      useUi.getState().setCreatePreview({ ...p, start: new Date(p.start), end: new Date(p.end), title: 'Re' })
    })
    expect(container.querySelector('[data-draft]')).toHaveTextContent('Re')
    expect(blockRenders.count).toBe(before)
  })
})
