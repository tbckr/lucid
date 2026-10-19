import { format } from 'date-fns'
import { describe, expect, it } from 'vitest'
import { type WeekStart } from './locale'
import {
  defaultModel,
  modelFromRule,
  nextDates,
  ruleFromModel,
  skipHint,
  startMatches,
  type RuleModel,
} from './recurrence'

// A Wednesday, the second of its month.
const start = new Date(2026, 2, 11, 9, 0)
const DEFAULT: RuleModel = {
  freq: 'weekly',
  interval: 1,
  weekdays: [3],
  monthly: { by: 'days', days: [11] },
  month: 2,
  end: { kind: 'never' },
}
const m = (changes: Partial<RuleModel> = {}): RuleModel => ({ ...DEFAULT, ...changes })
const TZ = 'Europe/Berlin'

describe('defaultModel', () => {
  it('repeats weekly on the start, with the start for every other choice', () => {
    expect(defaultModel(start)).toEqual(DEFAULT)
  })
})

describe('modelFromRule', () => {
  it.each<[string, Partial<RuleModel>]>([
    ['', {}],
    ['FREQ=DAILY;INTERVAL=3', { freq: 'daily', interval: 3 }],
    // Outlook's weekdays: every day on Monday to Friday is every week on them.
    ['FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR', { weekdays: [1, 2, 3, 4, 5] }],
    ['FREQ=WEEKLY;INTERVAL=2;BYDAY=TH,MO;WKST=SU', { interval: 2, weekdays: [1, 4], wkst: 'SU' }],
    ['FREQ=MONTHLY;BYMONTHDAY=15,1,-1', { freq: 'monthly', monthly: { by: 'days', days: [1, 15, -1] } }],
    ['FREQ=MONTHLY;BYDAY=-1FR', { freq: 'monthly', monthly: { by: 'nth', nth: -1, day: 5 } }],
    ['FREQ=MONTHLY;BYDAY=TU;BYSETPOS=2', { freq: 'monthly', monthly: { by: 'nth', nth: 2, day: 2 } }],
    ['FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1', { freq: 'monthly', monthly: { by: 'nth', nth: -1, day: 'weekday' } }],
    ['FREQ=MONTHLY;BYDAY=SU,SA;BYSETPOS=1', { freq: 'monthly', monthly: { by: 'nth', nth: 1, day: 'weekendDay' } }],
    ['FREQ=YEARLY', { freq: 'yearly' }],
    ['FREQ=YEARLY;BYMONTH=6;BYMONTHDAY=1', { freq: 'yearly', month: 5, monthly: { by: 'days', days: [1] } }],
    ['FREQ=YEARLY;BYMONTH=11;BYDAY=4TH', { freq: 'yearly', month: 10, monthly: { by: 'nth', nth: 4, day: 4 } }],
    ['FREQ=WEEKLY;COUNT=10', { end: { kind: 'count', count: 10 } }],
    ['FREQ=WEEKLY;UNTIL=20261231T225959Z', { end: { kind: 'until', date: '2026-12-31' } }],
    ['FREQ=WEEKLY;UNTIL=20261231', { end: { kind: 'until', date: '2026-12-31' } }],
  ])('reads %s exactly', (rule, changes) => {
    expect(modelFromRule(rule, start, TZ)).toEqual({ model: m(changes), exact: true })
  })

  it.each<[string, Partial<RuleModel>]>([
    ['FREQ=MONTHLY;BYMONTHDAY=-2', { freq: 'monthly' }],
    ['FREQ=MONTHLY;BYDAY=1MO,3FR', { freq: 'monthly' }],
    ['FREQ=HOURLY;INTERVAL=2', { freq: 'daily' }],
    ['FREQ=YEARLY;BYMONTH=1,7', { freq: 'yearly', month: 0 }],
    ['FREQ=WEEKLY;BYHOUR=9;COUNT=5', { end: { kind: 'count', count: 5 } }],
    ['FREQ=WEEKLY;RSCALE=GREGORIAN', {}],
  ])('reads %s as the closest repeat it can show', (rule, changes) => {
    expect(modelFromRule(rule, start, TZ)).toEqual({ model: m(changes), exact: false })
  })
})

// RFC 5545: without WKST, weeks start on Monday, which pairs the days of a rule every few weeks.
it('reads a rule every few weeks on several days without WKST with weeks from Monday', () => {
  const sunday = new Date(2026, 2, 8, 9)
  const { model, exact } = modelFromRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,MO', sunday, TZ)
  expect(exact).toBe(true)
  expect(model.wkst).toBe('MO')
  const dates = nextDates(model, sunday, 0, 5).dates.map((d) => format(d, 'yyyy-MM-dd'))
  expect(dates).toEqual(['2026-03-08', '2026-03-16', '2026-03-22', '2026-03-30', '2026-04-05'])
})

describe('ruleFromModel', () => {
  it.each<[Partial<RuleModel>, WeekStart, string]>([
    [{}, 1, 'FREQ=WEEKLY'],
    [{ interval: 2, weekdays: [1, 4] }, 1, 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH'],
    // Every other week on Sunday and Monday: with weeks from Sunday, they belong to one week.
    [{ interval: 2, weekdays: [0, 1] }, 0, 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,SU;WKST=SU'],
    [{ interval: 2, weekdays: [5, 6] }, 6, 'FREQ=WEEKLY;INTERVAL=2;BYDAY=FR,SA;WKST=SA'],
    [{ interval: 2, weekdays: [1] }, 0, 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO'],
    [{ weekdays: [1, 4], wkst: 'SU' }, 1, 'FREQ=WEEKLY;BYDAY=MO,TH;WKST=SU'],
    [{ freq: 'daily', interval: 3 }, 1, 'FREQ=DAILY;INTERVAL=3'],
    [{ freq: 'monthly' }, 1, 'FREQ=MONTHLY'],
    [{ freq: 'monthly', monthly: { by: 'days', days: [1, 15] } }, 1, 'FREQ=MONTHLY;BYMONTHDAY=1,15'],
    [{ freq: 'monthly', monthly: { by: 'days', days: [1, -1] } }, 1, 'FREQ=MONTHLY;BYMONTHDAY=1,-1'],
    [{ freq: 'monthly', monthly: { by: 'nth', nth: 2, day: 2 } }, 1, 'FREQ=MONTHLY;BYDAY=2TU'],
    [{ freq: 'monthly', monthly: { by: 'nth', nth: -1, day: 'weekday' } }, 1, 'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1'],
    [{ freq: 'monthly', monthly: { by: 'nth', nth: 1, day: 'weekendDay' } }, 1, 'FREQ=MONTHLY;BYDAY=SA,SU;BYSETPOS=1'],
    [{ freq: 'yearly' }, 1, 'FREQ=YEARLY'],
    [{ freq: 'yearly', month: 5, monthly: { by: 'days', days: [1] } }, 1, 'FREQ=YEARLY;BYMONTH=6;BYMONTHDAY=1'],
    [{ freq: 'yearly', month: 5 }, 1, 'FREQ=YEARLY;BYMONTH=6;BYMONTHDAY=11'],
    [{ freq: 'yearly', month: 10, monthly: { by: 'nth', nth: 4, day: 4 } }, 1, 'FREQ=YEARLY;BYMONTH=11;BYDAY=4TH'],
    [{ end: { kind: 'count', count: 10 } }, 1, 'FREQ=WEEKLY;COUNT=10'],
    [{ end: { kind: 'until', date: '2026-12-31' } }, 1, 'FREQ=WEEKLY;UNTIL=20261231'],
  ])('writes %j', (changes, weekStartsOn, rule) => {
    expect(ruleFromModel(m(changes), start, weekStartsOn)).toBe(rule)
  })

  // FR-17: a changed rule applies from the series' own start, which may lie elsewhere than the shown one.
  it.each<[Partial<RuleModel>, string]>([
    [{}, 'FREQ=WEEKLY;BYDAY=WE'],
    [{ freq: 'daily' }, 'FREQ=DAILY'],
    [{ freq: 'monthly' }, 'FREQ=MONTHLY;BYMONTHDAY=11'],
    [{ freq: 'yearly' }, 'FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=11'],
    [{ freq: 'monthly', monthly: { by: 'nth', nth: 2, day: 3 } }, 'FREQ=MONTHLY;BYDAY=2WE'],
  ])('writes %j with every day part when asked to', (changes, rule) => {
    expect(ruleFromModel(m(changes), start, 1, true)).toBe(rule)
  })

  it('writes a rule it read in its own words', () => {
    const { model } = modelFromRule('FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR', start, TZ)
    expect(ruleFromModel(model, start, 1)).toBe('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR')
  })
})

describe('nextDates', () => {
  const days = (r: { dates: Date[] }) => r.dates.map((d) => format(d, 'yyyy-MM-dd'))

  it.each<[Date, Partial<RuleModel>, WeekStart, number, string[], boolean]>([
    // The start counts though the rule doesn't fall on it, as on the server.
    [start, { interval: 2, weekdays: [1, 4] }, 1, 5, ['2026-03-11', '2026-03-12', '2026-03-23', '2026-03-26', '2026-04-06'], true],
    [start, { freq: 'monthly', monthly: { by: 'days', days: [31] } }, 1, 5, ['2026-03-11', '2026-03-31', '2026-05-31', '2026-07-31', '2026-08-31'], true],
    [start, { freq: 'monthly', monthly: { by: 'nth', nth: -1, day: 'weekday' } }, 1, 5, ['2026-03-11', '2026-03-31', '2026-04-30', '2026-05-29', '2026-06-30'], true],
    [start, { freq: 'monthly', interval: 3, monthly: { by: 'nth', nth: 2, day: 2 } }, 1, 5, ['2026-03-11', '2026-06-09', '2026-09-08', '2026-12-08', '2027-03-09'], true],
    [start, { freq: 'monthly', monthly: { by: 'nth', nth: 5, day: 5 } }, 1, 4, ['2026-03-11', '2026-05-29', '2026-07-31', '2026-10-30'], true],
    [start, { freq: 'monthly', monthly: { by: 'nth', nth: 1, day: 'weekendDay' } }, 1, 3, ['2026-03-11', '2026-04-04', '2026-05-02'], true],
    [start, { end: { kind: 'count', count: 3 } }, 1, 5, ['2026-03-11', '2026-03-18', '2026-03-25'], false],
    [start, { end: { kind: 'until', date: '2026-03-25' } }, 1, 5, ['2026-03-11', '2026-03-18', '2026-03-25'], false],
    [start, { end: { kind: 'count', count: 3 } }, 1, 3, ['2026-03-11', '2026-03-18', '2026-03-25'], false],
    [start, {}, 1, 3, ['2026-03-11', '2026-03-18', '2026-03-25'], true],
    [new Date(2026, 2, 8, 9), { interval: 2, weekdays: [0, 1] }, 0, 5, ['2026-03-08', '2026-03-09', '2026-03-22', '2026-03-23', '2026-04-05'], true],
    [new Date(2026, 2, 8, 9), { interval: 2, weekdays: [0, 1], wkst: 'MO' }, 0, 5, ['2026-03-08', '2026-03-16', '2026-03-22', '2026-03-30', '2026-04-05'], true],
    [new Date(2028, 1, 29, 9), { freq: 'yearly', month: 1, monthly: { by: 'days', days: [29] } }, 1, 3, ['2028-02-29', '2032-02-29', '2036-02-29'], true],
    [start, { freq: 'yearly', month: 10, monthly: { by: 'nth', nth: 4, day: 4 } }, 1, 3, ['2026-03-11', '2026-11-26', '2027-11-25'], true],
    [start, { freq: 'daily', interval: 2 }, 1, 3, ['2026-03-11', '2026-03-13', '2026-03-15'], true],
  ])('lists from %s: %j', (from, changes, weekStartsOn, limit, want, more) => {
    const r = nextDates(m(changes), from, weekStartsOn, limit)
    expect(days(r)).toEqual(want)
    expect(r.more).toBe(more)
  })

  it('keeps the time of day across a DST change', () => {
    const r = nextDates(m({ freq: 'daily' }), new Date(2026, 9, 24, 9, 30), 1, 3)
    expect(days(r)).toEqual(['2026-10-24', '2026-10-25', '2026-10-26'])
    expect(r.dates.map((d) => format(d, 'HH:mm'))).toEqual(['09:30', '09:30', '09:30'])
  })
})

describe('startMatches', () => {
  it.each<[Partial<RuleModel>, boolean]>([
    [{}, true],
    [{ weekdays: [1, 4] }, false],
    [{ freq: 'monthly', monthly: { by: 'days', days: [31] } }, false],
    [{ freq: 'monthly', monthly: { by: 'nth', nth: 2, day: 3 } }, true],
    [{ freq: 'monthly', monthly: { by: 'nth', nth: -1, day: 3 } }, false],
    [{ freq: 'yearly', month: 5 }, false],
  ])('%j', (changes, matches) => {
    expect(startMatches(m(changes), start, 1)).toBe(matches)
  })
})

describe('skipHint', () => {
  it.each<[Partial<RuleModel>, ReturnType<typeof skipHint>]>([
    [{ freq: 'monthly', monthly: { by: 'days', days: [31] } }, { kind: 'monthDay', day: 31 }],
    // A month is skipped only where none of the days exists: April has the 30th.
    [{ freq: 'monthly', monthly: { by: 'days', days: [30, 31] } }, { kind: 'monthDay', day: 30 }],
    // Every month keeps a date; short ones leave the late day out.
    [{ freq: 'monthly', monthly: { by: 'days', days: [1, 29] } }, { kind: 'shortMonths' }],
    [{ freq: 'monthly', monthly: { by: 'days', days: [29, -1] } }, { kind: 'shortMonths' }],
    [{ freq: 'monthly', monthly: { by: 'days', days: [28, -1] } }, null],
    [{ freq: 'monthly', monthly: { by: 'days', days: [-1] } }, null],
    [{ freq: 'yearly', month: 1, monthly: { by: 'days', days: [29] } }, { kind: 'leapDay' }],
    [{ freq: 'yearly', month: 0, monthly: { by: 'days', days: [31] } }, null],
    [{ freq: 'monthly', monthly: { by: 'nth', nth: 5, day: 5 } }, { kind: 'fifth', day: 5 }],
    // Every month has a fifth weekday and a fifth weekend day.
    [{ freq: 'monthly', monthly: { by: 'nth', nth: 5, day: 'weekday' } }, null],
    [{ freq: 'monthly', monthly: { by: 'nth', nth: 5, day: 'weekendDay' } }, null],
    [{ freq: 'weekly', monthly: { by: 'days', days: [31] } }, null],
  ])('%j', (changes, hint) => {
    expect(skipHint(m(changes))).toEqual(hint)
  })
})
