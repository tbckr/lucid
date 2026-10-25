import { DndContext, KeyboardSensor, PointerSensor, useDraggable, useSensor, useSensors } from '@dnd-kit/core'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { enUS } from 'date-fns/locale/en-US'
import { type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DndStateContext, type DndState } from '@/components/dnd/dndState'
import { TooltipProvider } from '@/components/ui/tooltip'
import { occurrenceTask, toCalTask } from '@/lib/calendarTasks'
import { eventColors } from '@/lib/color'
import { DRAG_DISTANCE } from '@/lib/dnd'
import { toCalEvent, type CalItem } from '@/lib/events'
import { type FormatPrefs } from '@/lib/format'
import { useUi } from '@/stores/ui'
import { apiEvent, occurrence, todo } from '@/test/fixtures'
import { renderWithProviders } from '@/test/render'
import { OverflowPopover, VIRTUALIZE_THRESHOLD } from './OverflowPopover'

const prefs: FormatPrefs = { tag: 'en-US', locale: enUS, hourCycle: '12h', weekStartsOn: 0 }
const colors = eventColors('#3b82f6', false)
const day = new Date(2026, 8, 25)
const HEADER = 'Friday, September 25th, 2026'

const idle: DndState = {
  pendingKeys: new Set(),
  pendingSeries: new Set(),
  pendingTodos: new Set(),
  resize: null,
  activeId: null,
  scope: null,
  held: null,
  scopeAnchor: () => undefined,
}

/** As the app's: a press becomes a drag after a few pixels, so a click on a row is a click. */
function Dnd({ children }: { children: ReactNode }) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: DRAG_DISTANCE } }),
    useSensor(KeyboardSensor, { keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space', 'Enter'] } }),
  )
  return <DndContext sensors={sensors}>{children}</DndContext>
}

interface Setup {
  lookup?: (key: string) => CalItem | undefined
  readOnly?: (calendarId: string) => boolean
  pendingTodos?: ReadonlySet<string>
  /** A click that reaches the element around the popover, as one reaches the day cell. */
  onCellClick?: () => void
}

function popover({ lookup = () => undefined, readOnly = () => false, pendingTodos = new Set(), onCellClick }: Setup = {}) {
  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events -- stands for the day cell
    <div onClick={onCellClick}>
      <Dnd>
        <DndStateContext value={{ ...idle, pendingTodos }}>
          <OverflowPopover prefs={prefs} colorsOf={() => colors} readOnly={readOnly} lookup={lookup} />
        </DndStateContext>
      </Dnd>
    </div>
  )
}

function renderPopover(setup: Setup = {}) {
  const result = renderWithProviders(popover(setup))
  return {
    ...result,
    /** Renders the popover again, as the page does when its items change. */
    update(next: Setup) {
      result.rerender(
        <QueryClientProvider client={result.queryClient}>
          <TooltipProvider>{popover(next)}</TooltipProvider>
        </QueryClientProvider>,
      )
    },
  }
}

// The button that opened the list and the cell around it: plain elements, so that a test can take the button away.
let anchor: HTMLButtonElement
let home: HTMLDivElement

beforeEach(() => {
  home = document.createElement('div')
  home.tabIndex = -1
  anchor = document.createElement('button')
  anchor.textContent = '2 more'
  home.append(anchor)
  document.body.append(home)
})

afterEach(() => {
  act(() => {
    useUi.getState().openOverflow(null)
    useUi.getState().openDetail(null)
  })
  home.remove()
})

/** Opens the list the way a "+N" button does, after the first render (as in the app). */
function open(items: CalItem[]) {
  act(() => {
    useUi.getState().openOverflow({
      id: 'more:2026-09-25',
      day,
      items,
      drag: 'event',
      anchor,
      home,
      rect: new DOMRect(10, 20, 100, 20),
    })
  })
}

const standup = toCalEvent(apiEvent({ id: 'e1', key: 'e1', title: 'Standup' }))
const holiday = toCalEvent(
  apiEvent({ id: 'e2', key: 'e2', title: 'Holiday', allDay: true, start: '2026-09-25T00:00:00Z', end: '2026-09-26T00:00:00Z' }),
)
const rent = toCalTask(todo({ id: 't1', title: 'Pay rent', due: '2026-09-25T08:00:00Z' }))!

function rowKeys(list: HTMLElement): (string | null)[] {
  return within(list)
    .getAllByRole('listitem')
    .map((li) => {
      const row = li.querySelector('[data-event-key], [data-task-key]')
      return row?.getAttribute('data-event-key') ?? row?.getAttribute('data-task-key') ?? null
    })
}

describe('OverflowPopover', () => {
  it('lists exactly the items it opened with', async () => {
    renderPopover()
    open([standup, rent, holiday])
    const list = await screen.findByRole('dialog', { name: HEADER })
    expect(within(list).getByText(HEADER)).toBeInTheDocument()
    expect(rowKeys(list)).toEqual(['e1', 'task:t1', 'e2'])
    // Rows are as tall as the list's rows always were, whatever they are.
    expect(within(list).getByRole('button', { name: 'Standup, 10 AM' })).toHaveClass('h-6')
    expect(within(list).getByRole('button', { name: 'Holiday, all day' })).toHaveClass('h-6')
    expect(list.querySelector('[data-task-key]')).toHaveClass('h-6')
  })

  it('stays closed until the store opens it', () => {
    renderPopover()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('closes and opens the details of a task at its button', async () => {
    const user = userEvent.setup()
    renderPopover()
    open([standup, rent])
    await user.click(await screen.findByRole('button', { name: /Pay rent/ }))
    // The task's chip leaves with the list; the details stay at the button.
    const { detail } = useUi.getState()
    expect(detail?.item).toBe(rent)
    expect(detail?.anchor).toBe(anchor)
    expect(useUi.getState().overflow).toBeNull()
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Pay rent/ })).not.toBeInTheDocument()
    })
  })

  it('closes and opens the details of an event at its button', async () => {
    const user = userEvent.setup()
    renderPopover()
    open([standup, holiday])
    await user.click(await screen.findByRole('button', { name: 'Holiday, all day' }))
    expect(useUi.getState().detail?.item).toBe(holiday)
    expect(useUi.getState().detail?.anchor).toBe(anchor)
    expect(useUi.getState().overflow).toBeNull()
  })

  it('opens the details of an event with Enter, at the button too', async () => {
    const user = userEvent.setup()
    renderPopover()
    open([standup])
    const row = await screen.findByRole('button', { name: 'Standup, 10 AM' })
    row.focus()
    await user.keyboard('{Enter}')
    expect(useUi.getState().detail?.item).toBe(standup)
    expect(useUi.getState().detail?.anchor).toBe(anchor)
  })

  it('anchors the details at home once the button is gone', async () => {
    const user = userEvent.setup()
    renderPopover()
    open([standup, rent])
    const row = await screen.findByRole('button', { name: /Pay rent/ })
    anchor.remove()
    await user.click(row)
    expect(useUi.getState().detail?.item).toBe(rent)
    expect(useUi.getState().detail?.anchor).toBe(home)
  })

  it('keeps its clicks from reaching the cell around the button', async () => {
    const user = userEvent.setup()
    let clicks = 0
    renderPopover({
      onCellClick: () => {
        clicks++
      },
    })
    open([standup])
    // The list is portaled out of the cell, but React bubbles its clicks into the cell, which would create an entry.
    const list = await screen.findByRole('dialog', { name: HEADER })
    await user.click(within(list).getByText(HEADER))
    expect(clicks).toBe(0)
  })

  describe('keeps its list until it is closed (FR-07)', () => {
    it('keeps a completed task checked after it leaves the calendar', async () => {
      const done = { ...rent, todo: { ...rent.todo, status: 'COMPLETED' as const } }
      const view = renderPopover({ lookup: (key) => (key === rent.key ? rent : undefined) })
      open([standup, rent])
      const box = await screen.findByRole('checkbox', { name: /Pay rent/ })
      expect(box).toHaveAttribute('aria-checked', 'false')

      // Another app, or this one, completes it, and the calendar hides completed tasks.
      view.update({ lookup: (key) => (key === rent.key ? done : undefined) })
      expect(screen.getByRole('checkbox', { name: /Pay rent/ })).toHaveAttribute('aria-checked', 'true')
      expect(rowKeys(screen.getByRole('dialog', { name: HEADER }))).toEqual(['e1', 'task:t1'])

      // The task is gone from the calendar altogether: its row stays as the list had it.
      view.update({ lookup: () => undefined })
      expect(screen.getByRole('checkbox', { name: /Pay rent/ })).toHaveAttribute('aria-checked', 'false')
      expect(rowKeys(screen.getByRole('dialog', { name: HEADER }))).toEqual(['e1', 'task:t1'])
    })

    it('keeps a completed repeat checked', async () => {
      const series = todo({ id: 's1', title: 'Water plants', recurring: true, rrule: 'FREQ=DAILY' })
      const fields = { key: 's1@2026-09-25T00:00:00Z', todoId: 's1', title: 'Water plants' }
      const current = occurrenceTask(occurrence({ ...fields, state: 'current' }), series)!
      const done = occurrenceTask(occurrence({ ...fields, state: 'done' }), series)!
      const view = renderPopover({ lookup: () => current })
      open([current])
      expect(await screen.findByRole('checkbox', { name: /Water plants/ })).toHaveAttribute('aria-checked', 'false')

      view.update({ lookup: (key) => (key === current.key ? done : undefined) })
      expect(screen.getByRole('checkbox', { name: /Water plants/ })).toHaveAttribute('aria-checked', 'true')
    })

    it('shows an event as the calendar has it now', async () => {
      const renamed = { ...standup, title: 'Stand-up' }
      const view = renderPopover()
      open([standup])
      expect(await screen.findByRole('button', { name: 'Standup, 10 AM' })).toBeInTheDocument()
      view.update({ lookup: () => renamed })
      expect(screen.getByRole('button', { name: 'Stand-up, 10 AM' })).toBeInTheDocument()
    })
  })

  describe('focus', () => {
    it('returns to the button when it closes', async () => {
      const user = userEvent.setup()
      renderPopover()
      open([standup])
      await screen.findByRole('dialog', { name: HEADER })
      await user.keyboard('{Escape}')
      await waitFor(() => {
        expect(document.activeElement).toBe(anchor)
      })
    })

    it('returns to home when the button is gone', async () => {
      const user = userEvent.setup()
      renderPopover()
      open([standup])
      await screen.findByRole('dialog', { name: HEADER })
      anchor.remove()
      await user.keyboard('{Escape}')
      await waitFor(() => {
        expect(document.activeElement).toBe(home)
      })
    })

    it('stays where the details put it when a row opens them', async () => {
      renderPopover()
      open([standup])
      const details = document.createElement('input')
      document.body.append(details)
      try {
        fireEvent.click(await screen.findByRole('button', { name: 'Standup, 10 AM' }))
        // The details popover takes the focus as it opens; the list's close must not take it back.
        details.focus()
        await new Promise((r) => setTimeout(r, 20))
        expect(document.activeElement).toBe(details)
      } finally {
        details.remove()
      }
    })
  })

  describe('dragging a row (FR-10)', () => {
    it('makes rows draggable as their tiles are', async () => {
      const locked = toCalEvent(apiEvent({ id: 'e3', key: 'e3', calendarId: 'locked', title: 'Birthday' }))
      const busy = toCalTask(todo({ id: 't2', title: 'Call', due: '2026-09-25T09:00:00Z' }))!
      renderPopover({ readOnly: (id) => id === 'locked', pendingTodos: new Set(['t2']) })
      open([standup, locked, rent, busy])
      const list = await screen.findByRole('dialog', { name: HEADER })
      expect(within(list).getByRole('button', { name: 'Standup, 10 AM' })).toHaveAttribute('aria-roledescription')
      expect(within(list).getByRole('button', { name: 'Birthday, 10 AM' })).not.toHaveAttribute('aria-roledescription')
      expect(within(list).getByRole('button', { name: /Pay rent/ })).toHaveAttribute('aria-roledescription')
      expect(within(list).getByRole('button', { name: /Call/ })).not.toHaveAttribute('aria-roledescription')
    })

    it('keeps a task of a read-only calendar in place', async () => {
      renderPopover({ readOnly: () => true })
      open([rent])
      expect(await screen.findByRole('button', { name: /Pay rent/ })).not.toHaveAttribute('aria-roledescription')
    })

    it('hides while a row is dragged out and closes when the drag ends', async () => {
      renderPopover()
      open([standup, rent])
      const list = await screen.findByRole('dialog', { name: HEADER })
      expect(list).not.toHaveClass('invisible')
      fireEvent.keyDown(within(list).getByRole('button', { name: 'Standup, 10 AM' }), { code: 'Space', key: ' ' })
      await waitFor(() => {
        expect(list).toHaveClass('invisible')
      })
      // Hidden, not unmounted: the row being dragged stays where dnd-kit holds it.
      expect(list).toBeInTheDocument()
      expect(useUi.getState().overflow).not.toBeNull()
      await act(() => new Promise((r) => setTimeout(r, 0)))
      fireEvent.keyDown(document, { code: 'Space', key: ' ' })
      await waitFor(() => {
        expect(useUi.getState().overflow).toBeNull()
      })
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      })
    })

    it('stays visible while something else is dragged', async () => {
      function Elsewhere() {
        const { attributes, listeners, setNodeRef } = useDraggable({ id: 'chip:elsewhere', data: {} })
        return (
          <button ref={setNodeRef} {...attributes} {...listeners}>
            elsewhere
          </button>
        )
      }
      renderWithProviders(
        <Dnd>
          <Elsewhere />
          <DndStateContext value={idle}>
            <OverflowPopover prefs={prefs} colorsOf={() => colors} readOnly={() => false} lookup={() => undefined} />
          </DndStateContext>
        </Dnd>,
      )
      open([standup])
      const list = await screen.findByRole('dialog', { name: HEADER })
      fireEvent.keyDown(screen.getByRole('button', { name: 'elsewhere' }), { code: 'Space', key: ' ' })
      await act(() => new Promise((r) => setTimeout(r, 0)))
      expect(list).not.toHaveClass('invisible')
      fireEvent.keyDown(document, { code: 'Space', key: ' ' })
      await act(() => new Promise((r) => setTimeout(r, 0)))
      // The drag elsewhere ended; the list is not its business.
      expect(useUi.getState().overflow).not.toBeNull()
      expect(list).not.toHaveClass('invisible')
    })
  })

  describe('NFR-25', () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => toCalEvent(apiEvent({ id: `m${i}`, key: `m${i}`, title: `Event ${i}` })))

    it('lists up to 10 rows plainly', async () => {
      renderPopover()
      open(many(VIRTUALIZE_THRESHOLD))
      await screen.findByRole('dialog', { name: HEADER })
      expect(screen.queryByTestId('more-virtual')).not.toBeInTheDocument()
      expect(screen.getAllByRole('listitem')).toHaveLength(VIRTUALIZE_THRESHOLD)
    })

    it('virtualizes more than 10 rows', async () => {
      renderPopover()
      open(many(VIRTUALIZE_THRESHOLD + 1))
      await screen.findByRole('dialog', { name: HEADER })
      expect(screen.getByTestId('more-virtual')).toBeInTheDocument()
    })
  })
})
