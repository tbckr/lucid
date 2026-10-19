import { de } from 'date-fns/locale/de'
import { enUS } from 'date-fns/locale/en-US'
import { describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import { type FormatPrefs } from './format'
import { buildRRule, describeRRule, fitUntil, normalizeRRule, parseRRule, parseRule, recurrenceFromRRule } from './rrule'

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

describe('parseRule', () => {
  it('reads every part Lucid knows', () => {
    expect(parseRule('freq=monthly;INTERVAL=2;BYDAY=-1FR,MO;BYSETPOS=1;UNTIL=20261231T225959Z;WKST=SU')).toEqual({
      freq: 'MONTHLY',
      interval: 2,
      until: { at: new Date(Date.UTC(2026, 11, 31, 22, 59, 59)), form: 'utc' },
      byDay: [
        { nth: -1, weekday: 5 },
        { nth: 0, weekday: 1 },
      ],
      byMonthDay: [],
      byMonth: [],
      byYearDay: [],
      byWeekNo: [],
      bySetPos: [1],
      byHour: [],
      byMinute: [],
      bySecond: [],
      wkst: 0,
    })
  })

  it.each([
    ['FREQ=DAILY;UNTIL=20260630', { at: new Date(2026, 5, 30), form: 'date' }],
    ['FREQ=DAILY;UNTIL=20260630T120000', { at: new Date(2026, 5, 30, 12), form: 'floating' }],
  ])('reads the UNTIL of %s', (rule, until) => {
    expect(parseRule(rule)?.until).toEqual(until)
  })

  it('reads a COUNT and the BY parts as numbers', () => {
    expect(parseRule('FREQ=YEARLY;COUNT=3;BYMONTH=1,7;BYMONTHDAY=-1;BYYEARDAY=100;BYWEEKNO=20;BYHOUR=9;BYMINUTE=30;BYSECOND=0')).toMatchObject({
      count: 3,
      byMonth: [1, 7],
      byMonthDay: [-1],
      byYearDay: [100],
      byWeekNo: [20],
      byHour: [9],
      byMinute: [30],
      bySecond: [0],
    })
  })

  it.each([
    '',
    'INTERVAL=2',
    'FREQ=FORTNIGHTLY',
    'FREQ=DAILY;INTERVAL=0',
    'FREQ=DAILY;INTERVAL=two',
    'FREQ=DAILY;COUNT=0',
    'FREQ=DAILY;UNTIL=soon',
    'FREQ=DAILY;COUNT=3;UNTIL=20260630',
    'FREQ=WEEKLY;BYDAY=XX',
    'FREQ=YEARLY;BYMONTH=13',
    'FREQ=MONTHLY;BYMONTHDAY=0',
    'FREQ=MONTHLY;BYDAY=60MO',
    'FREQ=DAILY;BYHOUR=24',
    'FREQ=WEEKLY;RSCALE=GREGORIAN',
  ])('cannot read %s', (rule) => {
    expect(parseRule(rule)).toBeNull()
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
    ['FREQ=MONTHLY;BYMONTHDAY=1,15', 'Every month on days 1 and 15', 'Jeden Monat am 1. und 15.'],
    ['FREQ=MONTHLY;BYMONTHDAY=-1', 'Every month on the last day', 'Jeden Monat am letzten Tag'],
    ['FREQ=MONTHLY;BYMONTHDAY=1,-1', 'Every month on day 1 and the last day', 'Jeden Monat am 1. und letzten Tag'],
    ['FREQ=MONTHLY;BYMONTHDAY=-3', 'Every month on the third-to-last day', 'Jeden Monat am drittletzten Tag'],
    ['FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1', 'Every month on the last weekday', 'Jeden Monat am letzten Werktag'],
    ['FREQ=MONTHLY;BYDAY=SA,SU;BYSETPOS=1', 'Every month on the first weekend day', 'Jeden Monat am ersten Wochenendtag'],
    ['FREQ=MONTHLY;BYDAY=MO,WE;BYSETPOS=2', 'Every month on the second Monday or Wednesday', 'Jeden Monat am zweiten Montag oder Mittwoch'],
    ['FREQ=MONTHLY;BYDAY=1MO,3FR', 'Every month on the first Monday and the third Friday', 'Jeden Monat am ersten Montag und dritten Freitag'],
    ['FREQ=MONTHLY;BYDAY=MO', 'Every month on every Monday', 'Jeden Monat an jedem Montag'],
    ['FREQ=MONTHLY;BYMONTHDAY=13;BYDAY=FR', 'Every month on day 13, only on Friday', 'Jeden Monat am 13., nur am Freitag'],
    ['FREQ=MONTHLY;BYDAY=-1FR;COUNT=6', 'Every month on the last Friday, 6 times', 'Jeden Monat am letzten Freitag, 6-mal'],
    ['FREQ=YEARLY;BYMONTH=11;BYDAY=4TH', 'Every year on the fourth Thursday in November', 'Jedes Jahr am vierten Donnerstag im November'],
    ['FREQ=YEARLY;BYMONTH=5;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1', 'Every year on the last weekday in May', 'Jedes Jahr am letzten Werktag im Mai'],
    ['FREQ=YEARLY;BYMONTH=1,7', 'Every year on day 11 in January and July', 'Jedes Jahr am 11. im Januar und Juli'],
    ['FREQ=YEARLY;BYYEARDAY=100', 'Every year on day 100 of the year', 'Jedes Jahr am 100. Tag des Jahres'],
    ['FREQ=YEARLY;BYYEARDAY=-1', 'Every year on the last day of the year', 'Jedes Jahr am letzten Tag des Jahres'],
    ['FREQ=YEARLY;BYDAY=20MO', 'Every year on the 20th Monday of the year', 'Jedes Jahr am 20. Montag des Jahres'],
    ['FREQ=YEARLY;BYWEEKNO=20;BYDAY=MO', 'Every year on Monday in week 20', 'Jedes Jahr am Montag in Kalenderwoche 20'],
    ['FREQ=DAILY;BYHOUR=9,17', 'Every day at 9:00 AM and 5:00 PM', 'Jeden Tag um 09:00 und 17:00'],
    ['FREQ=HOURLY;INTERVAL=2', 'Every 2 hours', 'Alle 2 Stunden'],
    ['FREQ=MINUTELY;INTERVAL=15', 'Every 15 minutes', 'Alle 15 Minuten'],
    ['FREQ=HOURLY;BYMINUTE=0,30', 'Every hour at minutes 0 and 30', 'Jede Stunde zu den Minuten 0 und 30'],
    // Below hourly, the hours are a window, not times of day.
    ['FREQ=MINUTELY;INTERVAL=30;BYHOUR=9,10,11', 'Every 30 minutes, with further conditions', 'Alle 30 Minuten, mit weiteren Bedingungen'],
    ['FREQ=DAILY;INTERVAL=2;BYDAY=MO', 'Every 2 days, only on Monday', 'Alle 2 Tage, nur am Montag'],
    ['FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1', 'Every week on the last weekday', 'Jede Woche am letzten Werktag'],
    ['FREQ=MONTHLY;BYMONTHDAY=1,2,3;BYSETPOS=1', 'Every month, with further conditions', 'Jeden Monat, mit weiteren Bedingungen'],
    ['FREQ=WEEKLY;BYDAY=1MO', 'Every week, with further conditions', 'Jede Woche, mit weiteren Bedingungen'],
    ['FREQ=WEEKLY;RSCALE=GREGORIAN', 'Repeats by a rule from another app', 'Wiederholt sich nach einer Regel aus einer anderen App'],
  ])('describes %s', (rule, english, deutsch) => {
    expect(en(rule)).toBe(english)
    expect(german(rule)).toBe(deutsch)
  })
})

// FR-17: UNTIL takes DTSTART's form (RFC 5545 3.3.10), as the server writes it.
describe('fitUntil', () => {
  it.each([
    ['FREQ=DAILY;UNTIL=20261231', true, 'FREQ=DAILY;UNTIL=20261231'],
    // The last day stays: until its end in the zone, as UTC.
    ['FREQ=DAILY;UNTIL=20261231', false, 'FREQ=DAILY;UNTIL=20261231T225959Z'],
    ['FREQ=DAILY;UNTIL=20260630;BYHOUR=9', false, 'FREQ=DAILY;UNTIL=20260630T215959Z;BYHOUR=9'],
    ['FREQ=DAILY;UNTIL=20261231T225959Z', true, 'FREQ=DAILY;UNTIL=20261231'],
    ['FREQ=DAILY;UNTIL=20261231T225959Z', false, 'FREQ=DAILY;UNTIL=20261231T225959Z'],
    ['FREQ=DAILY;UNTIL=20261231T120000', true, 'FREQ=DAILY;UNTIL=20261231'],
    ['FREQ=DAILY;UNTIL=20261231T120000', false, 'FREQ=DAILY;UNTIL=20261231T120000'],
    ['FREQ=WEEKLY;COUNT=3', false, 'FREQ=WEEKLY;COUNT=3'],
    ['', false, ''],
  ])('fits %s (all-day: %s)', (rule, allDay, fitted) => {
    expect(fitUntil(rule, allDay, 'Europe/Berlin')).toBe(fitted)
  })

  it('reads the date of a UTC end in the zone given', () => {
    expect(fitUntil('FREQ=DAILY;UNTIL=20261231T225959Z', true, 'America/New_York')).toBe('FREQ=DAILY;UNTIL=20261231')
    expect(fitUntil('FREQ=DAILY;UNTIL=20270101T045959Z', true, 'America/New_York')).toBe('FREQ=DAILY;UNTIL=20261231')
  })
})
