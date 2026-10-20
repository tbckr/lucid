import { LifeBuoyIcon, TriangleAlertIcon } from 'lucide-react'
import { type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { useUi } from '@/stores/ui'

/**
 * Placeholder for an event that could not be parsed or rendered (FR-19). A click opens the problem report
 * (FR-36), which lists what failed in it by field name.
 */
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
  const openReport = useUi((s) => s.openReport)
  const label = t('event.corrupted')
  return (
    // The wrapper takes the place the views give it; the button fills it.
    <div className={cn('min-w-0', className)} style={style}>
      <button
        type="button"
        data-testid="corrupted-event"
        title={reason}
        aria-label={t('diagnostics.corruptedAction', { label })}
        onClick={(e) => {
          // A month cell or a day column behind it would open the create popover.
          e.stopPropagation()
          openReport()
        }}
        className="flex h-5 w-full min-w-0 items-center gap-1 rounded-sm border border-dashed border-destructive/60 bg-destructive/5 px-1.5 text-left text-xs text-destructive transition-colors outline-none hover:bg-destructive/10 focus-visible:ring-2 focus-visible:ring-destructive/50"
      >
        <TriangleAlertIcon className="size-3 shrink-0" aria-hidden />
        <span className="truncate">{label}</span>
        {/* The life buoy of every way to the problem report. */}
        <LifeBuoyIcon className="ml-auto size-3 shrink-0" aria-hidden />
      </button>
    </div>
  )
}
