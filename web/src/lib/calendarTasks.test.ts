import { enUS } from 'date-fns/locale/en-US'
import { describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import { occurrence, todo } from '@/test/fixtures'
import {
  anchorOf,
  canComplete,
  canDrag,
  lastAllowedDay,
  moveWindow,
  movedTodo,
  occurrenceTask,
  outsideWindow,
  recurringLabel,
  shiftedTask,
  toCalTask,
  windowEdge,
  withinWindow,
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

  it('keeps the upcoming occurrences of a series on fixed days in place', () => {
    const fixed = { ...interval, rrule: 'FREQ=WEEKLY;BYDAY=MO,TH', fixedDays: true }
    expect(canDrag(occurrenceTask(occurrence({ state: 'upcoming' }), fixed)!)).toBe(false)
    expect(canDrag(occurrenceTask(occurrence({ state: 'current' }), fixed)!)).toBe(true)
  })

  it('keeps the upcoming occurrences in place while the current one is off the rule and moves alone', () => {
    const offRule = { ...interval, moveWindow: { from: null, until: allDay('2026-09-27') } }
    expect(canDrag(occurrenceTask(occurrence({ state: 'upcoming' }), offRule)!)).toBe(false)
    expect(canDrag(occurrenceTask(occurrence({ state: 'current' }), offRule)!)).toBe(true)
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

describe('moveWindow', () => {
  it("returns the server's instants for a timed series", () => {
    // A series in UTC−5: its days start at 05:00 UTC, 07:00 in Berlin (CEST).
    const t = todo({
      recurring: true,
      fixedDays: true,
      due: '2026-10-05T13:00:00Z',
      moveWindow: { from: '2026-10-05T05:00:00Z', until: '2026-10-08T05:00:00Z' },
    })
    expect(moveWindow(t)).toEqual({ from: new Date('2026-10-05T05:00:00Z'), until: new Date('2026-10-08T05:00:00Z') })
  })

  it('reads the dates of an all-day window as local days, like the dates themselves', () => {
    const t = todo({
      recurring: true,
      fixedDays: true,
      due: allDay('2026-10-05'),
      dueAllDay: true,
      moveWindow: { from: allDay('2026-10-05'), until: allDay('2026-10-08') },
    })
    expect(moveWindow(t)).toEqual({ from: new Date(2026, 9, 5), until: new Date(2026, 9, 8) })
  })

  it('keeps an all-day window on local midnights across the DST change', () => {
    // Sat 24 Oct, next Tue 27 Oct; the clocks go back on the 25th.
    const t = todo({
      recurring: true,
      fixedDays: true,
      start: allDay('2026-10-24'),
      startAllDay: true,
      moveWindow: { from: allDay('2026-10-24'), until: allDay('2026-10-27') },
    })
    expect(moveWindow(t)).toEqual({ from: new Date(2026, 9, 24), until: new Date(2026, 9, 27) })
    expect(lastAllowedDay(moveWindow(t)!)).toEqual(new Date(2026, 9, 26))
  })

  it('has a lower bound only for the last repeat', () => {
    const t = todo({
      recurring: true,
      fixedDays: true,
      due: allDay('2026-10-05'),
      dueAllDay: true,
      moveWindow: { from: allDay('2026-10-05'), until: null },
    })
    expect(moveWindow(t)).toEqual({ from: new Date(2026, 9, 5), until: null })
  })

  it('is null without a window from the server, whatever the series', () => {
    const t = todo({
      recurring: true,
      fixedDays: true,
      due: allDay('2026-10-05'),
      dueAllDay: true,
      next: { start: null, due: allDay('2026-10-08') },
    })
    expect(moveWindow(t)).toBeNull()
    expect(moveWindow({ ...t, moveWindow: null })).toBeNull()
  })

  it("follows the server's rule days, not the date another client moved the occurrence to", () => {
    // Another client moved Monday's repeat to Tuesday: the window still starts on the rule's Monday, before the
    // task's own start. The series is in UTC, so its days start at 01:00 in Berlin (CET in March).
    const t = todo({
      recurring: true,
      fixedDays: true,
      start: '2025-03-11T09:00:00Z',
      next: { start: '2025-03-13T09:00:00Z', startAllDay: false, due: null, dueAllDay: false },
      moveWindow: { from: '2025-03-10T00:00:00Z', until: '2025-03-13T00:00:00Z' },
    })
    const w = moveWindow(t)!
    expect(w).toEqual({ from: new Date('2025-03-10T00:00:00Z'), until: new Date('2025-03-13T00:00:00Z') })
    expect(outsideWindow(w, new Date(2025, 2, 9))).toBe(true)
    expect(outsideWindow(w, new Date(2025, 2, 10))).toBe(false)
    const startAt = (iso: string) => ({ start: iso, startAllDay: false, due: null, dueAllDay: false })
    expect(withinWindow(t, startAt('2025-03-10T09:00:00Z'))).toBe(true) // back onto its own Monday
    expect(withinWindow(t, startAt('2025-03-09T23:30:00Z'))).toBe(false) // Monday 00:30 in Berlin, before the series' day
    expect(windowEdge(w, new Date('2025-03-09T23:30:00Z'))).toEqual({ edge: 'from', date: w.from })
  })

  it('has no lower bound for a repeat off the rule', () => {
    // Shown on 10 March, before the weekly rule's next instance on Sunday the 16th: it may move earlier at will.
    const t = todo({
      recurring: true,
      start: '2025-03-10T15:00:00Z',
      next: { start: '2025-03-16T09:00:00Z', startAllDay: false, due: null, dueAllDay: false },
      moveWindow: { from: null, until: '2025-03-16T00:00:00Z' },
    })
    const w = moveWindow(t)!
    expect(w).toEqual({ from: null, until: new Date('2025-03-16T00:00:00Z') })
    expect(outsideWindow(w, new Date(2025, 2, 1))).toBe(false)
    expect(outsideWindow(w, new Date(2025, 2, 16))).toBe(false) // covered until 01:00 local
    expect(outsideWindow(w, new Date(2025, 2, 17))).toBe(true)
    const startAt = (iso: string) => ({ start: iso, startAllDay: false, due: null, dueAllDay: false })
    expect(withinWindow(t, startAt('2025-03-01T15:00:00Z'))).toBe(true)
    expect(withinWindow(t, startAt('2025-03-16T08:00:00Z'))).toBe(false)
    expect(windowEdge(w, new Date('2025-03-01T15:00:00Z'))).toBeNull()
    expect(windowEdge(w, new Date('2025-03-16T08:00:00Z'))).toEqual({ edge: 'until', date: new Date(2025, 2, 16) })
  })

  it('ends where the server says, not at the day of the next occurrence (A-15)', () => {
    // Twice a day, 09:00 and 17:00 local: the window ends at the next one, on the same day.
    const t = todo({
      recurring: true,
      fixedDays: true,
      due: '2026-10-05T07:00:00Z',
      next: { start: null, due: '2026-10-05T15:00:00Z' },
      moveWindow: { from: '2026-10-04T22:00:00Z', until: '2026-10-05T15:00:00Z' },
    })
    expect(moveWindow(t)).toEqual({ from: new Date(2026, 9, 5), until: new Date(2026, 9, 5, 17) })
    expect(withinWindow(t, { start: null, startAllDay: false, due: '2026-10-05T12:00:00Z', dueAllDay: false })).toBe(true)
    expect(withinWindow(t, { start: null, startAllDay: false, due: '2026-10-05T15:00:00Z', dueAllDay: false })).toBe(false)
  })
})

describe('a window in another zone than the browser (A-14)', () => {
  // A series in UTC−5: its days start at 05:00 UTC, 06:00 in Berlin (CET in March).
  const t = todo({
    recurring: true,
    fixedDays: true,
    due: '2025-03-10T14:00:00Z',
    moveWindow: { from: '2025-03-10T05:00:00Z', until: '2025-03-13T05:00:00Z' },
  })
  const w = moveWindow(t)!
  const dueAt = (iso: string) => ({ start: null, startAllDay: false, due: iso, dueAllDay: false })

  it('a partly covered local day stays selectable', () => {
    expect(outsideWindow(w, new Date(2025, 2, 9))).toBe(true)
    expect(outsideWindow(w, new Date(2025, 2, 10))).toBe(false)
    expect(outsideWindow(w, new Date(2025, 2, 13))).toBe(false)
    expect(outsideWindow(w, new Date(2025, 2, 14))).toBe(true)
    expect(lastAllowedDay(w)).toEqual(new Date(2025, 2, 13))
  })

  it('checks a time on such a day exactly', () => {
    expect(withinWindow(t, dueAt('2025-03-10T04:00:00Z'))).toBe(false) // 05:00 local
    expect(withinWindow(t, dueAt('2025-03-10T06:00:00Z'))).toBe(true) // 07:00 local
    expect(withinWindow(t, dueAt('2025-03-13T04:30:00Z'))).toBe(true) // 05:30 local
    expect(withinWindow(t, dueAt('2025-03-13T05:00:00Z'))).toBe(false) // 06:00 local
  })
})

describe('withinWindow', () => {
  const t = todo({
    recurring: true,
    fixedDays: true,
    due: allDay('2026-10-05'),
    dueAllDay: true,
    moveWindow: { from: allDay('2026-10-05'), until: allDay('2026-10-08') },
  })

  it('accepts a due date inside the window', () => {
    expect(withinWindow(t, { start: null, startAllDay: false, due: allDay('2026-10-07'), dueAllDay: true })).toBe(
      true,
    )
  })

  it('rejects the day the next occurrence is due', () => {
    expect(withinWindow(t, { start: null, startAllDay: false, due: allDay('2026-10-08'), dueAllDay: true })).toBe(
      false,
    )
  })

  it('rejects a day before the current occurrence', () => {
    expect(withinWindow(t, { start: null, startAllDay: false, due: allDay('2026-10-04'), dueAllDay: true })).toBe(
      false,
    )
  })

  it('is judged by its start when both start and due are given', () => {
    expect(
      withinWindow(t, { start: allDay('2026-10-04'), startAllDay: true, due: allDay('2026-10-07'), dueAllDay: true }),
    ).toBe(false)
  })

  it('is true without a window', () => {
    expect(
      withinWindow(todo(), { start: null, startAllDay: false, due: allDay('2026-10-20'), dueAllDay: true }),
    ).toBe(true)
  })

  it('rejects an input without dates when a window exists', () => {
    expect(withinWindow(t, { start: null, startAllDay: false, due: null, dueAllDay: false })).toBe(false)
  })

  describe('for a timed series', () => {
    // Mon 09:00 local, next Thu 09:00 local, in the browser's zone.
    const timed = todo({
      recurring: true,
      fixedDays: true,
      due: '2026-10-05T07:00:00Z',
      moveWindow: { from: '2026-10-04T22:00:00Z', until: '2026-10-07T22:00:00Z' },
    })
    const dueAt = (iso: string) => ({ start: null, startAllDay: false, due: iso, dueAllDay: false })

    it('rejects an earlier time on the day the next occurrence is due', () => {
      expect(withinWindow(timed, dueAt('2026-10-08T05:00:00Z'))).toBe(false)
    })

    it('accepts any time on the last allowed day', () => {
      expect(withinWindow(timed, dueAt('2026-10-07T21:30:00Z'))).toBe(true)
    })

    it('accepts an earlier time on the day of the current occurrence', () => {
      expect(withinWindow(timed, dueAt('2026-10-05T04:00:00Z'))).toBe(true)
    })

    it('ends at local midnight across the DST change', () => {
      // Sat 24 Oct 09:00 CEST, next Tue 27 Oct 09:00 CET; the clocks go back on the 25th.
      const dst = todo({
        recurring: true,
        fixedDays: true,
        due: '2026-10-24T07:00:00Z',
        moveWindow: { from: '2026-10-23T22:00:00Z', until: '2026-10-26T23:00:00Z' },
      })
      expect(withinWindow(dst, dueAt('2026-10-26T22:30:00Z'))).toBe(true) // Mon 23:30 CET
      expect(withinWindow(dst, dueAt('2026-10-26T23:00:00Z'))).toBe(false) // Tue 00:00 CET
    })
  })

  describe('for the last repeat of a fixed-day series', () => {
    const last = todo({
      recurring: true,
      fixedDays: true,
      due: allDay('2026-10-05'),
      dueAllDay: true,
      moveWindow: { from: allDay('2026-10-05'), until: null },
    })
    const dueOn = (day: string) => ({ start: null, startAllDay: false, due: allDay(day), dueAllDay: true })

    it('accepts a later day', () => {
      expect(withinWindow(last, dueOn('2026-12-25'))).toBe(true)
    })

    it('accepts its own day', () => {
      expect(withinWindow(last, dueOn('2026-10-05'))).toBe(true)
    })

    it('refuses an earlier day', () => {
      expect(withinWindow(last, dueOn('2026-10-04'))).toBe(false)
    })
  })
})

describe('lastAllowedDay', () => {
  it('is the day before the window ends', () => {
    const t = todo({
      recurring: true,
      fixedDays: true,
      due: allDay('2026-10-05'),
      dueAllDay: true,
      moveWindow: { from: allDay('2026-10-05'), until: allDay('2026-10-08') },
    })
    expect(lastAllowedDay(moveWindow(t)!)).toEqual(new Date(2026, 9, 7))
  })

  it('is null without an upper bound', () => {
    const t = todo({
      recurring: true,
      fixedDays: true,
      due: allDay('2026-10-05'),
      dueAllDay: true,
      moveWindow: { from: allDay('2026-10-05'), until: null },
    })
    expect(lastAllowedDay(moveWindow(t)!)).toBeNull()
  })
})

describe('outsideWindow', () => {
  it('is true only before from, when the window has no upper bound', () => {
    const w = { from: new Date(2026, 9, 5), until: null }
    expect(outsideWindow(w, new Date(2026, 9, 4))).toBe(true)
    expect(outsideWindow(w, new Date(2026, 9, 5))).toBe(false)
    expect(outsideWindow(w, new Date(2026, 9, 25))).toBe(false)
  })

  it('is true before from, or from until on, for a bounded window', () => {
    const w = { from: new Date(2026, 9, 5), until: new Date(2026, 9, 8) }
    expect(outsideWindow(w, new Date(2026, 9, 4))).toBe(true)
    expect(outsideWindow(w, new Date(2026, 9, 5))).toBe(false)
    expect(outsideWindow(w, new Date(2026, 9, 7))).toBe(false)
    expect(outsideWindow(w, new Date(2026, 9, 8))).toBe(true)
  })
})

describe('windowEdge', () => {
  it('names from for an anchor before the window, for a bounded window', () => {
    const w = { from: new Date(2026, 9, 5), until: new Date(2026, 9, 8) }
    expect(windowEdge(w, new Date(2026, 9, 4))).toEqual({ edge: 'from', date: new Date(2026, 9, 5) })
  })

  it('names until for an anchor at or past the end, for a bounded window', () => {
    const w = { from: new Date(2026, 9, 5), until: new Date(2026, 9, 8) }
    expect(windowEdge(w, new Date(2026, 9, 8))).toEqual({ edge: 'until', date: new Date(2026, 9, 7) })
    expect(windowEdge(w, new Date(2026, 9, 7, 23, 59))).toBeNull()
  })

  it('is null for an anchor inside a bounded window', () => {
    const w = { from: new Date(2026, 9, 5), until: new Date(2026, 9, 8) }
    expect(windowEdge(w, new Date(2026, 9, 5))).toBeNull()
    expect(windowEdge(w, new Date(2026, 9, 6))).toBeNull()
  })

  it('names from for an anchor before the window, without an upper bound', () => {
    const w = { from: new Date(2026, 9, 5), until: null }
    expect(windowEdge(w, new Date(2026, 9, 4))).toEqual({ edge: 'from', date: new Date(2026, 9, 5) })
  })

  it('is null for any anchor on or after from, without an upper bound', () => {
    const w = { from: new Date(2026, 9, 5), until: null }
    expect(windowEdge(w, new Date(2026, 9, 5))).toBeNull()
    expect(windowEdge(w, new Date(2026, 11, 25))).toBeNull()
  })
})
