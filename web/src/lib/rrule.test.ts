import { de } from 'date-fns/locale/de'
import { enUS } from 'date-fns/locale/en-US'
import { describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import { type FormatPrefs } from './format'
import { buildRRule, describeRRule, normalizeRRule, parseRRule, recurrenceFromRRule, summarizeRRule } from './rrule'

describe('rrule', () => {
  it('builds presets', () => {
    expect(buildRRule('none')).toBe('')
    expect(buildRRule('daily')).toBe('FREQ=DAILY')
    expect(buildRRule('weekly')).toBe('FREQ=WEEKLY')
    expect(buildRRule('monthly')).toBe('FREQ=MONTHLY')
    expect(buildRRule('yearly')).toBe('FREQ=YEARLY')
    expect(buildRRule('custom', 'rrule:freq=weekly; byday=mo,we ;')).toBe('FREQ=WEEKLY;BYDAY=MO,WE')
  })

  it('parses rules', () => {
    expect([...parseRRule('FREQ=WEEKLY;INTERVAL=2;BROKEN').entries()]).toEqual([
      ['FREQ', 'WEEKLY'],
      ['INTERVAL', '2'],
      ['BROKEN', ''],
    ])
    expect(normalizeRRule('')).toBe('')
  })

  it.each([
    [undefined, 'none'],
    ['', 'none'],
    ['FREQ=DAILY', 'daily'],
    ['FREQ=WEEKLY;INTERVAL=1', 'weekly'],
    ['FREQ=WEEKLY;WKST=MO', 'weekly'],
    ['FREQ=MONTHLY', 'monthly'],
    ['freq=yearly', 'yearly'],
    ['FREQ=WEEKLY;BYDAY=MO', 'custom'],
    ['FREQ=DAILY;INTERVAL=2', 'custom'],
    ['FREQ=DAILY;COUNT=3', 'custom'],
    ['FREQ=HOURLY', 'custom'],
  ])('maps %s to %s', (rule, preset) => {
    expect(recurrenceFromRRule(rule)).toBe(preset)
  })
})

describe('summarizeRRule', () => {
  // A Wednesday: rules without BYDAY/BYMONTHDAY/BYMONTH repeat on its weekday and date.
  const start = new Date(2026, 2, 11, 9, 0)

  it.each([
    ['FREQ=DAILY', { freq: 'daily', interval: 1 }],
    ['FREQ=DAILY;INTERVAL=3', { freq: 'daily', interval: 3 }],
    ['FREQ=WEEKLY', { freq: 'weekly', interval: 1, weekdays: [3] }],
    ['FREQ=WEEKLY;BYDAY=TH,MO', { freq: 'weekly', interval: 1, weekdays: [1, 4] }],
    ['FREQ=WEEKLY;INTERVAL=2;BYDAY=SU;WKST=MO', { freq: 'weekly', interval: 2, weekdays: [0] }],
    // Outlook writes weekdays as a daily rule.
    ['FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR', { freq: 'weekly', interval: 1, weekdays: [1, 2, 3, 4, 5] }],
    ['FREQ=MONTHLY', { freq: 'monthly', interval: 1, day: 11 }],
    ['FREQ=MONTHLY;BYMONTHDAY=5', { freq: 'monthly', interval: 1, day: 5 }],
    ['FREQ=MONTHLY;INTERVAL=3;BYDAY=+2TU', { freq: 'monthly', interval: 3, nth: 2, weekday: 2 }],
    ['FREQ=MONTHLY;BYDAY=-1FR', { freq: 'monthly', interval: 1, nth: -1, weekday: 5 }],
    ['FREQ=YEARLY', { freq: 'yearly', interval: 1, month: 2, day: 11 }],
    ['FREQ=YEARLY;BYMONTH=6', { freq: 'yearly', interval: 1, month: 5, day: 11 }],
    ['FREQ=YEARLY;BYMONTH=6;BYMONTHDAY=1', { freq: 'yearly', interval: 1, month: 5, day: 1 }],
    ['FREQ=WEEKLY;COUNT=10', { freq: 'weekly', interval: 1, weekdays: [3], count: 10 }],
    ['FREQ=DAILY;UNTIL=20260630', { freq: 'daily', interval: 1, until: new Date(2026, 5, 30) }],
    ['FREQ=DAILY;UNTIL=20260630T215959Z', { freq: 'daily', interval: 1, until: new Date(Date.UTC(2026, 5, 30, 21, 59, 59)) }],
    ['FREQ=DAILY;UNTIL=20260630T120000', { freq: 'daily', interval: 1, until: new Date(2026, 5, 30, 12) }],
  ])('summarizes %s', (rule, summary) => {
    expect(summarizeRRule(rule, start)).toEqual(summary)
  })

  it.each([
    '',
    'INTERVAL=2',
    'FREQ=HOURLY',
    'FREQ=DAILY;INTERVAL=0',
    'FREQ=DAILY;INTERVAL=two',
    'FREQ=DAILY;COUNT=0',
    'FREQ=DAILY;UNTIL=soon',
    'FREQ=DAILY;COUNT=3;UNTIL=20260630',
    'FREQ=DAILY;INTERVAL=2;BYDAY=MO',
    'FREQ=WEEKLY;BYDAY=1MO',
    'FREQ=WEEKLY;BYDAY=XX',
    'FREQ=WEEKLY;BYHOUR=9',
    'FREQ=MONTHLY;BYDAY=MO',
    'FREQ=MONTHLY;BYDAY=6MO',
    'FREQ=MONTHLY;BYDAY=-2MO',
    'FREQ=MONTHLY;BYDAY=1MO,3MO',
    'FREQ=MONTHLY;BYSETPOS=-1;BYDAY=MO,TU,WE,TH,FR',
    'FREQ=MONTHLY;BYMONTHDAY=1,15',
    'FREQ=MONTHLY;BYMONTHDAY=-1',
    'FREQ=MONTHLY;BYMONTHDAY=5;BYDAY=2TU',
    'FREQ=YEARLY;BYMONTHDAY=5',
    'FREQ=YEARLY;BYMONTH=2,3',
    'FREQ=YEARLY;BYMONTH=13',
    'FREQ=YEARLY;BYMONTH=11;BYDAY=4TH',
  ])('leaves %s to the raw rule', (rule) => {
    expect(summarizeRRule(rule, start)).toBeNull()
  })
})

describe('describeRRule', () => {
  const start = new Date(2026, 2, 11, 9, 0) // Wednesday
  const now = new Date(2026, 2, 11)
  const us: FormatPrefs = { tag: 'en-US', locale: enUS, hourCycle: '12h', weekStartsOn: 0 }
  const deDE: FormatPrefs = { tag: 'de-DE', locale: de, hourCycle: '24h', weekStartsOn: 1 }
  const en = (rule: string) => describeRRule(rule, start, us, now, i18n.getFixedT('en'))
  const german = (rule: string) => describeRRule(rule, start, deDE, now, i18n.getFixedT('de'))

  it.each([
    ['', 'Does not repeat', 'Keine Wiederholung'],
    ['FREQ=DAILY', 'Every day', 'Jeden Tag'],
    ['FREQ=DAILY;INTERVAL=3', 'Every 3 days', 'Alle 3 Tage'],
    ['FREQ=WEEKLY', 'Every week on Wednesday', 'Jede Woche am Mittwoch'],
    ['FREQ=WEEKLY;BYDAY=TH,MO', 'Every week on Monday and Thursday', 'Jede Woche am Montag und Donnerstag'],
    ['FREQ=WEEKLY;BYDAY=MO,WE,FR', 'Every week on Monday, Wednesday, and Friday', 'Jede Woche am Montag, Mittwoch und Freitag'],
    // Weekdays in the order of the week: it starts on Sunday in the US, on Monday in Germany.
    ['FREQ=WEEKLY;INTERVAL=2;BYDAY=SA,SU', 'Every 2 weeks on Sunday and Saturday', 'Alle 2 Wochen am Samstag und Sonntag'],
    ['FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR', 'Every weekday (Monday to Friday)', 'Jeden Werktag (Montag bis Freitag)'],
    ['FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TU,WE,TH,FR', 'Every 2 weeks on Monday, Tuesday, Wednesday, Thursday, and Friday', 'Alle 2 Wochen am Montag, Dienstag, Mittwoch, Donnerstag und Freitag'],
    ['FREQ=MONTHLY', 'Every month on day 11', 'Jeden Monat am 11.'],
    ['FREQ=MONTHLY;INTERVAL=6;BYMONTHDAY=1', 'Every 6 months on day 1', 'Alle 6 Monate am 1.'],
    ['FREQ=MONTHLY;BYDAY=2TU', 'Every month on the second Tuesday', 'Jeden Monat am zweiten Dienstag'],
    ['FREQ=MONTHLY;INTERVAL=3;BYDAY=-1FR', 'Every 3 months on the last Friday', 'Alle 3 Monate am letzten Freitag'],
    ['FREQ=YEARLY', 'Every year on March 11', 'Jedes Jahr am 11. März'],
    ['FREQ=YEARLY;INTERVAL=2;BYMONTH=2;BYMONTHDAY=29', 'Every 2 years on February 29', 'Alle 2 Jahre am 29. Februar'],
    ['FREQ=DAILY;COUNT=1', 'Every day, once', 'Jeden Tag, einmal'],
    ['FREQ=WEEKLY;COUNT=10', 'Every week on Wednesday, 10 times', 'Jede Woche am Mittwoch, 10-mal'],
    ['FREQ=DAILY;UNTIL=20260630T215959Z', 'Every day, until Tue, Jun 30', 'Jeden Tag, bis Di., 30. Juni'],
    ['FREQ=DAILY;UNTIL=20270105', 'Every day, until Tue, Jan 5, 2027', 'Jeden Tag, bis Di., 5. Jan. 2027'],
  ])('describes %s', (rule, english, deutsch) => {
    expect(en(rule)).toBe(english)
    expect(german(rule)).toBe(deutsch)
  })

  it('leaves rules it cannot put into words to the caller', () => {
    expect(en('FREQ=MONTHLY;BYSETPOS=-1;BYDAY=MO')).toBeNull()
  })
})
