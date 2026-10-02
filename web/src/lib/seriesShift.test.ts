/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { canMoveAll, seriesShift } from './seriesShift'

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

describe('canMoveAll', () => {
  it('follows a weekday move in Berlin', () => {
    const event = {
      rrule: 'FREQ=WEEKLY;BYDAY=MO',
      allDay: false,
      timezone: '',
      startsAt: new Date('2026-03-09T09:00:00+01:00'), // Monday, CET
    }
    const newStart = new Date('2026-03-10T09:00:00+01:00') // Tuesday, CET
    expect(canMoveAll(event, newStart, 'Europe/Berlin')).toBe(true)
  })

  it('rejects a day move but allows a time-only move for BYMONTHDAY', () => {
    const event = {
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=15',
      allDay: false,
      timezone: '',
      startsAt: new Date('2026-03-15T09:00:00+01:00'),
    }
    const nextDay = new Date('2026-03-16T09:00:00+01:00')
    expect(canMoveAll(event, nextDay, 'Europe/Berlin')).toBe(false)

    const sameDayLater = new Date('2026-03-15T11:00:00+01:00')
    expect(canMoveAll(event, sameDayLater, 'Europe/Berlin')).toBe(true)
  })

  it('judges the day in the event zone, not the browser zone', () => {
    const event = {
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=9',
      allDay: false,
      timezone: 'America/New_York',
      startsAt: new Date('2026-03-09T21:00:00Z'), // 17:00 EDT, Monday
    }
    // 23:30Z is 00:30 Tuesday in Berlin, but 19:30 Monday in New York.
    const newStart = new Date('2026-03-09T23:30:00Z')
    expect(canMoveAll(event, newStart, 'Europe/Berlin')).toBe(true)
  })

  it('derives all-day wall clocks from the local calendar date', () => {
    const event = {
      rrule: 'FREQ=WEEKLY;BYDAY=MO',
      allDay: true,
      timezone: '',
      startsAt: new Date(2026, 2, 9), // Monday, local midnight
    }
    const newStart = new Date(2026, 2, 10) // Tuesday, local midnight
    expect(canMoveAll(event, newStart, 'Europe/Berlin')).toBe(true)
  })
})
