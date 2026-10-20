import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { useUi } from '@/stores/ui'

// Loaded the first time the report opens: the login screen does without it until then.
const ReportDialog = lazy(() => import('./ReportDialog').then((m) => ({ default: m.ReportDialog })))

/**
 * The problem report dialog (FR-36), mounted once for both screens. At each opening it notes where the focus goes
 * back to once the dialog closes, before the opening closes the details it may come from: the item's block, or
 * what opened it. Each opening gets a number, by which the dialog starts afresh.
 */
export function ReportDialogMount() {
  const [opening, setOpening] = useState(0)
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
    <Suspense fallback={null}>
      <ReportDialog opening={opening} returnFocus={returnFocus} />
    </Suspense>
  )
}
