import { de } from 'date-fns/locale/de'
import { enGB } from 'date-fns/locale/en-GB'
import { enUS } from 'date-fns/locale/en-US'
import { describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import { toCalTask } from './calendarTasks'
import { visibleRange } from './dates'
import { toCalEvent } from './events'
import {
  formatClock,
  formatDuration,
  formatEventSpan,
  formatEventWhen,
  formatHour,
  formatInZones,
  formatLoadedAt,
  formatMonthDay,
  formatOwnZones,
  formatPeriodTitle,
  formatPickerDate,
  formatShortTime,
  formatTime,
  inYourZone,
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
  it('formats a time of day as entered, in the hour cycle', () => {
    expect(formatClock('14:05', us)).toBe('2:05 PM')
    expect(formatClock('14:05', deDE)).toBe('14:05')
    // A time some days don't have still formats.
    expect(formatClock('02:30', us)).toBe('2:30 AM')
  })

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

describe('formatInZones', () => {
  const us24: FormatPrefs = { ...us, hourCycle: '24h' }
  const now = new Date(2026, 9, 28)
  const berlin = 'Europe/Berlin'
  const ny = 'America/New_York'

  it('names the zone after each time where the zones differ, the date once where both lie on it', () => {
    // Berlin is on CET (UTC+1) from 25 October, New York on EDT (UTC-4) until 1 November.
    expect(
      formatInZones(
        [
          { at: new Date('2026-10-28T09:00:00Z'), zone: berlin },
          { at: new Date('2026-10-28T17:00:00Z'), zone: ny },
        ],
        us24,
        now,
      ),
    ).toBe('Wed, Oct 28, 10:00 Berlin\u00a0– 13:00 New York')
  })

  it('names a shared zone once, at the end', () => {
    expect(
      formatInZones(
        [
          { at: new Date('2026-11-10T23:00:00Z'), zone: ny },
          { at: new Date('2026-11-11T00:00:00Z'), zone: ny },
        ],
        us24,
        now,
      ),
    ).toBe('Tue, Nov 10, 18:00\u00a0– 19:00 New York')
  })

  it('treats two names of one zone as a shared zone', () => {
    expect(
      formatInZones(
        [
          { at: new Date('2026-10-28T09:00:00Z'), zone: 'Etc/UTC' },
          { at: new Date('2026-10-28T10:00:00Z'), zone: 'UTC' },
        ],
        us24,
        now,
      ),
    ).toBe('Wed, Oct 28, 09:00\u00a0– 10:00 UTC')
  })

  it('names the zone of a single time', () => {
    expect(formatInZones([{ at: new Date('2026-10-27T22:00:00Z'), zone: ny }], us24, now)).toBe(
      'Tue, Oct 27, 18:00 New York',
    )
  })

  it('repeats the date where the second time lies on another one in its zone', () => {
    expect(
      formatInZones(
        [
          { at: new Date('2026-10-27T22:00:00Z'), zone: ny },
          { at: new Date('2026-10-28T05:00:00Z'), zone: ny },
        ],
        us24,
        now,
      ),
    ).toBe('Tue, Oct 27, 18:00\u00a0– Wed, Oct 28, 01:00 New York')
    // Half past midnight in Berlin is still the evening before in New York: each date is the one in its own zone.
    expect(
      formatInZones(
        [
          { at: new Date('2026-10-27T23:30:00Z'), zone: berlin },
          { at: new Date('2026-10-28T03:00:00Z'), zone: ny },
        ],
        us24,
        now,
      ),
    ).toBe('Wed, Oct 28, 00:30 Berlin\u00a0– Tue, Oct 27, 23:00 New York')
  })

  it('adds the year of a time in its zone where it is not the current one, to every date, as a range does', () => {
    // 03:00Z on 1 January 2027 is the evening of 31 December in New York, already the new year in Berlin.
    const at = new Date('2027-01-01T03:00:00Z')
    expect(formatInZones([{ at, zone: ny }], us24, now)).toBe('Thu, Dec 31, 22:00 New York')
    expect(formatInZones([{ at, zone: berlin }], us24, now)).toBe('Fri, Jan 1, 2027, 04:00 Berlin')
    const later = new Date('2027-01-01T05:00:00Z')
    expect(
      formatInZones(
        [
          { at, zone: ny },
          { at: later, zone: ny },
        ],
        us24,
        now,
      ),
    ).toBe('Thu, Dec 31, 2026, 22:00\u00a0– Fri, Jan 1, 2027, 00:00 New York')
  })

  it('formats in the hour cycle and the language', () => {
    const parts = [
      { at: new Date('2026-10-28T09:00:00Z'), zone: berlin },
      { at: new Date('2026-10-28T17:00:00Z'), zone: ny },
    ]
    expect(formatInZones(parts, us, now)).toMatch(/^Wed, Oct 28, 10:00\sAM Berlin\u00a0– 1:00\sPM New York$/)
    expect(formatInZones(parts, deDE, now)).toBe('Mi., 28. Okt., 10:00 Berlin\u00a0– 13:00 New York')
  })

  // As the range of formatEventWhen says equal ends once.
  it('says a time once where the start and the end are one instant in one zone', () => {
    const at = new Date('2026-10-27T13:00:00Z')
    const once = [
      { at, zone: ny },
      { at, zone: ny },
    ]
    expect(formatInZones(once, us, now)).toMatch(/^Tue, Oct 27, 9:00\sAM New York$/)
    // In two zones, each is named.
    expect(
      formatInZones(
        [
          { at, zone: ny },
          { at, zone: berlin },
        ],
        us24,
        now,
      ),
    ).toBe('Tue, Oct 27, 09:00 New York\u00a0– 14:00 Berlin')
  })

  it('says nothing without a time', () => {
    expect(formatInZones([], us24, now)).toBe('')
  })
})

describe('formatOwnZones', () => {
  const us24: FormatPrefs = { ...us, hourCycle: '24h' }
  const now = new Date(2026, 9, 28)
  const berlin = 'Europe/Berlin'
  const ny = 'America/New_York'
  const start = new Date('2026-10-28T09:00:00Z')
  const end = new Date('2026-10-28T17:00:00Z')

  it("names the times in the zones of an item where one is other than the browser's", () => {
    expect(
      formatOwnZones(
        [
          { at: start, zone: berlin },
          { at: end, zone: ny },
        ],
        berlin,
        us24,
        now,
      ),
    ).toBe('Wed, Oct 28, 10:00 Berlin\u00a0– 13:00 New York')
    expect(
      formatOwnZones(
        [
          { at: start, zone: ny },
          { at: end, zone: ny },
        ],
        berlin,
        us24,
        now,
      ),
    ).toBe('Wed, Oct 28, 05:00\u00a0– 13:00 New York')
  })

  it("puts a time without a zone, or in one Intl does not know, in the browser's", () => {
    const parts = (zone: string) => [
      { at: start, zone },
      { at: end, zone: ny },
    ]
    expect(formatOwnZones(parts(''), berlin, us24, now)).toBe('Wed, Oct 28, 10:00 Berlin\u00a0– 13:00 New York')
    expect(formatOwnZones(parts('W. Europe Standard Time'), berlin, us24, now)).toBe(
      'Wed, Oct 28, 10:00 Berlin\u00a0– 13:00 New York',
    )
  })

  it.each([
    ['no zone', ['', ''], berlin],
    ["the browser's", [berlin, berlin], berlin],
    ["the browser's under another name", ['Asia/Calcutta', 'Asia/Kolkata'], 'Asia/Kolkata'],
    ['one Intl does not know', ['Mars/Olympus', ''], berlin],
    ['no time', [], berlin],
  ])('says nothing while every time is in %s', (_, zones, browserZone) => {
    const parts = zones.map((zone, i) => ({ at: i === 0 ? start : end, zone }))
    expect(formatOwnZones(parts, browserZone, us24, now)).toBeNull()
  })
})

describe('inYourZone', () => {
  const gb: FormatPrefs = { tag: 'en-GB', locale: enGB, hourCycle: '24h', weekStartsOn: 1 }
  const en = i18n.getFixedT('en')
  const now = new Date(2026, 9, 28)
  const berlin = 'Europe/Berlin'
  const ny = 'America/New_York'
  // 18:00 to 23:00 in New York on Tuesday, 27 October 2026: 23:00 to 04:00 the next day in Berlin.
  const start = new Date('2026-10-27T22:00:00Z')
  const end = new Date('2026-10-28T03:00:00Z')
  /** Whitespace a line can break at before the dash, or between a number and a word beside it. */
  const breaks = /[ \u2009]–|\d\.? (?=\p{L})|\p{L}\.? (?=\d)/u

  it('says where an item in another zone lies here, a day keeping its month, a time its "PM" and the dash its first time', () => {
    const text = inYourZone(en, us, now, { zones: [ny, ny], browserZone: berlin, start, end })
    expect(text).toBe('In your time zone (Berlin): Tue, Oct\u00a027, 11:00\u202fPM\u202f–\u2009Wed, Oct\u00a028, 4:00\u202fAM')
    expect(text).not.toMatch(breaks)
  })

  it('says one time where the item has one, such as a task due then', () => {
    // Intl separates "PM" by a plain space here, as browsers do in ranges too.
    expect(inYourZone(en, us, now, { zones: [ny], browserZone: berlin, start, end: start })).toBe(
      'In your time zone (Berlin): Tue, Oct\u00a027, 11:00\u00a0PM',
    )
  })

  it.each([
    ['en-GB', gb, en, 'In your time zone (Berlin): Tue\u00a027\u00a0Oct, 23:00\u202f–\u2009Wed\u00a028\u00a0Oct, 04:00'],
    ['de', deDE, i18n.getFixedT('de'), 'In deiner Zeitzone (Berlin): Di., 27.\u00a0Okt., 23:00\u202f–\u2009Mi., 28.\u00a0Okt., 04:00'],
  ])('keeps a day with its month and weekday in %s', (_, prefs, t, want) => {
    const text = inYourZone(t, prefs, now, { zones: [ny, ny], browserZone: berlin, start, end })
    expect(text).toBe(want)
    expect(text).not.toMatch(breaks)
  })

  it("names the browser's zone, and its times", () => {
    expect(inYourZone(en, us, now, { zones: [berlin, berlin], browserZone: ny, start, end: start })).toBe(
      'In your time zone (New York): Tue, Oct\u00a027, 6:00\u00a0PM',
    )
  })

  it('says it while one row is in another zone', () => {
    expect(inYourZone(en, us, now, { zones: ['', ny], browserZone: berlin, start, end })).not.toBeNull()
  })

  it.each([
    ['without a zone', ['', ''], berlin],
    ["in the browser's", [berlin, ''], berlin],
    ["in the browser's under another name", ['Asia/Calcutta'], 'Asia/Kolkata'],
    ["in one Intl does not know, whose fields are the browser's", ['Mars/Olympus'], berlin],
    ['none, without rows', [], berlin],
  ])('says nothing while every row is %s', (_, zones, browserZone) => {
    expect(inYourZone(en, us, now, { zones, browserZone, start, end })).toBeNull()
  })

  it('says nothing for an end before the start, which the form refuses', () => {
    expect(inYourZone(en, us, now, { zones: [ny], browserZone: berlin, start: end, end: start })).toBeNull()
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
