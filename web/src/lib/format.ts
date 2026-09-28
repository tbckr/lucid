import { format, isSameDay, type Locale } from 'date-fns'
import { enUS } from 'date-fns/locale/en-US'
import { type DateRange, type ViewKind } from './dates'
import { type CalEvent } from './events'
import { type HourCycle, type WeekStart } from './locale'

/** Everything formatting needs; derived from settings + browser locale. */
export interface FormatPrefs {
  /** BCP 47 tag used for Intl APIs. */
  tag: string
  locale: Locale
  hourCycle: HourCycle
  weekStartsOn: WeekStart
}

type Loader = () => Promise<Locale>

// Lazily loaded date-fns locales (each becomes its own small chunk).
const LOADERS: Record<string, Loader> = {
  'en-gb': () => import('date-fns/locale/en-GB').then((m) => m.enGB),
  'en-au': () => import('date-fns/locale/en-AU').then((m) => m.enAU),
  'en-ca': () => import('date-fns/locale/en-CA').then((m) => m.enCA),
  'en-ie': () => import('date-fns/locale/en-IE').then((m) => m.enIE),
  'en-in': () => import('date-fns/locale/en-IN').then((m) => m.enIN),
  'en-nz': () => import('date-fns/locale/en-NZ').then((m) => m.enNZ),
  de: () => import('date-fns/locale/de').then((m) => m.de),
  'de-at': () => import('date-fns/locale/de-AT').then((m) => m.deAT),
  fr: () => import('date-fns/locale/fr').then((m) => m.fr),
  'fr-ca': () => import('date-fns/locale/fr-CA').then((m) => m.frCA),
  'fr-ch': () => import('date-fns/locale/fr-CH').then((m) => m.frCH),
  es: () => import('date-fns/locale/es').then((m) => m.es),
  it: () => import('date-fns/locale/it').then((m) => m.it),
  nl: () => import('date-fns/locale/nl').then((m) => m.nl),
  pt: () => import('date-fns/locale/pt').then((m) => m.pt),
  'pt-br': () => import('date-fns/locale/pt-BR').then((m) => m.ptBR),
  pl: () => import('date-fns/locale/pl').then((m) => m.pl),
  cs: () => import('date-fns/locale/cs').then((m) => m.cs),
  sv: () => import('date-fns/locale/sv').then((m) => m.sv),
  da: () => import('date-fns/locale/da').then((m) => m.da),
  nb: () => import('date-fns/locale/nb').then((m) => m.nb),
  fi: () => import('date-fns/locale/fi').then((m) => m.fi),
  ru: () => import('date-fns/locale/ru').then((m) => m.ru),
  uk: () => import('date-fns/locale/uk').then((m) => m.uk),
  tr: () => import('date-fns/locale/tr').then((m) => m.tr),
  ja: () => import('date-fns/locale/ja').then((m) => m.ja),
  ko: () => import('date-fns/locale/ko').then((m) => m.ko),
  'zh-cn': () => import('date-fns/locale/zh-CN').then((m) => m.zhCN),
  'zh-tw': () => import('date-fns/locale/zh-TW').then((m) => m.zhTW),
}

/** Find the best date-fns loader key for a tag: exact match, then language. */
export function localeKey(tag: string): string | null {
  const lower = tag.toLowerCase().replace('_', '-')
  const parts = lower.split('-')
  const lang = parts[0] ?? ''
  const region = parts.find((p, i) => i > 0 && p.length === 2)
  const exact = region ? `${lang}-${region}` : lang
  if (exact in LOADERS) return exact
  if (lang === 'en') return null // en-US is bundled
  if (lang === 'zh') return 'zh-cn'
  if (lang === 'no' || lang === 'nn') return 'nb'
  return lang in LOADERS ? lang : null
}

/** Load the date-fns locale for a BCP 47 tag (en-US fallback). */
export async function loadDateLocale(tag: string): Promise<Locale> {
  const key = localeKey(tag)
  const loader = key ? LOADERS[key] : undefined
  if (!loader) return enUS
  try {
    return await loader()
  } catch {
    return enUS
  }
}

export const defaultDateLocale = enUS

/* ------------------------------------------------------------------------ */

export function timePattern(hc: HourCycle): string {
  return hc === '12h' ? 'h:mm a' : 'HH:mm'
}

export function formatTime(date: Date, p: FormatPrefs): string {
  return format(date, timePattern(p.hourCycle), { locale: p.locale })
}

/** Compact time for chips: "9 AM" / "9:30 AM" or "09:00". */
export function formatShortTime(date: Date, p: FormatPrefs): string {
  if (p.hourCycle === '24h') return format(date, 'HH:mm', { locale: p.locale })
  return format(date, date.getMinutes() === 0 ? 'h a' : 'h:mm a', { locale: p.locale })
}

/** Hour gutter label for the time grid. */
export function formatHour(hour: number, p: FormatPrefs): string {
  const d = new Date(2000, 0, 1, hour)
  return p.hourCycle === '12h' ? format(d, 'h a', { locale: p.locale }) : format(d, 'HH:mm', { locale: p.locale })
}

function intlRange(start: Date, endInclusive: Date, tag: string, opts: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat(tag, opts).formatRange(start, endInclusive)
  } catch {
    return `${start.toLocaleDateString(tag, opts)} – ${endInclusive.toLocaleDateString(tag, opts)}`
  }
}

/** The title shown in the top bar for the current period. */
export function formatPeriodTitle(view: ViewKind, date: Date, range: DateRange, p: FormatPrefs): string {
  const lastDay = new Date(range.end.getTime() - 1)
  switch (view) {
    case 'month':
      return format(date, 'LLLL yyyy', { locale: p.locale })
    case 'day':
      return format(date, 'PPPP', { locale: p.locale })
    case 'week':
    case 'agenda':
      return intlRange(range.start, lastDay, p.tag, { day: 'numeric', month: 'short', year: 'numeric' })
  }
}

/** Human readable time span of an event, e.g. "09:00 – 10:30". */
export function formatEventSpan(e: CalEvent, p: FormatPrefs, allDayLabel: string): string {
  if (e.allDay) {
    const last = new Date(e.endsAt.getTime() - 1)
    if (isSameDay(e.startsAt, last)) return `${format(e.startsAt, 'PPP', { locale: p.locale })}, ${allDayLabel}`
    return intlRange(e.startsAt, last, p.tag, { day: 'numeric', month: 'short', year: 'numeric' })
  }
  const t = timePattern(p.hourCycle)
  if (isSameDay(e.startsAt, e.endsAt)) {
    return `${format(e.startsAt, 'PPP', { locale: p.locale })}, ${format(e.startsAt, t, { locale: p.locale })} – ${format(e.endsAt, t, { locale: p.locale })}`
  }
  return `${format(e.startsAt, `PP, ${t}`, { locale: p.locale })} – ${format(e.endsAt, `PP, ${t}`, { locale: p.locale })}`
}

/** Length of an event: wall-clock minutes for timed events, days for all-day ones. */
export type Duration = { minutes: number } | { days: number }

function formatUnit(value: number, unit: 'day' | 'hour' | 'minute', p: FormatPrefs): string {
  return new Intl.NumberFormat(p.tag, { style: 'unit', unit, unitDisplay: unit === 'day' ? 'long' : 'short' }).format(value)
}

/** Duration next to the end time, e.g. "1 hr 30 min" or "3 days". */
export function formatDuration(d: Duration, p: FormatPrefs): string {
  if ('days' in d) return formatUnit(d.days, 'day', p)
  const days = Math.floor(d.minutes / (24 * 60))
  const hours = Math.floor((d.minutes % (24 * 60)) / 60)
  const minutes = d.minutes % 60
  const parts = [
    ...(days ? [formatUnit(days, 'day', p)] : []),
    ...(hours ? [formatUnit(hours, 'hour', p)] : []),
    ...(minutes ? [formatUnit(minutes, 'minute', p)] : []),
  ]
  if (parts.length === 0) return formatUnit(0, 'minute', p)
  return new Intl.ListFormat(p.tag, { type: 'unit', style: 'narrow' }).format(parts)
}

/** Date on a date picker button, e.g. "Wed, Mar 11"; with the year when it is not the current one. */
export function formatPickerDate(date: Date, p: FormatPrefs, now: Date): string {
  return new Intl.DateTimeFormat(p.tag, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  }).format(date)
}

/** Day and month without the year, e.g. "March 11" (yearly repeats). */
export function formatMonthDay(date: Date, p: FormatPrefs): string {
  return new Intl.DateTimeFormat(p.tag, { day: 'numeric', month: 'long' }).format(date)
}

/** Short weekday names in display order for the given week start. */
export function weekdayNames(p: FormatPrefs, width: 'short' | 'narrow' = 'short'): string[] {
  const names: string[] = []
  // 2023-01-01 was a Sunday.
  for (let i = 0; i < 7; i++) {
    const d = new Date(2023, 0, 1 + ((p.weekStartsOn + i) % 7))
    names.push(format(d, width === 'short' ? 'EEE' : 'EEEEE', { locale: p.locale }))
  }
  return names
}
