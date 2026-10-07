/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { moveAllRefusal, seriesShift } from './seriesShift'

/** One row of the shared case table (FR-17), also read by the Go test. */
interface SeriesShiftCase {
  name: string
  rule: string
  from: string
  to: string
  want: string | null
}

// Indirected through a variable: written inline, Vite's import-analysis
// plugin statically rewrites `new URL('...', import.meta.url)` into a dev-
// server asset URL (relative to `self.location`, not the file system),
// which breaks under jsdom (`self.location` is `http://...`, not `file://`).
const moduleUrl = import.meta.url
const casesUrl = new URL('../../../internal/caldav/testdata/series-shift.json', moduleUrl)
const cases = JSON.parse(readFileSync(casesUrl, 'utf-8')) as SeriesShiftCase[]

describe('seriesShift', () => {
  it.each(cases)('$name', ({ rule, from, to, want }) => {
    expect(seriesShift(rule, from, to)).toBe(want)
  })

  // Not in the shared table: Go's rulePart normalizes part names but not
  // values, so a non-upper-case FREQ falls through weeklySimpleByDay to
  // case 3 (internal/caldav/seriesshift.go:110) — matched here exactly,
  // rather than fixed, so the browser and server agree.
  it('matches Go case-sensitively for a non-upper-case FREQ', () => {
    expect(seriesShift('freq=weekly;byday=mo', '2026-03-09T09:00', '2026-03-10T09:00')).toBe(null)
  })
})

// Whether the series can follow at all (`null`), judged on the right day and time.
describe('moveAllRefusal: the wall clock it judges', () => {
  it('follows a weekday move in Berlin', () => {
    const event = {
      rrule: 'FREQ=WEEKLY;BYDAY=MO',
      allDay: false,
      timezone: '',
      start: '2026-03-09T08:00:00Z',
      startsAt: new Date('2026-03-09T09:00:00+01:00'), // Monday, CET
    }
    const newStart = new Date('2026-03-10T09:00:00+01:00') // Tuesday, CET
    expect(moveAllRefusal(event, newStart, 'Europe/Berlin')).toBeNull()
  })

  it('rejects a day move but allows a time-only move for BYMONTHDAY', () => {
    const event = {
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=15',
      allDay: false,
      timezone: '',
      start: '2026-03-15T08:00:00Z',
      startsAt: new Date('2026-03-15T09:00:00+01:00'),
    }
    const nextDay = new Date('2026-03-16T09:00:00+01:00')
    expect(moveAllRefusal(event, nextDay, 'Europe/Berlin')).toBe('fixedDays')

    const sameDayLater = new Date('2026-03-15T11:00:00+01:00')
    expect(moveAllRefusal(event, sameDayLater, 'Europe/Berlin')).toBeNull()
  })

  it('judges the day in the event zone, not the browser zone', () => {
    const event = {
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=9',
      allDay: false,
      timezone: 'America/New_York',
      start: '2026-03-09T21:00:00Z',
      startsAt: new Date('2026-03-09T21:00:00Z'), // 17:00 EDT, Monday
    }
    // 23:30Z is 00:30 Tuesday in Berlin, but 19:30 Monday in New York.
    const newStart = new Date('2026-03-09T23:30:00Z')
    expect(moveAllRefusal(event, newStart, 'Europe/Berlin')).toBeNull()
  })

  it('derives all-day wall clocks from the UTC calendar date', () => {
    const event = {
      rrule: 'FREQ=WEEKLY;BYDAY=MO',
      allDay: true,
      timezone: '',
      start: '2026-03-09T00:00:00Z', // Monday
      startsAt: new Date(2026, 2, 9),
    }
    const newStart = new Date('2026-03-10T00:00:00Z') // Tuesday
    expect(moveAllRefusal(event, newStart, 'Europe/Berlin')).toBeNull()
  })

  // FR-17: all-day events are date-only on the wire (UTC midnight). Reading
  // their day through the environment's local getters, as the old
  // implementation did, shifts it west of UTC: an unchanged series looked
  // moved by a day in America/New_York even though nothing changed.
  it('judges an unchanged all-day series the same regardless of the local time zone', () => {
    const originalTz = process.env.TZ
    process.env.TZ = 'America/New_York'
    try {
      const event = {
        rrule: 'FREQ=MONTHLY;BYMONTHDAY=25',
        allDay: true,
        timezone: '',
        start: '2026-09-25T00:00:00Z',
        startsAt: new Date(2026, 8, 25),
      }
      expect(moveAllRefusal(event, new Date('2026-09-25T00:00:00Z'), 'Europe/Berlin')).toBeNull()
      expect(moveAllRefusal(event, new Date('2026-09-26T00:00:00Z'), 'Europe/Berlin')).toBe('fixedDays')
    } finally {
      process.env.TZ = originalTz
    }
  })
})

describe('moveAllRefusal', () => {
  /** A timed Berlin series whose shown occurrence starts at `startsAt`. */
  function series(rrule: string, startsAt: string) {
    return { rrule, allDay: false, timezone: '', start: new Date(startsAt).toISOString(), startsAt: new Date(startsAt) }
  }

  it('allows a move the series can follow', () => {
    const event = series('FREQ=WEEKLY;BYDAY=MO', '2026-03-09T09:00:00+01:00') // Monday
    const tuesday = new Date('2026-03-10T09:00:00+01:00')
    expect(moveAllRefusal(event, tuesday, 'Europe/Berlin')).toBeNull()
  })

  it('refuses another day of a monthly series on fixed days', () => {
    const event = series('FREQ=MONTHLY;BYMONTHDAY=15', '2026-03-15T09:00:00+01:00')
    const nextDay = new Date('2026-03-16T09:00:00+01:00')
    expect(moveAllRefusal(event, nextDay, 'Europe/Berlin')).toBe('fixedDays')
  })

  it('refuses another time when the rule fixes the hour', () => {
    const event = series('FREQ=DAILY;BYHOUR=9', '2026-03-09T09:00:00+01:00')
    const later = new Date('2026-03-09T10:00:00+01:00')
    expect(moveAllRefusal(event, later, 'Europe/Berlin')).toBe('fixedTimes')
  })

  it('refuses another day even when the rule fixes the hour', () => {
    // BYHOUR is another BY part: no rotation, so Monday -> Wednesday is refused.
    const event = series('FREQ=WEEKLY;BYDAY=MO;BYHOUR=9', '2026-03-09T09:00:00+01:00')
    const wednesday = new Date('2026-03-11T09:00:00+01:00')
    expect(moveAllRefusal(event, wednesday, 'Europe/Berlin')).toBe('fixedDays')
  })

  it('blames the time when only the time keeps the series from following', () => {
    // Every day at 09:00: the day is not what the rule fixes, the hour is.
    const event = series('FREQ=DAILY;BYHOUR=9', '2026-03-09T09:00:00+01:00')
    const nextDayLater = new Date('2026-03-10T10:00:00+01:00')
    expect(moveAllRefusal(event, nextDayLater, 'Europe/Berlin')).toBe('fixedTimes')
  })

  it('always blames the days for an all-day event', () => {
    const event = {
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=15',
      allDay: true,
      timezone: '',
      start: '2026-03-15T00:00:00Z',
      startsAt: new Date(2026, 2, 15),
    }
    expect(moveAllRefusal(event, new Date('2026-03-16T00:00:00Z'), 'Europe/Berlin')).toBe('fixedDays')
  })
})
