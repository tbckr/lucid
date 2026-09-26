import { TriangleAlertIcon } from 'lucide-react'
import { type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

/** Placeholder for an event that could not be parsed or rendered (FR-19). */
export function CorruptedEvent({
  reason,
  className,
  style,
}: {
  reason?: string
  className?: string
  style?: CSSProperties
}) {
  const { t } = useTranslation()
  return (
    <div
      role="note"
      data-testid="corrupted-event"
      title={reason}
      style={style}
      className={cn(
        'flex h-5 min-w-0 items-center gap-1 rounded-sm border border-dashed border-destructive/60 bg-destructive/5 px-1.5 text-xs text-destructive',
        className,
      )}
    >
      <TriangleAlertIcon className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{t('event.corrupted')}</span>
    </div>
  )
}
