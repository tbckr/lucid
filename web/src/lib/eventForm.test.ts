import { describe, expect, it } from 'vitest'
import { apiEvent } from '@/test/fixtures'
import { type ApiEvent } from './api/schemas'
import { toCalEvent } from './events'
import {
  createFormValues,
  editFormValues,
  eventFormSchema,
  formDuration,
  formToInput,
  occurrenceInput,
  ruleChanged,
  shiftEnd,
  timeOptions,
  withStartZone,
  zonesChanged,
  type EventFormValues,
} from './eventForm'
import { PICKED_UTC } from './zones'

const TZ = 'Europe/Berlin'
const base: EventFormValues = {
  title: 'Standup',
  calendarId: 'c1',
  allDay: false,
  startDate: '2026-03-28',
  startTime: '09:00',
  endDate: '2026-03-28',
  endTime: '09:30',
  location: ' Room 1 ',
  description: 'Notes',
  recurrence: 'none',
  customRule: '',
  startZone: '',
  endZone: '',
}

describe('eventFormSchema', () => {
  it('accepts valid values', () => {
    expect(eventFormSchema.safeParse(base).success).toBe(true)
  })

  it('rejects an end before the start', () => {
    const r = eventFormSchema.safeParse({ ...base, endTime: '08:00' })
    expect(r.success).toBe(false)
    expect(r.error?.issues[0]).toMatchObject({ message: 'validation.endBeforeStart', path: ['endDate'] })
  })

  it('judges the end at the times saved on the night summer time starts', () => {
    const night = { ...base, startDate: '2026-03-29', endDate: '2026-03-29' }
    // 02:45 is saved as 03:45, after 03:15.
    const r = eventFormSchema.safeParse({ ...night, startTime: '02:45', endTime: '03:15' })
    expect(r.error?.issues.map((i) => [i.message, i.path[0]])).toEqual([['validation.endBeforeStart', 'endDate']])
    // 02:15 and 03:15 are the same time: allowed, as on the server.
    expect(eventFormSchema.safeParse({ ...night, startTime: '02:15', endTime: '03:15' }).success).toBe(true)
  })

  it('compares dates only for all-day events', () => {
    expect(eventFormSchema.safeParse({ ...base, allDay: true, endTime: '08:00' }).success).toBe(true)
    expect(eventFormSchema.safeParse({ ...base, allDay: true, endDate: '2026-03-27' }).success).toBe(false)
  })

  // A time All day hides can't block saving, even one the field couldn't read (FR-09).
  it('reads the times of timed events only', () => {
    expect(eventFormSchema.safeParse({ ...base, allDay: true, startTime: '9:4x', endTime: '' }).success).toBe(true)
    const r = eventFormSchema.safeParse({ ...base, startTime: '9:4x', endTime: '' })
    expect(r.error?.issues.map((i) => [i.message, i.path[0]])).toEqual([
      ['validation.time', 'startTime'],
      ['validation.time', 'endTime'],
    ])
  })

  // The forms' shape, but no day the calendar has (FR-09): refused as a date, not read as the day it would roll over to.
  it.each([
    ['startDate', '2026-02-31'],
    ['endDate', '2026-13-45'],
  ])("refuses a %s in the forms' shape that doesn't exist", (path, value) => {
    const r = eventFormSchema.safeParse({ ...base, [path]: value })
    expect(r.error?.issues.map((i) => [i.message, i.path[0]])).toEqual([['validation.date', path]])
  })

  it('validates formats and required calendar', () => {
    const r = eventFormSchema.safeParse({ ...base, startTime: '25:00', endDate: 'x', calendarId: '' })
    const messages = r.error?.issues.map((i) => i.message)
    expect(messages).toEqual(expect.arrayContaining(['validation.time', 'validation.date', 'validation.calendarRequired']))
  })
})

describe('formToInput', () => {
  // A new single event without a zone picked is saved without one (FR-18).
  it('converts timed values in the given zone (across DST)', () => {
    const input = formToInput({ ...base, endDate: '2026-03-29', endTime: '09:00' }, TZ)
    expect(input).toEqual({
      title: 'Standup',
      description: 'Notes',
      location: 'Room 1',
      start: '2026-03-28T08:00:00.000Z', // CET
      end: '2026-03-29T07:00:00.000Z', // CEST
      allDay: false,
      rrule: '',
    })
  })

  it("sends an event's own times while its date and time stay as it opened, also in the hour summer time repeats", () => {
    for (const [start, end] of [
      ['2026-10-25T00:30:00Z', '2026-10-25T00:45:00Z'],
      ['2026-10-25T01:30:00Z', '2026-10-25T01:45:00Z'],
    ] as const) {
      const event = toCalEvent(apiEvent({ start, end }))
      const input = formToInput({ ...editFormValues(event, TZ), title: 'Renamed' }, TZ, event)
      expect(input.start).toBe(new Date(start).toISOString())
      expect(input.end).toBe(new Date(end).toISOString())
    }
  })

  it('reads a changed time anew, next to one that stays', () => {
    const event = toCalEvent(apiEvent({ start: '2026-10-25T01:30:00Z', end: '2026-10-25T01:45:00Z' }))
    const input = formToInput({ ...editFormValues(event, TZ), endTime: '03:00' }, TZ, event)
    expect(input.start).toBe('2026-10-25T01:30:00.000Z')
    expect(input.end).toBe('2026-10-25T02:00:00.000Z')
  })

  it('reads a changed end in the hour summer time repeats after a start kept at its second pass', () => {
    // 02:00-02:30 CET, after the clocks went back from 03:00 CEST.
    const event = toCalEvent(apiEvent({ start: '2026-10-25T01:00:00Z', end: '2026-10-25T01:30:00Z' }))
    const v = { ...editFormValues(event, TZ), endTime: '02:45' }
    expect(eventFormSchema.safeParse(v).success).toBe(true)
    const input = formToInput(v, TZ, event)
    expect(input.start).toBe('2026-10-25T01:00:00.000Z')
    expect(input.end).toBe('2026-10-25T01:45:00.000Z')
  })

  it('reads the times of an all-day event made timed as entered', () => {
    const event = toCalEvent(apiEvent({ allDay: true, start: '2026-09-25T00:00:00Z', end: '2026-09-26T00:00:00Z' }))
    const input = formToInput({ ...editFormValues(event, TZ), allDay: false }, TZ, event)
    expect(input.start).toBe('2026-09-25T07:00:00.000Z')
    expect(input.end).toBe('2026-09-25T07:30:00.000Z')
  })

  it('converts all-day values to UTC midnight with exclusive end', () => {
    const input = formToInput({ ...base, allDay: true, endDate: '2026-03-29', recurrence: 'yearly' }, TZ)
    expect(input.start).toBe('2026-03-28T00:00:00.000Z')
    expect(input.end).toBe('2026-03-30T00:00:00.000Z')
    expect(input).not.toHaveProperty('timezone')
    expect(input.rrule).toBe('FREQ=YEARLY')
  })

  it('adds instanceStart for occurrences of recurring series', () => {
    const occurrence = toCalEvent(
      apiEvent({ recurring: true, rrule: 'FREQ=WEEKLY', recurrenceId: '2026-09-25T08:00:00Z' }),
    )
    expect(formToInput(base, TZ, occurrence).instanceStart).toBe('2026-09-25T08:00:00Z')
    expect(formToInput(base, TZ, toCalEvent(apiEvent()))).not.toHaveProperty('instanceStart')
  })

  // FR-17: a stored rule the presets would rewrite (Apple's explicit
  // "INTERVAL=1") must round-trip unchanged while the user leaves it alone,
  // or the server would see a changed rule and take the slower, full-rewrite
  // path instead of the one that keeps the series' own time zone.
  it('keeps an unrecognized but unchanged rule verbatim instead of rebuilding it', () => {
    const occurrence = toCalEvent(
      apiEvent({ recurring: true, rrule: 'FREQ=WEEKLY;INTERVAL=1', recurrenceId: '2026-09-25T08:00:00Z' }),
    )
    const unchanged = editFormValues(occurrence, TZ)
    expect(formToInput(unchanged, TZ, occurrence).rrule).toBe('FREQ=WEEKLY;INTERVAL=1')
    expect(formToInput({ ...unchanged, recurrence: 'daily' }, TZ, occurrence).rrule).toBe('FREQ=DAILY')
  })

  it('keeps a series of dates without a rule as it is', () => {
    const dates = toCalEvent(apiEvent({ recurring: true, rrule: '', recurrenceId: '2026-09-25T08:00:00Z' }))
    const v = editFormValues(dates, TZ)
    expect(v).toMatchObject({ recurrence: 'custom', customRule: '' })
    expect(formToInput(v, TZ, dates).rrule).toBe('')
  })

  it('ends a timed series with the end of its last day, as UTC', () => {
    const input = formToInput({ ...base, recurrence: 'custom', customRule: 'FREQ=WEEKLY;UNTIL=20261231' }, TZ)
    expect(input.rrule).toBe('FREQ=WEEKLY;UNTIL=20261231T225959Z')
  })

  it('ends an all-day series with a date', () => {
    const input = formToInput({ ...base, allDay: true, recurrence: 'custom', customRule: 'FREQ=WEEKLY;UNTIL=20261231T225959Z' }, TZ)
    expect(input.rrule).toBe('FREQ=WEEKLY;UNTIL=20261231')
  })

  it('sends a kept rule verbatim, whatever its end', () => {
    const series = toCalEvent(apiEvent({ allDay: true, recurring: true, rrule: 'FREQ=WEEKLY;UNTIL=20261231T225959Z' }))
    expect(formToInput(editFormValues(series, TZ), TZ, series).rrule).toBe('FREQ=WEEKLY;UNTIL=20261231T225959Z')
  })
})

describe('occurrenceInput', () => {
  // One zone per series: "Only this event" keeps the zones (FR-17, FR-18).
  it('drops exactly rrule, instanceStart and the zones', () => {
    const input = formToInput(base, TZ)
    const withSeries = {
      ...input,
      rrule: 'FREQ=WEEKLY',
      instanceStart: '2026-09-25T08:00:00Z',
      timezone: 'Asia/Tokyo',
      endTimezone: 'Asia/Tokyo',
    }
    expect(occurrenceInput(withSeries)).toEqual({
      title: withSeries.title,
      description: withSeries.description,
      location: withSeries.location,
      start: withSeries.start,
      end: withSeries.end,
      allDay: withSeries.allDay,
    })
  })
})

describe('ruleChanged', () => {
  it('is false for the unchanged rule, and true after switching the preset', () => {
    const initial: EventFormValues = { ...base, recurrence: 'custom', customRule: 'FREQ=WEEKLY;BYDAY=MO' }
    expect(ruleChanged(initial, initial)).toBe(false)
    expect(ruleChanged({ ...initial, recurrence: 'daily' }, initial)).toBe(true)
  })

  it('is true when only the custom rule text differs', () => {
    const initial: EventFormValues = { ...base, recurrence: 'custom', customRule: 'FREQ=WEEKLY;BYDAY=MO' }
    expect(ruleChanged({ ...initial, customRule: 'FREQ=WEEKLY;BYDAY=TU' }, initial)).toBe(true)
  })
})

describe('initial values', () => {
  it('takes a title over into the create values', () => {
    const start = new Date(2026, 8, 25, 14, 0)
    expect(createFormValues({ start, end: start, allDay: false, title: 'Review' }, 'c1', TZ).title).toBe('Review')
    expect(createFormValues({ start, end: start, allDay: false }, 'c1', TZ).title).toBe('')
  })

  it('creates timed and all-day defaults', () => {
    const start = new Date(2026, 8, 25, 14, 0)
    const end = new Date(2026, 8, 25, 15, 0)
    expect(createFormValues({ start, end, allDay: false }, 'c1', TZ)).toMatchObject({
      startDate: '2026-09-25',
      startTime: '14:00',
      endTime: '15:00',
      calendarId: 'c1',
    })
    expect(createFormValues({ start, end: start, allDay: true }, 'c1', TZ)).toMatchObject({
      allDay: true,
      endDate: '2026-09-25',
    })
  })

  it('gives a switch from all-day to timed 30 minutes from 09:00 (FR-09)', () => {
    expect(createFormValues({ start: new Date(2026, 8, 25), end: new Date(2026, 8, 25), allDay: true }, 'c1', TZ)).toMatchObject({
      startTime: '09:00',
      endTime: '09:30',
    })
  })

  it('maps events back to form values', () => {
    const timed = toCalEvent(apiEvent({ rrule: 'FREQ=WEEKLY;BYDAY=MO', recurring: true }))
    expect(editFormValues(timed, TZ)).toMatchObject({
      startDate: '2026-09-25',
      startTime: '10:00',
      endTime: '11:00',
      recurrence: 'custom',
      customRule: 'FREQ=WEEKLY;BYDAY=MO',
    })
    const allDay = toCalEvent(apiEvent({ allDay: true, start: '2026-09-25T00:00:00Z', end: '2026-09-27T00:00:00Z' }))
    expect(editFormValues(allDay, TZ)).toMatchObject({
      allDay: true,
      startDate: '2026-09-25',
      startTime: '09:00',
      endDate: '2026-09-26',
      endTime: '09:30',
    })
  })
})

// An event is edited in its own zones, and a save names them only where they changed (FR-17, FR-18).
describe('time zones', () => {
  // A weekly series on Tuesdays and Thursdays at 18:00 in New York; its event of 10 November is at
  // midnight in Berlin, a day later.
  const newYork = (p: Partial<ApiEvent> = {}) =>
    toCalEvent(
      apiEvent({
        start: '2026-11-10T23:00:00Z',
        end: '2026-11-11T00:00:00Z',
        timezone: 'America/New_York',
        endTimezone: 'America/New_York',
        recurring: true,
        rrule: 'FREQ=WEEKLY;BYDAY=TU,TH',
        recurrenceId: '2026-11-10T23:00:00Z',
        ...p,
      }),
    )
  const zoneKeys = (input: object) => ['timezone', 'endTimezone'].filter((key) => key in input)

  it('opens a New York series in New York', () => {
    expect(editFormValues(newYork(), TZ)).toMatchObject({
      startDate: '2026-11-10',
      startTime: '18:00',
      endDate: '2026-11-10',
      endTime: '19:00',
      startZone: 'America/New_York',
      endZone: 'America/New_York',
      recurrence: 'custom',
      customRule: 'FREQ=WEEKLY;BYDAY=TU,TH',
    })
  })

  it('opens an exception moved to another time in the zone of its series', () => {
    // 10:00 in New York, 16:00 in Berlin; its place in the rule is 18:00 in New York.
    const moved = newYork({ start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' })
    expect(editFormValues(moved, TZ)).toMatchObject({
      startDate: '2026-11-10',
      startTime: '10:00',
      endTime: '11:00',
      startZone: 'America/New_York',
      customRule: 'FREQ=WEEKLY;BYDAY=TU,TH',
    })
  })

  it('opens a series without a zone in UTC', () => {
    const at = { start: '2027-01-18T08:00:00Z', end: '2027-01-18T09:00:00Z' }
    const series = toCalEvent(
      apiEvent({ ...at, timezone: '', endTimezone: '', recurring: true, rrule: 'FREQ=WEEKLY', recurrenceId: at.start }),
    )
    expect(editFormValues(series, TZ)).toMatchObject({ startTime: '08:00', endTime: '09:00', startZone: 'UTC', endZone: 'UTC' })
    const single = toCalEvent(apiEvent({ ...at, timezone: '', endTimezone: '' }))
    expect(editFormValues(single, TZ)).toMatchObject({ startTime: '09:00', endTime: '10:00', startZone: '', endZone: '' })
  })

  it('opens an all-day event without zones', () => {
    const allDay = toCalEvent(apiEvent({ allDay: true, start: '2026-09-25T00:00:00Z', end: '2026-09-26T00:00:00Z' }))
    expect(editFormValues(allDay, TZ)).toMatchObject({ startZone: '', endZone: '' })
  })

  it("treats a legacy zone name as the browser's", () => {
    const kolkata = toCalEvent(apiEvent({ timezone: 'Asia/Kolkata', endTimezone: 'Asia/Kolkata' }))
    const v = editFormValues(kolkata, 'Asia/Calcutta')
    expect(zonesChanged(v, editFormValues(kolkata, 'Asia/Calcutta'))).toBe(false)
    expect(zoneKeys(formToInput(v, 'Asia/Calcutta', kolkata))).toEqual([])
    // Picking the browser's name of the same zone changes nothing either.
    const picked = withStartZone(v, 'Asia/Calcutta')
    expect(zonesChanged(picked, v)).toBe(false)
    expect(zoneKeys(formToInput(picked, 'Asia/Calcutta', kolkata))).toEqual([])
  })

  it("opens an event in a zone the browser doesn't know", () => {
    const mars = toCalEvent(apiEvent({ timezone: 'Mars/Olympus', endTimezone: 'Mars/Olympus' }))
    const v = editFormValues(mars, TZ)
    // Kept, and its fields in the browser's zone: 08:00Z is 10:00 in Berlin.
    expect(v).toMatchObject({ startZone: 'Mars/Olympus', endZone: 'Mars/Olympus', startTime: '10:00', endTime: '11:00' })
    expect(eventFormSchema.safeParse(v).success).toBe(true)
    expect(formToInput(v, TZ, mars)).toMatchObject({ start: '2026-09-25T08:00:00.000Z', end: '2026-09-25T09:00:00.000Z' })
    expect(zoneKeys(formToInput(v, TZ, mars))).toEqual([])
    expect(formToInput({ ...v, title: 'Renamed', startTime: '10:30' }, TZ, mars).start).toBe('2026-09-25T08:30:00.000Z')
  })

  it('sends no zone for an unchanged event', () => {
    const series = newYork()
    const input = formToInput(editFormValues(series, TZ), TZ, series)
    expect('timezone' in input).toBe(false)
    expect('endTimezone' in input).toBe(false)
    expect(input).toMatchObject({ start: '2026-11-10T23:00:00.000Z', rrule: 'FREQ=WEEKLY;BYDAY=TU,TH' })
    const single = toCalEvent(apiEvent())
    expect(zoneKeys(formToInput({ ...editFormValues(single, TZ), startTime: '11:00' }, TZ, single))).toEqual([])
  })

  // A changed rule keeps the series in its zone, where the rule is built.
  it('sends a changed rule as built in the series\' zone, and no zone', () => {
    const series = newYork()
    const input = formToInput({ ...editFormValues(series, TZ), customRule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH' }, TZ, series)
    expect(input.rrule).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH')
    expect(zoneKeys(input)).toEqual([])
  })

  it('fits the end of a changed rule in the start\'s zone', () => {
    const series = newYork()
    const input = formToInput({ ...editFormValues(series, TZ), customRule: 'FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20261231' }, TZ, series)
    // The end of 31 December in New York.
    expect(input.rrule).toBe('FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20270101T045959Z')
  })

  it('keeps the clock on a zone change', () => {
    const series = newYork()
    const v = withStartZone(editFormValues(series, TZ), 'Europe/Berlin')
    expect(v).toMatchObject({ startZone: 'Europe/Berlin', endZone: 'Europe/Berlin', startTime: '18:00', endTime: '19:00' })
    expect(formToInput(v, TZ, series)).toMatchObject({
      start: '2026-11-10T17:00:00.000Z',
      end: '2026-11-10T18:00:00.000Z',
      timezone: 'Europe/Berlin',
      endTimezone: 'Europe/Berlin',
    })
  })

  it('an unlinked end keeps its zone', () => {
    const series = newYork()
    const v = { ...editFormValues(series, TZ), endZone: 'Asia/Tokyo' }
    const moved = withStartZone(v, 'Europe/Berlin')
    expect(moved.endZone).toBe('Asia/Tokyo')
    expect(formToInput(moved, TZ, series)).toMatchObject({ timezone: 'Europe/Berlin', endTimezone: 'Asia/Tokyo' })
    // A change of the end alone sends the end's only: the start keeps its zone and form.
    const endOnly = formToInput(v, TZ, series)
    expect(zoneKeys(endOnly)).toEqual(['endTimezone'])
    expect(endOnly.endTimezone).toBe('Asia/Tokyo')
    // Set back to the start's, the end follows it again.
    expect(withStartZone({ ...moved, endZone: 'Europe/Berlin' }, 'Asia/Seoul').endZone).toBe('Asia/Seoul')
  })

  // A series without a start zone (floating, a TZID Lucid can't resolve) is shown in UTC: sending that back would
  // write it in UTC for every other app.
  it('sends no start zone for a series without one whose end zone alone changed', () => {
    const at = { start: '2026-03-17T18:00:00Z', end: '2026-03-17T19:00:00Z' }
    const series = toCalEvent(
      apiEvent({ ...at, timezone: '', endTimezone: '', recurring: true, rrule: 'FREQ=WEEKLY', recurrenceId: at.start }),
    )
    const input = formToInput({ ...editFormValues(series, TZ), endZone: 'Asia/Tokyo' }, TZ, series)
    expect('timezone' in input).toBe(false)
    expect(input.endTimezone).toBe('Asia/Tokyo')
    // The start as it was; the end at 19:00 as before, now in Tokyo.
    expect(input).toMatchObject({ start: '2026-03-17T18:00:00.000Z', end: '2026-03-17T10:00:00.000Z' })
  })

  it('sends the zone of an unlinked end with a changed start, so it does not follow the start', () => {
    const series = newYork({ endTimezone: 'Asia/Tokyo', end: '2026-11-11T00:00:00Z' })
    const v = withStartZone(editFormValues(series, TZ), 'Europe/Berlin')
    expect(v.endZone).toBe('Asia/Tokyo')
    expect(formToInput(v, TZ, series)).toMatchObject({ timezone: 'Europe/Berlin', endTimezone: 'Asia/Tokyo' })
    // An end the series has in UTC goes back as "UTC", which keeps its form, not as a UTC picked.
    const utcEnd = newYork({ endTimezone: '' })
    const moved = withStartZone(editFormValues(utcEnd, TZ), 'Europe/Berlin')
    expect(moved.endZone).toBe('UTC')
    expect(formToInput(moved, TZ, utcEnd)).toMatchObject({ timezone: 'Europe/Berlin', endTimezone: 'UTC' })
  })

  // A browser that reports UTC offers it as "Where you are now": picked, it is stored, as every zone picked is.
  it('sends a changed zone that names UTC as a UTC picked', () => {
    const single = toCalEvent(apiEvent({ timezone: '', endTimezone: '' }))
    const v = withStartZone(editFormValues(single, 'UTC'), 'UTC')
    expect(formToInput(v, 'UTC', single)).toMatchObject({ timezone: PICKED_UTC, endTimezone: PICKED_UTC })
    const zoned = toCalEvent(apiEvent({ timezone: 'America/New_York', endTimezone: 'America/New_York' }))
    expect(formToInput({ ...editFormValues(zoned, TZ), endZone: 'GMT' }, TZ, zoned)).toMatchObject({ endTimezone: PICKED_UTC })
    // Unchanged, it is not sent; the ✕ still sends none.
    const series = newYork({ timezone: '', endTimezone: '' })
    expect(zoneKeys(formToInput(editFormValues(series, 'UTC'), 'UTC', series))).toEqual([])
    expect(formToInput({ ...editFormValues(zoned, 'UTC'), startZone: '', endZone: '' }, 'UTC', zoned)).toMatchObject({
      timezone: '',
      endTimezone: '',
    })
  })

  it('tells a changed zone of either row', () => {
    const v = editFormValues(newYork(), TZ)
    expect(zonesChanged(v, v)).toBe(false)
    expect(zonesChanged({ ...v, startZone: 'Europe/Berlin' }, v)).toBe(true)
    expect(zonesChanged({ ...v, endZone: '' }, v)).toBe(true)
    expect(zonesChanged({ ...v, endZone: 'US/Eastern' }, v)).toBe(false)
  })

  it("a new single event sends no zone, a new series the browser's", () => {
    const created = createFormValues({ start: new Date(2026, 8, 25, 14), end: new Date(2026, 8, 25, 15), allDay: false }, 'c1', TZ)
    expect(created).toMatchObject({ startZone: '', endZone: '' })
    expect(zoneKeys(formToInput(created, TZ))).toEqual([])
    expect(formToInput({ ...created, recurrence: 'weekly' }, TZ)).toMatchObject({ timezone: TZ, endTimezone: TZ })
    // A zone picked for a new event is sent.
    expect(formToInput({ ...created, startZone: 'Asia/Tokyo', endZone: 'Asia/Tokyo' }, TZ)).toMatchObject({
      start: '2026-09-25T05:00:00.000Z',
      timezone: 'Asia/Tokyo',
      endTimezone: 'Asia/Tokyo',
    })
  })

  it("gives an event that becomes a timed series the browser's zone for a row without one", () => {
    const single = toCalEvent(apiEvent({ timezone: '', endTimezone: '' }))
    expect(formToInput({ ...editFormValues(single, TZ), recurrence: 'weekly' }, TZ, single)).toMatchObject({ timezone: TZ, endTimezone: TZ })
    const allDay = toCalEvent(
      apiEvent({ allDay: true, recurring: true, rrule: 'FREQ=WEEKLY', start: '2026-09-25T00:00:00Z', end: '2026-09-26T00:00:00Z', recurrenceId: '2026-09-25T00:00:00Z' }),
    )
    expect(formToInput({ ...editFormValues(allDay, TZ), allDay: false }, TZ, allDay)).toMatchObject({ timezone: TZ, endTimezone: TZ })
    // A single event with zones keeps them.
    const zoned = toCalEvent(apiEvent({ timezone: 'America/New_York', endTimezone: 'America/New_York' }))
    expect(zoneKeys(formToInput({ ...editFormValues(zoned, TZ), recurrence: 'weekly' }, TZ, zoned))).toEqual([])
  })

  it('sends no zone for an all-day event', () => {
    expect(zoneKeys(formToInput({ ...base, allDay: true }, TZ))).toEqual([])
    const series = newYork()
    const v = { ...withStartZone(editFormValues(series, TZ), 'Asia/Tokyo'), allDay: true }
    expect(zoneKeys(formToInput(v, TZ, series))).toEqual([])
  })

  it('the ✕ of a single event sends UTC', () => {
    const single = toCalEvent(apiEvent({ timezone: 'America/New_York', endTimezone: 'America/New_York' }))
    const v = { ...editFormValues(single, TZ), startZone: '', endZone: '' }
    // 04:00 and 05:00 as in New York, now in Berlin.
    expect(formToInput(v, TZ, single)).toMatchObject({
      start: '2026-09-25T02:00:00.000Z',
      end: '2026-09-25T03:00:00.000Z',
      timezone: '',
      endTimezone: '',
    })
  })

  it("the ✕ of a series sends the browser's zone", () => {
    const series = newYork()
    const v = { ...editFormValues(series, TZ), startZone: '', endZone: '' }
    expect(formToInput(v, TZ, series)).toMatchObject({ start: '2026-11-10T17:00:00.000Z', timezone: TZ, endTimezone: TZ })
    // A series whose rule goes is a single event after the save: no zone.
    expect(formToInput({ ...v, recurrence: 'none' }, TZ, series)).toMatchObject({ timezone: '', endTimezone: '' })
  })

  it('a picked UTC is Etc/UTC', () => {
    const single = toCalEvent(apiEvent())
    const v = { ...editFormValues(single, TZ), startZone: PICKED_UTC, endZone: PICKED_UTC }
    expect(formToInput(v, TZ, single)).toMatchObject({
      start: '2026-09-25T10:00:00.000Z',
      timezone: 'Etc/UTC',
      endTimezone: 'Etc/UTC',
    })
  })

  it('drops the zones for only this event', () => {
    const series = newYork()
    const input = formToInput(withStartZone(editFormValues(series, TZ), 'Asia/Tokyo'), TZ, series)
    expect(input).toMatchObject({ timezone: 'Asia/Tokyo', endTimezone: 'Asia/Tokyo' })
    expect(zoneKeys(occurrenceInput(input))).toEqual([])
  })

  // #10: the hour summer time repeats can't be told apart in the fields; the start's zone counts too.
  it('keeps the instant of a row only while its zone stays too', () => {
    // 02:30 CET, the second pass of the hour on the night Berlin leaves summer time.
    const event = toCalEvent(apiEvent({ start: '2026-10-25T01:30:00Z', end: '2026-10-25T02:30:00Z' }))
    const v = editFormValues(event, TZ)
    expect(formToInput({ ...v, title: 'Renamed' }, TZ, event).start).toBe('2026-10-25T01:30:00.000Z')
    // 02:30 in London is 02:30 GMT.
    expect(formToInput(withStartZone(v, 'Europe/London'), TZ, event).start).toBe('2026-10-25T02:30:00.000Z')
  })

  it('measures the length across zones', () => {
    const across = { ...base, startDate: '2026-10-28', startTime: '10:00', startZone: 'Europe/Berlin', endDate: '2026-10-28', endTime: '13:00', endZone: 'America/New_York' }
    expect(formDuration(across, TZ)).toEqual({ minutes: 480 })
    // A row in a zone the browser doesn't know is in the browser's.
    expect(formDuration({ ...across, startZone: 'Mars/Olympus' }, TZ)).toEqual({ minutes: 480 })
  })

  it('refuses an end before the start across zones', () => {
    const across = { ...base, startDate: '2026-10-28', startTime: '10:00', startZone: 'Europe/Berlin', endDate: '2026-10-28', endZone: 'America/New_York' }
    // 03:00 in New York is 08:00 in Berlin.
    const r = eventFormSchema.safeParse({ ...across, endTime: '03:00' })
    expect(r.error?.issues.map((i) => [i.message, i.path[0]])).toEqual([['validation.endBeforeStart', 'endDate']])
    expect(formDuration({ ...across, endTime: '03:00' }, TZ)).toBeNull()
    // 05:00 in New York is 10:00 in Berlin.
    expect(eventFormSchema.safeParse({ ...across, endTime: '05:00' }).success).toBe(true)
    // 16:00 in New York is after 20:00 in Berlin, though its clock reads earlier.
    expect(eventFormSchema.safeParse({ ...across, startTime: '20:00', endTime: '16:00' }).success).toBe(true)
  })
})

describe('shiftEnd', () => {
  it('keeps the duration of timed events', () => {
    expect(shiftEnd(base, '2026-03-28', '23:45')).toEqual({ endDate: '2026-03-29', endTime: '00:15' })
  })

  // FR-18: an event at 09:00Z-10:00Z, from 10:00 in Berlin to 06:00 in New York.
  it('keeps the length of an event whose end is in another zone', () => {
    const across = { ...base, startDate: '2026-10-28', startTime: '10:00', startZone: 'Europe/Berlin', endDate: '2026-10-28', endTime: '06:00', endZone: 'America/New_York' }
    expect(shiftEnd(across, '2026-10-28', '11:00', TZ)).toEqual({ endDate: '2026-10-28', endTime: '07:00' })
    // Into the next day in New York's dates.
    expect(shiftEnd(across, '2026-10-29', '06:30', TZ)).toEqual({ endDate: '2026-10-29', endTime: '02:30' })
  })

  it("keeps the clock's length within one zone across a change of summer time", () => {
    const berlin = { ...base, startDate: '2026-03-28', startTime: '23:00', startZone: 'Europe/Berlin', endDate: '2026-03-29', endTime: '01:00', endZone: 'Europe/Berlin' }
    // Two hours on the clock, one of them skipped: 03:00, as today, not the instant's 04:00.
    expect(shiftEnd(berlin, '2026-03-29', '01:00', TZ)).toEqual({ endDate: '2026-03-29', endTime: '03:00' })
  })

  it("reads a zone the browser doesn't know as the browser's, as the fields do", () => {
    // 10:00 in Tokyo to 03:00 in Berlin's fields (01:00Z-02:00Z).
    const unknownEnd = { ...base, startDate: '2026-10-28', startTime: '10:00', startZone: 'Asia/Tokyo', endDate: '2026-10-28', endTime: '03:00', endZone: 'Mars/Olympus' }
    expect(shiftEnd(unknownEnd, '2026-10-28', '11:00', TZ)).toEqual({ endDate: '2026-10-28', endTime: '04:00' })
    // With the start in Berlin, both rows are in one zone: on the clock.
    expect(shiftEnd({ ...unknownEnd, startTime: '02:00', startZone: TZ }, '2026-10-28', '23:30', TZ)).toEqual({ endDate: '2026-10-29', endTime: '00:30' })
  })

  it('keeps the day span of all-day events', () => {
    expect(shiftEnd({ ...base, allDay: true, endDate: '2026-03-30' }, '2026-04-01', '09:00')).toEqual({
      endDate: '2026-04-03',
      endTime: '09:30',
    })
  })

  it('leaves invalid input alone', () => {
    expect(shiftEnd({ ...base, startDate: '' }, '2026-04-01', '09:00')).toEqual({ endDate: '2026-03-28', endTime: '09:30' })
    expect(shiftEnd({ ...base, startTime: '' }, '2026-04-01', '09:00')).toEqual({ endDate: '2026-03-28', endTime: '09:30' })
  })

  // FR-09: an end its field couldn't read stays as typed, for its note to say what to type, as a start does.
  it('keeps an end that is unreadable as it is', () => {
    expect(shiftEnd({ ...base, endDate: '3/x' }, '2026-04-01', '09:00')).toEqual({ endDate: '3/x', endTime: '09:30' })
    expect(shiftEnd({ ...base, allDay: true, endDate: '3/x' }, '2026-04-01', '09:00')).toEqual({ endDate: '3/x', endTime: '09:30' })
    expect(shiftEnd({ ...base, endTime: '9:3x' }, '2026-04-01', '09:00')).toEqual({ endDate: '2026-03-28', endTime: '9:3x' })
  })

  // A date in the forms' shape that doesn't exist can't be read either (FR-09).
  it("keeps the end for a date in the forms' shape that doesn't exist", () => {
    expect(shiftEnd({ ...base, endDate: '2026-02-31' }, '2026-04-01', '09:00')).toEqual({ endDate: '2026-02-31', endTime: '09:30' })
    expect(shiftEnd(base, '2026-13-45', '09:00')).toEqual({ endDate: '2026-03-28', endTime: '09:30' })
    expect(shiftEnd({ ...base, allDay: true }, '2026-02-31', '09:00')).toEqual({ endDate: '2026-03-28', endTime: '09:30' })
  })
})

describe('formDuration', () => {
  it('measures timed events in minutes, across midnight too', () => {
    expect(formDuration(base, TZ)).toEqual({ minutes: 30 })
    expect(formDuration({ ...base, startTime: '23:15', endDate: '2026-03-29', endTime: '01:00' }, TZ)).toEqual({ minutes: 105 })
  })

  it('measures wall-clock time across a DST change', () => {
    // Berlin skips 02:00-03:00 on 2026-03-29; the form still shows two hours.
    expect(formDuration({ ...base, startDate: '2026-03-29', startTime: '01:00', endDate: '2026-03-29', endTime: '03:00' }, TZ)).toEqual({
      minutes: 120,
    })
  })

  it('counts the days of all-day events, the last day included', () => {
    expect(formDuration({ ...base, allDay: true }, TZ)).toEqual({ days: 1 })
    expect(formDuration({ ...base, allDay: true, endDate: '2026-03-30' }, TZ)).toEqual({ days: 3 })
  })

  it('has no duration while the end lies before the start or a value is invalid', () => {
    expect(formDuration({ ...base, endTime: '08:00' }, TZ)).toBeNull()
    expect(formDuration({ ...base, allDay: true, endDate: '2026-03-27' }, TZ)).toBeNull()
    expect(formDuration({ ...base, endDate: '' }, TZ)).toBeNull()
    expect(formDuration({ ...base, startTime: '9' }, TZ)).toBeNull()
    expect(formDuration({ ...base, startDate: '2026-02-31' }, TZ)).toBeNull()
    expect(formDuration({ ...base, allDay: true, endDate: '2026-04-31' }, TZ)).toBeNull()
  })
})

describe('timeOptions', () => {
  it('lists the day in steps', () => {
    const opts = timeOptions(30)
    expect(opts).toHaveLength(48)
    expect(opts[0]).toBe('00:00')
    expect(opts[1]).toBe('00:30')
    expect(opts.at(-1)).toBe('23:30')
  })
})
