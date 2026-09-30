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
  recurringLabel,
  toCalTask,
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
  it('matches canComplete for an occurrence', () => {
    const current = occurrenceTask(occurrence({ state: 'current' }), todo())!
    const done = occurrenceTask(occurrence({ state: 'done' }), todo())!
    expect(canDrag(current)).toBe(true)
    expect(canDrag(done)).toBe(false)
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

describe('moveWindow', () => {
  it('bounds a fixed-day all-day series to its next occurrence', () => {
    const t = todo({
      recurring: true,
      fixedDays: true,
      due: allDay('2026-10-05'),
      dueAllDay: true,
      next: { start: null, due: allDay('2026-10-08') },
    })
    expect(moveWindow(t)).toEqual({ from: new Date(2026, 9, 5), until: new Date(2026, 9, 8) })
  })

  it('starts a timed series window at local midnight of the current occurrence', () => {
    const t = todo({
      recurring: true,
      fixedDays: true,
      due: '2026-10-05T07:00:00Z',
      next: { start: null, due: '2026-10-08T07:00:00Z' },
    })
    expect(moveWindow(t)?.from).toEqual(new Date(2026, 9, 5))
  })

  it('ends a timed series window at local midnight of the day the next occurrence is due', () => {
    // Mon 09:00 local, next Thu 09:00 local: the window ends where Thursday begins.
    const t = todo({
      recurring: true,
      fixedDays: true,
      due: '2026-10-05T07:00:00Z',
      next: { start: null, due: '2026-10-08T07:00:00Z' },
    })
    expect(moveWindow(t)).toEqual({ from: new Date(2026, 9, 5), until: new Date(2026, 9, 8) })
  })

  it('keeps the window on local midnights across the DST change', () => {
    // Sat 24 Oct 09:00 CEST, next Tue 27 Oct 09:00 CET; the clocks go back on the 25th.
    const t = todo({
      recurring: true,
      fixedDays: true,
      due: '2026-10-24T07:00:00Z',
      next: { start: null, due: '2026-10-27T08:00:00Z' },
    })
    expect(moveWindow(t)).toEqual({ from: new Date(2026, 9, 24), until: new Date(2026, 9, 27) })
    expect(lastAllowedDay(moveWindow(t)!)).toEqual(new Date(2026, 9, 26))
  })

  it('is null for an interval rule (fixedDays false)', () => {
    const t = todo({
      recurring: true,
      fixedDays: false,
      due: allDay('2026-10-05'),
      dueAllDay: true,
      next: { start: null, due: allDay('2026-10-08') },
    })
    expect(moveWindow(t)).toBeNull()
  })

  it('is null without a next occurrence', () => {
    const t = todo({ recurring: true, fixedDays: true, due: allDay('2026-10-05'), dueAllDay: true, next: null })
    expect(moveWindow(t)).toBeNull()
  })

  it('is null without dates on the series itself', () => {
    const t = todo({ recurring: true, fixedDays: true, next: { start: null, due: allDay('2026-10-08') } })
    expect(moveWindow(t)).toBeNull()
  })

  it('is null without dates on the next occurrence', () => {
    const t = todo({
      recurring: true,
      fixedDays: true,
      due: allDay('2026-10-05'),
      dueAllDay: true,
      next: { start: null, due: null },
    })
    expect(moveWindow(t)).toBeNull()
  })
})

describe('withinWindow', () => {
  const t = todo({
    recurring: true,
    fixedDays: true,
    due: allDay('2026-10-05'),
    dueAllDay: true,
    next: { start: null, due: allDay('2026-10-08') },
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
    // Mon 09:00 local, next Thu 09:00 local.
    const timed = todo({
      recurring: true,
      fixedDays: true,
      due: '2026-10-05T07:00:00Z',
      next: { start: null, due: '2026-10-08T07:00:00Z' },
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
        next: { start: null, due: '2026-10-27T08:00:00Z' },
      })
      expect(withinWindow(dst, dueAt('2026-10-26T22:30:00Z'))).toBe(true) // Mon 23:30 CET
      expect(withinWindow(dst, dueAt('2026-10-26T23:00:00Z'))).toBe(false) // Tue 00:00 CET
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
      next: { start: null, due: allDay('2026-10-08') },
    })
    expect(lastAllowedDay(moveWindow(t)!)).toEqual(new Date(2026, 9, 7))
  })
})
