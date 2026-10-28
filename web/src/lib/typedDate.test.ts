import { arEG } from 'date-fns/locale/ar-EG'
import { bg } from 'date-fns/locale/bg'
import { cs } from 'date-fns/locale/cs'
import { de } from 'date-fns/locale/de'
import { enGB } from 'date-fns/locale/en-GB'
import { enUS } from 'date-fns/locale/en-US'
import { faIR } from 'date-fns/locale/fa-IR'
import { hr } from 'date-fns/locale/hr'
import { hu } from 'date-fns/locale/hu'
import { ja } from 'date-fns/locale/ja'
import { ko } from 'date-fns/locale/ko'
import { lv } from 'date-fns/locale/lv'
import { nl } from 'date-fns/locale/nl'
import { sv } from 'date-fns/locale/sv'
import { describe, expect, it } from 'vitest'
import { dayKey } from './dates'
import { type FormatPrefs } from './format'
import { dateExample, formatTypedDate, readDate } from './typedDate'

const de24: FormatPrefs = { tag: 'de-DE', locale: de, hourCycle: '24h', weekStartsOn: 1 }
const us: FormatPrefs = { tag: 'en-US', locale: enUS, hourCycle: '12h', weekStartsOn: 0 }
const gb: FormatPrefs = { tag: 'en-GB', locale: enGB, hourCycle: '24h', weekStartsOn: 1 }
const sv24: FormatPrefs = { tag: 'sv-SE', locale: sv, hourCycle: '24h', weekStartsOn: 1 }
const ko12: FormatPrefs = { tag: 'ko-KR', locale: ko, hourCycle: '12h', weekStartsOn: 0 }
const fa24: FormatPrefs = { tag: 'fa-IR', locale: faIR, hourCycle: '24h', weekStartsOn: 6 }
const ja24: FormatPrefs = { tag: 'ja-JP', locale: ja, hourCycle: '24h', weekStartsOn: 0 }
const cs24: FormatPrefs = { tag: 'cs-CZ', locale: cs, hourCycle: '24h', weekStartsOn: 1 }
const hu24: FormatPrefs = { tag: 'hu-HU', locale: hu, hourCycle: '24h', weekStartsOn: 1 }
const nl24: FormatPrefs = { tag: 'nl-NL', locale: nl, hourCycle: '24h', weekStartsOn: 1 }
const hr24: FormatPrefs = { tag: 'hr-HR', locale: hr, hourCycle: '24h', weekStartsOn: 1 }
const lv24: FormatPrefs = { tag: 'lv-LV', locale: lv, hourCycle: '24h', weekStartsOn: 1 }
const bg24: FormatPrefs = { tag: 'bg-BG', locale: bg, hourCycle: '24h', weekStartsOn: 1 }
// Writes the day before the month, which no locale Lucid loads does; Intl has it.
const ug24: FormatPrefs = { tag: 'ug-CN', locale: enUS, hourCycle: '24h', weekStartsOn: 6 }
const ar12: FormatPrefs = { tag: 'ar-EG', locale: arEG, hourCycle: '12h', weekStartsOn: 6 }

const base = new Date(2026, 9, 27)

describe('formatTypedDate', () => {
  const day = new Date(2026, 2, 13)
  it.each([
    ['de', de24, '13.3.2026'],
    ['us', us, '3/13/2026'],
    ['gb', gb, '13/03/2026'],
    ['sv', sv24, '2026-03-13'],
  ])('shows the numbers in the order of %s', (_, p, want) => {
    expect(formatTypedDate(day, p)).toBe(want)
  })

  it('writes Latin digits and the Gregorian year where the locale does not', () => {
    const text = formatTypedDate(day, fa24)
    expect(text).toMatch(/^[\d/. -]+$/)
    expect(text).toContain('2026')
  })

  it('writes Latin digits in Arabic, apart from the marks that keep the order', () => {
    const text = formatTypedDate(day, ar12)
    expect(text.replace(/[\u200e\u200f\u061c]/g, '')).toBe('13/3/2026')
  })
})

describe('dateExample', () => {
  it.each([
    ['de', de24, '28.10.2026'],
    ['us', us, '10/28/2026'],
    ['gb', gb, '28/10/2026'],
  ])('is the date as the field shows it, %s', (_, p, want) => {
    expect(dateExample(p, new Date(2026, 9, 28))).toBe(want)
  })

  it('is a date the reader reads', () => {
    const now = new Date(2026, 9, 28)
    for (const p of [de24, us, gb, sv24, ko12, fa24]) {
      expect(readDate(dateExample(p, now), { prefs: p, base })).toBe('2026-10-28')
    }
  })
})

describe('readDate in the order of the locale', () => {
  it.each([
    ['de, full', de24, '28.10.2026', '2026-10-28'],
    ['de, two-digit year', de24, '28.10.26', '2026-10-28'],
    ['de, trailing dot', de24, '28.10.', '2026-10-28'],
    ['de, day and month', de24, '28.10', '2026-10-28'],
    ['de, day', de24, '28', '2026-10-28'],
    ['de, four digits', de24, '2810', '2026-10-28'],
    ['de, six digits', de24, '281026', '2026-10-28'],
    ['de, eight digits', de24, '28102026', '2026-10-28'],
    ['de, dashes', de24, '28-10-2026', '2026-10-28'],
    ['de, slashes', de24, '28/10/2026', '2026-10-28'],
    ['de, spaces around the separators', de24, ' 28. 10. 2026 ', '2026-10-28'],
    ['de, spaces as separators', de24, '28 10 2026', '2026-10-28'],
    ['de, a trailing separator after the year', de24, '28.10.2026.', '2026-10-28'],
    ['de, day and month without zeros', de24, '1.1.', '2026-01-01'],
    ['de, a day below ten', de24, '5', '2026-10-05'],
    ['de, with zeros', de24, '05.03.2026', '2026-03-05'],
    ['de, a four-digit year is taken as typed', de24, '01.01.2126', '2126-01-01'],
    ['de, a leap day', de24, '29.02.2028', '2028-02-29'],
    ['us, month and day', us, '10/28', '2026-10-28'],
    ['us, four digits', us, '1028', '2026-10-28'],
    ['us, two-digit year', us, '10/28/26', '2026-10-28'],
    ['us, eight digits', us, '10282026', '2026-10-28'],
    ['us, the day alone', us, '28', '2026-10-28'],
    ['gb, full', gb, '28/10/2026', '2026-10-28'],
    ['gb, four digits', gb, '2810', '2026-10-28'],
    ['sv, full', sv24, '2026-10-28', '2026-10-28'],
    ['sv, eight digits', sv24, '20261028', '2026-10-28'],
    ['sv, month and day', sv24, '10-28', '2026-10-28'],
    ['sv, six digits', sv24, '261028', '2026-10-28'],
    ['sv, four digits', sv24, '1028', '2026-10-28'],
    ['sv, two-digit year', sv24, '26-10-28', '2026-10-28'],
    ['sv, the day alone', sv24, '28', '2026-10-28'],
    ['ko, as it shows the date', ko12, '2026. 10. 28.', '2026-10-28'],
    ['ko, without spaces', ko12, '2026.10.28', '2026-10-28'],
    ['cs, as it shows the date', cs24, '28. 10. 2026', '2026-10-28'],
    ['ja, slashes', ja24, '2026/10/28', '2026-10-28'],
    ['hu, as it shows the date', hu24, '2026. 10. 28.', '2026-10-28'],
    ['nl, dashes', nl24, '28-10-2026', '2026-10-28'],
    ['hr, a separator after the year', hr24, '28. 10. 2026.', '2026-10-28'],
    ['lv, a separator after the year', lv24, '28.10.2026.', '2026-10-28'],
    ['bg, its word for the year', bg24, '28.10.2026 \u0433.', '2026-10-28'],
    ['bg, without it', bg24, '28.10.2026', '2026-10-28'],
    ['bg, its word in capitals', bg24, '28.10.2026 \u0413.', '2026-10-28'],
    ['ug, the day before the month', ug24, '2026-28-10', '2026-10-28'],
    ['ug, four digits', ug24, '2810', '2026-10-28'],
    ['ug, eight digits', ug24, '20262810', '2026-10-28'],
    ['de, full-width', de24, '２８．１０．２０２６', '2026-10-28'],
    ['ar, its own digits, as it writes them', ar12, '٢٨\u200f/١٠\u200f/٢٠٢٦', '2026-10-28'],
    ['ar, its own digits', ar12, '٢٨/١٠/٢٠٢٦', '2026-10-28'],
    ['fa, its own digits', fa24, '۲۰۲۶/۱۰/۲۸', '2026-10-28'],
    ['fa, the day in its own digits', fa24, '۲۸', '2026-10-28'],
  ])('%s', (_, p, text, want) => {
    expect(readDate(text, { prefs: p, base })).toBe(want)
  })

  it('reads the marks that keep the order in a right-to-left date', () => {
    expect(readDate('28\u200f/10\u200f/2026', { prefs: ar12, base })).toBe('2026-10-28')
    expect(readDate('28/10/2026', { prefs: ar12, base })).toBe('2026-10-28')
  })

  it('does not take the word of another locale for the year', () => {
    expect(readDate('28.10.2026 \u0433.', { prefs: de24, base })).toBeNull()
  })

  it('reads the format of the locale, not of another one', () => {
    expect(readDate('10/28/2026', { prefs: de24, base })).toBeNull()
    expect(readDate('28/10/2026', { prefs: us, base })).toBeNull()
  })
})

describe('readDate', () => {
  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['a day that month does not have', '31.02.'],
    ['a month that does not exist', '28.13.'],
    ['month zero', '28.0.'],
    ['day zero', '0.10.'],
    ['day zero, digits only', '0010'],
    ['a day above 31', '32.10.'],
    ['three digits', '123'],
    ['five digits', '12345'],
    ['seven digits', '1234567'],
    ['nine digits', '281020261'],
    ['a word', 'morgen'],
    ['four parts', '28.10.2026.1'],
    ['an empty part in the middle', '28..2026'],
    ['two trailing separators', '28.10..'],
    ['a leading separator', '.28.10.'],
    ['letters among the digits', '28.1o.2026'],
    ['a one-digit year', '28.10.6'],
    ['a three-digit year', '28.10.202'],
    ['a five-digit year', '28.10.20266'],
    ['a year before 1000', '28.10.0026'],
    ['a three-digit day', '028.10.'],
    ['a leap day in a common year', '29.02.2027'],
    ['a leap day by the two-digit year', '29.02.27'],
    ['a sign', '-28.10.'],
    ['a time', '28.10. 14:30'],
  ])('reads %s as nothing', (_, text) => {
    expect(readDate(text, { prefs: de24, base })).toBeNull()
  })

  it('reads nothing in us from a day above 12 in the month place', () => {
    expect(readDate('28/10', { prefs: us, base })).toBeNull()
    expect(readDate('2810', { prefs: us, base })).toBeNull()
  })

  it('reads nothing in sv from a date that is not one', () => {
    expect(readDate('2026-02-30', { prefs: sv24, base })).toBeNull()
    expect(readDate('20261301', { prefs: sv24, base })).toBeNull()
  })

  it('takes the missing parts from base', () => {
    const feb = new Date(2027, 1, 15)
    expect(readDate('28', { prefs: de24, base: feb })).toBe('2027-02-28')
    expect(readDate('30', { prefs: de24, base: feb })).toBeNull()
    expect(readDate('28.3.', { prefs: de24, base: feb })).toBe('2027-03-28')
    expect(readDate('29.2.', { prefs: de24, base: feb })).toBeNull()
    expect(readDate('29.2.', { prefs: de24, base: new Date(2028, 0, 1) })).toBe('2028-02-29')
    expect(readDate('1028', { prefs: us, base: feb })).toBe('2027-10-28')
    expect(readDate('10-28', { prefs: sv24, base: feb })).toBe('2027-10-28')
  })

  it('does not guess the next 28 October', () => {
    expect(readDate('28.10.', { prefs: de24, base: new Date(2026, 11, 31) })).toBe('2026-10-28')
  })

  it('reads a base at the end of the year', () => {
    expect(readDate('5', { prefs: de24, base: new Date(2026, 11, 31, 23, 59) })).toBe('2026-12-05')
  })

  it('reads a two-digit year as 20yy', () => {
    expect(readDate('1.1.00', { prefs: de24, base })).toBe('2000-01-01')
    expect(readDate('1.1.99', { prefs: de24, base })).toBe('2099-01-01')
  })
})

describe('readDate reads back what the field shows', () => {
  const days = [new Date(2026, 0, 1), new Date(2028, 1, 29), new Date(2026, 11, 31)]
  it.each([
    ['de', de24],
    ['us', us],
    ['gb', gb],
    ['sv', sv24],
    ['ko', ko12],
    ['fa', fa24],
    ['ja', ja24],
    ['cs', cs24],
    ['hu', hu24],
    ['nl', nl24],
    ['hr', hr24],
    ['lv', lv24],
    ['bg', bg24],
    ['ug', ug24],
    ['ar', ar12],
  ])('%s', (_, p) => {
    for (const d of days) {
      expect(readDate(formatTypedDate(d, p), { prefs: p, base }), `${dayKey(d)} shown as ${formatTypedDate(d, p)}`).toBe(
        dayKey(d),
      )
    }
  })

  it('reads ko back, as the one the brief names', () => {
    expect(readDate(formatTypedDate(new Date(2026, 9, 28), ko12), { prefs: ko12, base })).toBe('2026-10-28')
  })
})
