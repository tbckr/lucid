import { de } from 'date-fns/locale/de'
import { enUS } from 'date-fns/locale/en-US'
import { describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import { type Todo } from './api/schemas'
import { currentRepeat, type TaskDates, type TaskRepeat, type ZonedTaskDates } from './calendarTasks'
import { toCalEvent, type CalEvent } from './events'
import { type FormatPrefs } from './format'
import {
  eventScopeHint,
  eventScopeItems,
  eventScopeMissing,
  glyphSlots,
  scopeOptions,
  taskGlyphSlots,
  taskScopeHint,
  taskScopeItems,
  taskScopeMissing,
  type ScopeAction,
  type ScopeResult,
} from './scope'
import { apiEvent, todo } from '@/test/fixtures'

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
      { scope: 'this', label: 'Only this event', note: 'Only Mon, Mar 9.', slots: glyphSlots('this') },
      { scope: 'all', label: 'All events', note: 'Past ones too.', slots: glyphSlots('all') },
    ])
  })

  it('says it in German', () => {
    expect(eventScopeItems(i18n.getFixedT('de'), event, ['this', 'all'], deDE, now)).toEqual([
      { scope: 'this', label: 'Nur diesen Termin', note: 'Nur Mo., 9. März.', slots: glyphSlots('this') },
      { scope: 'all', label: 'Alle Termine', note: 'Auch vergangene.', slots: glyphSlots('all') },
    ])
  })

  it('names "this and following" with the day it starts on', () => {
    expect(eventScopeItems(i18n.getFixedT('en'), event, ['this', 'following', 'all'], us, now)).toEqual([
      { scope: 'this', label: 'Only this event', note: 'Only Mon, Mar 9.', slots: glyphSlots('this') },
      {
        scope: 'following',
        label: 'This and following events',
        note: 'From Mon, Mar 9 on, as a series of its own. Earlier ones stay as they are.',
        slots: glyphSlots('following'),
      },
      { scope: 'all', label: 'All events', note: 'Past ones too.', slots: glyphSlots('all') },
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
        slots: glyphSlots('following'),
      },
      { scope: 'all', label: 'Alle Termine', note: 'Auch vergangene.', slots: glyphSlots('all') },
    ])
    expect(items('delete')[0]?.note).toBe('Die Serie endet vor dem Mo., 9. März.')
    expect(items('ruleRemoved').map((i) => i.note)).toEqual([
      'Ab Mo., 9. März bleibt nur dieser Termin. Frühere bleiben, wie sie sind.',
      'Nur dieser Termin bleibt. Alle anderen werden gelöscht.',
    ])
  })

  // Final review, Minor 2: the server splits by recurrence ID, so "this and following" reaches every
  // event from the earlier of the event's recurrence date and its shown start; "only this" stays
  // on the day the event is shown.
  describe('of an event changed on its own', () => {
    const notes = (moved: CalEvent, kind: 'change' | 'delete' | 'ruleRemoved') =>
      eventScopeItems(i18n.getFixedT('en'), moved, ['this', 'following', 'all'], us, now, kind).map((i) => i.note)

    it('names its recurrence date when it was moved later', () => {
      // Shown on Thursday, Mar 12, in place of Monday, Mar 9: the split takes Mar 10 and 11 along.
      const later = toCalEvent({ ...event, start: '2026-03-12T08:00:00Z', end: '2026-03-12T09:00:00Z' })
      expect(notes(later, 'change')).toEqual([
        'Only Thu, Mar 12.',
        'From Mon, Mar 9 on, as a series of its own. Earlier ones stay as they are.',
        'Past ones too.',
      ])
      expect(notes(later, 'delete')[1]).toBe('The series ends before Mon, Mar 9.')
      expect(notes(later, 'ruleRemoved')[1]).toBe(
        'From Mon, Mar 9 on, only this event stays. Earlier ones stay as they are.',
      )
    })

    it('names the day it is shown on when it was moved earlier', () => {
      const earlier = toCalEvent({ ...event, start: '2026-03-07T08:00:00Z', end: '2026-03-07T09:00:00Z' })
      expect(notes(earlier, 'delete').slice(0, 2)).toEqual(['Only Sat, Mar 7.', 'The series ends before Sat, Mar 7.'])
    })

    it('reads the recurrence date of an all-day event as a date', () => {
      const allDay = toCalEvent(
        apiEvent({
          start: '2026-03-12T00:00:00Z',
          end: '2026-03-13T00:00:00Z',
          allDay: true,
          timezone: '',
          rrule: 'FREQ=WEEKLY',
          recurring: true,
          recurrenceId: '2026-03-09T00:00:00Z',
        }),
      )
      expect(notes(allDay, 'delete').slice(0, 2)).toEqual(['Only Thu, Mar 12.', 'The series ends before Mon, Mar 9.'])
    })
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
      slots: glyphSlots('this'),
      tone: 'default',
    })
    expect(eventScopeHint(t, { options: ['this'], reason: 'fixedTimes' }, false)).toEqual({
      text: 'Only this event. The series keeps its times.',
      reach: 'this',
      slots: glyphSlots('this'),
      tone: 'default',
    })
  })

  it('says that a new rule applies to every event', () => {
    expect(eventScopeHint(t, { options: ['all'] }, false)).toEqual({
      text: 'Applies to every event in the series.',
      reach: 'all',
      slots: glyphSlots('all'),
      tone: 'default',
    })
  })

  it('warns in red that a removed rule deletes every other event', () => {
    expect(eventScopeHint(t, { options: ['all'] }, true)).toEqual({
      text: 'The series becomes this one event. All others are deleted.',
      reach: 'all',
      slots: glyphSlots('all'),
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

/** A due date-time alone, as a timed repeat of the series below is shown. */
const due = (iso: string): TaskDates => ({ start: null, startAllDay: false, due: iso, dueAllDay: false })

/**
 * A task series on Monday and Thursday at 09:00 in Berlin, its current repeat on Monday, 9 March 2026, its next one
 * on Thursday.
 */
function series(p: Partial<Todo> = {}): Todo {
  return todo({
    rrule: 'FREQ=WEEKLY;BYDAY=MO,TH',
    recurring: true,
    fixedDays: true,
    timezone: 'Europe/Berlin',
    due: '2026-03-09T08:00:00Z',
    recurrenceId: '2026-03-09T08:00:00Z',
    next: { due: '2026-03-12T08:00:00Z', dueAllDay: false },
    ...p,
  })
}

/** The current repeat of `series(p)`. */
function current(p: Partial<Todo> = {}): TaskRepeat {
  return currentRepeat(series(p))!
}

/** The repeat of `series(p)` after the current one, named `rid` and shown on `shown`. */
function later(p: Partial<Todo> = {}, o: { rid?: string; shown?: TaskDates; offRule?: boolean } = {}): TaskRepeat {
  const rid = o.rid ?? '2026-03-12T08:00:00Z'
  const todo = series(p)
  const { title } = todo
  const offRule = o.offRule ?? false
  return { todo, recurrenceId: rid, at: 'upcoming', last: false, offRule, title, shown: o.shown ?? due(rid) }
}

describe('scopeOptions for tasks', () => {
  const attendees = { hasAttendees: true }
  // On the 15th of each month: it stays on its days, so a series moved a day can't follow.
  const monthly = {
    rrule: 'FREQ=MONTHLY;BYMONTHDAY=15',
    due: '2026-03-15T08:00:00Z',
    recurrenceId: '2026-03-15T08:00:00Z',
    next: { due: '2026-04-15T07:00:00Z', dueAllDay: false },
  }
  const monthlyLater = (p: Partial<Todo> = {}) => later({ ...monthly, ...p }, { rid: '2026-04-15T07:00:00Z' })
  // Daily at 02:30 in Berlin in March and April. On Sunday, 29 March, summer time begins and 02:30 does not exist,
  // so the current repeat is at 03:30 (the server's RECURRENCE-ID 01:30Z); the next one is at 02:30 on Monday. The
  // same move of the later repeat can cross midnight from one of them and not from the other.
  const daylight = later(
    {
      rrule: 'FREQ=DAILY;BYMONTH=3,4',
      due: '2026-03-29T01:30:00Z',
      recurrenceId: '2026-03-29T01:30:00Z',
      next: { due: '2026-03-30T00:30:00Z', dueAllDay: false },
    },
    { rid: '2026-03-30T00:30:00Z' },
  )
  // The current repeat on the 9th at `rid`, stored in UTC ("Z"): the server counts its days in UTC, and so does the
  // browser, whatever its own zone (Berlin here).
  const utcAt = (rid: string) =>
    current({
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=9',
      timezone: null,
      due: rid,
      recurrenceId: rid,
      next: { due: '2026-04-09T22:30:00Z', dueAllDay: false },
    })

  const tuesday = due('2026-03-10T08:00:00Z')
  const friday = due('2026-03-13T08:00:00Z')

  // The 5th of each month, all-day, without a zone: November's is the current repeat.
  const fifth = current({
    rrule: 'FREQ=MONTHLY;BYMONTHDAY=5',
    timezone: null,
    due: '2026-11-05T00:00:00Z',
    dueAllDay: true,
    recurrenceId: '2026-11-05T00:00:00Z',
    next: { due: '2026-12-05T00:00:00Z', dueAllDay: true },
  })

  const rows: { name: string; action: ScopeAction; item: TaskRepeat; to?: ZonedTaskDates; want: ScopeResult }[] = [
    // at the current repeat
    { name: 'move the current repeat', action: 'move', item: current(), to: tuesday, want: { options: ['this', 'all'] } },
    {
      name: 'move the current repeat with attendees, which no repeat can be detached from',
      action: 'move',
      item: current(attendees),
      to: tuesday,
      want: { options: ['all'], missing: 'attendeesTask' },
    },
    {
      name: 'move the current repeat of a series that stays on its days',
      action: 'move',
      item: current(monthly),
      to: due('2026-03-16T08:00:00Z'),
      want: { options: ['this'], reason: 'fixedDays' },
    },
    {
      name: 'move the current repeat with attendees of a series that stays on its days: refused',
      action: 'move',
      item: current({ ...monthly, ...attendees }),
      to: due('2026-03-16T08:00:00Z'),
      want: { options: [], reason: 'fixedDays' },
    },
    {
      name: 'move the current repeat of a series on its days to another time',
      action: 'move',
      item: current(monthly),
      to: due('2026-03-15T10:00:00Z'),
      want: { options: ['this', 'all'] },
    },
    {
      name: 'move without new dates keeps the shown ones',
      action: 'move',
      item: current(monthly),
      want: { options: ['this', 'all'] },
    },
    { name: 'change the current repeat', action: 'change', item: current(), want: { options: ['this', 'all'] } },
    {
      name: 'change the current repeat with attendees',
      action: 'change',
      item: current(attendees),
      want: { options: ['all'], missing: 'attendeesTask' },
    },
    {
      name: 'change compares no dates',
      action: 'change',
      item: current(monthly),
      to: due('2026-03-16T08:00:00Z'),
      want: { options: ['this', 'all'] },
    },
    { name: 'change the rule at the current repeat', action: 'rule', item: current(), want: { options: ['all'] } },
    {
      name: 'change the rule at the current repeat with attendees',
      action: 'rule',
      item: current(attendees),
      want: { options: ['all'] },
    },
    { name: 'delete the current repeat', action: 'delete', item: current(), want: { options: ['this', 'all'] } },
    {
      name: 'delete the current repeat with attendees: skipping it detaches nothing',
      action: 'delete',
      item: current(attendees),
      want: { options: ['this', 'all'] },
    },
    // at a later repeat
    {
      name: 'move a later repeat of a series on fixed days a day later',
      action: 'move',
      item: later(),
      to: friday,
      want: { options: ['following', 'all'], missing: 'taskThis' },
    },
    {
      name: 'move a later repeat with attendees',
      action: 'move',
      item: later(attendees),
      to: friday,
      want: { options: ['all'], missing: 'attendees' },
    },
    {
      name: 'move a later repeat off the rule',
      action: 'move',
      item: later({}, { offRule: true }),
      to: friday,
      want: { options: ['all'] },
    },
    {
      name: 'move a later repeat off the rule with attendees: not the attendees alone take "following" away',
      action: 'move',
      item: later(attendees, { offRule: true }),
      to: friday,
      want: { options: ['all'] },
    },
    {
      name: 'move a later repeat of a series that stays on its days: refused',
      action: 'move',
      item: monthlyLater(),
      to: due('2026-04-16T07:00:00Z'),
      want: { options: [], reason: 'fixedDays' },
    },
    {
      name: 'move a later repeat with attendees of a series that stays on its days: refused',
      action: 'move',
      item: monthlyLater(attendees),
      to: due('2026-04-16T07:00:00Z'),
      want: { options: [], reason: 'fixedDays' },
    },
    {
      name: 'move a later repeat that only the series from it can follow',
      action: 'move',
      item: daylight,
      to: due('2026-03-30T21:30:00Z'),
      want: { options: ['following'], reason: 'fixedDays' },
    },
    {
      name: 'move a later repeat that only the whole series can follow',
      action: 'move',
      item: daylight,
      to: due('2026-03-29T21:30:00Z'),
      want: { options: ['all'], reason: 'fixedDays' },
    },
    {
      name: 'move a series stored in UTC past midnight in UTC, though not in the browser\'s Berlin',
      action: 'move',
      item: utcAt('2026-03-09T23:30:00Z'),
      to: due('2026-03-10T00:30:00Z'),
      want: { options: ['this'], reason: 'fixedDays' },
    },
    {
      name: 'move a series stored in UTC within its day in UTC, though past midnight in the browser\'s Berlin',
      action: 'move',
      item: utcAt('2026-03-09T22:30:00Z'),
      to: due('2026-03-09T23:15:00Z'),
      want: { options: ['this', 'all'] },
    },
    {
      // 08:00 on the 5th in Tokyo, 23:00 UTC on the 4th: the server writes the time in the zone of the write.
      name: 'give an all-day series a time on its day east of UTC',
      action: 'move',
      item: fifth,
      to: { ...due('2026-11-04T23:00:00Z'), timezone: 'Asia/Tokyo' },
      want: { options: ['this', 'all'] },
    },
    {
      // 20:00 on the 5th in New York, 01:00 UTC on the 6th.
      name: 'give an all-day series a time on its day west of UTC',
      action: 'move',
      item: fifth,
      to: { ...due('2026-11-06T01:00:00Z'), timezone: 'America/New_York' },
      want: { options: ['this', 'all'] },
    },
    {
      name: 'give an all-day series a time on the next day in the zone of the write',
      action: 'move',
      item: fifth,
      to: { ...due('2026-11-05T23:00:00Z'), timezone: 'Asia/Tokyo' },
      want: { options: ['this'], reason: 'fixedDays' },
    },
    {
      name: 'change a later repeat',
      action: 'change',
      item: later(),
      want: { options: ['following', 'all'], missing: 'taskThis' },
    },
    {
      name: 'change a later repeat with attendees',
      action: 'change',
      item: later(attendees),
      want: { options: ['all'], missing: 'attendees' },
    },
    {
      name: 'change a later repeat off the rule',
      action: 'change',
      item: later({}, { offRule: true }),
      want: { options: ['all'] },
    },
    {
      name: 'change the rule at a later repeat',
      action: 'rule',
      item: later(),
      want: { options: ['following', 'all'], missing: 'taskThis' },
    },
    {
      name: 'change the rule at a later repeat with attendees',
      action: 'rule',
      item: later(attendees),
      want: { options: ['all'], missing: 'attendees' },
    },
    {
      name: 'change the rule at a later repeat off the rule',
      action: 'rule',
      item: later({}, { offRule: true }),
      want: { options: ['all'] },
    },
    {
      name: 'delete a later repeat',
      action: 'delete',
      item: later(),
      want: { options: ['following', 'all'], missing: 'taskThis' },
    },
    {
      name: 'delete a later repeat with attendees',
      action: 'delete',
      item: later(attendees),
      want: { options: ['all'], missing: 'attendees' },
    },
    {
      name: 'delete a later repeat off the rule',
      action: 'delete',
      item: later({}, { offRule: true }),
      want: { options: ['all'] },
    },
    // a single task: no question and no hint
    ...(
      [
        ['move', 'move'],
        ['change', 'change'],
        ['rule', 'change the rule of'],
        ['delete', 'delete'],
      ] as const
    ).flatMap(([action, verb]) => [
      {
        name: `${verb} a task that does not repeat`,
        action,
        item: { ...current(), todo: series({ rrule: '', recurring: false }) },
        to: friday,
        want: { options: [] },
      },
      { name: `${verb} the last repeat`, action, item: current({ next: null }), to: friday, want: { options: [] } },
      { name: `${verb} a done series`, action, item: current({ status: 'COMPLETED' }), to: friday, want: { options: [] } },
      {
        name: `${verb} a series whose rule Lucid can't read`,
        action,
        item: current({ ruleUnsupported: true }),
        to: friday,
        want: { options: [] },
      },
    ]),
    {
      name: 'move the last repeat of a series on its days to another day',
      action: 'move',
      item: current({ ...monthly, next: null }),
      to: due('2026-03-16T08:00:00Z'),
      want: { options: [] },
    },
  ]

  it.each(rows)('$name', ({ action, item, to, want }) => {
    expect(scopeOptions({ kind: 'task', action, item, to })).toStrictEqual(want)
  })
})

describe('taskGlyphSlots', () => {
  it.each([
    // ✓ ✓ ● ○ ○: only the current repeat; the done ones before it stay, and so do the later ones.
    ['this', 'current', ['done', 'done', 'affected', 'kept', 'kept']],
    // ✓ ✓ ● ● ●: the current repeat and all later ones.
    ['all', 'current', ['done', 'done', 'affected', 'affected', 'affected']],
    // ✓ ○ ● ● ●: from a later repeat on; the current one stays.
    ['following', 'upcoming', ['done', 'kept', 'affected', 'affected', 'affected']],
    // ✓ ● ● ● ●: from a later repeat, the current one too.
    ['all', 'upcoming', ['done', 'affected', 'affected', 'affected', 'affected']],
    // Never offered, drawn by the same rule: from the current repeat, "this and following" is all of them.
    ['following', 'current', ['done', 'done', 'affected', 'affected', 'affected']],
    ['this', 'upcoming', ['done', 'kept', 'affected', 'kept', 'kept']],
  ] as const)('%s at the %s repeat', (reach, at, want) => {
    expect(taskGlyphSlots(reach, at)).toEqual(want)
  })
})

describe('taskScopeItems', () => {
  const en = i18n.getFixedT('en')
  const us: FormatPrefs = { tag: 'en-US', locale: enUS, hourCycle: '12h', weekStartsOn: 0 }
  const deDE: FormatPrefs = { tag: 'de-DE', locale: de, hourCycle: '24h', weekStartsOn: 1 }
  const now = new Date(2026, 0, 1)

  it('names "only this repeat" with the day the series goes on, at the current repeat', () => {
    expect(taskScopeItems(en, current(), ['this', 'all'], us, now, 'change')).toEqual([
      {
        scope: 'this',
        label: 'Only this repeat',
        note: 'Becomes a task of its own. The series goes on Thu, Mar 12.',
        slots: taskGlyphSlots('this', 'current'),
      },
      { scope: 'all', label: 'All repeats', note: 'Done ones stay.', slots: taskGlyphSlots('all', 'current') },
    ])
  })

  it('names "this and following" with the day of the repeat, at a later repeat', () => {
    expect(taskScopeItems(en, later(), ['following', 'all'], us, now, 'change')).toEqual([
      {
        scope: 'following',
        label: 'This and following repeats',
        note: 'From Thu, Mar 12 on, as a series of its own. Earlier ones stay as they are.',
        slots: taskGlyphSlots('following', 'upcoming'),
      },
      { scope: 'all', label: 'All repeats', note: 'Done ones stay.', slots: taskGlyphSlots('all', 'upcoming') },
    ])
  })

  it('says what a delete does', () => {
    const notes = (repeat: TaskRepeat, options: ('this' | 'following' | 'all')[]) =>
      taskScopeItems(en, repeat, options, us, now, 'delete').map((i) => i.note)
    expect(notes(current(), ['this', 'all'])).toEqual([
      'Skipped. The series goes on Thu, Mar 12.',
      'Done and detached ones stay.',
    ])
    expect(notes(later(), ['following', 'all'])).toEqual([
      'The series ends before Thu, Mar 12.',
      'Done and detached ones stay.',
    ])
  })

  it('says what removing the rule does', () => {
    expect(taskScopeItems(en, later(), ['following', 'all'], us, now, 'ruleRemoved').map((i) => i.note)).toEqual([
      'From Thu, Mar 12 on, only this repeat stays. Earlier ones stay as they are.',
      'The task stops repeating. Upcoming repeats are removed.',
    ])
  })

  it('says it in German', () => {
    const t = i18n.getFixedT('de')
    expect(taskScopeItems(t, current(), ['this', 'all'], deDE, now, 'change').map((i) => [i.label, i.note])).toEqual([
      ['Nur diese Wiederholung', 'Wird eine eigene Aufgabe. Die Serie geht am Do., 12. März weiter.'],
      ['Alle Wiederholungen', 'Erledigte bleiben.'],
    ])
    expect(taskScopeItems(t, current(), ['this', 'all'], deDE, now, 'delete').map((i) => i.note)).toEqual([
      'Wird übersprungen. Die Serie geht am Do., 12. März weiter.',
      'Erledigte und aus der Serie gelöste bleiben.',
    ])
    expect(taskScopeItems(t, later(), ['following', 'all'], deDE, now, 'change').map((i) => [i.label, i.note])).toEqual([
      ['Diese und alle folgenden', 'Ab Do., 12. März als eigene Serie. Frühere bleiben, wie sie sind.'],
      ['Alle Wiederholungen', 'Erledigte bleiben.'],
    ])
    expect(taskScopeItems(t, later(), ['following', 'all'], deDE, now, 'ruleRemoved').map((i) => i.note)).toEqual([
      'Ab Do., 12. März bleibt nur diese Wiederholung. Frühere bleiben, wie sie sind.',
      'Die Aufgabe wiederholt sich dann nicht mehr. Kommende Wiederholungen entfallen.',
    ])
  })

  it('names the next repeat of an all-day series by its date', () => {
    const allDay = current({
      due: '2026-03-09T00:00:00Z',
      dueAllDay: true,
      timezone: null,
      recurrenceId: '2026-03-09T00:00:00Z',
      next: { due: '2026-03-12T00:00:00Z', dueAllDay: true },
    })
    expect(taskScopeItems(en, allDay, ['this'], us, now, 'change')[0]?.note).toBe(
      'Becomes a task of its own. The series goes on Thu, Mar 12.',
    )
  })

  // As for events: the series splits at the repeat's recurrence ID, so a repeat another app showed later takes the
  // ones in between along.
  it('starts "this and following" at the earlier of the recurrence date and the shown one', () => {
    const shownLater = later({}, { shown: due('2026-03-14T08:00:00Z') })
    expect(taskScopeItems(en, shownLater, ['following'], us, now, 'delete')[0]?.note).toBe(
      'The series ends before Thu, Mar 12.',
    )
    const shownEarlier = later({}, { shown: due('2026-03-11T08:00:00Z') })
    expect(taskScopeItems(en, shownEarlier, ['following'], us, now, 'delete')[0]?.note).toBe(
      'The series ends before Wed, Mar 11.',
    )
  })
})

describe('taskScopeMissing', () => {
  const en = i18n.getFixedT('en')

  it('says why an option is not offered', () => {
    expect(taskScopeMissing(en, { options: ['following', 'all'], missing: 'taskThis' })).toBe(
      'Only the current repeat can be changed on its own.',
    )
    expect(taskScopeMissing(en, { options: ['all'], missing: 'attendeesTask' })).toBe(
      "With attendees, a repeat can't become a task of its own.",
    )
    expect(taskScopeMissing(en, { options: ['all'], missing: 'attendees' })).toBe("With attendees, the series can't be split.")
  })

  it('says it in German', () => {
    const t = i18n.getFixedT('de')
    expect(taskScopeMissing(t, { options: ['following', 'all'], missing: 'taskThis' })).toBe(
      'Einzeln geht nur die aktuelle Wiederholung.',
    )
    expect(taskScopeMissing(t, { options: ['all'], missing: 'attendeesTask' })).toBe(
      'Mit Teilnehmenden kann keine Wiederholung eine eigene Aufgabe werden.',
    )
  })

  it('has nothing to say when nothing is missing', () => {
    expect(taskScopeMissing(en, { options: ['this', 'all'] })).toBeUndefined()
  })
})

describe('taskScopeHint', () => {
  const t = i18n.getFixedT('en')

  it('says that only this repeat changes, and becomes a task of its own', () => {
    expect(taskScopeHint(t, { options: ['this'], reason: 'fixedDays' }, 'move', false, 'current')).toEqual({
      text: 'Only this repeat. It becomes a task of its own.',
      reach: 'this',
      slots: taskGlyphSlots('this', 'current'),
      tone: 'default',
    })
  })

  it('says that a move moves all repeats', () => {
    expect(taskScopeHint(t, { options: ['all'] }, 'move', false, 'current')).toEqual({
      text: 'Moves all repeats.',
      reach: 'all',
      slots: taskGlyphSlots('all', 'current'),
      tone: 'default',
    })
  })

  it('says that any other change at the current repeat applies from it on', () => {
    expect(taskScopeHint(t, { options: ['all'] }, 'change', false, 'current')).toEqual({
      text: 'Applies from this repeat on. Done ones stay.',
      reach: 'all',
      slots: taskGlyphSlots('all', 'current'),
      tone: 'default',
    })
    expect(taskScopeHint(t, { options: ['all'] }, 'rule', false, 'current')?.text).toBe(
      'Applies from this repeat on. Done ones stay.',
    )
  })

  // FR-17: from a later repeat, "all repeats" reaches the current one before it too (✓ ● ● ● ●).
  it('says that any other change at a later repeat reaches the current one too', () => {
    expect(taskScopeHint(t, { options: ['all'] }, 'change', false, 'upcoming')).toEqual({
      text: 'Applies to all repeats, the current one too. Done ones stay.',
      reach: 'all',
      slots: taskGlyphSlots('all', 'upcoming'),
      tone: 'default',
    })
    expect(taskScopeHint(t, { options: ['all'] }, 'rule', false, 'upcoming')?.text).toBe(
      'Applies to all repeats, the current one too. Done ones stay.',
    )
    expect(taskScopeHint(t, { options: ['all'] }, 'move', false, 'upcoming')?.text).toBe('Moves all repeats.')
  })

  it('warns in red that a removed rule removes the upcoming repeats', () => {
    expect(taskScopeHint(t, { options: ['all'] }, 'rule', true, 'current')).toEqual({
      text: 'The task stops repeating. Upcoming repeats are removed.',
      reach: 'all',
      slots: taskGlyphSlots('all', 'current'),
      tone: 'destructive',
    })
  })

  it('says that this and the following repeats become a series of their own', () => {
    expect(taskScopeHint(t, { options: ['following'], reason: 'fixedDays' }, 'move', false, 'upcoming')).toEqual({
      text: 'This and following repeats, as a series of their own.',
      reach: 'following',
      slots: taskGlyphSlots('following', 'upcoming'),
      tone: 'default',
    })
  })

  it('adds why the repeat could not go on its own, or the series not be split', () => {
    expect(taskScopeHint(t, { options: ['all'], missing: 'attendeesTask' }, 'move', false, 'current')?.text).toBe(
      "Moves all repeats. With attendees, a repeat can't become a task of its own.",
    )
    expect(taskScopeHint(t, { options: ['all'], missing: 'attendees' }, 'change', false, 'upcoming')?.text).toBe(
      "Applies to all repeats, the current one too. Done ones stay. With attendees, the series can't be split.",
    )
  })

  it('never adds that only the current repeat goes on its own', () => {
    expect(taskScopeHint(t, { options: ['all'], missing: 'taskThis' }, 'change', false, 'upcoming')?.text).toBe(
      'Applies to all repeats, the current one too. Done ones stay.',
    )
  })

  it('says it in German', () => {
    const de = i18n.getFixedT('de')
    expect(taskScopeHint(de, { options: ['this'] }, 'change', false, 'current')?.text).toBe(
      'Nur diese Wiederholung. Sie wird eine eigene Aufgabe.',
    )
    expect(taskScopeHint(de, { options: ['all'], missing: 'attendeesTask' }, 'move', false, 'current')?.text).toBe(
      'Verschiebt alle Wiederholungen. Mit Teilnehmenden kann keine Wiederholung eine eigene Aufgabe werden.',
    )
    expect(taskScopeHint(de, { options: ['following'] }, 'move', false, 'upcoming')?.text).toBe(
      'Diese und alle folgenden, als eigene Serie.',
    )
    expect(taskScopeHint(de, { options: ['all'] }, 'change', false, 'upcoming')?.text).toBe(
      'Gilt für alle Wiederholungen, auch die aktuelle. Erledigte bleiben.',
    )
  })

  it('has nothing to say before a delete, which asks to confirm instead', () => {
    expect(taskScopeHint(t, { options: ['all'] }, 'delete', false, 'current')).toBeNull()
    expect(taskScopeHint(t, { options: ['all'], missing: 'attendees' }, 'delete', false, 'upcoming')).toBeNull()
  })

  it('has nothing to say with a choice, which the question asks, for a single task, or for a refused move', () => {
    expect(taskScopeHint(t, { options: ['this', 'all'] }, 'move', false, 'current')).toBeNull()
    expect(taskScopeHint(t, { options: [] }, 'move', false, 'current')).toBeNull()
    expect(taskScopeHint(t, { options: [], reason: 'fixedDays' }, 'move', false, 'upcoming')).toBeNull()
  })
})
