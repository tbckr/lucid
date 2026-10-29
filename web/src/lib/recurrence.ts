import { addDays, addMonths, getDaysInMonth, startOfDay } from 'date-fns'
import { dayKey, parseDayKey, utcToZoned } from './dates'
import { type CalEvent } from './events'
import { type WeekStart } from './locale'
import { parseRule, WEEKDAY_CODES, type ParsedRule } from './rrule'
import { eventRuleStart } from './seriesShift'

/**
 * The repeat editor's model (FR-17): what the editor can show, read from and
 * written to an RRULE, and the dates it previews. Weekdays count from 0 =
 * Sunday, months from 0 = January.
 */

export type Frequency = 'daily' | 'weekly' | 'monthly' | 'yearly'
/** First to fifth, or -1 for the last. */
export type Nth = 1 | 2 | 3 | 4 | 5 | -1
/** A weekday, any of Monday to Friday, or Saturday or Sunday. */
export type NthDay = number | 'weekday' | 'weekendDay'
/** Days of the month (1–31 ascending, then -1 for the last day), or the nth of a kind of day. */
export type MonthPattern = { by: 'days'; days: number[] } | { by: 'nth'; nth: Nth; day: NthDay }
export type RepeatEnd = { kind: 'never' } | { kind: 'count'; count: number } | { kind: 'until'; date: string }

export interface RuleModel {
  freq: Frequency
  interval: number
  /** Weekly: the weekdays, ascending. */
  weekdays: number[]
  /** Monthly and yearly. */
  monthly: MonthPattern
  /** Yearly. */
  month: number
  end: RepeatEnd
  /** The WKST of the rule read, written back. */
  wkst?: string
}

const NTHS: readonly number[] = [1, 2, 3, 4, 5, -1]
const WEEKDAYS = [1, 2, 3, 4, 5]
const WEEKEND = [0, 6]
const MONDAY_FIRST = [1, 2, 3, 4, 5, 6, 0]
// Bounds the periods a preview walks, for a pattern that falls on few or no dates.
const MAX_PERIODS = 2000

const ascending = (days: number[]) => [...new Set(days)].sort((a, b) => a - b)
const sameDays = (a: number[], b: number[]) => ascending(a).join() === ascending(b).join()
// Days of the month in order, the last day last.
const monthDayOrder = (days: number[]) => [...ascending(days.filter((d) => d > 0)), ...(days.includes(-1) ? [-1] : [])]

/** Weekly on the start's weekday; the other choices follow the start too. */
export function defaultModel(start: Date): RuleModel {
  return {
    freq: 'weekly',
    interval: 1,
    weekdays: [start.getDay()],
    monthly: { by: 'days', days: [start.getDate()] },
    month: start.getMonth(),
    end: { kind: 'never' },
  }
}

// The day pattern of a monthly or yearly rule; undefined where the rule
// leaves it to the start, null where the editor cannot show it.
function monthPattern(r: ParsedRule): MonthPattern | undefined | null {
  const plain = r.byDay.filter((d) => d.nth === 0).map((d) => d.weekday)
  const ordinal = r.byDay.filter((d) => d.nth !== 0)
  if (r.byDay.length === 0 && r.byMonthDay.length === 0 && r.bySetPos.length === 0) return undefined
  if (r.byDay.length === 0 && r.bySetPos.length === 0) {
    return r.byMonthDay.every((d) => d > 0 || d === -1) ? { by: 'days', days: monthDayOrder(r.byMonthDay) } : null
  }
  if (r.byMonthDay.length > 0) return null
  const [only] = ordinal
  if (only && r.byDay.length === 1 && r.bySetPos.length === 0) {
    return NTHS.includes(only.nth) ? { by: 'nth', nth: only.nth as Nth, day: only.weekday } : null
  }
  const [pos] = r.bySetPos
  if (ordinal.length > 0 || pos === undefined || r.bySetPos.length > 1 || !NTHS.includes(pos)) return null
  const nth = pos as Nth
  if (plain.length === 1 && plain[0] !== undefined) return { by: 'nth', nth, day: plain[0] }
  if (sameDays(plain, WEEKDAYS)) return { by: 'nth', nth, day: 'weekday' }
  if (sameDays(plain, WEEKEND)) return { by: 'nth', nth, day: 'weekendDay' }
  return null
}

/**
 * The model of `rule` for a series starting at `start` (FR-17). `exact` is
 * false where the editor cannot show all of the rule: the model is then the
 * closest repeat it can show, which Done would write in its place. A UTC end
 * is read as its date in `timeZone`.
 */
export function modelFromRule(rule: string, start: Date, timeZone: string): { model: RuleModel; exact: boolean } {
  const model = defaultModel(start)
  if (!rule.trim()) return { model, exact: true }
  const r = parseRule(rule)
  if (!r) return { model, exact: false }
  let exact = [r.byYearDay, r.byWeekNo, r.byHour, r.byMinute, r.bySecond].every((v) => v.length === 0)
  if (r.count !== undefined) model.end = { kind: 'count', count: r.count }
  else if (r.until) {
    const { at, form } = r.until
    model.end = { kind: 'until', date: form === 'utc' ? utcToZoned(at, timeZone).date : dayKey(at) }
  }
  if (r.wkst !== undefined) model.wkst = WEEKDAY_CODES[r.wkst]

  const plain = r.byDay.filter((d) => d.nth === 0).map((d) => d.weekday)
  const ordinal = r.byDay.filter((d) => d.nth !== 0)
  const onlyPlainDays = ordinal.length === 0 && r.byMonthDay.length === 0 && r.byMonth.length === 0 && r.bySetPos.length === 0
  switch (r.freq) {
    case 'DAILY':
      // Outlook writes weekdays as a daily rule; every day on them is every week on them.
      if (r.interval === 1 && plain.length > 0 && onlyPlainDays) {
        model.weekdays = ascending(plain)
      } else {
        model.freq = 'daily'
        model.interval = r.interval
        exact &&= r.byDay.length === 0 && onlyPlainDays
      }
      break
    case 'WEEKLY':
      model.interval = r.interval
      if (plain.length > 0) model.weekdays = ascending(plain)
      // Without WKST the weeks start on Monday (RFC 5545), not on the user's week start,
      // which pairs up the days of a rule every few weeks.
      if (r.wkst === undefined && r.interval > 1 && model.weekdays.length > 1) model.wkst = 'MO'
      exact &&= onlyPlainDays
      break
    case 'MONTHLY':
    case 'YEARLY': {
      model.freq = r.freq === 'MONTHLY' ? 'monthly' : 'yearly'
      model.interval = r.interval
      const months = ascending(r.byMonth)
      if (model.freq === 'yearly' && months[0] !== undefined) model.month = months[0] - 1
      // A monthly rule in some months only, a yearly one in several, or a
      // yearly one on days of every month cannot be shown.
      exact &&= model.freq === 'monthly' ? months.length === 0 : months.length <= 1
      const pattern = monthPattern(r)
      if (pattern === null) exact = false
      else if (pattern) {
        if (model.freq === 'yearly' && months.length === 0) exact = false
        // The yearly editor offers one day of the month.
        else if (model.freq === 'yearly' && pattern.by === 'days' && (pattern.days.length !== 1 || pattern.days[0] === -1)) exact = false
        else model.monthly = pattern
      }
      break
    }
    default:
      // Hourly and finer repeats are not the editor's: the closest it has is daily.
      model.freq = 'daily'
      exact = false
  }
  return { model, exact }
}

const code = (weekday: number) => WEEKDAY_CODES[weekday] ?? 'MO'
const codes = (weekdays: number[]) =>
  MONDAY_FIRST.filter((d) => weekdays.includes(d))
    .map(code)
    .join(',')

function kindDays(day: NthDay): number[] {
  if (day === 'weekday') return WEEKDAYS
  if (day === 'weekendDay') return WEEKEND
  return [day]
}

// The WKST the rule gets: the one read, else the user's week start where it
// changes the weeks a rule every few weeks on several days pairs up.
function writtenWkst(model: RuleModel, weekStartsOn: WeekStart): string | undefined {
  if (model.wkst) return model.wkst
  const pairs = model.freq === 'weekly' && model.interval > 1 && new Set(model.weekdays).size > 1
  return pairs && weekStartsOn !== 1 ? code(weekStartsOn) : undefined
}

function patternParts(p: MonthPattern, start: Date, explicit: boolean): string[] {
  if (p.by === 'days') {
    const days = monthDayOrder(p.days)
    return !explicit && days.length === 1 && days[0] === start.getDate() ? [] : [`BYMONTHDAY=${days.join(',')}`]
  }
  if (typeof p.day === 'number') return [`BYDAY=${p.nth}${code(p.day)}`]
  return [`BYDAY=${codes(kindDays(p.day))}`, `BYSETPOS=${p.nth}`]
}

/**
 * The RRULE value of `model` for a series starting at `start` (FR-17), as
 * short as RFC 5545 allows: what the start implies is left out, unless
 * `explicit`, for an existing series, whose rule applies from its own start,
 * not the one shown. UNTIL is written as a DATE; `fitUntil` gives it
 * DTSTART's form on save.
 */
export function ruleFromModel(model: RuleModel, start: Date, weekStartsOn: WeekStart, explicit = false): string {
  const parts = [`FREQ=${model.freq.toUpperCase()}`]
  if (model.interval > 1) parts.push(`INTERVAL=${model.interval}`)
  switch (model.freq) {
    case 'weekly': {
      const days = ascending(model.weekdays)
      if (explicit || !(days.length === 1 && days[0] === start.getDay())) parts.push(`BYDAY=${codes(days)}`)
      break
    }
    case 'monthly':
      parts.push(...patternParts(model.monthly, start, explicit))
      break
    case 'yearly': {
      const implied = model.month === start.getMonth() && model.monthly.by === 'days' && sameDays(model.monthly.days, [start.getDate()])
      if (explicit || !implied) parts.push(`BYMONTH=${model.month + 1}`, ...patternParts(model.monthly, start, true))
      break
    }
    case 'daily':
      break
  }
  if (model.end.kind === 'count') parts.push(`COUNT=${model.end.count}`)
  if (model.end.kind === 'until') parts.push(`UNTIL=${model.end.date.replaceAll('-', '')}`)
  const wkst = writtenWkst(model, weekStartsOn)
  if (wkst) parts.push(`WKST=${wkst}`)
  return parts.join(';')
}

// The days of the month starting at `first` that `p` picks, in order.
function daysInMonth(p: MonthPattern, first: Date): Date[] {
  const length = getDaysInMonth(first)
  if (p.by === 'days') {
    const numbers = p.days.map((d) => (d > 0 ? d : length + d + 1)).filter((d) => d >= 1 && d <= length)
    return ascending(numbers).map((d) => addDays(first, d - 1))
  }
  const kinds = kindDays(p.day)
  const matching: Date[] = []
  for (let d = 0; d < length; d++) {
    const day = addDays(first, d)
    if (kinds.includes(day.getDay())) matching.push(day)
  }
  const pick = p.nth > 0 ? matching[p.nth - 1] : matching[matching.length + p.nth]
  return pick ? [pick] : []
}

// The days the rule falls on, period by period from the start's, at midnight.
function* ruleDays(model: RuleModel, start: Date, weekStartsOn: WeekStart): Generator<Date> {
  const day = startOfDay(start)
  for (let k = 0; k < MAX_PERIODS; k++) {
    const step = k * model.interval
    switch (model.freq) {
      case 'daily':
        yield addDays(day, step)
        break
      case 'weekly': {
        const wkst = WEEKDAY_CODES.indexOf((writtenWkst(model, weekStartsOn) ?? 'MO') as (typeof WEEKDAY_CODES)[number])
        const offset = (d: number) => (d - wkst + 7) % 7
        const week = addDays(day, 7 * step - offset(day.getDay()))
        for (const d of [...new Set(model.weekdays)].sort((a, b) => offset(a) - offset(b))) yield addDays(week, offset(d))
        break
      }
      case 'monthly':
        yield* daysInMonth(model.monthly, addMonths(new Date(day.getFullYear(), day.getMonth(), 1), step))
        break
      case 'yearly':
        yield* daysInMonth(model.monthly, new Date(day.getFullYear() + step, model.month, 1))
        break
    }
  }
}

/**
 * The first `limit` dates of the series, as the server expands it (FR-17,
 * `ruleInstances`): the start, whether or not the rule falls on it, counting
 * toward COUNT, then the rule's days after the start's, at its time of day,
 * through the UNTIL day. `more` reports dates beyond them. Without
 * `countStart`, the start is one only where the rule falls on it, as an
 * event of an existing series moves to the rule's next date (#11), and COUNT
 * counts from the first date.
 */
export function nextDates(
  model: RuleModel,
  start: Date,
  weekStartsOn: WeekStart,
  limit: number,
  countStart = true,
): { dates: Date[]; more: boolean } {
  const first = startOfDay(start)
  const until = model.end.kind === 'until' ? parseDayKey(model.end.date) : null
  const total = model.end.kind === 'count' ? model.end.count : Infinity
  const dates = countStart || startMatches(model, start, weekStartsOn) ? [start] : []
  for (const day of ruleDays(model, start, weekStartsOn)) {
    if (day <= first) continue
    if (dates.length >= total || (until && day > until)) break
    if (dates.length >= limit) return { dates, more: true }
    dates.push(new Date(day.getFullYear(), day.getMonth(), day.getDate(), start.getHours(), start.getMinutes(), start.getSeconds()))
  }
  return { dates, more: false }
}

/** Whether the rule itself falls on the start's day. */
export function startMatches(model: RuleModel, start: Date, weekStartsOn: WeekStart): boolean {
  const first = startOfDay(start)
  for (const day of ruleDays(model, start, weekStartsOn)) {
    if (day >= first) return day.getTime() === first.getTime()
  }
  return false
}

/**
 * What a changed repeat does to the event it is edited from, where the
 * repeat doesn't fall on it (FR-17, #11): a new series or a task counts it
 * as the first date (`counts`); an event of an existing series on its rule
 * moves to the repeat's next date (`moves`), as the server moves the series
 * onto its new rule; an exception, an extra date, and a start set off the
 * old rule keep their place (`stays`).
 */
export type OffRule = 'counts' | 'moves' | 'stays'

/**
 * What a changed repeat does to `event` where it doesn't fall on it (see
 * `OffRule`): `counts` for a new event (`undefined`) and a single one;
 * `stays` for an event of a series of dates, an exception (`override`), and
 * an event whose place in the series, its RECURRENCE-ID (`eventRuleStart`),
 * is no date of the old rule, such as an extra date or a start set off the
 * rule; else `moves`. The old rule is read as the repeat editor reads it, on
 * the wall clock of `timeZone`, the zone of the event's start (FR-18).
 */
export function eventOffRule(event: CalEvent | undefined, weekStartsOn: WeekStart, timeZone: string): OffRule {
  if (!event?.recurring) return 'counts'
  if (!event.rrule || event.override) return 'stays'
  const at = eventRuleStart(event, undefined, undefined, timeZone)
  return startMatches(modelFromRule(event.rrule, at, timeZone).model, at, weekStartsOn) ? 'moves' : 'stays'
}

export type SkipHint =
  | { kind: 'monthDay'; day: number }
  | { kind: 'shortMonths' }
  | { kind: 'leapDay' }
  | { kind: 'fifth'; day: number }

/**
 * What the repeat skips where it is not obvious: months without any of the
 * chosen days (from the 29th on), the late days short months leave out where
 * another day or the last one keeps a date in each, years without February
 * 29, months without a fifth such weekday (every month has a fifth weekday
 * and a fifth weekend day).
 */
export function skipHint(model: RuleModel): SkipHint | null {
  if (model.freq !== 'monthly' && model.freq !== 'yearly') return null
  const p = model.monthly
  if (p.by === 'nth') return p.nth === 5 && typeof p.day === 'number' ? { kind: 'fifth', day: p.day } : null
  if (model.freq === 'yearly') return model.month === 1 && p.days.includes(29) ? { kind: 'leapDay' } : null
  const late = p.days.filter((d) => d >= 29)
  if (late.length === 0) return null
  if (p.days.includes(-1) || p.days.some((d) => d > 0 && d < 29)) return { kind: 'shortMonths' }
  return { kind: 'monthDay', day: Math.min(...late) }
}
