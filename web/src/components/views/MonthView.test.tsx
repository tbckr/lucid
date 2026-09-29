import { DndContext } from '@dnd-kit/core'
import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { enUS } from 'date-fns/locale/en-US'
import { describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api/client'
import { toCalTask } from '@/lib/calendarTasks'
import { eventColors } from '@/lib/color'
import { toCalEvent, type CalItem } from '@/lib/events'
import { type FormatPrefs } from '@/lib/format'
import { useUi } from '@/stores/ui'
import { apiEvent, calendar, todo } from '@/test/fixtures'
import { renderWithProviders } from '@/test/render'
import { MonthView } from './MonthView'

const prefs: FormatPrefs = { tag: 'en-US', locale: enUS, hourCycle: '12h', weekStartsOn: 0 }
const colors = eventColors('#3b82f6', false)
const cal = calendar()

function renderMonth(events: CalItem[] = [toCalEvent(apiEvent({ title: 'Standup' }))]) {
  return renderWithProviders(
    <DndContext>
      <MonthView
        date={new Date(2026, 8, 25)}
        now={new Date(2026, 8, 25, 12)}
        events={events}
        corrupted={[
          { kind: 'corrupted', key: 'bad', calendarId: 'c1', start: new Date(2026, 8, 26, 9), reason: 'title: bad' },
        ]}
        prefs={prefs}
        colorsOf={() => colors}
        calendarOf={() => cal}
      />
    </DndContext>,
  )
}

describe('MonthView', () => {
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

  it('opens the create dialog state from a cell and moves focus with arrows', async () => {
    const user = userEvent.setup()
    renderMonth()
    const today = screen.getByRole('gridcell', { name: /September 25th/ })
    today.focus()
    await user.keyboard('{ArrowLeft}')
    const thu = screen.getByRole('gridcell', { name: /September 24th/ })
    expect(thu).toHaveFocus()
    await user.keyboard('{Enter}')
    const editor = useUi.getState().editor
    expect(editor?.mode).toBe('create')
    if (editor?.mode === 'create') expect(editor.defaults.start.getDate()).toBe(24)
    useUi.getState().openEditor(null)
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
    expect(useUi.getState().editor).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Call, 10 AM' }))
    expect(useUi.getState().editor).toBeNull()
    expect(useUi.getState().detail?.item).toBe(call)
    useUi.getState().openDetail(null)
  })

  it('counts tasks apart from events in the cell label', () => {
    const rent = toCalTask(todo({ title: 'Pay rent', due: '2026-09-25T00:00:00Z', dueAllDay: true }))!
    renderMonth([toCalEvent(apiEvent()), rent])
    expect(screen.getByRole('gridcell', { name: 'Friday, September 25th, 2026, 1 event, 1 task' })).toBeInTheDocument()
    expect(screen.getByRole('gridcell', { name: 'Saturday, September 26th, 2026, no events' })).toBeInTheDocument()
  })
})

