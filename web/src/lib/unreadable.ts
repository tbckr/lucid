import { type TFunction } from 'i18next'
import { isFormDate, isFormTime } from './dates'
import { type FormatPrefs } from './format'
import { dateExample } from './typedDate'
import { timeExample } from './typedTime'

/**
 * What to type where a field holds text it couldn't read (FR-09), with an
 * example in the user's own format: "Enter a date like 28.10.2026." for the
 * first part whose `date` isn't empty and isn't a date as the forms hold it
 * (`isFormDate`), else "Enter a time like 9:40 AM." for the first whose
 * `time` isn't a time as they hold it (`isFormTime`). A field passes text it
 * can't read up as it is, so the forms' checks keep it from being saved; this
 * says why, at once, not only after Save. `parts` are the dates and times the
 * form shows.
 */
export function unreadableNote(
  t: TFunction,
  prefs: FormatPrefs,
  now: Date,
  parts: { date?: string; time?: string }[],
): string | undefined {
  if (parts.some((p) => p.date && !isFormDate(p.date))) {
    return t('validation.dateLike', { example: dateExample(prefs, now) })
  }
  if (parts.some((p) => p.time && !isFormTime(p.time))) {
    return t('validation.timeLike', { example: timeExample(prefs) })
  }
  return undefined
}
