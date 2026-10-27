import { type FormatPrefs } from './format'

type Part = 'day' | 'month' | 'year'

/** Latin digits and the Gregorian calendar, so the text stays numbers in fa, ar-EG and the like. */
function formatter(prefs: FormatPrefs): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(prefs.tag, {
    calendar: 'gregory',
    numberingSystem: 'latn',
    day: 'numeric',
    month: 'numeric',
    year: 'numeric',
  })
}

/**
 * What a date field shows while it has focus: the date as numbers in the order
 * and with the separators of the user's locale (de `13.3.2026`, en-US
 * `3/13/2026`, en-GB `13/03/2026`) (FR-09).
 */
export function formatTypedDate(day: Date, prefs: FormatPrefs): string {
  return formatter(prefs).format(day)
}

/** The example the error message gives: a date as the field would show it (FR-09). */
export function dateExample(prefs: FormatPrefs, now: Date): string {
  return formatTypedDate(now, prefs)
}

/**
 * The order of day, month and year in the locale's numeric date, and the words
 * it writes besides the numbers (bg `г.`): the reader takes both, so it reads
 * back everything `formatTypedDate` writes.
 */
function layout(prefs: FormatPrefs): { places: Part[]; words: string[] } {
  const places: Part[] = []
  const words: string[] = []
  for (const p of formatter(prefs).formatToParts(new Date(2026, 2, 13))) {
    if (p.type === 'day' || p.type === 'month' || p.type === 'year') places.push(p.type)
    else if (p.type === 'literal' && /\p{L}/u.test(p.value)) words.push(squash(p.value))
  }
  return { places, words: words.sort((a, b) => b.length - a.length) }
}

/** Lower case, one space for any run of white space; the marks that keep right-to-left dates in order are dropped. */
function squash(text: string): string {
  return text
    .replace(/[\u200e\u200f\u061c]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

/** Cuts the locale's own words off the front or the back of the text. */
function bare(text: string, words: string[]): string {
  for (const word of words) {
    if (text.endsWith(word)) return text.slice(0, -word.length).trim()
    if (text.startsWith(word)) return text.slice(word.length).trim()
  }
  return text
}

/**
 * Which part each number stands for. With fewer numbers than parts the year is
 * dropped first, then the month, so one number is the day. Digits only (`28`,
 * `2810`, `281026`, `28102026`) are cut by length: 1 or 2 digits are the day,
 * 4 the two parts besides the year, 6 all three with a two-digit year, 8 all
 * three with a four-digit one; any other count is unreadable.
 */
function split(text: string, places: Part[]): [Part, string][] | null {
  const noYear = places.filter((p) => p !== 'year')
  if (/^\d+$/.test(text)) {
    const n = text.length
    const kept = n <= 2 ? (['day'] as Part[]) : n === 4 ? noYear : n === 6 || n === 8 ? places : null
    if (!kept) return null
    let at = 0
    return kept.map((part) => {
      const width = n <= 2 ? n : part === 'year' && n === 8 ? 4 : 2
      at += width
      return [part, text.slice(at - width, at)]
    })
  }
  // A separator is . / - with spaces around it, or spaces alone; one after the last number is allowed.
  const numbers = text.split(/\s*[./-]\s*|\s+/)
  if (numbers.at(-1) === '') numbers.pop()
  const kept = numbers.length === 3 ? places : numbers.length === 2 ? noYear : numbers.length === 1 ? (['day'] as Part[]) : null
  return kept ? kept.map((part, i) => [part, numbers[i] ?? ''] as [Part, string]) : null
}

/**
 * Reads what a user typed into a date field as the forms' `"yyyy-MM-dd"`, or
 * `null` when it can't be read (FR-09). Numbers only, no words or relative
 * dates.
 *
 * The parts come in the order of the user's locale (`28.10.2026` in de,
 * `10/28/2026` in en-US, `2026-10-28` in sv), separated by `.`, `/`, `-` or
 * spaces, with a separator after the last one allowed: `28.10.2026`,
 * `28.10.26`, `28.10.`, `28.10`, `28`. Digits alone work too: `28`, `2810`,
 * `281026`, `28102026`. A part left out comes from `base` (no guessing of the
 * next 28 October), a two-digit year is 20yy, and a date that does not exist
 * (`31.02.`) is unreadable, as is a year before 1000, which the forms' day keys
 * could not hold.
 */
export function readDate(text: string, o: { prefs: FormatPrefs; base: Date }): string | null {
  const { places, words } = layout(o.prefs)
  const read = split(bare(squash(text), words), places)
  if (!read) return null
  let year = o.base.getFullYear()
  let month = o.base.getMonth() + 1
  let day = 0
  for (const [part, digits] of read) {
    if (!/^\d+$/.test(digits)) return null
    const value = Number(digits)
    if (part === 'day' && digits.length <= 2) day = value
    else if (part === 'month' && digits.length <= 2) month = value
    else if (part === 'year' && digits.length === 2) year = 2000 + value
    else if (part === 'year' && digits.length === 4) year = value
    else return null
  }
  if (year < 1000) return null
  // Through UTC, so that neither the zone nor a skipped hour can move the day.
  const check = new Date(Date.UTC(year, month - 1, day))
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}
