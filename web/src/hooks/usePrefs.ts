import { type Locale } from 'date-fns'
import { useEffect, useMemo, useState } from 'react'
import { defaultDateLocale, loadDateLocale, localeKey, type FormatPrefs } from '@/lib/format'
import { browserLocale, detectHourCycle, detectWeekStart, pickLanguage } from '@/lib/locale'
import { useSettings, type SettingsState } from '@/stores/settings'

/** The locale tag used for formatting: the browser locale unless the user picked another language. */
export function formattingTag(language: SettingsState['language'], browser = browserLocale()): string {
  if (language === 'auto' || pickLanguage(browser) === language) return browser
  return language
}

const cache = new Map<string, Locale>()

/** Formatting preferences derived from the browser locale and the user's overrides (FR-22). */
export function usePrefs(): FormatPrefs {
  const language = useSettings((s) => s.language)
  const timeFormat = useSettings((s) => s.timeFormat)
  const weekStart = useSettings((s) => s.weekStart)
  const tag = formattingTag(language)
  const [, setLoaded] = useState(0)

  useEffect(() => {
    if (cache.has(tag) || localeKey(tag) === null) return
    let active = true
    void loadDateLocale(tag).then((loc) => {
      cache.set(tag, loc)
      if (active) setLoaded((n) => n + 1)
    })
    return () => {
      active = false
    }
  }, [tag])

  const locale = cache.get(tag) ?? defaultDateLocale
  return useMemo(
    () => ({
      tag,
      locale,
      hourCycle: timeFormat === 'auto' ? detectHourCycle(tag) : timeFormat,
      weekStartsOn: weekStart === 'auto' ? detectWeekStart(tag) : weekStart,
    }),
    [tag, locale, timeFormat, weekStart],
  )
}
