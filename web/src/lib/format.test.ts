import { de } from 'date-fns/locale/de'
import { enUS } from 'date-fns/locale/en-US'
import { describe, expect, it } from 'vitest'
import { visibleRange } from './dates'
import { toCalEvent } from './events'
import {
  formatEventSpan,
  formatHour,
  formatPeriodTitle,
  formatShortTime,
  formatTime,
  loadDateLocale,
  localeKey,
  timePattern,
  weekdayNames,
  type FormatPrefs,
} from './format'
import { apiEvent } from '@/test/fixtures'

const us: FormatPrefs = { tag: 'en-US', locale: enUS, hourCycle: '12h', weekStartsOn: 0 }
const deDE: FormatPrefs = { tag: 'de-DE', locale: de, hourCycle: '24h', weekStartsOn: 1 }

describe('locale loading', () => {
  it.each([
    ['en-US', null],
    ['en', null],
    ['en-GB', 'en-gb'],
    ['de-DE', 'de'],
    ['de-AT', 'de-at'],
    ['de_CH', 'de'],
    ['zh-Hant-TW', 'zh-tw'],
    ['zh', 'zh-cn'],
    ['no', 'nb'],
    ['xx', null],
  ])('localeKey(%s) = %s', (tag, key) => {
    expect(localeKey(tag)).toBe(key)
  })

  it('loads locales lazily with en-US fallback', async () => {
    expect((await loadDateLocale('de-DE')).code).toBe('de')
    expect((await loadDateLocale('fr-CA')).code).toBe('fr-CA')
    expect((await loadDateLocale('xx-YY')).code).toBe('en-US')
  })
})

describe('time formats', () => {
  const d = new Date(2026, 8, 25, 14, 5)
  it('honours the hour cycle', () => {
    expect(timePattern('12h')).toBe('h:mm a')
    expect(formatTime(d, us)).toBe('2:05 PM')
    expect(formatTime(d, deDE)).toBe('14:05')
    expect(formatShortTime(new Date(2026, 8, 25, 9), us)).toBe('9 AM')
    expect(formatShortTime(d, us)).toBe('2:05 PM')
    expect(formatShortTime(d, deDE)).toBe('14:05')
    expect(formatHour(13, us)).toBe('1 PM')
    expect(formatHour(13, deDE)).toBe('13:00')
  })
})

describe('period titles', () => {
  const date = new Date(2026, 8, 25)
  it('formats each view', () => {
    expect(formatPeriodTitle('month', date, visibleRange('month', date, 0), us)).toBe('September 2026')
    expect(formatPeriodTitle('month', date, visibleRange('month', date, 1), deDE)).toBe('September 2026')
    expect(formatPeriodTitle('day', date, visibleRange('day', date, 0), us)).toBe('Friday, September 25th, 2026')
    expect(formatPeriodTitle('week', date, visibleRange('week', date, 0), us)).toMatch(/Sep 20\s*–\s*26, 2026/)
    expect(formatPeriodTitle('agenda', date, visibleRange('agenda', date, 1), deDE)).toContain('2026')
  })
})

describe('event spans', () => {
  it('formats all-day, timed and multi-day events', () => {
    const allDay = toCalEvent(apiEvent({ allDay: true, start: '2026-09-25T00:00:00Z', end: '2026-09-26T00:00:00Z' }))
    expect(formatEventSpan(allDay, us, 'All day')).toBe('September 25th, 2026, All day')
    const multi = toCalEvent(apiEvent({ allDay: true, start: '2026-09-25T00:00:00Z', end: '2026-09-28T00:00:00Z' }))
    expect(formatEventSpan(multi, us, 'All day')).toMatch(/Sep 25\s*–\s*27, 2026/)
    const timed = toCalEvent(apiEvent())
    expect(formatEventSpan(timed, deDE, 'Ganztägig')).toBe('25. September 2026, 10:00 – 11:00')
    const overnight = toCalEvent(apiEvent({ start: '2026-09-25T20:00:00Z', end: '2026-09-26T06:00:00Z' }))
    expect(formatEventSpan(overnight, us, 'All day')).toBe('Sep 25, 2026, 10:00 PM – Sep 26, 2026, 8:00 AM')
  })
})

describe('weekdayNames', () => {
  it('starts on the configured day', () => {
    expect(weekdayNames(us)).toEqual(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'])
    expect(weekdayNames(deDE, 'narrow')).toEqual(['M', 'D', 'M', 'D', 'F', 'S', 'S'])
    expect(weekdayNames({ ...us, weekStartsOn: 6 })[0]).toBe('Sat')
  })
})

describe('all bundled date-fns locales load', () => {
  it.each([
    ['en-GB', 'en-GB'],
    ['en-AU', 'en-AU'],
    ['en-CA', 'en-CA'],
    ['en-IE', 'en-IE'],
    ['en-IN', 'en-IN'],
    ['en-NZ', 'en-NZ'],
    ['de', 'de'],
    ['de-AT', 'de-AT'],
    ['fr', 'fr'],
    ['fr-CA', 'fr-CA'],
    ['fr-CH', 'fr-CH'],
    ['es', 'es'],
    ['it', 'it'],
    ['nl', 'nl'],
    ['pt', 'pt'],
    ['pt-BR', 'pt-BR'],
    ['pl', 'pl'],
    ['cs', 'cs'],
    ['sv', 'sv'],
    ['da', 'da'],
    ['nb', 'nb'],
    ['fi', 'fi'],
    ['ru', 'ru'],
    ['uk', 'uk'],
    ['tr', 'tr'],
    ['ja', 'ja'],
    ['ko', 'ko'],
    ['zh-CN', 'zh-CN'],
    ['zh-TW', 'zh-TW'],
  ])('%s', async (tag, code) => {
    expect((await loadDateLocale(tag)).code).toBe(code)
  })
})
