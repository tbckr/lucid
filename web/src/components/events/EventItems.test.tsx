import { DndContext } from '@dnd-kit/core'
import { render, screen } from '@testing-library/react'
import { enUS } from 'date-fns/locale/en-US'
import { describe, expect, it } from 'vitest'
import { eventColors } from '@/lib/color'
import { toCalEvent, type CalEvent } from '@/lib/events'
import { type FormatPrefs } from '@/lib/format'
import { apiEvent } from '@/test/fixtures'
import { renderWithProviders } from '@/test/render'
import { EventChip, RepeatGlyph, TimedBlock } from './EventItems'

const prefs: FormatPrefs = { tag: 'en-US', locale: enUS, hourCycle: '12h', weekStartsOn: 0 }
const colors = eventColors('#3b82f6', false)

function recurringEvent(modified: boolean): CalEvent {
  return toCalEvent(apiEvent({ recurring: true, rrule: 'FREQ=DAILY', modified }))
}

const drag = (event: CalEvent) => ({ id: event.key, data: { type: 'event' as const, event, originDay: event.startsAt }, disabled: false })

describe('EventItems', () => {
  it.each([
    [true, 'Repeating event, changed individually'],
    [false, 'Recurring event'],
  ])('marks a TimedBlock changed individually (modified: %s)', (modified, name) => {
    const event = recurringEvent(modified)
    renderWithProviders(
      <DndContext>
        <TimedBlock event={event} colors={colors} prefs={prefs} drag={drag(event)} size="md" />
      </DndContext>,
    )
    expect(screen.getByRole('img', { name })).toBeInTheDocument()
  })

  // The month grid's chips are the tightest tiles: only an exception earns a mark there (FR-17).
  it('marks an EventChip changed individually, but not a plain recurring one', () => {
    const changed = recurringEvent(true)
    renderWithProviders(
      <DndContext>
        <EventChip event={changed} colors={colors} prefs={prefs} drag={drag(changed)} />
      </DndContext>,
    )
    expect(screen.getByRole('img', { name: 'Repeating event, changed individually' })).toBeInTheDocument()
  })

  // A dot over lucide's top arrowhead merged with it at 12-16 px: the dot takes the arrowhead's place.
  it('draws the glyph of an event changed individually with a dot in place of the top arrowhead', () => {
    const { container } = render(
      <>
        <RepeatGlyph />
        <RepeatGlyph modified />
      </>,
    )
    const [plain, changed] = Array.from(container.querySelectorAll('svg'))
    expect(plain?.querySelector('circle')).toBeNull()
    expect(plain?.querySelector('path[d="m17 2 4 4-4 4"]')).not.toBeNull()
    expect(changed?.querySelector('circle')).not.toBeNull()
    expect(changed?.querySelector('path[d="m17 2 4 4-4 4"]')).toBeNull()
  })

  it('shows no mark on an EventChip of a plain recurring event', () => {
    const plain = recurringEvent(false)
    renderWithProviders(
      <DndContext>
        <EventChip event={plain} colors={colors} prefs={prefs} drag={drag(plain)} />
      </DndContext>,
    )
    expect(screen.queryByRole('img', { name: 'Recurring event' })).toBeNull()
  })
})
