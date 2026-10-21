import { LifeBuoyIcon, XIcon } from 'lucide-react'
import { useId, useLayoutEffect, useRef } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { reportWaits, useUi } from '@/stores/ui'

/**
 * The problem report while it waits (FR-36): closed with items, or to add one, it does not vanish but docks at the
 * bottom of the screen, says what it holds and how to add an item, until it is downloaded or discarded. Quiet
 * chrome: paper and a hairline, no tint, no iris (which means consented content), no red.
 */
/** Sonner's default toast width (its `--width`), and the gap the tray keeps to a toast. */
const TOAST_WIDTH = 356
const TOAST_GAP = 12

export function ReportTray() {
  const waits = useUi(reportWaits)
  return waits ? <Tray /> : null
}

function Tray() {
  const { t } = useTranslation()
  const id = useId()
  const candidates = useUi((s) => s.report.candidates)
  const openReport = useUi((s) => s.openReport)
  const ref = useRef<HTMLElement>(null)

  // Toasts share the bottom of the screen: where a centred one would cover the tray (a phone, a narrow window), the
  // tray tells them the room it takes, its height and a gap, and the toaster adds that to its offset (`App.tsx`).
  useLayoutEffect(() => {
    const tray = ref.current
    if (!tray) return
    const root = document.documentElement
    const measure = () => {
      const toastLeft = (window.innerWidth - TOAST_WIDTH) / 2
      if (tray.getBoundingClientRect().right + TOAST_GAP > toastLeft) {
        root.style.setProperty('--report-tray-space', `${tray.offsetHeight + TOAST_GAP}px`)
      } else {
        root.style.removeProperty('--report-tray-space')
      }
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(tray)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
      root.style.removeProperty('--report-tray-space')
    }
  }, [])

  function discard() {
    const { clearReport, restoreReport } = useUi.getState()
    const before = useUi.getState().report
    clearReport()
    const discarded = useUi.getState().report
    // The tray goes with its buttons; the report lives in the account menu.
    document.querySelector<HTMLElement>('[data-account-menu]')?.focus()
    toast(t('diagnostics.discarded'), {
      id: 'report-discarded',
      action: {
        label: t('common.undo'),
        onClick: () => {
          // Only while nothing happened to the report since: Undo must not overwrite what came after.
          if (useUi.getState().report === discarded) restoreReport(before)
        },
      },
    })
  }

  return (
    <section
      ref={ref}
      aria-labelledby={`${id}-title`}
      className="fixed inset-x-3 bottom-3 z-40 rounded-lg border border-border bg-surface p-4 text-foreground shadow-float duration-200 animate-in fade-in-0 slide-in-from-bottom-2 motion-reduce:animate-none sm:right-auto sm:bottom-4 sm:left-4 sm:w-80"
    >
      <div className="grid grid-cols-[1rem_minmax(0,1fr)_auto] items-start gap-x-2.5">
        <LifeBuoyIcon className="mt-0.5 size-4 text-muted-foreground" aria-hidden />
        <div className="min-w-0">
          <h2 id={`${id}-title`} className="font-display text-sm font-semibold">
            {t('diagnostics.tray.label')}
          </h2>
          {candidates.length > 0 ? (
            <p className="truncate text-sm">{candidates.map((c) => c.label).join(', ')}</p>
          ) : (
            <p className="text-sm text-muted-foreground">{t('diagnostics.tray.empty')}</p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            <Trans i18nKey="diagnostics.tray.hint" components={{ icon: <ReportGlyph /> }} />
          </p>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('diagnostics.tray.discard')}
              onClick={discard}
              className="-mt-1 -mr-1 text-muted-foreground"
            >
              <XIcon aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('diagnostics.tray.discard')}</TooltipContent>
        </Tooltip>
      </div>
      <div className="mt-3 flex justify-end">
        <Button
          size="sm"
          onClick={() => {
            openReport()
          }}
          data-report-tray-open=""
          className="bg-foreground text-background hover:bg-foreground/85"
        >
          {t('diagnostics.tray.open')}
        </Button>
      </div>
    </section>
  )
}

/** The life buoy in a sentence: what it looks like, and its name for screen readers. */
function ReportGlyph() {
  const { t } = useTranslation()
  return (
    <>
      <LifeBuoyIcon className="inline size-3.5 align-[-0.2em]" aria-hidden />
      <span className="sr-only">{t('diagnostics.addItem')}</span>
    </>
  )
}
