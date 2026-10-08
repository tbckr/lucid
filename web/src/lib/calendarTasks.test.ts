import { enUS } from 'date-fns/locale/en-US'
import { describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import { occurrence, todo } from '@/test/fixtures'
import {
  anchorOf,
  canComplete,
  canDrag,
  currentRepeat,
  movedTodo,
  occurrenceTask,
  recurringLabel,
  repeatOf,
  shiftedTask,
  toCalTask,
} from './calendarTasks'
import { isSpanning } from './events'
import { type FormatPrefs } from './format'

// Vitest runs in Europe/Berlin (CEST until 25 Oct 2026, UTC+2).
const allDay = (iso: string) => `${iso}T00:00:00Z`

describe('toCalTask', () => {
  it('spans from start to due when both have a time', () => {
    const task = toCalTask(todo({ start: '2026-09-25T07:00:00Z', due: '2026-09-25T09:00:00Z' }))
    expect(task).toMatchObject({
      startsAt: new Date(2026, 8, 25, 9),
      endsAt: new Date(2026, 8, 25, 11),
      allDay: false,
      point: false,
      dates: 'span',
    })
  })

  it('spans all-day from the start day through the due day', () => {
    const task = toCalTask(
      todo({ start: allDay('2026-09-25'), startAllDay: true, due: allDay('2026-09-27'), dueAllDay: true }),
    )
    expect(task).toMatchObject({
      startsAt: new Date(2026, 8, 25),
      endsAt: new Date(2026, 8, 28),
      allDay: true,
      point: false,
      dates: 'span',
    })
  })

  it('keeps an all-day span on local midnights across the DST change', () => {
    const task = toCalTask(
      todo({ start: allDay('2026-10-24'), startAllDay: true, due: allDay('2026-10-26'), dueAllDay: true }),
    )
    expect(task).toMatchObject({ startsAt: new Date(2026, 9, 24), endsAt: new Date(2026, 9, 27) })
  })

  it('shows a due time alone as a 30-minute point', () => {
    const task = toCalTask(todo({ due: '2026-09-25T08:00:00Z' }))
    expect(task).toMatchObject({
      startsAt: new Date(2026, 8, 25, 10),
      endsAt: new Date(2026, 8, 25, 10, 30),
      allDay: false,
      point: true,
      dates: 'due',
    })
  })

  it('shows a start time alone as a point', () => {
    const task = toCalTask(todo({ start: '2026-09-25T08:00:00Z' }))
    expect(task).toMatchObject({
      startsAt: new Date(2026, 8, 25, 10),
      endsAt: new Date(2026, 8, 25, 10, 30),
      point: true,
      dates: 'start',
    })
  })

  it('ends a point late in the day at midnight', () => {
    const task = toCalTask(todo({ due: '2026-09-25T21:45:00Z' }))!
    expect(task).toMatchObject({ startsAt: new Date(2026, 8, 25, 23, 45), endsAt: new Date(2026, 8, 26), point: true })
    expect(isSpanning(task)).toBe(false)
  })

  it('shows a due date alone on that day', () => {
    const task = toCalTask(todo({ due: allDay('2026-09-25'), dueAllDay: true }))
    expect(task).toMatchObject({
      startsAt: new Date(2026, 8, 25),
      endsAt: new Date(2026, 8, 26),
      allDay: true,
      point: false,
      dates: 'due',
    })
  })

  it('shows a start date alone on that day', () => {
    const task = toCalTask(todo({ start: allDay('2026-09-25'), startAllDay: true }))
    expect(task).toMatchObject({ startsAt: new Date(2026, 8, 25), endsAt: new Date(2026, 8, 26), allDay: true, dates: 'start' })
  })

  it.each([
    ['start after due', { start: '2026-09-25T10:00:00Z', due: '2026-09-25T08:00:00Z' }],
    ['equal timed start and due', { start: '2026-09-25T08:00:00Z', due: '2026-09-25T08:00:00Z' }],
    ['start date with timed due', { start: allDay('2026-09-24'), startAllDay: true, due: '2026-09-25T08:00:00Z' }],
  ])('falls back to the due time for %s', (_name, dates) => {
    expect(toCalTask(todo(dates))).toMatchObject({ startsAt: new Date(2026, 8, 25, 10), point: true, dates: 'due' })
  })

  it('falls back to the due day for a timed start with an all-day due', () => {
    const task = toCalTask(todo({ start: '2026-09-24T08:00:00Z', due: allDay('2026-09-25'), dueAllDay: true }))
    expect(task).toMatchObject({ startsAt: new Date(2026, 8, 25), endsAt: new Date(2026, 8, 26), allDay: true, dates: 'due' })
  })

  it('has no calendar entry without dates', () => {
    expect(toCalTask(todo())).toBeNull()
  })

  it('carries the todo', () => {
    const t = todo({ id: 't1', calendarId: 'c9', title: 'Pay rent', due: allDay('2026-09-25'), dueAllDay: true })
    const task = toCalTask(t)
    expect(task).toMatchObject({ kind: 'task', key: 'task:t1', calendarId: 'c9', title: 'Pay rent' })
    expect(task?.todo).toBe(t)
  })
})

describe('movedTodo', () => {
  it('moves a timed span by days and minutes, keeping its length', () => {
    const t = todo({ title: 'Pay rent', start: '2026-09-25T07:00:00Z', due: '2026-09-25T09:00:00Z', priority: 1 })
    expect(movedTodo(t, 2, 30)).toEqual({
      title: 'Pay rent',
      description: '',
      checklist: [],
      start: '2026-09-27T07:30:00.000Z',
      startAllDay: false,
      due: '2026-09-27T09:30:00.000Z',
      dueAllDay: false,
      priority: 1,
      status: 'NEEDS-ACTION',
    })
  })

  it('moves an all-day span by whole dates', () => {
    const t = todo({ start: allDay('2026-09-25'), startAllDay: true, due: allDay('2026-09-27'), dueAllDay: true })
    expect(movedTodo(t, -1, 0)).toMatchObject({
      start: '2026-09-24T00:00:00.000Z',
      startAllDay: true,
      due: '2026-09-26T00:00:00.000Z',
      dueAllDay: true,
    })
  })

  it('moves only the date a task has', () => {
    expect(movedTodo(todo({ due: '2026-09-25T08:00:00Z' }), 1, -15)).toMatchObject({
      start: null,
      due: '2026-09-26T07:45:00.000Z',
    })
    expect(movedTodo(todo({ start: allDay('2026-09-25'), startAllDay: true }), 3, 0)).toMatchObject({
      start: '2026-09-28T00:00:00.000Z',
      due: null,
    })
  })

  it('keeps the wall-clock time across the DST change', () => {
    // 10:00 CEST on 24 Oct is 10:00 CET on 25 Oct.
    expect(movedTodo(todo({ due: '2026-10-24T08:00:00Z' }), 1, 0).due).toBe('2026-10-25T09:00:00.000Z')
  })

  it('keeps all-day dates on UTC midnight across the DST change', () => {
    const t = todo({ due: allDay('2026-10-24'), dueAllDay: true })
    expect(movedTodo(t, 2, 0).due).toBe('2026-10-26T00:00:00.000Z')
  })

  it('moves each date by its own kind', () => {
    // A mix from another client: the all-day start moves by days only.
    const t = todo({ start: allDay('2026-09-24'), startAllDay: true, due: '2026-09-25T08:00:00Z' })
    expect(movedTodo(t, 1, 45)).toMatchObject({ start: '2026-09-25T00:00:00.000Z', due: '2026-09-26T08:45:00.000Z' })
  })
})

describe('anchorOf', () => {
  it('prefers start over due', () => {
    expect(
      anchorOf({ start: allDay('2026-09-20'), startAllDay: true, due: allDay('2026-09-25'), dueAllDay: true }),
    ).toEqual(new Date(2026, 8, 20))
  })

  it('falls back to due', () => {
    expect(anchorOf({ start: null, startAllDay: false, due: '2026-09-25T08:00:00Z', dueAllDay: false })).toEqual(
      new Date(2026, 8, 25, 10),
    )
  })

  it('is null without dates', () => {
    expect(anchorOf({ start: null, startAllDay: false, due: null, dueAllDay: false })).toBeNull()
  })
})

describe('recurringLabel', () => {
  const t = i18n.getFixedT('en')
  const prefs: FormatPrefs = { tag: 'en-US', locale: enUS, hourCycle: '12h', weekStartsOn: 0 }
  const now = new Date(2026, 8, 25)

  it('anchors the rule on the series\' own dates', () => {
    const series = todo({ rrule: 'FREQ=WEEKLY;BYDAY=MO,TH', recurring: true, due: '2026-10-08T00:00:00Z', dueAllDay: true })
    expect(recurringLabel(t, series, null, prefs, now)).toBe('Every week on Monday and Thursday')
  })

  it('falls back to the given date without one of its own', () => {
    const series = todo({ rrule: 'FREQ=DAILY', recurring: true, ruleUnsupported: true })
    expect(recurringLabel(t, series, new Date(2026, 9, 5), prefs, now)).toBe('Every day')
  })

  it('names a rule it cannot put into words verbatim', () => {
    const series = todo({ rrule: 'FREQ=MONTHLY;BYSETPOS=-1;BYDAY=MO', recurring: true, due: '2026-10-08T00:00:00Z', dueAllDay: true })
    expect(recurringLabel(t, series, null, prefs, now)).toBe('Custom rule: FREQ=MONTHLY;BYSETPOS=-1;BYDAY=MO')
  })

  it('names the rule verbatim without any anchor at all', () => {
    const series = todo({ rrule: 'FREQ=DAILY', recurring: true, ruleUnsupported: true })
    expect(recurringLabel(t, series, null, prefs, now)).toBe('Custom rule: FREQ=DAILY')
  })
})

describe('occurrenceTask', () => {
  it('places an all-day occurrence on its day', () => {
    const t = todo({ id: 't1' })
    const occ = occurrence({ due: allDay('2026-09-25'), dueAllDay: true, state: 'upcoming' })
    const task = occurrenceTask(occ, t)
    expect(task).toMatchObject({
      startsAt: new Date(2026, 8, 25),
      allDay: true,
      key: occ.key,
      occurrence: { state: 'upcoming', recurrenceId: occ.recurrenceId },
    })
    expect(task?.todo.id).toBe('t1')
  })

  it('keeps the wire dates of an all-day occurrence, which place it only as local dates', () => {
    const occ = occurrence({
      start: allDay('2026-09-24'),
      startAllDay: true,
      due: allDay('2026-09-25'),
      dueAllDay: true,
      state: 'upcoming',
    })
    expect(occurrenceTask(occ, todo())?.occurrence).toEqual({
      state: 'upcoming',
      recurrenceId: occ.recurrenceId,
      offRule: false,
      start: allDay('2026-09-24'),
      startAllDay: true,
      due: allDay('2026-09-25'),
      dueAllDay: true,
    })
  })

  it('keeps the wire dates of a timed occurrence and each date\'s own value type', () => {
    const occ = occurrence({
      start: '2026-09-25T08:00:00Z',
      startAllDay: false,
      due: allDay('2026-09-26'),
      dueAllDay: true,
    })
    expect(occurrenceTask(occ, todo())?.occurrence).toMatchObject({
      start: '2026-09-25T08:00:00Z',
      startAllDay: false,
      due: allDay('2026-09-26'),
      dueAllDay: true,
    })
  })

  it('keeps a missing start or due as the wire has it', () => {
    const occ = occurrence({ start: null, due: '2026-09-25T08:00:00Z', dueAllDay: false })
    const kept = occurrenceTask(occ, todo())?.occurrence
    expect(kept?.start).toBeNull()
    expect(kept?.due).toBe('2026-09-25T08:00:00Z')
  })

  it('keeps whether the repeat is off the rule', () => {
    expect(occurrenceTask(occurrence({ offRule: true }), todo())?.occurrence?.offRule).toBe(true)
    expect(occurrenceTask(occurrence({ offRule: false }), todo())?.occurrence?.offRule).toBe(false)
  })

  it('places a timed point occurrence as a 30-minute point', () => {
    const occ = occurrence({ due: '2026-09-25T08:00:00Z', dueAllDay: false })
    const task = occurrenceTask(occ, todo())
    expect(task).toMatchObject({
      point: true,
      startsAt: new Date(2026, 8, 25, 10),
      endsAt: new Date(2026, 8, 25, 10, 30),
    })
  })

  it('is null without dates', () => {
    expect(occurrenceTask(occurrence({ start: null, due: null }), todo())).toBeNull()
  })
})

describe('repeatOf', () => {
  const series = todo({
    rrule: 'FREQ=WEEKLY;BYDAY=MO,TH',
    recurring: true,
    due: allDay('2026-09-24'),
    dueAllDay: true,
    recurrenceId: allDay('2026-09-24'),
    next: { due: allDay('2026-09-28'), dueAllDay: true },
  })

  it('names the current repeat by its recurrence ID, with the dates it is shown on', () => {
    const occ = occurrence({ recurrenceId: allDay('2026-09-24'), due: allDay('2026-09-25'), state: 'current' })
    expect(repeatOf(occurrenceTask(occ, series)!)).toEqual({
      todo: series,
      recurrenceId: allDay('2026-09-24'),
      at: 'current',
      last: false,
      offRule: false,
      shown: { start: null, startAllDay: false, due: allDay('2026-09-25'), dueAllDay: true },
    })
  })

  it('names a later repeat, and whether it is off the rule', () => {
    const occ = occurrence({ recurrenceId: allDay('2026-10-01'), due: allDay('2026-10-01'), state: 'upcoming', offRule: true })
    expect(repeatOf(occurrenceTask(occ, series)!)).toMatchObject({ at: 'upcoming', last: false, offRule: true })
  })

  it('marks the current repeat of a series without a next one as the last', () => {
    const last = { ...series, next: null }
    expect(repeatOf(occurrenceTask(occurrence({ state: 'current' }), last)!)?.last).toBe(true)
  })

  it('has no repeat for a plain task or a done repeat', () => {
    expect(repeatOf(toCalTask(todo({ due: allDay('2026-09-25'), dueAllDay: true }))!)).toBeNull()
    expect(repeatOf(occurrenceTask(occurrence({ state: 'done' }), series)!)).toBeNull()
  })
})

describe('currentRepeat', () => {
  it('is the current repeat of a series, shown on the series\' own dates', () => {
    const series = todo({
      rrule: 'FREQ=DAILY',
      recurring: true,
      start: '2026-09-25T07:00:00Z',
      due: '2026-09-25T08:00:00Z',
      recurrenceId: '2026-09-25T07:00:00Z',
      next: { start: '2026-09-26T07:00:00Z', due: '2026-09-26T08:00:00Z' },
    })
    expect(currentRepeat(series)).toEqual({
      todo: series,
      recurrenceId: '2026-09-25T07:00:00Z',
      at: 'current',
      last: false,
      offRule: false,
      shown: { start: '2026-09-25T07:00:00Z', startAllDay: false, due: '2026-09-25T08:00:00Z', dueAllDay: false },
    })
  })

  it('is the last repeat without a next one', () => {
    const series = todo({ rrule: 'FREQ=DAILY', recurring: true, due: allDay('2026-09-25'), dueAllDay: true })
    expect(currentRepeat({ ...series, recurrenceId: allDay('2026-09-25') })?.last).toBe(true)
  })

  it('is null for a todo without a current repeat', () => {
    expect(currentRepeat(todo({ due: allDay('2026-09-25'), dueAllDay: true }))).toBeNull()
  })
})

describe('canComplete', () => {
  it.each([
    ['upcoming', false],
    ['done', false],
    ['current', true],
  ] as const)('an occurrence in state %s -> %s', (state, expected) => {
    const task = occurrenceTask(occurrence({ state }), todo())!
    expect(canComplete(task)).toBe(expected)
  })

  it('is true for a plain todo', () => {
    const task = toCalTask(todo({ due: allDay('2026-09-25'), dueAllDay: true }))!
    expect(canComplete(task)).toBe(true)
  })

  it('is false for a todo whose rule is unsupported', () => {
    const task = toCalTask(todo({ due: allDay('2026-09-25'), dueAllDay: true, ruleUnsupported: true }))!
    expect(canComplete(task)).toBe(false)
  })
})

describe('canDrag', () => {
  const interval = todo({ recurring: true, rrule: 'FREQ=DAILY', due: allDay('2026-09-25'), dueAllDay: true })

  it.each([
    ['current', true],
    ['upcoming', true],
    ['done', false],
  ] as const)('an occurrence of an interval series in state %s -> %s', (state, expected) => {
    expect(canDrag(occurrenceTask(occurrence({ state }), interval)!)).toBe(expected)
  })

  it.each([
    ['current', true],
    ['upcoming', true],
    ['done', false],
  ] as const)('an occurrence of a series on fixed days in state %s -> %s', (state, expected) => {
    const fixed = { ...interval, rrule: 'FREQ=WEEKLY;BYDAY=MO,TH', fixedDays: true }
    expect(canDrag(occurrenceTask(occurrence({ state }), fixed)!)).toBe(expected)
  })

  it('is false for an upcoming occurrence of a series whose rule is unsupported', () => {
    const unsupported = { ...interval, ruleUnsupported: true }
    expect(canDrag(occurrenceTask(occurrence({ state: 'upcoming' }), unsupported)!)).toBe(false)
  })

  it('stays true for a plain, done task (unlike an occurrence)', () => {
    const t = todo({ due: allDay('2026-09-25'), dueAllDay: true, status: 'COMPLETED' })
    expect(canDrag(toCalTask(t)!)).toBe(true)
  })

  it('is false for a todo whose rule is unsupported', () => {
    const t = todo({ due: allDay('2026-09-25'), dueAllDay: true, ruleUnsupported: true })
    expect(canDrag(toCalTask(t)!)).toBe(false)
  })
})

describe('shiftedTask', () => {
  it('moves a span by days and minutes', () => {
    const task = toCalTask(todo({ start: '2026-09-25T07:00:00Z', due: '2026-09-25T09:00:00Z' }))!
    expect(shiftedTask(task, 2, 30)).toMatchObject({
      startsAt: new Date(2026, 8, 27, 9, 30),
      endsAt: new Date(2026, 8, 27, 11, 30),
    })
  })

  it('gives a point its full length again once it leaves midnight behind', () => {
    // 23:45 local: a point cut short to 15 minutes at midnight.
    const task = toCalTask(todo({ due: '2026-09-25T21:45:00Z' }))!
    expect(shiftedTask(task, 0, -60)).toMatchObject({
      startsAt: new Date(2026, 8, 25, 22, 45),
      endsAt: new Date(2026, 8, 25, 23, 15),
    })
  })

  it('cuts a point short at midnight once it reaches it', () => {
    const task = toCalTask(todo({ due: '2026-09-25T20:00:00Z' }))! // 22:00 local
    expect(shiftedTask(task, 1, 105)).toMatchObject({
      startsAt: new Date(2026, 8, 26, 23, 45),
      endsAt: new Date(2026, 8, 27),
    })
  })
})
