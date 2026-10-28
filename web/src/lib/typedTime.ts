import { isFormTime } from './dates'
import { formatClock, type FormatPrefs } from './format'

/** The example the error message gives: 9:40 as the field would show it (FR-09). */
export function timeExample(prefs: FormatPrefs): string {
  return formatClock('09:40', prefs)
}

type Half = 'am' | 'pm'

/**
 * What marks a half of the day: `a`, `p`, `am`, `pm`, and the day periods the
 * date-fns locale shows in its `a` token (all three widths it can use), so the
 * field reads back everything `formatClock` writes. Lower case, longest first,
 * so `am` is taken before `a`.
 */
function markers(prefs: FormatPrefs): [string, Half][] {
  const found = new Map<string, Half>([
    ['a', 'am'],
    ['am', 'am'],
    ['p', 'pm'],
    ['pm', 'pm'],
  ])
  for (const width of ['abbreviated', 'wide', 'narrow'] as const) {
    for (const half of ['am', 'pm'] as const) {
      const text = squash(prefs.locale.localize.dayPeriod(half, { width, context: 'formatting' }))
      if (text) found.set(text, half)
    }
  }
  return [...found].sort((a, b) => b[0].length - a[0].length)
}

function squash(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** Cuts a marker off the front or the back of the text: what is left, and the half it names. */
function splitMarker(text: string, prefs: FormatPrefs): { rest: string; half: Half | null } {
  for (const [marker, half] of markers(prefs)) {
    if (text.endsWith(marker)) return { rest: text.slice(0, -marker.length).trim(), half }
    if (text.startsWith(marker)) return { rest: text.slice(marker.length).trim(), half }
  }
  return { rest: text, half: null }
}

/**
 * Hours and minutes of what is typed without a marker: `9`, `940`, `9:40`,
 * `9.40`, `9h40`, `9h`, `9 40`. `padded`: the hour was written with a leading
 * zero (`09`), which is 24-hour notation.
 */
function splitDigits(text: string): { hour: number; minute: number; padded: boolean } | null {
  const found =
    // 940 and 0940: with three or four digits the last two are minutes.
    /^(\d{1,2})(\d{2})$/.exec(text) ??
    // Minutes are always two digits, so that "9:4" is not a guess between 9:04 and 9:40.
    /^(\d{1,2})(?:(?:\s*[:.h]\s*|\s+)(\d{2})|\s*[:.h])?$/.exec(text)
  if (!found) return null
  const [, hour = '', minute = '0'] = found
  return { hour: Number(hour), minute: Number(minute), padded: hour.length === 2 && hour.startsWith('0') }
}

/** The half of the day a bare hour of 1 to 11 falls in: the field's current one, else 1 to 6 PM and 7 to 11 AM. */
function halfOf(hour: number, current: string): Half {
  if (isFormTime(current)) return Number(current.slice(0, 2)) >= 12 ? 'pm' : 'am'
  return hour <= 6 ? 'pm' : 'am'
}

/**
 * Reads what a user typed into a time field as the forms' `"HH:mm"`, or `null`
 * when it can't be read (FR-09). Minute-exact: nothing is rounded to the
 * 30-minute grid the lists offer.
 *
 * Reads `9`, `14`, `940`, `0940`, `9:40`, `9.40`, `9h40`, `9h`, and any of
 * them with a day period before or after (`9p`, `9 pm`, `9:40am`, `12a`, or
 * the date-fns locale's own, such as `2:00 nachm.`). Hours run 0 to 23 and
 * minutes 0 to 59; with a marker the hour is 1 to 12. In a 12-hour clock an
 * hour without a marker of 13 to 23 or 0 is a 24-hour reading, and so is one
 * written with a leading zero (`09:40`, `0940`, `05`); 12 is noon, and 1 to 11
 * written without a leading zero keep the half of the day of `current` (the
 * field's value, or `''`); an empty field reads 1 to 6 as PM and 7 to 11 as AM.
 * The 24-hour clock reads them as typed.
 */
export function readTime(text: string, o: { prefs: FormatPrefs; current: string }): string | null {
  const { rest, half } = splitMarker(squash(text), o.prefs)
  const at = splitDigits(rest)
  if (!at || at.minute > 59) return null
  let hour = at.hour
  if (half) {
    if (hour < 1 || hour > 12) return null
    hour = (hour % 12) + (half === 'pm' ? 12 : 0)
  } else {
    if (hour > 23) return null
    const needsHalf = o.prefs.hourCycle === '12h' && !at.padded && hour >= 1 && hour <= 11
    if (needsHalf && halfOf(hour, o.current) === 'pm') hour += 12
  }
  return `${String(hour).padStart(2, '0')}:${String(at.minute).padStart(2, '0')}`
}
