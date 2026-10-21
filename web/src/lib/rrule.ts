import { type TFunction } from 'i18next'
import { dayAt, dayKey, utcToZoned, zonedToUtc } from './dates'
import { formatMonthDay, formatPickerDate, formatTime, type FormatPrefs } from './format'
import { ruleInZone, type RuleClock } from './seriesShift'

/**
 * RRULE support for the editors and the details (FR-17): the simple presets
 * map to a bare FREQ rule (the weekday/day of month is implied by DTSTART),
 * other rules are "custom", and every rule is shown in words only.
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

/** RRULE weekday codes in `Date#getDay()` order (Sunday first). */
export const WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const

export type Freq = 'SECONDLY' | 'MINUTELY' | 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'

const FREQS: readonly string[] = ['SECONDLY', 'MINUTELY', 'HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']

/**
 * A rule's parts as numbers. Weekdays count from 0 = Sunday; months from 1 =
 * January, as in the rule. A BYDAY entry's nth is 0 for every such weekday.
 * UNTIL keeps its form: a DATE and a floating DATE-TIME are local wall time.
 */
export interface ParsedRule {
  freq: Freq
  interval: number
  count?: number
  until?: { at: Date; form: 'date' | 'utc' | 'floating' }
  byDay: { nth: number; weekday: number }[]
  byMonthDay: number[]
  byMonth: number[]
  byYearDay: number[]
  byWeekNo: number[]
  bySetPos: number[]
  byHour: number[]
  byMinute: number[]
  bySecond: number[]
  wkst?: number
}

type ListPart = 'byMonthDay' | 'byMonth' | 'byYearDay' | 'byWeekNo' | 'bySetPos' | 'byHour' | 'byMinute' | 'bySecond'

// The rule parts Lucid reads, with their RFC 5545 ranges; 0 is never valid where the range is signed.
const LISTS: Record<string, [ListPart, number, number]> = {
  BYMONTHDAY: ['byMonthDay', -31, 31],
  BYMONTH: ['byMonth', 1, 12],
  BYYEARDAY: ['byYearDay', -366, 366],
  BYWEEKNO: ['byWeekNo', -53, 53],
  BYSETPOS: ['bySetPos', -366, 366],
  BYHOUR: ['byHour', 0, 23],
  BYMINUTE: ['byMinute', 0, 59],
  BYSECOND: ['bySecond', 0, 60],
}
const KNOWN = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'WKST', ...Object.keys(LISTS)])

function positiveInt(value: string): number | null {
  if (!/^\d+$/.test(value)) return null
  const n = Number(value)
  return n >= 1 && n <= Number.MAX_SAFE_INTEGER ? n : null
}

function intList(value: string, min: number, max: number): number[] | null {
  const out: number[] = []
  for (const v of value.split(',')) {
    if (!/^[+-]?\d+$/.test(v)) return null
    const n = Number(v)
    if (n < min || n > max || (min < 0 && n === 0)) return null
    out.push(n)
  }
  return out
}

function parseUntil(value: string): ParsedRule['until'] | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/.exec(value)
  if (!m) return null
  const [y = 0, mo = 1, d = 1, h = 0, mi = 0, s = 0] = m.slice(1, 7).map((v: string | undefined) => Number(v ?? 0))
  if (m[7]) return { at: new Date(Date.UTC(y, mo - 1, d, h, mi, s)), form: 'utc' }
  return { at: new Date(y, mo - 1, d, h, mi, s), form: m[4] === undefined ? 'date' : 'floating' }
}

// "2TU" is the second Tuesday, "-1FR" the last Friday, "MO" every Monday.
function parseByDay(value: string): ParsedRule['byDay'] | null {
  const out: ParsedRule['byDay'] = []
  for (const v of value.split(',')) {
    const m = /^([+-]?\d{1,2})?([A-Z]{2})$/.exec(v)
    const weekday = WEEKDAY_CODES.indexOf((m?.[2] ?? '') as (typeof WEEKDAY_CODES)[number])
    const nth = m?.[1] === undefined ? 0 : Number(m[1])
    if (weekday === -1 || (m?.[1] !== undefined && (nth === 0 || Math.abs(nth) > 53))) return null
    out.push({ nth, weekday })
  }
  return out
}

/**
 * Reads a rule into its parts (FR-17); null for a rule Lucid can't read: no
 * or an unknown FREQ, a part it doesn't know (RSCALE, X-…), a value outside
 * RFC 5545's ranges, or COUNT together with UNTIL.
 */
export function parseRule(rule: string): ParsedRule | null {
  const parts = parseRRule(rule)
  if ([...parts.keys()].some((k) => !KNOWN.has(k))) return null
  const freq = parts.get('FREQ') ?? ''
  if (!FREQS.includes(freq)) return null
  const r: ParsedRule = {
    freq: freq as Freq,
    interval: 1,
    byDay: [],
    byMonthDay: [],
    byMonth: [],
    byYearDay: [],
    byWeekNo: [],
    bySetPos: [],
    byHour: [],
    byMinute: [],
    bySecond: [],
  }
  for (const [key, value] of parts) {
    const list = LISTS[key]
    if (list) {
      const [field, min, max] = list
      const values = intList(value, min, max)
      if (!values) return null
      r[field] = values
      continue
    }
    switch (key) {
      case 'INTERVAL':
      case 'COUNT': {
        const n = positiveInt(value)
        if (n === null) return null
        if (key === 'INTERVAL') r.interval = n
        else r.count = n
        break
      }
      case 'UNTIL': {
        const until = parseUntil(value)
        if (!until) return null
        r.until = until
        break
      }
      case 'BYDAY': {
        const byDay = parseByDay(value)
        if (!byDay) return null
        r.byDay = byDay
        break
      }
      case 'WKST': {
        const wkst = WEEKDAY_CODES.indexOf(value as (typeof WEEKDAY_CODES)[number])
        if (wkst === -1) return null
        r.wkst = wkst
        break
      }
    }
  }
  if (r.count !== undefined && r.until) return null
  return r
}

const UNITS = {
  SECONDLY: 'second',
  MINUTELY: 'minute',
  HOURLY: 'hour',
  DAILY: 'day',
  WEEKLY: 'week',
  MONTHLY: 'month',
  YEARLY: 'year',
} as const

const ORDINALS = {
  1: 'first',
  2: 'second',
  3: 'third',
  4: 'fourth',
  5: 'fifth',
  [-1]: 'last',
  [-2]: 'secondToLast',
  [-3]: 'thirdToLast',
  [-4]: 'fourthToLast',
  [-5]: 'fifthToLast',
} as const

const sameDays = (days: number[], want: number[]) => [...new Set(days)].sort().join() === want.join()

function list(items: string[], p: FormatPrefs, type: 'conjunction' | 'disjunction' = 'conjunction'): string {
  return new Intl.ListFormat(p.tag, { type }).format(items)
}

// Weekday names in the order of the user's week; 2023-01-01 was a Sunday.
function weekdayList(days: number[], p: FormatPrefs, type: 'conjunction' | 'disjunction' = 'conjunction'): string {
  const name = new Intl.DateTimeFormat(p.tag, { weekday: 'long' })
  const ordered = [...new Set(days)].sort((a, b) => ((a - p.weekStartsOn + 7) % 7) - ((b - p.weekStartsOn + 7) % 7))
  return list(
    ordered.map((d) => name.format(new Date(2023, 0, 1 + d))),
    p,
    type,
  )
}

/** "first", "last", "third-to-last", "20th": the nth of something, counted from the end where negative. */
function nthWord(n: number, t: TFunction): string {
  const word = ORDINALS[n as keyof typeof ORDINALS] as (typeof ORDINALS)[keyof typeof ORDINALS] | undefined
  if (word) return t(`recurrence.ordinal.${word}`)
  if (n > 0) return t('recurrence.ordinalNumber', { count: n, ordinal: true })
  return t('recurrence.ordinal.fromEnd', { nth: t('recurrence.ordinalNumber', { count: -n, ordinal: true }) })
}

function nthDay(n: number, day: string, t: TFunction): string {
  return t('recurrence.nthDay', { nth: nthWord(n, t), day })
}

// The days that a BYSETPOS picks from: a weekday, Monday to Friday, the weekend, any day, or a choice of weekdays.
function dayGroup(days: number[], p: FormatPrefs, t: TFunction): string {
  if (sameDays(days, [1, 2, 3, 4, 5])) return t('recurrence.dayKind.weekday')
  if (sameDays(days, [0, 6])) return t('recurrence.dayKind.weekendDay')
  if (sameDays(days, [0, 1, 2, 3, 4, 5, 6])) return t('recurrence.dayKind.day')
  return weekdayList(days, p, 'disjunction')
}

// Days of the month or year: "days 1 and 15", "the last day", "day 1 and the last day".
function dayNumbers(days: number[], key: 'monthDays' | 'yearDays', p: FormatPrefs, t: TFunction): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b)
  const positive = sorted.filter((d) => d > 0)
  const items: string[] = []
  if (positive.length > 0) {
    const numbers = list(
      positive.map((day) => t('recurrence.dayOfMonth', { day })),
      p,
    )
    items.push(t(`recurrence.${key}`, { count: positive.length, days: numbers }))
  }
  for (const d of sorted.filter((d) => d < 0)) items.push(nthDay(d, t('recurrence.dayKind.day'), t))
  return list(items, p)
}

/**
 * Fills in what a rule leaves to its start, as RFC 5545 (and rrule-go) do:
 * the weekday of a weekly rule, the day of a monthly one, the month and day
 * of a yearly one.
 */
function implied(r: ParsedRule, start: Date): ParsedRule {
  if (r.byDay.length > 0 || r.byMonthDay.length > 0 || r.byYearDay.length > 0 || r.byWeekNo.length > 0) return r
  switch (r.freq) {
    case 'WEEKLY':
      return { ...r, byDay: [{ nth: 0, weekday: start.getDay() }] }
    case 'MONTHLY':
      return { ...r, byMonthDay: [start.getDate()] }
    case 'YEARLY':
      return { ...r, byMonth: r.byMonth.length > 0 ? r.byMonth : [start.getMonth() + 1], byMonthDay: [start.getDate()] }
    default:
      return r
  }
}

// Parts that the sentence below cannot word precisely: they get "with further conditions".
function complex(r: ParsedRule, plain: number[], ordinal: ParsedRule['byDay']): boolean {
  const yearly = r.freq === 'YEARLY'
  const monthlyOrYearly = yearly || r.freq === 'MONTHLY'
  return (
    r.bySecond.length > 0 ||
    // Below hourly, BYHOUR is a window of hours, not times of day.
    (r.byHour.length > 0 && (r.freq === 'MINUTELY' || r.freq === 'SECONDLY')) ||
    (ordinal.length > 0 && (plain.length > 0 || !monthlyOrYearly)) ||
    (ordinal.length > 0 && (r.byMonthDay.length > 0 || r.byYearDay.length > 0 || r.byWeekNo.length > 0)) ||
    r.byWeekNo.some((w) => w < 0) ||
    ((r.byWeekNo.length > 0 || r.byYearDay.length > 0) && !yearly) ||
    (r.byMonthDay.length > 0 && r.freq === 'WEEKLY') ||
    (r.bySetPos.length > 0 &&
      (plain.length === 0 ||
        r.byMonthDay.length > 0 ||
        r.byYearDay.length > 0 ||
        r.byWeekNo.length > 0 ||
        r.byHour.length > 0 ||
        r.byMinute.length > 0))
  )
}

// The rule without its end, e.g. "Every 2 weeks on Monday and Thursday".
function describeRepeats(rule: ParsedRule, start: Date, p: FormatPrefs, t: TFunction): string {
  const r = implied(rule, start)
  const plain = r.byDay.filter((d) => d.nth === 0).map((d) => d.weekday)
  const ordinal = r.byDay.filter((d) => d.nth !== 0)
  const onlyDays =
    ordinal.length === 0 &&
    [r.byMonthDay, r.byMonth, r.byYearDay, r.byWeekNo, r.bySetPos, r.byHour, r.byMinute, r.bySecond].every((v) => v.length === 0)
  const dailyOrWeekly = r.freq === 'DAILY' || r.freq === 'WEEKLY'
  if (r.interval === 1 && dailyOrWeekly && onlyDays && sameDays(plain, [1, 2, 3, 4, 5])) return t('recurrence.weekdays')
  // Outlook writes weekdays as a daily rule; only every day is the same as a weekly one.
  const freq = r.freq === 'DAILY' && r.interval === 1 && plain.length > 0 && onlyDays ? 'WEEKLY' : r.freq
  const base = t(`recurrence.every.${UNITS[freq]}`, { count: r.interval })
  if (complex(r, plain, ordinal)) return t('recurrence.complex', { rule: base })

  const parts: { text: string; filter?: boolean }[] = []
  const on = (what: string) => parts.push({ text: t('recurrence.on', { what }) })
  const onlyOn = (days: string) => parts.push({ text: t('recurrence.onlyOn', { days }), filter: true })
  // An nth day of a yearly rule without months counts within the year.
  const ofYear = (what: string) => (freq === 'YEARLY' && r.byMonth.length === 0 ? t('recurrence.ofYear', { what }) : what)
  let monthsSaid = false

  if (r.bySetPos.length > 0) {
    const group = dayGroup(plain, p, t)
    on(
      ofYear(
        list(
          r.bySetPos.map((n) => nthDay(n, group, t)),
          p,
        ),
      ),
    )
  } else if (ordinal.length > 0) {
    const name = new Intl.DateTimeFormat(p.tag, { weekday: 'long' })
    on(
      ofYear(
        list(
          ordinal.map((d) => nthDay(d.nth, name.format(new Date(2023, 0, 1 + d.weekday)), t)),
          p,
        ),
      ),
    )
  } else if (r.byYearDay.length > 0) {
    on(t('recurrence.ofYear', { what: dayNumbers(r.byYearDay, 'yearDays', p, t) }))
    if (plain.length > 0) onlyOn(weekdayList(plain, p))
  } else if (r.byMonthDay.length > 0) {
    const [month] = r.byMonth
    const [day = 0] = r.byMonthDay
    if (freq === 'YEARLY' && month !== undefined && r.byMonth.length === 1 && r.byMonthDay.length === 1 && day > 0 && plain.length === 0) {
      // 2000 is a leap year, so February 29 exists.
      on(formatMonthDay(new Date(2000, month - 1, day), p))
      monthsSaid = true
    } else if (freq === 'MONTHLY' || freq === 'YEARLY') {
      on(dayNumbers(r.byMonthDay, 'monthDays', p, t))
      if (plain.length > 0) onlyOn(weekdayList(plain, p))
    } else {
      onlyOn(dayNumbers(r.byMonthDay, 'monthDays', p, t))
      if (plain.length > 0) onlyOn(weekdayList(plain, p))
    }
  } else if (plain.length > 0) {
    if (freq === 'WEEKLY' || (freq === 'YEARLY' && r.byWeekNo.length > 0)) on(weekdayList(plain, p))
    else if (freq === 'MONTHLY' || freq === 'YEARLY') parts.push({ text: t('recurrence.onEvery', { days: weekdayList(plain, p) }) })
    else onlyOn(weekdayList(plain, p))
  }

  if (r.byMonth.length > 0 && !monthsSaid) {
    const name = new Intl.DateTimeFormat(p.tag, { month: 'long' })
    const months = [...new Set(r.byMonth)].sort((a, b) => a - b).map((m) => name.format(new Date(2000, m - 1, 1)))
    parts.push({ text: t('recurrence.inMonths', { months: list(months, p) }) })
  }
  if (r.byWeekNo.length > 0) {
    const weeks = [...new Set(r.byWeekNo)].sort((a, b) => a - b).map(String)
    parts.push({ text: t('recurrence.inWeeks', { count: weeks.length, weeks: list(weeks, p) }) })
  }
  if (r.byHour.length > 0) {
    const minutes = r.byMinute.length > 0 ? [...new Set(r.byMinute)].sort((a, b) => a - b) : [start.getMinutes()]
    const hours = [...new Set(r.byHour)].sort((a, b) => a - b)
    const times = hours.flatMap((h) => minutes.map((m) => formatTime(new Date(2000, 0, 1, h, m), p)))
    parts.push({
      text: times.length > 12 ? t('recurrence.manyTimes', { count: times.length }) : t('recurrence.at', { times: list(times, p) }),
    })
  } else if (r.byMinute.length > 0) {
    const minutes = [...new Set(r.byMinute)].sort((a, b) => a - b).map(String)
    parts.push({ text: t('recurrence.atMinutes', { count: minutes.length, minutes: list(minutes, p) }) })
  }

  return parts.reduce((text, part) => t(part.filter ? 'recurrence.joinFilter' : 'recurrence.join', { rule: text, part: part.text }), base)
}

/**
 * A rule in words (FR-17), e.g. "Every 2 weeks on Monday and Thursday, until
 * Tue, Jun 30". What the rule leaves out comes from the start, as in RFC
 * 5545. A rule Lucid can't read is named as one from another app: the rule
 * itself is never shown.
 */
export function describeRRule(rule: string, start: Date, p: FormatPrefs, now: Date, t: TFunction): string {
  if (!rule.trim()) return t('recurrence.none')
  const r = parseRule(rule)
  if (!r) return t('recurrence.foreign')
  const repeats = describeRepeats(r, start, p, t)
  if (r.count) return t('recurrence.times', { rule: repeats, count: r.count })
  if (r.until) return t('recurrence.until', { rule: repeats, date: formatPickerDate(r.until.at, p, now) })
  return repeats
}

/**
 * A series' rule in words as the browser shows the series (FR-17, FR-18): on
 * its wall clock in `timeZone`, the environment's own, read at the event of
 * `clock`, the wall clock the rule recurs on (see `ruleInZone`), and filled
 * in from `start` as `describeRRule` does. A rule that doesn't read the same
 * there is said on its own wall clock (`describeRRuleIn`). Without `clock`
 * the rule recurs on dates, the same everywhere.
 */
export function describeSeriesRule(
  rule: string,
  start: Date,
  clock: RuleClock | null,
  timeZone: string,
  p: FormatPrefs,
  now: Date,
  t: TFunction,
): string {
  if (!clock) return describeRRule(rule, start, p, now, t)
  const shown = ruleInZone(rule, clock.at, clock.zone, timeZone)
  return shown === null ? describeRRuleIn(rule, clock, p, now, t) : describeRRule(shown, start, p, now, t)
}

/**
 * A rule in words on the wall clock it recurs on, `clock`'s, which it names
 * (FR-17, FR-18): for a rule that doesn't read the same on the browser's
 * (see `ruleInZone`). What it leaves out comes from its event there.
 */
export function describeRRuleIn(rule: string, clock: RuleClock, p: FormatPrefs, now: Date, t: TFunction): string {
  const there = utcToZoned(clock.at, clock.zone)
  return t('recurrence.inZone', { rule: describeRRule(rule, dayAt(there.date, there.time), p, now, t), zone: clock.zone })
}

const compact = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '')

/**
 * The rule with its UNTIL in the form DTSTART needs (RFC 5545 3.3.10), as the
 * server writes it (FR-17): a DATE for an all-day series; for a timed one,
 * which Lucid writes with a TZID, UTC, a DATE becoming the end of that day in
 * `timeZone`, so that the last day's occurrence stays. A floating date-time
 * only another app writes stays as it is on a timed series.
 */
export function fitUntil(rule: string, allDay: boolean, timeZone: string): string {
  const r = parseRule(rule)
  if (!r?.until) return rule
  const { at, form } = r.until
  let value: string | null = null
  if (allDay && form !== 'date') {
    value = (form === 'utc' ? utcToZoned(at, timeZone).date : dayKey(at)).replaceAll('-', '')
  } else if (!allDay && form === 'date') {
    value = compact(new Date(zonedToUtc(dayKey(at), '23:59', timeZone).getTime() + 59_000).toISOString())
  }
  if (value === null) return rule
  return rule.replace(/(UNTIL=)[^;]*/i, `$1${value}`)
}
