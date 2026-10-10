import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api/client'
import { formatLoadedAt } from '@/lib/format'
import { isReported, markReported, refreshAll } from '@/lib/refresh'
import { useUi } from '@/stores/ui'
import { usePrefs } from './usePrefs'

export type RefreshState = 'idle' | 'running' | 'done'

/** The shortest spin, one full turn, so a quick refresh shows too. */
const MIN_SPIN_MS = 600
/** How long the check mark says a refresh is done. */
const DONE_MS = 1500

const wait = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/** The toasts of failed loads; a refresh tells about its own failure instead (FR-23). */
const LOAD_TOASTS = ['events-load', 'repeats-load']

/**
 * Manual refresh (FR-23), for the top bar's button and the `r` shortcut.
 * Ignored while one runs or Lucid can't reach its server. A failure is told
 * once, with the state still shown, in place of the load toasts; a success
 * clears them.
 */
export function useRefresh(): { state: RefreshState; refresh: () => void } {
  const qc = useQueryClient()
  const { t } = useTranslation()
  const prefs = usePrefs()
  const [state, setState] = useState<RefreshState>('idle')
  const running = useRef(false)
  const doneTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(
    () => () => {
      clearTimeout(doneTimer.current)
    },
    [],
  )

  const refresh = useCallback(() => {
    if (running.current || !useUi.getState().backendReachable) return
    running.current = true
    clearTimeout(doneTimer.current)
    setState('running')
    void Promise.all([refreshAll(qc, api), wait(MIN_SPIN_MS)])
      .then(([{ failed, errors, shownAt }]) => {
        if (!failed) {
          for (const id of [...LOAD_TOASTS, 'refresh']) toast.dismiss(id)
          setState('done')
          doneTimer.current = setTimeout(() => {
            setState('idle')
          }, DONE_MS)
          return
        }
        markReported(errors)
        for (const id of LOAD_TOASTS) toast.dismiss(id)
        const message =
          shownAt === null
            ? t('refresh.failed')
            : t('refresh.failedShowing', { time: formatLoadedAt(new Date(shownAt), prefs, new Date()) })
        toast.error(message, { id: 'refresh' })
        setState('idle')
      })
      .catch(() => {
        toast.error(t('refresh.failed'), { id: 'refresh' })
        setState('idle')
      })
      .finally(() => {
        running.current = false
      })
  }, [qc, t, prefs])

  return { state, refresh }
}

/**
 * Shows `message` as toast `id` for a new load error, but not while a refresh
 * runs, nor for an error a refresh told about: it says itself what failed
 * (FR-23).
 */
export function useLoadErrorToast(error: unknown, id: string, message: string, refreshing: boolean): void {
  useEffect(() => {
    if (error && !refreshing && !isReported(error)) toast.error(message, { id })
  }, [error, id, message, refreshing])
}
