import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { useUi } from '@/stores/ui'

/**
 * The dialog, loaded the first time the report opens: the login screen does without it until then. A lazy component
 * whose import failed stays failed, so a failure makes a new one for the next opening.
 */
const lazyDialog = () => lazy(() => import('./ReportDialog').then((m) => ({ default: m.ReportDialog })))

/**
 * The problem report dialog (FR-36), mounted once for both screens. At each opening it notes where the focus goes
 * back to once the dialog closes, before the opening closes the details it may come from: the item's block, or
 * what opened it. Each opening gets a number, by which the dialog starts afresh. A dialog that fails to load, its
 * chunk gone after an upgrade or the network down, or to render, says so in a toast and leaves the app as it was:
 * the report is closed, and the next opening tries again.
 */
export function ReportDialogMount() {
  const { t } = useTranslation()
  const [opening, setOpening] = useState(0)
  const [ReportDialog, setReportDialog] = useState(lazyDialog)
  const returnFocus = useRef<HTMLElement | null>(null)

  useEffect(
    () =>
      useUi.subscribe((s, prev) => {
        if (!s.report.open || prev.report.open) return
        const active = document.activeElement
        returnFocus.current =
          prev.detail?.anchor ?? (active instanceof HTMLElement && active !== document.body ? active : null)
        setOpening((n) => n + 1)
      }),
    [],
  )

  if (opening === 0) return null
  return (
    <ErrorBoundary
      resetKeys={[opening]}
      onError={(error) => {
        console.error('problem report failed', error)
        useUi.getState().closeReport()
        setReportDialog(() => lazyDialog())
        toast.error(t('diagnostics.loadFailed'), { id: 'report-failed' })
      }}
      fallback={() => null}
    >
      <Suspense fallback={null}>
        <ReportDialog opening={opening} returnFocus={returnFocus} />
      </Suspense>
    </ErrorBoundary>
  )
}
