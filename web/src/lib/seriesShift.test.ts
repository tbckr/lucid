/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { type TaskDates, type TaskRepeat } from './calendarTasks'
import { eventRuleClock, eventRuleStart, moveAllRefusal, ruleInZone, seriesShift, taskMoveRefusal, taskRuleClock } from './seriesShift'
import { todo } from '@/test/fixtures'

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
      timezone: 'Europe/Berlin',
      start: '2026-03-09T08:00:00Z',
      startsAt: new Date('2026-03-09T09:00:00+01:00'), // Monday, CET
    }
    const newStart = new Date('2026-03-10T09:00:00+01:00') // Tuesday, CET
    expect(moveAllRefusal(event, newStart)).toBeNull()
  })

  it('rejects a day move but allows a time-only move for BYMONTHDAY', () => {
    const event = {
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=15',
      allDay: false,
      timezone: 'Europe/Berlin',
      start: '2026-03-15T08:00:00Z',
      startsAt: new Date('2026-03-15T09:00:00+01:00'),
    }
    const nextDay = new Date('2026-03-16T09:00:00+01:00')
    expect(moveAllRefusal(event, nextDay)).toBe('fixedDays')

    const sameDayLater = new Date('2026-03-15T11:00:00+01:00')
    expect(moveAllRefusal(event, sameDayLater)).toBeNull()
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
    expect(moveAllRefusal(event, newStart)).toBeNull()
  })

  // The server reads a time in UTC ("Z"), a floating one and one in a zone it can't resolve in UTC, and reports no
  // zone for them: the browser's zone must not decide what it allows.
  it.each(['Europe/Berlin', 'America/New_York', 'Asia/Tokyo'])(
    'counts the days of a series without a zone in UTC, with the browser in %s',
    (browserZone) => {
      const originalTz = process.env.TZ
      process.env.TZ = browserZone
      try {
        const at = (start: string) => ({
          rrule: 'FREQ=MONTHLY;BYMONTHDAY=9',
          allDay: false,
          timezone: '',
          start,
          startsAt: new Date(start),
        })
        // 23:30 UTC on Monday, 9 March: 00:30 UTC is Tuesday, wherever the browser is.
        expect(moveAllRefusal(at('2026-03-09T23:30:00Z'), new Date('2026-03-10T00:30:00Z'))).toBe('fixedDays')
        // 22:30 to 23:15 UTC stays on Monday, though in Berlin it crosses midnight.
        expect(moveAllRefusal(at('2026-03-09T22:30:00Z'), new Date('2026-03-09T23:15:00Z'))).toBeNull()
      } finally {
        process.env.TZ = originalTz
      }
    },
  )

  it('derives all-day wall clocks from the UTC calendar date', () => {
    const event = {
      rrule: 'FREQ=WEEKLY;BYDAY=MO',
      allDay: true,
      timezone: '',
      start: '2026-03-09T00:00:00Z', // Monday
      startsAt: new Date(2026, 2, 9),
    }
    const newStart = new Date('2026-03-10T00:00:00Z') // Tuesday
    expect(moveAllRefusal(event, newStart)).toBeNull()
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
      expect(moveAllRefusal(event, new Date('2026-09-25T00:00:00Z'))).toBeNull()
      expect(moveAllRefusal(event, new Date('2026-09-26T00:00:00Z'))).toBe('fixedDays')
    } finally {
      process.env.TZ = originalTz
    }
  })
})

describe('moveAllRefusal', () => {
  /** A timed Berlin series whose shown occurrence starts at `startsAt`. */
  function series(rrule: string, startsAt: string) {
    return {
      rrule,
      allDay: false,
      timezone: 'Europe/Berlin',
      start: new Date(startsAt).toISOString(),
      startsAt: new Date(startsAt),
    }
  }

  it('allows a move the series can follow', () => {
    const event = series('FREQ=WEEKLY;BYDAY=MO', '2026-03-09T09:00:00+01:00') // Monday
    const tuesday = new Date('2026-03-10T09:00:00+01:00')
    expect(moveAllRefusal(event, tuesday)).toBeNull()
  })

  it('refuses another day of a monthly series on fixed days', () => {
    const event = series('FREQ=MONTHLY;BYMONTHDAY=15', '2026-03-15T09:00:00+01:00')
    const nextDay = new Date('2026-03-16T09:00:00+01:00')
    expect(moveAllRefusal(event, nextDay)).toBe('fixedDays')
  })

  it('refuses another time when the rule fixes the hour', () => {
    const event = series('FREQ=DAILY;BYHOUR=9', '2026-03-09T09:00:00+01:00')
    const later = new Date('2026-03-09T10:00:00+01:00')
    expect(moveAllRefusal(event, later)).toBe('fixedTimes')
  })

  it('refuses another day even when the rule fixes the hour', () => {
    // BYHOUR is another BY part: no rotation, so Monday -> Wednesday is refused.
    const event = series('FREQ=WEEKLY;BYDAY=MO;BYHOUR=9', '2026-03-09T09:00:00+01:00')
    const wednesday = new Date('2026-03-11T09:00:00+01:00')
    expect(moveAllRefusal(event, wednesday)).toBe('fixedDays')
  })

  it('blames the time when only the time keeps the series from following', () => {
    // Every day at 09:00: the day is not what the rule fixes, the hour is.
    const event = series('FREQ=DAILY;BYHOUR=9', '2026-03-09T09:00:00+01:00')
    const nextDayLater = new Date('2026-03-10T10:00:00+01:00')
    expect(moveAllRefusal(event, nextDayLater)).toBe('fixedTimes')
  })

  it('always blames the days for an all-day event', () => {
    const event = {
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=15',
      allDay: true,
      timezone: '',
      start: '2026-03-15T00:00:00Z',
      startsAt: new Date(2026, 2, 15),
    }
    expect(moveAllRefusal(event, new Date('2026-03-16T00:00:00Z'))).toBe('fixedDays')
  })

  // The server moves the series by the distance the exception moves, from its place in the rule: an exception at
  // another time of day than its series crosses midnight where the series does not, or the other way round (#6).
  describe('of an exception at another time of day', () => {
    /** The April event of a series at 09:30 in Berlin on the 15th, moved to `startsAt`. */
    function exception(startsAt: string) {
      return { ...series('FREQ=MONTHLY;BYMONTHDAY=15', startsAt), recurrenceId: '2025-04-15T07:30:00Z' }
    }

    it('allows a move that keeps the series on its day', () => {
      // 23:30 to 00:30 the next day moves the series from 09:30 to 10:30 on the 15th.
      const event = exception('2025-04-15T23:30:00+02:00')
      expect(moveAllRefusal(event, new Date('2025-04-16T00:30:00+02:00'))).toBeNull()
    })

    it('refuses a move that takes the series to another day', () => {
      // 00:30 to 23:30 on the 16th moves the series by 23 hours, from 09:30 on the 15th to 08:30 on the 16th.
      const event = exception('2025-04-16T00:30:00+02:00')
      expect(moveAllRefusal(event, new Date('2025-04-16T23:30:00+02:00'))).toBe('fixedDays')
    })
  })
})

// FR-17: the shift check of a task series is the events' `seriesShift`, measured from a repeat's RECURRENCE-ID by
// the distance its shown dates move.
describe('taskMoveRefusal', () => {
  /**
   * A repeat of the series `rrule` (in `timezone`) named `rid`, shown on `shown`; the current repeat is named
   * `current` and shown on `currentShown`, else on `shown`.
   */
  function repeat(p: {
    rrule: string
    timezone?: string
    current: string
    currentShown?: TaskDates
    rid: string
    shown: TaskDates
    at?: TaskRepeat['at']
  }): TaskRepeat {
    return {
      todo: todo({
        rrule: p.rrule,
        recurring: true,
        timezone: p.timezone,
        recurrenceId: p.current,
        ...(p.currentShown ?? p.shown),
      }),
      recurrenceId: p.rid,
      at: p.at ?? 'current',
      last: false,
      offRule: false,
      title: 'Task',
      shown: p.shown,
    }
  }
  const timed = (due: string): TaskDates => ({ start: null, startAllDay: false, due, dueAllDay: false })
  const date = (day: string): TaskDates => ({ start: null, startAllDay: false, due: `${day}T00:00:00Z`, dueAllDay: true })

  it('lets an all-day weekly series follow from Monday to Tuesday', () => {
    const monday = repeat({
      rrule: 'FREQ=WEEKLY;BYDAY=MO,TH',
      current: '2026-03-09T00:00:00Z',
      rid: '2026-03-09T00:00:00Z',
      shown: date('2026-03-09'),
    })
    expect(taskMoveRefusal(monday, date('2026-03-10'), 'repeat')).toBeNull()
  })

  it('reads an all-day repeat by its UTC date west of UTC too', () => {
    const originalTz = process.env.TZ
    process.env.TZ = 'America/New_York'
    try {
      const fifteenth = repeat({
        rrule: 'FREQ=MONTHLY;BYMONTHDAY=15',
        current: '2026-03-15T00:00:00Z',
        rid: '2026-03-15T00:00:00Z',
        shown: date('2026-03-15'),
      })
      expect(taskMoveRefusal(fifteenth, date('2026-03-15'), 'repeat')).toBeNull()
      expect(taskMoveRefusal(fifteenth, date('2026-03-16'), 'repeat')).toBe('fixedDays')
    } finally {
      process.env.TZ = originalTz
    }
  })

  it('counts the days of a timed series in its own zone', () => {
    // 23:30 in Berlin on Monday, 9 March; an hour later is Tuesday there, but still Monday in New York.
    const late = {
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=9',
      current: '2026-03-09T22:30:00Z',
      rid: '2026-03-09T22:30:00Z',
      shown: timed('2026-03-09T22:30:00Z'),
    }
    const hourLater = timed('2026-03-09T23:30:00Z')
    expect(taskMoveRefusal(repeat({ ...late, timezone: 'Europe/Berlin' }), hourLater, 'repeat')).toBe('fixedDays')
    expect(taskMoveRefusal(repeat({ ...late, timezone: 'America/New_York' }), hourLater, 'repeat')).toBeNull()
  })

  // The server reads a time in UTC ("Z"), a floating one and one in a zone it can't resolve in UTC, and reports no
  // zone for them: the browser's zone must not decide what it allows.
  it.each(['Europe/Berlin', 'America/New_York', 'Asia/Tokyo'])(
    'counts the days of a series without a zone in UTC, with the browser in %s',
    (browserZone) => {
      const originalTz = process.env.TZ
      process.env.TZ = browserZone
      try {
        // 23:30 UTC on Monday, 9 March: 00:30 UTC is Tuesday, wherever the browser is.
        const lateUtc = repeat({
          rrule: 'FREQ=MONTHLY;BYMONTHDAY=9',
          current: '2026-03-09T23:30:00Z',
          rid: '2026-03-09T23:30:00Z',
          shown: timed('2026-03-09T23:30:00Z'),
        })
        expect(taskMoveRefusal(lateUtc, timed('2026-03-10T00:30:00Z'), 'repeat')).toBe('fixedDays')
        // 22:30 to 23:15 UTC stays on Monday, though in Berlin it crosses midnight.
        const earlierUtc = repeat({
          rrule: 'FREQ=MONTHLY;BYMONTHDAY=9',
          current: '2026-03-09T22:30:00Z',
          rid: '2026-03-09T22:30:00Z',
          shown: timed('2026-03-09T22:30:00Z'),
        })
        expect(taskMoveRefusal(earlierUtc, timed('2026-03-09T23:15:00Z'), 'repeat')).toBeNull()
      } finally {
        process.env.TZ = originalTz
      }
    },
  )

  // FR-17: an all-day series given a time takes it on the wall clock of the zone the write names (its `timezone`),
  // where the server writes it (seriesForm) and reads the move: not in UTC, where east or west of it the time can lie
  // on another day. Run in the browser's zone too, which must not decide it either.
  it.each([
    // 08:00 on Thursday, 5 November in Tokyo is 23:00 UTC on the 4th.
    { zone: 'Asia/Tokyo', on: '2026-11-04T23:00:00Z', dayLater: '2026-11-05T23:00:00Z' },
    // 20:00 on the 5th in New York is 01:00 UTC on the 6th.
    { zone: 'America/New_York', on: '2026-11-06T01:00:00Z', dayLater: '2026-11-07T01:00:00Z' },
  ])('reads a time given to an all-day series in the zone of the write, in $zone', ({ zone, on, dayLater }) => {
    const originalTz = process.env.TZ
    process.env.TZ = zone
    try {
      const fifth = repeat({
        rrule: 'FREQ=MONTHLY;BYMONTHDAY=5',
        current: '2026-11-05T00:00:00Z',
        rid: '2026-11-05T00:00:00Z',
        shown: date('2026-11-05'),
      })
      expect(taskMoveRefusal(fifth, { ...timed(on), timezone: zone }, 'repeat')).toBeNull()
      expect(taskMoveRefusal(fifth, { ...timed(on), timezone: zone }, 'current')).toBeNull()
      expect(taskMoveRefusal(fifth, { ...timed(dayLater), timezone: zone }, 'repeat')).toBe('fixedDays')
      // A write without a zone gets its time in UTC, as the server reads it then: another day.
      expect(taskMoveRefusal(fifth, timed(on), 'repeat')).toBe('fixedDays')
    } finally {
      process.env.TZ = originalTz
    }
  })

  it("reads a timed series without a zone in UTC, whatever zone the write names", () => {
    // 23:30 UTC on Monday, 9 March, an hour later: 00:30 UTC is Tuesday, though 09:30 in Tokyo is still Tuesday's start.
    const lateUtc = repeat({
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=9',
      current: '2026-03-09T23:30:00Z',
      rid: '2026-03-09T23:30:00Z',
      shown: timed('2026-03-09T23:30:00Z'),
    })
    expect(taskMoveRefusal(lateUtc, { ...timed('2026-03-10T00:30:00Z'), timezone: 'America/New_York' }, 'repeat')).toBe(
      'fixedDays',
    )
  })

  it('measures from the recurrence ID by the distance the shown dates move', () => {
    // A repeat at 23:30 on the 9th in Berlin, which another app shows at 10:00 instead: an hour later moves the rule
    // from 23:30 past midnight, off its day; a quarter of an hour later keeps it there.
    const elsewhere = repeat({
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=9',
      timezone: 'Europe/Berlin',
      current: '2026-03-09T22:30:00Z',
      rid: '2026-03-09T22:30:00Z',
      shown: timed('2026-03-09T09:00:00Z'),
    })
    expect(taskMoveRefusal(elsewhere, timed('2026-03-09T10:00:00Z'), 'repeat')).toBe('fixedDays')
    expect(taskMoveRefusal(elsewhere, timed('2026-03-09T09:15:00Z'), 'repeat')).toBeNull()
  })

  it('measures "all" from a later repeat from the current repeat\'s recurrence ID', () => {
    // Daily at 02:30 in Berlin in March and April. On Sunday, 29 March, summer time begins and 02:30 does not exist,
    // so the current repeat is at 03:30 there (the server's RECURRENCE-ID 01:30Z); the next one is at 02:30 on
    // Monday. The same move of the later repeat can cross midnight from one of them and not from the other.
    const later = repeat({
      rrule: 'FREQ=DAILY;BYMONTH=3,4',
      timezone: 'Europe/Berlin',
      current: '2026-03-29T01:30:00Z',
      currentShown: timed('2026-03-29T01:30:00Z'),
      rid: '2026-03-30T00:30:00Z',
      shown: timed('2026-03-30T00:30:00Z'),
      at: 'upcoming',
    })
    // 21 hours later, to 23:30 on Monday: from the later repeat it stays on its day, from 03:30 on Sunday it does not.
    const lateMonday = timed('2026-03-30T21:30:00Z')
    expect(taskMoveRefusal(later, lateMonday, 'repeat')).toBeNull()
    expect(taskMoveRefusal(later, lateMonday, 'current')).toBe('fixedDays')
    // 3 hours earlier, to 23:30 on Sunday: from the later repeat it leaves its day, from 03:30 on Sunday it does not.
    const lateSunday = timed('2026-03-29T21:30:00Z')
    expect(taskMoveRefusal(later, lateSunday, 'repeat')).toBe('fixedDays')
    expect(taskMoveRefusal(later, lateSunday, 'current')).toBeNull()
  })

  it('blames the times when the rule fixes them and the clock moves', () => {
    const nine = repeat({
      rrule: 'FREQ=DAILY;BYHOUR=9',
      timezone: 'Europe/Berlin',
      current: '2026-03-09T08:00:00Z',
      rid: '2026-03-09T08:00:00Z',
      shown: timed('2026-03-09T08:00:00Z'),
    })
    expect(taskMoveRefusal(nine, timed('2026-03-09T09:00:00Z'), 'repeat')).toBe('fixedTimes')
    expect(taskMoveRefusal(nine, timed('2026-03-10T09:00:00Z'), 'repeat')).toBe('fixedTimes')
    // Another day at the same time: the rule fixes no days, but it lets no move change the day either.
    expect(taskMoveRefusal(nine, timed('2026-03-10T08:00:00Z'), 'repeat')).toBe('fixedDays')
  })

  it('anchors on the start, else the due', () => {
    const spanning = repeat({
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=15',
      timezone: 'Europe/Berlin',
      current: '2026-03-15T08:00:00Z',
      rid: '2026-03-15T08:00:00Z',
      shown: { start: '2026-03-15T08:00:00Z', startAllDay: false, due: '2026-03-16T08:00:00Z', dueAllDay: false },
    })
    // Only the due moves: the start, which anchors it, stays on its day.
    const longer = { start: '2026-03-15T08:00:00Z', startAllDay: false, due: '2026-03-18T08:00:00Z', dueAllDay: false }
    expect(taskMoveRefusal(spanning, longer, 'repeat')).toBeNull()
    const startLater = { ...longer, start: '2026-03-16T08:00:00Z' }
    expect(taskMoveRefusal(spanning, startLater, 'repeat')).toBe('fixedDays')
  })

  it('moves a repeat between a time and a date by its change of date alone', () => {
    // A repeat of 09:00 on the 15th in Berlin, which another app moved to 10:00, made an all-day task on the same day:
    // no day moves, as on the server. Counting the hours, the rule would go back to 23:00 on the 14th.
    const moved = repeat({
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=15',
      timezone: 'Europe/Berlin',
      current: '2026-03-15T08:00:00Z',
      rid: '2026-03-15T08:00:00Z',
      shown: timed('2026-03-15T09:00:00Z'),
    })
    expect(taskMoveRefusal(moved, date('2026-03-15'), 'repeat')).toBeNull()
    expect(taskMoveRefusal(moved, date('2026-03-16'), 'repeat')).toBe('fixedDays')
  })

  it('has nothing to refuse without dates to move to', () => {
    const fifteenth = repeat({
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=15',
      current: '2026-03-15T00:00:00Z',
      rid: '2026-03-15T00:00:00Z',
      shown: date('2026-03-15'),
    })
    expect(
      taskMoveRefusal(fifteenth, { start: null, startAllDay: false, due: null, dueAllDay: false }, 'repeat'),
    ).toBeNull()
  })
})

// A series in New York at 18:00 shows at midnight in Berlin, a day later (FR-17, FR-18).
describe('ruleInZone', () => {
  it('reads the clock of a series in another zone on the night the browser skips that hour', () => {
    // 01:30Z on 29 March 2026: 02:30 in London, 03:30 in Berlin (Vitest's zone, which skips 02:00 to 03:00).
    expect(ruleInZone('FREQ=DAILY;BYHOUR=2;BYMINUTE=30', new Date('2026-03-29T01:30:00Z'), 'Europe/London', 'Europe/Berlin')).toBeNull()
  })

  const tuesday = new Date('2026-11-10T23:00:00Z') // 18:00 EST, Wednesday 00:00 CET
  it.each([
    ['rotates plain weekdays to the dates shown', 'FREQ=WEEKLY;BYDAY=TU,TH', tuesday, 'America/New_York', 'Europe/Berlin', 'FREQ=WEEKLY;BYDAY=WE,FR'],
    [
      'rotates them back',
      'FREQ=WEEKLY;INTERVAL=2;BYDAY=WE,FR;WKST=MO',
      tuesday,
      'Europe/Berlin',
      'America/New_York',
      'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;WKST=MO',
    ],
    ['keeps a rule without fixed days', 'FREQ=MONTHLY;COUNT=5', tuesday, 'America/New_York', 'Europe/Berlin', 'FREQ=MONTHLY;COUNT=5'],
    ['cannot read days of the month on another date', 'FREQ=MONTHLY;BYMONTHDAY=10', tuesday, 'America/New_York', 'Europe/Berlin', null],
    [
      'keeps days of the month on the same date',
      'FREQ=MONTHLY;BYMONTHDAY=10',
      new Date('2026-11-10T15:00:00Z'), // 10:00 EST, 16:00 CET
      'America/New_York',
      'Europe/Berlin',
      'FREQ=MONTHLY;BYMONTHDAY=10',
    ],
    [
      'cannot read hours on another clock',
      'FREQ=DAILY;BYHOUR=10',
      new Date('2026-11-10T15:00:00Z'),
      'America/New_York',
      'Europe/Berlin',
      null,
    ],
    [
      'goes by the date at its event: here New York is already on summer time',
      'FREQ=WEEKLY;BYDAY=TU,TH',
      new Date('2026-03-10T22:00:00Z'), // 18:00 EDT, 23:00 CET
      'America/New_York',
      'Europe/Berlin',
      'FREQ=WEEKLY;BYDAY=TU,TH',
    ],
    [
      'cannot read weekdays that leave the weeks every other week pairs up',
      'FREQ=WEEKLY;INTERVAL=2;BYDAY=TH,SU',
      tuesday,
      'America/New_York',
      'Europe/Berlin',
      null,
    ],
    ['reads a series without a zone in UTC', 'FREQ=WEEKLY;BYDAY=TU', tuesday, 'UTC', 'Asia/Tokyo', 'FREQ=WEEKLY;BYDAY=WE'],
    ['leaves the rule as written in its own zone', 'FREQ=WEEKLY;BYDAY=TU, TH', tuesday, 'Europe/Berlin', 'Europe/Berlin', 'FREQ=WEEKLY;BYDAY=TU, TH'],
  ])('%s', (_, rule, at, from, to, want) => {
    expect(ruleInZone(rule, at, from, to)).toBe(want)
  })
})

describe('eventRuleClock', () => {
  const at = new Date('2026-11-10T23:00:00Z')
  it('reads a timed series in its own zone, else in UTC, as the server does', () => {
    expect(eventRuleClock({ allDay: false, timezone: 'America/New_York', startsAt: at })).toEqual({ at, zone: 'America/New_York' })
    expect(eventRuleClock({ allDay: false, timezone: '', startsAt: at })).toEqual({ at, zone: 'UTC' })
  })

  it('has none for an all-day series, whose days are dates', () => {
    expect(eventRuleClock({ allDay: true, timezone: '', startsAt: at })).toBeNull()
  })

  // The server resolves zones the browser may not know yet (a newer IANA name in an older browser).
  it('has none in a zone the browser cannot read', () => {
    expect(eventRuleClock({ allDay: false, timezone: 'right/Europe/Berlin', startsAt: at })).toBeNull()
    expect(taskRuleClock(todo({ recurring: true, due: '2026-11-10T23:00:00Z', timezone: 'right/Europe/Berlin' }))).toBeNull()
  })

  // An exception moved to 10:00 in New York shows on Tuesday in Berlin too, though the rule's events show on Wednesday.
  it("reads an event at its place in the rule, not where an exception moved it", () => {
    const moved = { allDay: false, timezone: 'America/New_York', startsAt: new Date('2026-11-10T15:00:00Z'), recurrenceId: '2026-11-10T23:00:00Z' }
    expect(eventRuleClock(moved)).toEqual({ at, zone: 'America/New_York' })
  })
})

// A weekly series at 10:00 in Berlin whose event of Tuesday, 10 November, is moved to Monday, 9 November.
describe('eventRuleStart', () => {
  const moved = { allDay: false, startsAt: new Date(2026, 10, 9, 10), recurrenceId: '2026-11-10T09:00:00Z' }

  it('places an exception at its place in the rule, not where it moved', () => {
    expect(eventRuleStart(moved)).toEqual(new Date(2026, 10, 10, 10))
  })

  it('moves that place as far as a save moves the event from where it is shown', () => {
    expect(eventRuleStart(moved, new Date(2026, 10, 10, 11), false)).toEqual(new Date(2026, 10, 11, 11))
    // A save that makes it all-day moves it by dates.
    expect(eventRuleStart(moved, new Date(2026, 10, 10), true)).toEqual(new Date(2026, 10, 11))
  })

  it('reads an all-day event by its date', () => {
    const allDay = { allDay: true, startsAt: new Date(2026, 10, 9), recurrenceId: '2026-11-10T00:00:00Z' }
    expect(eventRuleStart(allDay)).toEqual(new Date(2026, 10, 10))
    expect(eventRuleStart(allDay, new Date(2026, 10, 9, 9, 30), false)).toEqual(new Date(2026, 10, 10, 9, 30))
  })

  it('is where a single event is saved', () => {
    expect(eventRuleStart({ allDay: false, startsAt: new Date(2026, 10, 9, 10) }, new Date(2026, 10, 12, 8), false)).toEqual(
      new Date(2026, 10, 12, 8),
    )
  })
})

describe('taskRuleClock', () => {
  const at = '2026-11-10T23:00:00Z'
  it('reads a timed series at its start, else its due, in its own zone, else in UTC', () => {
    expect(taskRuleClock(todo({ recurring: true, start: at, due: '2026-11-11T23:00:00Z', timezone: 'America/New_York' }))).toEqual({
      at: new Date(at),
      zone: 'America/New_York',
    })
    expect(taskRuleClock(todo({ recurring: true, due: at }))).toEqual({ at: new Date(at), zone: 'UTC' })
  })

  it('reads the current repeat at its place in the rule, not where an override moved it', () => {
    const moved = todo({ recurring: true, due: '2026-11-10T15:00:00Z', timezone: 'America/New_York', recurrenceId: at })
    expect(taskRuleClock(moved)).toEqual({ at: new Date(at), zone: 'America/New_York' })
  })

  it('keeps a single task in its own zone, where the server keeps a rule it is given', () => {
    expect(taskRuleClock(todo({ due: at, timezone: 'America/New_York' }))).toEqual({ at: new Date(at), zone: 'America/New_York' })
  })

  it('has none where a rule recurs in the zone the write names, or on dates', () => {
    expect(taskRuleClock(todo({ due: at }))).toBeNull()
    expect(taskRuleClock(todo({ recurring: true, due: '2026-11-10T00:00:00Z', dueAllDay: true }))).toBeNull()
    expect(taskRuleClock(todo({ recurring: true, rrule: 'FREQ=DAILY' }))).toBeNull()
  })
})
