import { useTranslation } from 'react-i18next'
import { formatClock, type FormatPrefs } from '@/lib/format'
import { cn } from '@/lib/utils'

/**
 * Where a time is entered, that `time`, which summer time skips on its date,
 * is saved as `saved` (`skippedTime`), said before saving (#10, FR-18). A
 * fact, not an error: quiet, and the field stays unmarked.
 */
export function SkippedTimeNote({
  id,
  time,
  saved,
  prefs,
  className,
}: {
  id: string
  time: string
  saved: string
  prefs: FormatPrefs
  className?: string
}) {
  const { t } = useTranslation()
  return (
    <p id={id} className={cn('text-sm', className)}>
      {t('event.skippedTime', { time: formatClock(time, prefs), saved: formatClock(saved, prefs) })}
    </p>
  )
}
