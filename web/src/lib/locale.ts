/**
 * Locale-derived defaults (FR-22): 12h/24h clock and first day of week from
 * the browser locale, using Intl.Locale week/hour-cycle info where available
 * and CLDR-based fallbacks otherwise.
 */

export type WeekStart = 0 | 1 | 6 // date-fns weekStartsOn: Sunday, Monday, Saturday
export type HourCycle = '12h' | '24h'

interface WeekInfo {
  firstDay: number // 1 = Monday … 7 = Sunday
}

interface LocaleWithInfo {
  getWeekInfo?: () => WeekInfo
  weekInfo?: WeekInfo
  getHourCycles?: () => string[]
  hourCycles?: string[]
  maximize: () => Intl.Locale
  region?: string
}

// CLDR supplemental weekData (firstDay) for regions not starting on Monday.
const SUNDAY_REGIONS = new Set([
  'AG', 'AS', 'BD', 'BR', 'BS', 'BT', 'BW', 'BZ', 'CA', 'CN', 'CO', 'DM', 'DO', 'ET', 'GT', 'GU', 'HK',
  'HN', 'ID', 'IL', 'IN', 'JM', 'JP', 'KE', 'KH', 'KR', 'LA', 'MH', 'MM', 'MO', 'MT', 'MX', 'MZ', 'NI',
  'NP', 'PA', 'PE', 'PH', 'PK', 'PR', 'PT', 'PY', 'SA', 'SG', 'SV', 'TH', 'TT', 'TW', 'UM', 'US', 'VE',
  'VI', 'WS', 'YE', 'ZA', 'ZW',
])
const SATURDAY_REGIONS = new Set(['AE', 'AF', 'BH', 'DJ', 'DZ', 'EG', 'IQ', 'IR', 'JO', 'KW', 'LY', 'OM', 'QA', 'SD', 'SY'])

function toLocale(tag: string): LocaleWithInfo | null {
  try {
    return new Intl.Locale(tag)
  } catch {
    return null
  }
}

function regionOf(loc: LocaleWithInfo): string | undefined {
  if (loc.region) return loc.region
  try {
    return (loc.maximize() as unknown as LocaleWithInfo).region
  } catch {
    return undefined
  }
}

/** First day of week for a BCP 47 tag, as date-fns `weekStartsOn`. */
export function detectWeekStart(tag: string): WeekStart {
  const loc = toLocale(tag)
  if (!loc) return 1
  let info: WeekInfo | undefined
  try {
    info = typeof loc.getWeekInfo === 'function' ? loc.getWeekInfo() : loc.weekInfo
  } catch {
    info = undefined
  }
  if (info && Number.isInteger(info.firstDay)) {
    const d = info.firstDay % 7
    if (d === 0 || d === 1 || d === 6) return d
    return 1
  }
  const region = regionOf(loc)
  if (region && SUNDAY_REGIONS.has(region)) return 0
  if (region && SATURDAY_REGIONS.has(region)) return 6
  return 1
}

/** Preferred clock for a BCP 47 tag. */
export function detectHourCycle(tag: string): HourCycle {
  const loc = toLocale(tag)
  if (loc) {
    let cycles: string[] | undefined
    try {
      cycles = typeof loc.getHourCycles === 'function' ? loc.getHourCycles() : loc.hourCycles
    } catch {
      cycles = undefined
    }
    const first = cycles?.[0]
    if (first) return first === 'h11' || first === 'h12' ? '12h' : '24h'
  }
  try {
    const opts = new Intl.DateTimeFormat(tag, { hour: 'numeric' }).resolvedOptions()
    if (opts.hourCycle) return opts.hourCycle === 'h11' || opts.hourCycle === 'h12' ? '12h' : '24h'
    if (typeof opts.hour12 === 'boolean') return opts.hour12 ? '12h' : '24h'
  } catch {
    // fall through
  }
  return '24h'
}

/** The browser's preferred locale tag (navigator.language), defaulting to en-US. */
export function browserLocale(): string {
  if (typeof navigator !== 'undefined') {
    const tag = navigator.languages[0] ?? navigator.language
    if (tag) return tag
  }
  return 'en-US'
}

/** The browser's IANA time zone. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

export const SUPPORTED_LANGUAGES = ['en', 'de'] as const
export type Language = (typeof SUPPORTED_LANGUAGES)[number]

/** Map a BCP 47 tag to a supported UI language (English default). */
export function pickLanguage(tag: string | undefined): Language {
  const base = (tag ?? '').toLowerCase().split(/[-_]/)[0]
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(base ?? '') ? (base as Language) : 'en'
}
