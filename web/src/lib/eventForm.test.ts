import { describe, expect, it } from 'vitest'
import { apiEvent } from '@/test/fixtures'
import { toCalEvent } from './events'
import {
  createFormValues,
  editFormValues,
  eventFormSchema,
  formDuration,
  formToInput,
  shiftEnd,
  timeOptions,
  type EventFormValues,
} from './eventForm'

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

  it('compares dates only for all-day events', () => {
    expect(eventFormSchema.safeParse({ ...base, allDay: true, endTime: '08:00' }).success).toBe(true)
    expect(eventFormSchema.safeParse({ ...base, allDay: true, endDate: '2026-03-27' }).success).toBe(false)
  })

  it('validates formats and required calendar', () => {
    const r = eventFormSchema.safeParse({ ...base, startTime: '25:00', endDate: 'x', calendarId: '' })
    const messages = r.error?.issues.map((i) => i.message)
    expect(messages).toEqual(expect.arrayContaining(['validation.time', 'validation.date', 'validation.calendarRequired']))
  })
})

describe('formToInput', () => {
  it('converts timed values in the given zone (across DST)', () => {
    const input = formToInput({ ...base, endDate: '2026-03-29', endTime: '09:00' }, TZ)
    expect(input).toEqual({
      title: 'Standup',
      description: 'Notes',
      location: 'Room 1',
      start: '2026-03-28T08:00:00.000Z', // CET
      end: '2026-03-29T07:00:00.000Z', // CEST
      allDay: false,
      timezone: TZ,
      rrule: '',
    })
  })

  it('converts all-day values to UTC midnight with exclusive end', () => {
    const input = formToInput({ ...base, allDay: true, endDate: '2026-03-29', recurrence: 'yearly' }, TZ)
    expect(input.start).toBe('2026-03-28T00:00:00.000Z')
    expect(input.end).toBe('2026-03-30T00:00:00.000Z')
    expect(input.timezone).toBe('')
    expect(input.rrule).toBe('FREQ=YEARLY')
  })

  it('adds instanceStart for occurrences of recurring series', () => {
    const occurrence = toCalEvent(
      apiEvent({ recurring: true, rrule: 'FREQ=WEEKLY', recurrenceId: '2026-09-25T08:00:00Z' }),
    )
    expect(formToInput(base, TZ, occurrence).instanceStart).toBe('2026-09-25T08:00:00Z')
    expect(formToInput(base, TZ, toCalEvent(apiEvent()))).not.toHaveProperty('instanceStart')
  })
})

describe('initial values', () => {
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
    expect(editFormValues(allDay, TZ)).toMatchObject({ allDay: true, startDate: '2026-09-25', endDate: '2026-09-26' })
  })
})

describe('shiftEnd', () => {
  it('keeps the duration of timed events', () => {
    expect(shiftEnd(base, '2026-03-28', '23:45')).toEqual({ endDate: '2026-03-29', endTime: '00:15' })
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
})

describe('formDuration', () => {
  it('measures timed events in minutes, across midnight too', () => {
    expect(formDuration(base)).toEqual({ minutes: 30 })
    expect(formDuration({ ...base, startTime: '23:15', endDate: '2026-03-29', endTime: '01:00' })).toEqual({ minutes: 105 })
  })

  it('measures wall-clock time across a DST change', () => {
    // Berlin skips 02:00-03:00 on 2026-03-29; the form still shows two hours.
    expect(formDuration({ ...base, startDate: '2026-03-29', startTime: '01:00', endDate: '2026-03-29', endTime: '03:00' })).toEqual({
      minutes: 120,
    })
  })

  it('counts the days of all-day events, the last day included', () => {
    expect(formDuration({ ...base, allDay: true })).toEqual({ days: 1 })
    expect(formDuration({ ...base, allDay: true, endDate: '2026-03-30' })).toEqual({ days: 3 })
  })

  it('has no duration while the end lies before the start or a value is invalid', () => {
    expect(formDuration({ ...base, endTime: '08:00' })).toBeNull()
    expect(formDuration({ ...base, allDay: true, endDate: '2026-03-27' })).toBeNull()
    expect(formDuration({ ...base, endDate: '' })).toBeNull()
    expect(formDuration({ ...base, startTime: '9' })).toBeNull()
  })
})

describe('timeOptions', () => {
  it('lists the day in steps', () => {
    const opts = timeOptions(15)
    expect(opts).toHaveLength(96)
    expect(opts[0]).toBe('00:00')
    expect(opts.at(-1)).toBe('23:45')
  })
})
