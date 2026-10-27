import { describe, expect, it } from 'vitest'
import { defaultCreateTimes, newDraft } from './createDefaults'

describe('defaultCreateTimes', () => {
  it('starts at the next full hour today and lasts 30 minutes (FR-09)', () => {
    const today = new Date(2026, 8, 25)
    expect(defaultCreateTimes(today, new Date(2026, 8, 25, 10, 20))).toEqual({
      start: new Date(2026, 8, 25, 11),
      end: new Date(2026, 8, 25, 11, 30),
      allDay: false,
    })
  })

  it('starts at 09:00 on another day', () => {
    expect(defaultCreateTimes(new Date(2026, 8, 26), new Date(2026, 8, 25, 10, 20))).toEqual({
      start: new Date(2026, 8, 26, 9),
      end: new Date(2026, 8, 26, 9, 30),
      allDay: false,
    })
  })

  it('stays within the day late in the evening', () => {
    expect(defaultCreateTimes(new Date(2026, 8, 25), new Date(2026, 8, 25, 23, 10))).toEqual({
      start: new Date(2026, 8, 25, 23),
      end: new Date(2026, 8, 25, 23, 30),
      allDay: false,
    })
  })
})

describe('newDraft', () => {
  it('begins an event of 30 minutes', () => {
    expect(newDraft(new Date(2026, 8, 26), new Date(2026, 8, 25, 10, 20)).event).toMatchObject({
      startDate: '2026-09-26',
      startTime: '09:00',
      endDate: '2026-09-26',
      endTime: '09:30',
    })
  })
})
