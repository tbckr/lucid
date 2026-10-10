import { type Query, type QueryClient } from '@tanstack/react-query'
import { type ApiClient } from '@/lib/api/client'

export interface RefreshResult {
  /** Whether something on screen failed to reload, or only got queued for when Lucid is back online. */
  failed: boolean
  /** Errors of what failed to reload; its earlier data stays shown. */
  errors: unknown[]
  /** When the oldest data still shown after a failure was loaded, null if none. */
  shownAt: number | null
}

/** Calendars, events and tasks: everything a refresh reloads, the session aside. */
function isCalendarData(q: Query): boolean {
  return q.queryKey[0] !== 'session'
}

function oldestLoad(queries: Query[]): number | null {
  const times = queries.map((q) => q.state.dataUpdatedAt).filter((t) => t > 0)
  return times.length > 0 ? Math.min(...times) : null
}

/** Resolves once no change is being saved, whose own reload would race a refresh's. */
function changesSaved(qc: QueryClient): Promise<void> {
  if (qc.isMutating() === 0) return Promise.resolve()
  return new Promise((resolve) => {
    const unsubscribe = qc.getMutationCache().subscribe(() => {
      if (qc.isMutating() > 0) return
      unsubscribe()
      resolve()
    })
  })
}

/**
 * Manual refresh (FR-23): once pending changes are saved, reloads the
 * calendars, events and tasks on screen past the backend's cache freshness,
 * and has those off screen reload when shown again.
 */
export async function refreshAll(qc: QueryClient, client: Pick<ApiClient, 'revalidating'>): Promise<RefreshResult> {
  await changesSaved(qc)
  const started = Date.now()
  await client.revalidating(() => qc.invalidateQueries({ predicate: isCalendarData }))
  const onScreen = qc.getQueryCache().findAll({ type: 'active', predicate: isCalendarData })
  const errored = onScreen.filter((q) => q.state.status === 'error' && q.state.errorUpdatedAt >= started)
  // Offline, a reload only pauses, and the invalidation doesn't wait for it.
  const paused = onScreen.filter((q) => q.state.fetchStatus === 'paused')
  const failed = [...errored, ...paused]
  return { failed: failed.length > 0, errors: errored.map((q) => q.state.error), shownAt: oldestLoad(failed) }
}

/** When the oldest calendar data on screen was loaded, null before any is. */
export function loadedAt(qc: QueryClient): number | null {
  return oldestLoad(qc.getQueryCache().findAll({ type: 'active', predicate: isCalendarData }))
}

const reported = new WeakSet<object>()

/** Marks the errors a refresh told about, so the load toasts don't tell again. */
export function markReported(errors: unknown[]): void {
  for (const e of errors) if (typeof e === 'object' && e !== null) reported.add(e)
}

/** Whether a refresh already told about `error`. */
export function isReported(error: unknown): boolean {
  return typeof error === 'object' && error !== null && reported.has(error)
}
