import { afterEach, describe, expect, it, vi } from 'vitest'
import { browserLocale, browserTimeZone, detectHourCycle, detectWeekStart, pickLanguage } from './locale'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('detectWeekStart', () => {
  it.each([
    ['en-US', 0],
    ['en', 0], // maximized to en-Latn-US
    ['de-DE', 1],
    ['de', 1],
    ['en-GB', 1],
    ['fr-FR', 1],
    ['ar-EG', 6],
    ['pt-BR', 0],
  ])('%s → %i', (tag, expected) => {
    expect(detectWeekStart(tag)).toBe(expected)
  })

  it('falls back to Monday for invalid tags', () => {
    expect(detectWeekStart('not a locale!!')).toBe(1)
  })

  it('uses the CLDR region table without Intl week info', () => {
    const proto = Intl.Locale.prototype as unknown as Record<string, unknown>
    const saved = Object.getOwnPropertyDescriptor(proto, 'getWeekInfo')
    const savedProp = Object.getOwnPropertyDescriptor(proto, 'weekInfo')
    try {
      Object.defineProperty(proto, 'getWeekInfo', { value: undefined, configurable: true })
      Object.defineProperty(proto, 'weekInfo', { get: () => undefined, configurable: true })
      expect(detectWeekStart('en-US')).toBe(0)
      expect(detectWeekStart('ar-SA')).toBe(0)
      expect(detectWeekStart('fa-IR')).toBe(6)
      expect(detectWeekStart('de-DE')).toBe(1)
      expect(detectWeekStart('ja')).toBe(0)
    } finally {
      if (saved) Object.defineProperty(proto, 'getWeekInfo', saved)
      else delete proto.getWeekInfo
      if (savedProp) Object.defineProperty(proto, 'weekInfo', savedProp)
      else delete proto.weekInfo
    }
  })

  it('maps unusual first days (e.g. Friday) to Monday', () => {
    const proto = Intl.Locale.prototype as unknown as Record<string, unknown>
    const saved = Object.getOwnPropertyDescriptor(proto, 'getWeekInfo')
    try {
      Object.defineProperty(proto, 'getWeekInfo', { value: () => ({ firstDay: 5 }), configurable: true })
      expect(detectWeekStart('xx-MV')).toBe(1)
    } finally {
      if (saved) Object.defineProperty(proto, 'getWeekInfo', saved)
      else delete proto.getWeekInfo
    }
  })
})

describe('detectHourCycle', () => {
  it.each([
    ['en-US', '12h'],
    ['en-GB', '24h'],
    ['de-DE', '24h'],
    ['ja-JP', '24h'],
  ])('%s → %s', (tag, expected) => {
    expect(detectHourCycle(tag)).toBe(expected)
  })

  it('falls back to DateTimeFormat without Intl hour cycle info', () => {
    const proto = Intl.Locale.prototype as unknown as Record<string, unknown>
    const saved = Object.getOwnPropertyDescriptor(proto, 'getHourCycles')
    const savedProp = Object.getOwnPropertyDescriptor(proto, 'hourCycles')
    try {
      Object.defineProperty(proto, 'getHourCycles', { value: undefined, configurable: true })
      Object.defineProperty(proto, 'hourCycles', { get: () => undefined, configurable: true })
      expect(detectHourCycle('en-US')).toBe('12h')
      expect(detectHourCycle('de-DE')).toBe('24h')
    } finally {
      if (saved) Object.defineProperty(proto, 'getHourCycles', saved)
      else delete proto.getHourCycles
      if (savedProp) Object.defineProperty(proto, 'hourCycles', savedProp)
      else delete proto.hourCycles
    }
  })

  it('defaults to 24h for invalid tags', () => {
    expect(detectHourCycle('not a locale!!')).toBe('24h')
  })
})

describe('browser helpers', () => {
  it('reads navigator.languages', () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['de-AT', 'en'])
    expect(browserLocale()).toBe('de-AT')
  })

  it('falls back to navigator.language', () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue([])
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('fr-FR')
    expect(browserLocale()).toBe('fr-FR')
  })

  it('returns the configured time zone', () => {
    expect(browserTimeZone()).toBe('Europe/Berlin')
  })

  it.each([
    ['de-AT', 'de'],
    ['DE', 'de'],
    ['en_GB', 'en'],
    ['fr', 'en'],
    [undefined, 'en'],
  ])('pickLanguage(%s) → %s', (tag, lang) => {
    expect(pickLanguage(tag)).toBe(lang)
  })
})
