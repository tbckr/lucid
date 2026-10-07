import { de } from 'date-fns/locale/de'
import { enUS } from 'date-fns/locale/en-US'
import { describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import { toCalEvent } from './events'
import { type FormatPrefs } from './format'
import {
  eventScopeHint,
  eventScopeItems,
  eventScopeMissing,
  scopeOptions,
  type ScopeAction,
  type ScopeResult,
} from './scope'
import { apiEvent } from '@/test/fixtures'

const tz = 'Europe/Berlin'

/** One shown occurrence of a series, starting Monday 2026-03-09 09:00 Berlin. */
function occurrence(rrule: string, flags: { first?: boolean; hasAttendees?: boolean } = {}) {
  return toCalEvent(
    apiEvent({
      start: '2026-03-09T08:00:00Z',
      end: '2026-03-09T09:00:00Z',
      rrule,
      recurring: true,
      recurrenceId: '2026-03-09T08:00:00Z',
      ...flags,
    }),
  )
}

describe('scopeOptions for events', () => {
  const weekly = occurrence('FREQ=WEEKLY;BYDAY=MO')
  const monthly = occurrence('FREQ=MONTHLY;BYMONTHDAY=9')
  const hourly = occurrence('FREQ=DAILY;BYHOUR=9')
  // The series' first shown event has nothing before it; with attendees the server refuses to split.
  const weeklyFirst = occurrence('FREQ=WEEKLY;BYDAY=MO', { first: true })
  const monthlyFirst = occurrence('FREQ=MONTHLY;BYMONTHDAY=9', { first: true })
  const weeklyAttendees = occurrence('FREQ=WEEKLY;BYDAY=MO', { hasAttendees: true })
  const monthlyAttendees = occurrence('FREQ=MONTHLY;BYMONTHDAY=9', { hasAttendees: true })
  const weeklyFirstAttendees = occurrence('FREQ=WEEKLY;BYDAY=MO', { first: true, hasAttendees: true })
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
    // move or change, the series can follow
    {
      name: 'move a late event of a series that can follow',
      action: 'move',
      item: weekly,
      to: tuesday,
      want: { options: ['this', 'following', 'all'] },
    },
    { name: 'move the first event of a series that can follow', action: 'move', item: weeklyFirst, to: tuesday, want: { options: ['this', 'all'] } },
    {
      name: 'move a late event with attendees names what removed "following"',
      action: 'move',
      item: weeklyAttendees,
      to: tuesday,
      want: { options: ['this', 'all'], missing: 'attendees' },
    },
    {
      name: 'move the first event with attendees: it is the first, not the attendees, that removes "following"',
      action: 'move',
      item: weeklyFirstAttendees,
      to: tuesday,
      want: { options: ['this', 'all'] },
    },
    {
      name: 'change a late event of a series that can follow',
      action: 'change',
      item: weekly,
      to: tuesday,
      want: { options: ['this', 'following', 'all'] },
    },
    {
      name: 'change the first event of a series that can follow',
      action: 'change',
      item: weeklyFirst,
      to: tuesday,
      want: { options: ['this', 'all'] },
    },
    {
      name: 'change a late event with attendees',
      action: 'change',
      item: weeklyAttendees,
      to: tuesday,
      want: { options: ['this', 'all'], missing: 'attendees' },
    },
    {
      name: 'move to another time of a fixed-days series',
      action: 'move',
      item: monthly,
      to: sameDayLater,
      want: { options: ['this', 'following', 'all'] },
    },
    {
      name: 'change without a new start uses the shown start',
      action: 'change',
      item: monthly,
      want: { options: ['this', 'following', 'all'] },
    },
    {
      name: 'change of an all-day event without a new start',
      action: 'change',
      item: allDay,
      want: { options: ['this', 'following', 'all'] },
    },
    // move or change, the series can't follow: neither "following" nor "all"
    {
      name: 'move a late event of a series that cannot follow',
      action: 'move',
      item: monthly,
      to: tuesday,
      want: { options: ['this'], reason: 'fixedDays' },
    },
    {
      name: 'move the first event of a series that cannot follow',
      action: 'move',
      item: monthlyFirst,
      to: tuesday,
      want: { options: ['this'], reason: 'fixedDays' },
    },
    {
      name: 'move a late event with attendees of a series that cannot follow',
      action: 'move',
      item: monthlyAttendees,
      to: tuesday,
      want: { options: ['this'], reason: 'fixedDays' },
    },
    {
      name: 'change refused by the time',
      action: 'change',
      item: hourly,
      to: sameDayLater,
      want: { options: ['this'], reason: 'fixedTimes' },
    },
    // a rule change: "following" only before the first event, and never with attendees
    { name: 'rule change of a late event', action: 'rule', item: weekly, want: { options: ['following', 'all'] } },
    { name: 'rule change of the first event', action: 'rule', item: weeklyFirst, want: { options: ['all'] } },
    { name: 'rule change of a late event with attendees', action: 'rule', item: weeklyAttendees, want: { options: ['all'] } },
    { name: 'rule change of the first event with attendees', action: 'rule', item: weeklyFirstAttendees, want: { options: ['all'] } },
    { name: 'rule change ignores the new start', action: 'rule', item: monthly, to: tuesday, want: { options: ['following', 'all'] } },
    // a delete
    { name: 'delete a late event', action: 'delete', item: weekly, want: { options: ['this', 'following', 'all'] } },
    { name: 'delete the first event', action: 'delete', item: weeklyFirst, want: { options: ['this', 'all'] } },
    {
      name: 'delete a late event with attendees',
      action: 'delete',
      item: weeklyAttendees,
      want: { options: ['this', 'all'], missing: 'attendees' },
    },
    { name: 'delete the first event with attendees', action: 'delete', item: weeklyFirstAttendees, want: { options: ['this', 'all'] } },
    { name: 'delete of a fixed-days series', action: 'delete', item: monthly, want: { options: ['this', 'following', 'all'] } },
    // not a series: nothing to choose
    { name: 'move of a single event', action: 'move', item: single, to: tuesday, want: { options: [] } },
    { name: 'rule change of a single event', action: 'rule', item: single, want: { options: [] } },
    { name: 'delete of a single event', action: 'delete', item: single, want: { options: [] } },
    { name: 'move of an override without a series', action: 'move', item: orphan, to: tuesday, want: { options: [] } },
    { name: 'delete of an override without a series', action: 'delete', item: orphan, want: { options: [] } },
    { name: 'move of a recurring event without a recurrenceId', action: 'move', item: nameless, to: tuesday, want: { options: [] } },
  ]

  it.each(rows)('$name', ({ action, item, to, want }) => {
    expect(scopeOptions({ kind: 'event', action, item, to, tz })).toStrictEqual(want)
  })
})

describe('eventScopeItems', () => {
  const us: FormatPrefs = { tag: 'en-US', locale: enUS, hourCycle: '12h', weekStartsOn: 0 }
  const deDE: FormatPrefs = { tag: 'de-DE', locale: de, hourCycle: '24h', weekStartsOn: 1 }
  const now = new Date(2026, 0, 1)
  // Its shown start is Monday, 9 March 2026, 09:00 in Berlin.
  const event = occurrence('FREQ=WEEKLY;BYDAY=MO')

  it('names each option and what it reaches, in order', () => {
    expect(eventScopeItems(i18n.getFixedT('en'), event, ['this', 'all'], us, now)).toEqual([
      { scope: 'this', label: 'Only this event', note: 'Only Mon, Mar 9.' },
      { scope: 'all', label: 'All events', note: 'Past ones too.' },
    ])
  })

  it('says it in German', () => {
    expect(eventScopeItems(i18n.getFixedT('de'), event, ['this', 'all'], deDE, now)).toEqual([
      { scope: 'this', label: 'Nur diesen Termin', note: 'Nur Mo., 9. März.' },
      { scope: 'all', label: 'Alle Termine', note: 'Auch vergangene.' },
    ])
  })

  it('names "this and following" with the day it starts on', () => {
    expect(eventScopeItems(i18n.getFixedT('en'), event, ['this', 'following', 'all'], us, now)).toEqual([
      { scope: 'this', label: 'Only this event', note: 'Only Mon, Mar 9.' },
      {
        scope: 'following',
        label: 'This and following events',
        note: 'From Mon, Mar 9 on, as a series of its own. Earlier ones stay as they are.',
      },
      { scope: 'all', label: 'All events', note: 'Past ones too.' },
    ])
  })

  it('names each option with what it reaches', () => {
    const items = (notes: 'change' | 'delete' | 'ruleRemoved') =>
      eventScopeItems(i18n.getFixedT('en'), event, ['this', 'following', 'all'], us, now, notes)
    expect(items('change').map((i) => i.note)).toEqual([
      'Only Mon, Mar 9.',
      'From Mon, Mar 9 on, as a series of its own. Earlier ones stay as they are.',
      'Past ones too.',
    ])
    expect(items('delete').map((i) => i.note)).toEqual([
      'Only Mon, Mar 9.',
      'The series ends before Mon, Mar 9.',
      'Past ones too.',
    ])
    expect(items('ruleRemoved').map((i) => i.note)).toEqual([
      'Only Mon, Mar 9.',
      'From Mon, Mar 9 on, only this event stays. Earlier ones stay as they are.',
      'Only this event stays. All others are deleted.',
    ])
  })

  it('says "this and following" in German', () => {
    const t = i18n.getFixedT('de')
    const items = (notes: 'change' | 'delete' | 'ruleRemoved') =>
      eventScopeItems(t, event, ['following', 'all'], deDE, now, notes)
    expect(items('change')).toEqual([
      {
        scope: 'following',
        label: 'Diesen und alle folgenden',
        note: 'Ab Mo., 9. März als eigene Serie. Frühere bleiben, wie sie sind.',
      },
      { scope: 'all', label: 'Alle Termine', note: 'Auch vergangene.' },
    ])
    expect(items('delete')[0]?.note).toBe('Die Serie endet vor dem Mo., 9. März.')
    expect(items('ruleRemoved').map((i) => i.note)).toEqual([
      'Ab Mo., 9. März bleibt nur dieser Termin. Frühere bleiben, wie sie sind.',
      'Nur dieser Termin bleibt. Alle anderen werden gelöscht.',
    ])
  })
})

describe('eventScopeMissing', () => {
  const en = i18n.getFixedT('en')

  it('says why "this and following" is not offered', () => {
    expect(eventScopeMissing(en, { options: ['this', 'all'], missing: 'attendees' })).toBe(
      "With attendees, the series can't be split.",
    )
    expect(eventScopeMissing(i18n.getFixedT('de'), { options: ['this', 'all'], missing: 'attendees' })).toBe(
      'Mit Teilnehmenden lässt sich die Serie nicht teilen.',
    )
  })

  it('has nothing to say when nothing is missing', () => {
    expect(eventScopeMissing(en, { options: ['this', 'following', 'all'] })).toBeUndefined()
    expect(eventScopeMissing(en, { options: ['this'], reason: 'fixedDays' })).toBeUndefined()
  })
})

describe('eventScopeHint', () => {
  const t = i18n.getFixedT('en')

  it('says that only this event changes, and why the series stays', () => {
    expect(eventScopeHint(t, { options: ['this'], reason: 'fixedDays' }, false)).toEqual({
      text: 'Only this event. The series stays on its days.',
      reach: 'this',
      tone: 'default',
    })
    expect(eventScopeHint(t, { options: ['this'], reason: 'fixedTimes' }, false)).toEqual({
      text: 'Only this event. The series keeps its times.',
      reach: 'this',
      tone: 'default',
    })
  })

  it('says that a new rule applies to every event', () => {
    expect(eventScopeHint(t, { options: ['all'] }, false)).toEqual({
      text: 'Applies to every event in the series.',
      reach: 'all',
      tone: 'default',
    })
  })

  it('warns in red that a removed rule deletes every other event', () => {
    expect(eventScopeHint(t, { options: ['all'] }, true)).toEqual({
      text: 'The series becomes this one event. All others are deleted.',
      reach: 'all',
      tone: 'destructive',
    })
  })

  it('says it in German', () => {
    const de = i18n.getFixedT('de')
    expect(eventScopeHint(de, { options: ['this'], reason: 'fixedDays' }, false)?.text).toBe(
      'Nur dieser Termin. Die Serie bleibt auf ihren Tagen.',
    )
    expect(eventScopeHint(de, { options: ['all'] }, true)?.text).toBe(
      'Die Serie wird zu diesem einen Termin. Alle anderen werden gelöscht.',
    )
  })

  it('has nothing to say with a choice, which the question asks, or without a series', () => {
    expect(eventScopeHint(t, { options: ['this', 'all'] }, false)).toBeNull()
    expect(eventScopeHint(t, { options: [] }, false)).toBeNull()
  })

  it('has nothing to say for a sole "this and following", which no event has', () => {
    expect(eventScopeHint(t, { options: ['following'] }, false)).toBeNull()
  })
})
