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
})
