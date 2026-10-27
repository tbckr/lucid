import { de } from 'date-fns/locale/de'
import { enUS } from 'date-fns/locale/en-US'
import { describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import { type FormatPrefs } from './format'
import { isFormDate, isFormTime, unreadableNote } from './unreadable'

const us: FormatPrefs = { tag: 'en-US', locale: enUS, hourCycle: '12h', weekStartsOn: 0 }
const de24: FormatPrefs = { tag: 'de-DE', locale: de, hourCycle: '24h', weekStartsOn: 1 }
const now = new Date(2026, 9, 28)

describe('unreadableNote (FR-09)', () => {
  it('says what date to type, in the user\'s format', () => {
    expect(unreadableNote(i18n.t, de24, now, [{ date: '28.13.' }])).toBe('Enter a date like 28.10.2026.')
    expect(unreadableNote(i18n.t, us, now, [{ date: '13/28' }])).toBe('Enter a date like 10/28/2026.')
  })

  it('says what time to type, in the user\'s format', () => {
    expect(unreadableNote(i18n.t, us, now, [{ time: '25:00' }])).toBe('Enter a time like 9:40 AM.')
    expect(unreadableNote(i18n.t, de24, now, [{ time: '9:4x' }])).toBe('Enter a time like 09:40.')
  })

  it('says nothing for values it can read, or empty ones', () => {
    expect(unreadableNote(i18n.t, us, now, [{ date: '2026-10-28', time: '09:40' }, { date: '', time: '' }, {}])).toBeUndefined()
    expect(unreadableNote(i18n.t, us, now, [])).toBeUndefined()
  })

  it('names a date before a time', () => {
    expect(unreadableNote(i18n.t, de24, now, [{ date: '28.13.' }, { time: '25:00' }])).toBe('Enter a date like 28.10.2026.')
    expect(unreadableNote(i18n.t, de24, now, [{ date: '2026-10-28', time: '25:00' }, { date: '31.02.' }])).toBe(
      'Enter a date like 28.10.2026.',
    )
  })
})

describe('isFormDate, isFormTime', () => {
  it('accept the forms\' values only', () => {
    expect(isFormDate('2026-10-28')).toBe(true)
    expect(isFormDate('28.10.2026')).toBe(false)
    expect(isFormTime('09:40')).toBe(true)
    expect(isFormTime('23:59')).toBe(true)
    expect(isFormTime('24:00')).toBe(false)
    expect(isFormTime('9:40')).toBe(false)
    expect(isFormTime('')).toBe(false)
  })
})
