import { describe, expect, it } from 'vitest'
import { toCalEvent } from './events'
import { scopeOptions, type ScopeAction, type ScopeResult } from './scope'
import { apiEvent } from '@/test/fixtures'

const tz = 'Europe/Berlin'

/** One shown occurrence of a series, starting Monday 2026-03-09 09:00 Berlin. */
function occurrence(rrule: string) {
  return toCalEvent(
    apiEvent({
      start: '2026-03-09T08:00:00Z',
      end: '2026-03-09T09:00:00Z',
      rrule,
      recurring: true,
      recurrenceId: '2026-03-09T08:00:00Z',
    }),
  )
}

describe('scopeOptions for events', () => {
  const weekly = occurrence('FREQ=WEEKLY;BYDAY=MO')
  const monthly = occurrence('FREQ=MONTHLY;BYMONTHDAY=9')
  const hourly = occurrence('FREQ=DAILY;BYHOUR=9')
  // All-day events are date-only on the wire; their shown start is local midnight.
  const allDay = toCalEvent(
    apiEvent({
      start: '2026-03-09T00:00:00Z',
      end: '2026-03-10T00:00:00Z',
      allDay: true,
      timezone: '',
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=9',
      recurring: true,
      recurrenceId: '2026-03-09T00:00:00Z',
    }),
  )
  const single = toCalEvent(apiEvent({ rrule: '', recurring: false }))
  // An override whose series is gone: `recurrenceId` is set, `recurring` is not.
  const orphan = toCalEvent(apiEvent({ recurring: false, recurrenceId: '2026-03-09T08:00:00Z' }))
  // Defensive: `recurring` without a `recurrenceId` names no occurrence.
  const nameless = toCalEvent(apiEvent({ rrule: 'FREQ=WEEKLY;BYDAY=MO', recurring: true }))

  const tuesday = new Date('2026-03-10T09:00:00+01:00')
  const sameDayLater = new Date('2026-03-09T11:00:00+01:00')

  const rows: { name: string; action: ScopeAction; item: ReturnType<typeof occurrence>; to?: Date; want: ScopeResult }[] = [
    { name: 'move the series can follow', action: 'move', item: weekly, to: tuesday, want: { options: ['this', 'all'] } },
    {
      name: 'move the series cannot follow',
      action: 'move',
      item: monthly,
      to: tuesday,
      want: { options: ['this'], reason: 'fixedDays' },
    },
    { name: 'move to another time of a fixed-days series', action: 'move', item: monthly, to: sameDayLater, want: { options: ['this', 'all'] } },
    {
      name: 'change refused by the time',
      action: 'change',
      item: hourly,
      to: sameDayLater,
      want: { options: ['this'], reason: 'fixedTimes' },
    },
    { name: 'change without a new start uses the shown start', action: 'change', item: monthly, want: { options: ['this', 'all'] } },
    { name: 'change of an all-day event without a new start', action: 'change', item: allDay, want: { options: ['this', 'all'] } },
    { name: 'change the series can follow', action: 'change', item: weekly, to: tuesday, want: { options: ['this', 'all'] } },
    { name: 'rule change', action: 'rule', item: weekly, want: { options: ['all'] } },
    { name: 'rule change ignores the new start', action: 'rule', item: monthly, to: tuesday, want: { options: ['all'] } },
    { name: 'delete', action: 'delete', item: weekly, want: { options: ['this', 'all'] } },
    { name: 'delete of a fixed-days series', action: 'delete', item: monthly, want: { options: ['this', 'all'] } },
    { name: 'move of a single event', action: 'move', item: single, to: tuesday, want: { options: [] } },
    { name: 'rule change of a single event', action: 'rule', item: single, want: { options: [] } },
    { name: 'delete of a single event', action: 'delete', item: single, want: { options: [] } },
    { name: 'move of an override without a series', action: 'move', item: orphan, to: tuesday, want: { options: [] } },
    { name: 'delete of an override without a series', action: 'delete', item: orphan, want: { options: [] } },
    { name: 'move of a recurring event without a recurrenceId', action: 'move', item: nameless, to: tuesday, want: { options: [] } },
  ]

  it.each(rows)('$name', ({ action, item, to, want }) => {
    expect(scopeOptions({ kind: 'event', action, item, to, tz })).toEqual(want)
  })
})
