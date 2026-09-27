import { DndContext } from '@dnd-kit/core'
import { fireEvent, screen } from '@testing-library/react'
import { enUS } from 'date-fns/locale/en-US'
import { afterEach, describe, expect, it } from 'vitest'
import { eventColors } from '@/lib/color'
import { type FormatPrefs } from '@/lib/format'
import { useUi } from '@/stores/ui'
import { calendar } from '@/test/fixtures'
import { renderWithProviders } from '@/test/render'
import { TimeGridView } from './TimeGridView'

const prefs: FormatPrefs = { tag: 'en-US', locale: enUS, hourCycle: '12h', weekStartsOn: 0 }
const colors = eventColors('#3b82f6', false)
const cal = calendar()

function renderDay() {
  return renderWithProviders(
    <DndContext>
      <TimeGridView
        days={[new Date(2026, 8, 25)]}
        now={new Date(2026, 8, 25, 12)}
        events={[]}
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
    useUi.getState().openEditor(null)
  })

  it.each([
    ['top', 0],
    ['middle', 24],
    ['bottom', 44],
  ])('creates a one-hour event at the full hour from a click at the %s of the slot', (_, clientY) => {
    renderDay()
    fireEvent.click(screen.getByRole('button', { name: /9:00 AM$/ }), { clientY })
    expect(useUi.getState().editor).toEqual({
      mode: 'create',
      defaults: { start: new Date(2026, 8, 25, 9), end: new Date(2026, 8, 25, 10), allDay: false },
    })
  })

  // jsdom lays nothing out, so every slot's top is 0 and clientY is the offset in the slot:
  // 4 px = 09:05, 64 px = 10:20 (0.8 px per minute).
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
    expect(useUi.getState().editor).toEqual({
      mode: 'create',
      defaults: { start: new Date(2026, 8, 25, 9), end: new Date(2026, 8, 25, 10, 30), allDay: false },
    })
  })

  it.each([
    ['a mouse press that moves less than 6 px', 'mouse', 8],
    ['a touch, which scrolls the grid instead', 'touch', 64],
  ])('keeps %s a click on the full hour', (_, pointerType, toY) => {
    renderDay()
    const slot = screen.getByRole('button', { name: /9:00 AM$/ })
    pressAndMove(slot, pointerType, 4, toY)
    fireEvent.pointerUp(slot, { pointerId: 1, pointerType, clientX: 10, clientY: toY })
    fireEvent.click(slot, { clientY: toY })
    expect(useUi.getState().editor).toEqual({
      mode: 'create',
      defaults: { start: new Date(2026, 8, 25, 9), end: new Date(2026, 8, 25, 10), allDay: false },
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
    expect(useUi.getState().editor).toBeNull()
  })
})
