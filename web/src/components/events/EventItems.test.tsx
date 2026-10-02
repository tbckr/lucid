import { DndContext } from '@dnd-kit/core'
import { screen } from '@testing-library/react'
import { enUS } from 'date-fns/locale/en-US'
import { describe, expect, it } from 'vitest'
import { eventColors } from '@/lib/color'
import { toCalEvent, type CalEvent } from '@/lib/events'
import { type FormatPrefs } from '@/lib/format'
import { apiEvent } from '@/test/fixtures'
import { renderWithProviders } from '@/test/render'
import { EventChip, TimedBlock } from './EventItems'

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

  it.each([
    [true, 'Repeating event, changed individually'],
    [false, 'Recurring event'],
  ])('marks an EventChip changed individually (modified: %s)', (modified, name) => {
    const event = recurringEvent(modified)
    renderWithProviders(
      <DndContext>
        <EventChip event={event} colors={colors} prefs={prefs} drag={drag(event)} />
      </DndContext>,
    )
    expect(screen.getByRole('img', { name })).toBeInTheDocument()
  })
})
