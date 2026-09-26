import { CloudOffIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useUi } from '@/stores/ui'

/** Visible when the backend cannot be reached (FR-20). */
export function OfflineIndicator() {
  const { t } = useTranslation()
  const reachable = useUi((s) => s.backendReachable)
  return (
    <div role="status" aria-live="polite" className="contents">
      {!reachable && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              data-testid="offline-indicator"
              className="inline-flex h-8 items-center gap-1.5 rounded-full bg-destructive/10 px-3 text-xs font-semibold text-destructive outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <CloudOffIcon className="size-3.5" aria-hidden />
              {t('offline.label')}
            </button>
          </TooltipTrigger>
          <TooltipContent>{t('offline.description')}</TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}
