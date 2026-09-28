import { type TFunction } from 'i18next'
import { formatMonthDay, formatPickerDate, type FormatPrefs } from './format'

/**
 * Minimal RRULE support for the event editor: the simple presets map to a
 * bare FREQ rule (the weekday/day of month is implied by DTSTART). Existing
 * rules the editor cannot express are kept verbatim as "custom".
 */

export type Recurrence = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'custom'

export const RECURRENCE_PRESETS = ['none', 'daily', 'weekly', 'monthly', 'yearly'] as const

const FREQ_BY_PRESET = {
  daily: 'DAILY',
  weekly: 'WEEKLY',
  monthly: 'MONTHLY',
  yearly: 'YEARLY',
} as const

/** Build the RRULE value (without "RRULE:") for a preset. */
export function buildRRule(recurrence: Recurrence, customRule = ''): string {
  if (recurrence === 'none') return ''
  if (recurrence === 'custom') return normalizeRRule(customRule)
  return `FREQ=${FREQ_BY_PRESET[recurrence]}`
}

/** Uppercase, strip an "RRULE:" prefix, whitespace and empty parts. */
export function normalizeRRule(rule: string): string {
  return rule
    .trim()
    .replace(/^RRULE:/i, '')
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const [k = '', v = ''] = p.split('=')
      return `${k.toUpperCase()}=${v.toUpperCase()}`
    })
    .join(';')
}

/** Parse "FREQ=WEEKLY;INTERVAL=2" into a key/value map. */
export function parseRRule(rule: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const part of normalizeRRule(rule).split(';')) {
    if (!part) continue
    const [k, v] = part.split('=')
    if (k && v !== undefined) map.set(k, v)
  }
  return map
}

/** Map an RRULE back to a preset; anything beyond a plain FREQ is "custom". */
export function recurrenceFromRRule(rule: string | undefined | null): Recurrence {
  if (!rule?.trim()) return 'none'
  const parts = parseRRule(rule)
  const freq = parts.get('FREQ')
  const interval = parts.get('INTERVAL')
  const extra = [...parts.keys()].filter((k) => k !== 'FREQ' && k !== 'INTERVAL' && k !== 'WKST')
  if (extra.length > 0 || (interval !== undefined && interval !== '1')) return 'custom'
  switch (freq) {
    case 'DAILY':
      return 'daily'
    case 'WEEKLY':
      return 'weekly'
    case 'MONTHLY':
      return 'monthly'
    case 'YEARLY':
      return 'yearly'
    default:
      return 'custom'
  }
}

/** What a rule repeats on; weekdays count from 0 = Sunday, months from 0 = January. */
export type RecurrencePattern =
  | { freq: 'daily' }
  | { freq: 'weekly'; weekdays: number[] }
  | { freq: 'monthly'; day: number }
  | { freq: 'monthly'; nth: number; weekday: number }
  | { freq: 'yearly'; month: number; day: number }

export type RecurrenceSummary = RecurrencePattern & { interval: number; count?: number; until?: Date }

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']
const SUMMARIZED = new Set(['FREQ', 'INTERVAL', 'WKST', 'COUNT', 'UNTIL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH'])

function positiveInt(value: string, max = Number.MAX_SAFE_INTEGER): number | null {
  if (!/^\d+$/.test(value)) return null
  const n = Number(value)
  return n >= 1 && n <= max ? n : null
}

// UNTIL is a date, a UTC date-time or a floating (local) date-time. The
// time groups of a date are undefined, though typed as strings.
function parseUntil(value: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/.exec(value)
  if (!m) return null
  const [y = 0, mo = 1, d = 1, h = 0, mi = 0, s = 0] = m.slice(1, 7).map((v: string | undefined) => Number(v ?? 0))
  return m[7] ? new Date(Date.UTC(y, mo - 1, d, h, mi, s)) : new Date(y, mo - 1, d, h, mi, s)
}

function weekly(byDay: string[]): RecurrencePattern | null {
  const days = byDay.map((d) => WEEKDAYS.indexOf(d))
  if (days.includes(-1)) return null
  return { freq: 'weekly', weekdays: [...new Set(days)].sort((a, b) => a - b) }
}

// "2TU" is the second Tuesday, "-1FR" the last Friday of the month.
function nthWeekday(byDay: string): RecurrencePattern | null {
  const m = /^([+-]?\d{1,2})([A-Z]{2})$/.exec(byDay)
  const nth = Number(m?.[1])
  const weekday = WEEKDAYS.indexOf(m?.[2] ?? '')
  if (weekday === -1 || !(nth === -1 || (nth >= 1 && nth <= 5))) return null
  return { freq: 'monthly', nth, weekday }
}

function pattern(parts: Map<string, string>, start: Date, interval: number): RecurrencePattern | null {
  const byDay = parts.get('BYDAY')?.split(',')
  const byMonthDay = parts.get('BYMONTHDAY')
  const byMonth = parts.get('BYMONTH')
  switch (parts.get('FREQ')) {
    case 'DAILY':
      if (byMonthDay !== undefined || byMonth !== undefined) return null
      if (!byDay) return { freq: 'daily' }
      // Outlook writes "every weekday" as a daily rule; only every week is the same as a weekly one.
      return interval === 1 ? weekly(byDay) : null
    case 'WEEKLY':
      if (byMonthDay !== undefined || byMonth !== undefined) return null
      return byDay ? weekly(byDay) : { freq: 'weekly', weekdays: [start.getDay()] }
    case 'MONTHLY': {
      if (byMonth !== undefined) return null
      if (byDay) return byDay.length === 1 && byMonthDay === undefined ? nthWeekday(byDay[0] ?? '') : null
      const day = byMonthDay === undefined ? start.getDate() : positiveInt(byMonthDay, 31)
      return day ? { freq: 'monthly', day } : null
    }
    case 'YEARLY': {
      if (byDay || (byMonth === undefined && byMonthDay !== undefined)) return null
      const month = byMonth === undefined ? start.getMonth() + 1 : positiveInt(byMonth, 12)
      const day = byMonthDay === undefined ? start.getDate() : positiveInt(byMonthDay, 31)
      return month && day ? { freq: 'yearly', month: month - 1, day } : null
    }
    default:
      return null
  }
}

/**
 * The rules the details and the editor put into words: FREQ up to yearly
 * with INTERVAL, COUNT or UNTIL, weekdays, a day of the month, or the nth
 * weekday of the month. Anything else returns null and is shown verbatim.
 * What the rule leaves out comes from the start, as in RFC 5545.
 */
export function summarizeRRule(rule: string, start: Date): RecurrenceSummary | null {
  const parts = parseRRule(rule)
  if ([...parts.keys()].some((k) => !SUMMARIZED.has(k))) return null
  const intervalValue = parts.get('INTERVAL')
  const countValue = parts.get('COUNT')
  const untilValue = parts.get('UNTIL')
  const interval = intervalValue === undefined ? 1 : positiveInt(intervalValue)
  const count = countValue === undefined ? undefined : positiveInt(countValue)
  const until = untilValue === undefined ? undefined : parseUntil(untilValue)
  if (interval === null || count === null || until === null || (count && until)) return null
  const repeats = pattern(parts, start, interval)
  if (!repeats) return null
  return { ...repeats, interval, ...(count ? { count } : {}), ...(until ? { until } : {}) }
}

const ORDINALS = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', 5: 'fifth', [-1]: 'last' } as const

// Weekday names in the order of the user's week; 2023-01-01 was a Sunday.
function weekdayList(days: number[], p: FormatPrefs): string {
  const name = new Intl.DateTimeFormat(p.tag, { weekday: 'long' })
  const ordered = [...days].sort((a, b) => ((a - p.weekStartsOn + 7) % 7) - ((b - p.weekStartsOn + 7) % 7))
  return new Intl.ListFormat(p.tag, { type: 'conjunction' }).format(ordered.map((d) => name.format(new Date(2023, 0, 1 + d))))
}

function describePattern(s: RecurrenceSummary, p: FormatPrefs, t: TFunction): string {
  const count = s.interval
  switch (s.freq) {
    case 'daily':
      return t('recurrence.daily', { count })
    case 'weekly':
      if (count === 1 && s.weekdays.join() === '1,2,3,4,5') return t('recurrence.weekdays')
      return t('recurrence.weekly', { count, days: weekdayList(s.weekdays, p) })
    case 'monthly':
      if ('day' in s) return t('recurrence.monthly', { count, day: s.day })
      return t('recurrence.monthlyNth', {
        count,
        nth: t(`recurrence.ordinal.${ORDINALS[s.nth as keyof typeof ORDINALS]}`),
        weekday: weekdayList([s.weekday], p),
      })
    case 'yearly':
      // 2000 is a leap year, so February 29 exists.
      return t('recurrence.yearly', { count, date: formatMonthDay(new Date(2000, s.month, s.day), p) })
  }
}

/**
 * A rule in words, e.g. "Every 2 weeks on Monday and Thursday, until Tue,
 * Jun 30"; null for a rule `summarizeRRule` cannot put into words.
 */
export function describeRRule(rule: string, start: Date, p: FormatPrefs, now: Date, t: TFunction): string | null {
  if (!rule.trim()) return t('recurrence.none')
  const s = summarizeRRule(rule, start)
  if (!s) return null
  const repeats = describePattern(s, p, t)
  if (s.count) return t('recurrence.times', { rule: repeats, count: s.count })
  if (s.until) return t('recurrence.until', { rule: repeats, date: formatPickerDate(s.until, p, now) })
  return repeats
}
