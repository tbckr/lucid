import { de } from 'date-fns/locale/de'
import { enUS } from 'date-fns/locale/en-US'
import { describe, expect, it } from 'vitest'
import { toCalTask } from './calendarTasks'
import { visibleRange } from './dates'
import { toCalEvent } from './events'
import {
  formatDuration,
  formatEventSpan,
  formatEventWhen,
  formatHour,
  formatLoadedAt,
  formatMonthDay,
  formatPeriodTitle,
  formatPickerDate,
  formatShortTime,
  formatTime,
  loadDateLocale,
  localeKey,
  timePattern,
  weekdayNames,
  type FormatPrefs,
} from './format'
import { apiEvent, todo } from '@/test/fixtures'

const us: FormatPrefs = { tag: 'en-US', locale: enUS, hourCycle: '12h', weekStartsOn: 0 }
const deDE: FormatPrefs = { tag: 'de-DE', locale: de, hourCycle: '24h', weekStartsOn: 1 }

describe('formatLoadedAt', () => {
  const now = new Date(2026, 2, 11, 9, 0)
  it.each([
    ['today, the time only', new Date(2026, 2, 11, 8, 32), us, '8:32 AM'],
    ['another day, with its date', new Date(2026, 2, 10, 14, 32), us, 'Tue, Mar 10, 2:32 PM'],
    ['in German', new Date(2026, 2, 10, 14, 32), deDE, 'Di., 10. März, 14:32'],
  ])('%s', (_, at, p, want) => {
    expect(formatLoadedAt(at, p, now)).toBe(want)
  })
})

describe('formatDuration', () => {
  it.each([
    [{ minutes: 0 }, '0 min', '0 Min.'],
    [{ minutes: 45 }, '45 min', '45 Min.'],
    [{ minutes: 60 }, '1 hr', '1 Std.'],
    [{ minutes: 90 }, '1 hr 30 min', '1 Std., 30 Min.'],
    [{ minutes: 26 * 60 }, '1 day 2 hr', '1 Tag, 2 Std.'],
    [{ days: 1 }, '1 day', '1 Tag'],
    [{ days: 3 }, '3 days', '3 Tage'],
  ])('%o', (duration, en, german) => {
    expect(formatDuration(duration, us)).toBe(en)
    expect(formatDuration(duration, deDE)).toBe(german)
  })
})

describe('date labels', () => {
  const now = new Date(2026, 2, 11, 10)

  it('names weekday, day and month, with the year only when it differs', () => {
    expect(formatPickerDate(new Date(2026, 2, 11), us, now)).toBe('Wed, Mar 11')
    expect(formatPickerDate(new Date(2026, 2, 11), deDE, now)).toBe('Mi., 11. März')
    expect(formatPickerDate(new Date(2027, 0, 4), us, now)).toBe('Mon, Jan 4, 2027')
  })

  it('names the day of the year for yearly repeats', () => {
    expect(formatMonthDay(new Date(2026, 2, 11), us)).toBe('March 11')
    expect(formatMonthDay(new Date(2026, 2, 11), deDE)).toBe('11. März')
  })
})

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

  it('formats a task at one point in time as that time alone', () => {
    const point = toCalTask(todo({ due: '2026-09-25T08:00:00Z' }))!
    expect(formatEventSpan(point, deDE, 'Ganztägig')).toBe('25. September 2026, 10:00')
    const span = toCalTask(todo({ start: '2026-09-25T08:00:00Z', due: '2026-09-25T09:00:00Z' }))!
    expect(formatEventSpan(span, deDE, 'Ganztägig')).toBe('25. September 2026, 10:00 – 11:00')
  })
})

describe('formatEventWhen', () => {
  // Intl puts thin spaces around the dash and a narrow no-break space before AM/PM.
  const now = new Date(2026, 2, 11)
  const timed = toCalEvent(apiEvent({ start: '2026-03-13T13:00:00Z', end: '2026-03-13T15:00:00Z' }))

  it('names the day and the times in one range', () => {
    expect(formatEventWhen(timed, us, now)).toBe('Fri, Mar 13, 2:00\u2009–\u20094:00\u202fPM')
    expect(formatEventWhen(timed, { ...us, hourCycle: '24h' }, now)).toBe('Fri, Mar 13, 14:00\u2009–\u200916:00')
    expect(formatEventWhen(timed, deDE, now)).toBe('Fr., 13. März, 14:00–16:00 Uhr')
  })

  it('repeats the day when a timed event ends on another', () => {
    const overnight = toCalEvent(apiEvent({ start: '2026-03-13T21:00:00Z', end: '2026-03-14T01:00:00Z' }))
    expect(formatEventWhen(overnight, us, now)).toBe('Fri, Mar 13, 10:00\u202fPM\u2009–\u2009Sat, Mar 14, 2:00\u202fAM')
  })

  it('shows only the days of all-day events', () => {
    const one = toCalEvent(apiEvent({ allDay: true, start: '2026-03-14T00:00:00Z', end: '2026-03-15T00:00:00Z' }))
    expect(formatEventWhen(one, us, now)).toBe('Sat, Mar 14')
    const two = toCalEvent(apiEvent({ allDay: true, start: '2026-03-09T00:00:00Z', end: '2026-03-11T00:00:00Z' }))
    expect(formatEventWhen(two, us, now)).toBe('Mon, Mar 9\u2009–\u2009Tue, Mar 10')
  })

  it('adds the year outside the current one', () => {
    const next = toCalEvent(apiEvent({ allDay: true, start: '2027-01-04T00:00:00Z', end: '2027-01-05T00:00:00Z' }))
    expect(formatEventWhen(next, us, now)).toBe('Mon, Jan 4, 2027')
    const newYear = toCalEvent(apiEvent({ allDay: true, start: '2026-12-31T00:00:00Z', end: '2027-01-02T00:00:00Z' }))
    expect(formatEventWhen(newYear, us, now)).toBe('Thu, Dec 31, 2026\u2009–\u2009Fri, Jan 1, 2027')
  })

  it('formats in another time zone', () => {
    // New York is on EDT (UTC-4) from March 8, 2026.
    expect(formatEventWhen(timed, us, now, 'America/New_York')).toBe('Fri, Mar 13, 9:00\u2009–\u200911:00\u202fAM')
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
