import { useQueryClient } from '@tanstack/react-query'
import { CheckIcon, RefreshCwIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { usePrefs } from '@/hooks/usePrefs'
import { type RefreshState } from '@/hooks/useRefresh'
import { formatLoadedAt } from '@/lib/format'
import { loadedAt } from '@/lib/refresh'
import { cn } from '@/lib/utils'
import { useUi } from '@/stores/ui'

/**
 * Manual refresh (FR-23): spins while it runs, at least a full turn, then
 * shows a check mark for a moment. Its tooltip tells when the data on screen
 * was loaded; it can't refresh while Lucid can't reach its server.
 */
export function RefreshButton({
  state,
  onRefresh,
  className,
}: {
  state: RefreshState
  onRefresh: () => void
  className?: string
}) {
  const { t } = useTranslation()
  const reachable = useUi((s) => s.backendReachable)
  const label = t('refresh.label')
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={label}
            aria-keyshortcuts="r"
            aria-disabled={reachable ? undefined : true}
            aria-busy={state === 'running' ? true : undefined}
            onClick={() => {
              if (reachable) onRefresh()
            }}
            className={cn(state !== 'idle' && 'text-primary', 'aria-disabled:opacity-50', className)}
          >
            {state === 'done' ? (
              <CheckIcon aria-hidden />
            ) : (
              <RefreshCwIcon
                aria-hidden
                className={cn(state === 'running' && 'motion-safe:animate-spin')}
                style={{ animationDuration: '600ms' }}
              />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {label}
          <span className="ml-2 opacity-70">r</span>
          {reachable ? <LoadedAt className="block opacity-70" /> : <span className="block opacity-70">{t('refresh.offline')}</span>}
        </TooltipContent>
      </Tooltip>
      <span role="status" className="sr-only">
        {state === 'done' ? t('refresh.done') : ''}
      </span>
    </>
  )
}

/** When the data on screen was loaded, read as the tooltip or menu opens. */
export function LoadedAt({ className }: { className?: string }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const prefs = usePrefs()
  const at = loadedAt(qc)
  if (at === null) return null
  return <span className={className}>{t('refresh.loadedAt', { time: formatLoadedAt(new Date(at), prefs, new Date()) })}</span>
}
