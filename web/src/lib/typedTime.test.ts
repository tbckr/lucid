import { de } from 'date-fns/locale/de'
import { enUS } from 'date-fns/locale/en-US'
import { ko } from 'date-fns/locale/ko'
import { describe, expect, it } from 'vitest'
import { formatClock, type FormatPrefs } from './format'
import { readTime, timeExample } from './typedTime'

const us: FormatPrefs = { tag: 'en-US', locale: enUS, hourCycle: '12h', weekStartsOn: 0 }
const de24: FormatPrefs = { tag: 'de-DE', locale: de, hourCycle: '24h', weekStartsOn: 1 }
const de12: FormatPrefs = { tag: 'de-DE', locale: de, hourCycle: '12h', weekStartsOn: 1 }
const ko12: FormatPrefs = { tag: 'ko-KR', locale: ko, hourCycle: '12h', weekStartsOn: 0 }

describe('readTime in the 24-hour clock', () => {
  it.each([
    ['9', '09:00'],
    ['14', '14:00'],
    ['940', '09:40'],
    ['0940', '09:40'],
    ['1340', '13:40'],
    ['9:40', '09:40'],
    ['9.40', '09:40'],
    ['9h40', '09:40'],
    ['9h', '09:00'],
    ['9 40', '09:40'],
    ['9 : 40', '09:40'],
    ['09:05', '09:05'],
    [' 9:40 ', '09:40'],
    ['9 pm', '21:00'],
    ['0', '00:00'],
    ['23:59', '23:59'],
  ])('%j reads as %s', (text, want) => {
    expect(readTime(text, { prefs: de24, current: '' })).toBe(want)
  })

  it.each([
    [''],
    ['  '],
    ['24:00'],
    ['24'],
    ['9:60'],
    ['12345'],
    ['abc'],
    ['9:4x'],
    ['9:4'],
    ['13pm'],
    ['0am'],
    ['9::40'],
    ['9:40:10'],
    ['9 pm pm'],
    ['pm'],
  ])('%j is unreadable', (text) => {
    expect(readTime(text, { prefs: de24, current: '' })).toBeNull()
  })
})

describe('readTime with day period markers', () => {
  it.each([
    ['9p', '21:00'],
    ['9:40am', '09:40'],
    ['9:40 PM', '21:40'],
    ['12a', '00:00'],
    ['12p', '12:00'],
    ['12:30 am', '00:30'],
    ['1 PM', '13:00'],
    ['9:40 a.m.', '09:40'],
    ['9:40 p.m.', '21:40'],
    ['am 9', '09:00'],
    ['PM 9:40', '21:40'],
  ])('%j reads as %s', (text, want) => {
    expect(readTime(text, { prefs: us, current: '14:00' })).toBe(want)
  })

  it('takes the markers of the date-fns locale, before or after the time', () => {
    expect(readTime('2:00 nachm.', { prefs: de12, current: '' })).toBe('14:00')
    expect(readTime('2:00 NACHMITTAGS', { prefs: de12, current: '' })).toBe('14:00')
    expect(readTime('9:40 vorm.', { prefs: de12, current: '' })).toBe('09:40')
    expect(readTime('9:40 vm.', { prefs: de12, current: '' })).toBe('09:40')
    expect(readTime('nachm. 2:00', { prefs: de12, current: '' })).toBe('14:00')
    expect(readTime('2:00 오후', { prefs: ko12, current: '' })).toBe('14:00')
    expect(readTime('오전 9:40', { prefs: ko12, current: '' })).toBe('09:40')
    expect(readTime('오후2', { prefs: ko12, current: '' })).toBe('14:00')
  })

  it('takes the markers of the locale in any hour cycle, and English ones in any locale', () => {
    expect(readTime('2 nachm.', { prefs: de24, current: '' })).toBe('14:00')
    expect(readTime('2 pm', { prefs: de12, current: '' })).toBe('14:00')
    expect(readTime('2 pm', { prefs: ko12, current: '' })).toBe('14:00')
  })

  it('does not take the markers of another locale', () => {
    expect(readTime('2:00 nachm.', { prefs: us, current: '' })).toBeNull()
  })
})

describe('readTime in the 12-hour clock without a marker', () => {
  it.each([
    ['keeps the afternoon', '5', '14:00', '17:00'],
    ['keeps the morning', '5', '09:00', '05:00'],
    ['keeps the afternoon of a time with minutes', '5:30', '23:30', '17:30'],
    ['keeps the morning of a time with digits only', '530', '11:59', '05:30'],
    ['keeps noon as the afternoon', '5', '12:00', '17:00'],
    ['keeps midnight as the morning', '5', '00:00', '05:00'],
    ['reads 13 as the 24-hour clock', '13', '09:00', '13:00'],
    ['reads 23:30 as the 24-hour clock', '23:30', '09:00', '23:30'],
    ['reads 0 as the 24-hour clock', '0', '14:00', '00:00'],
    ['reads 0:30 as the 24-hour clock', '0:30', '14:00', '00:30'],
    ['reads 12 as noon after midnight', '12', '00:00', '12:00'],
    ['reads 12 as noon in the morning', '12', '09:00', '12:00'],
    ['reads 12 as noon in the afternoon', '12', '14:00', '12:00'],
    ['reads 12 as noon in an empty field', '12', '', '12:00'],
    ['reads 12:15 as noon', '12:15', '09:00', '12:15'],
    ['reads 1 to 6 as the afternoon in an empty field', '5', '', '17:00'],
    ['reads 7 as the morning in an empty field', '7', '', '07:00'],
    ['reads 11 as the morning in an empty field', '11', '', '11:00'],
    ['reads 6 as the afternoon in an empty field', '6', '', '18:00'],
    ['reads 1 as the afternoon in an empty field', '1', '', '13:00'],
    ['reads 6:59 as the afternoon in an empty field', '6:59', '', '18:59'],
    ['reads 7:00 as the morning in an empty field', '7:00', '', '07:00'],
    ['reads a current value it does not know like an empty field', '5', 'noon', '17:00'],
    ['reads a current value in the shape of a time that is none like an empty field', '9', '25:00', '09:00'],
    ['reads an hour with a leading zero as the 24-hour clock', '09:40', '14:00', '09:40'],
    ['reads four digits with a leading zero as the 24-hour clock', '0940', '14:00', '09:40'],
    ['reads a bare hour with a leading zero as the 24-hour clock', '09', '14:00', '09:00'],
    ['reads a leading zero as the 24-hour clock in an empty field', '05', '', '05:00'],
    ['reads 00:30 as the 24-hour clock', '00:30', '14:00', '00:30'],
    ['reads three digits without a leading zero by the 12-hour rules', '940', '14:00', '21:40'],
    ['lets a marker win over a leading zero', '09pm', '14:00', '21:00'],
  ])('%s', (_, text, current, want) => {
    expect(readTime(text, { prefs: us, current })).toBe(want)
  })

  it('does the same in every 12-hour locale', () => {
    expect(readTime('5', { prefs: de12, current: '14:00' })).toBe('17:00')
    expect(readTime('5', { prefs: ko12, current: '09:00' })).toBe('05:00')
  })

  it('leaves the 24-hour clock alone', () => {
    expect(readTime('5', { prefs: de24, current: '14:00' })).toBe('05:00')
  })

  it('lets a marker win over the current half of the day', () => {
    expect(readTime('5 am', { prefs: us, current: '14:00' })).toBe('05:00')
    expect(readTime('5 pm', { prefs: us, current: '09:00' })).toBe('17:00')
  })
})

describe('readTime reads back what the field shows', () => {
  const values = ['00:00', '09:40', '12:00', '23:30']
  it.each([
    ['en-US', us],
    ['de-DE', de12],
    ['ko-KR', ko12],
  ])('%s, 12-hour clock', (_, p) => {
    for (const v of values) {
      expect(readTime(formatClock(v, p), { prefs: p, current: '' }), `${v} shown as ${formatClock(v, p)}`).toBe(v)
    }
  })

  it.each([
    ['en-US', us],
    ['de-DE', de12],
    ['ko-KR', ko12],
  ])('%s, whatever the field showed before', (_, p) => {
    for (const v of values) {
      for (const current of ['', '00:00', '09:00', '14:00']) {
        expect(readTime(formatClock(v, p), { prefs: p, current }), `${v} over ${current}`).toBe(v)
      }
    }
  })

  it('reads the 24-hour clock back', () => {
    for (const v of values) expect(readTime(formatClock(v, de24), { prefs: de24, current: '' })).toBe(v)
  })
})

describe('timeExample', () => {
  it.each([
    [us, '9:40 AM'],
    [de24, '09:40'],
    [de12, '9:40 vorm.'],
    [ko12, '9:40 오전'],
  ])('%o', (p, want) => {
    expect(timeExample(p)).toBe(want)
  })

  it('is a time the reader reads', () => {
    for (const p of [us, de24, de12, ko12]) expect(readTime(timeExample(p), { prefs: p, current: '' })).toBe('09:40')
  })
})
