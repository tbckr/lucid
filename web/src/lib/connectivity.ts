import { onlineManager } from '@tanstack/react-query'
import { type ApiClient } from './api/client'

export interface ConnectivityOptions {
  client: ApiClient
  /** Called whenever the combined online state changes. */
  onChange?: (state: { browserOnline: boolean; backendReachable: boolean }) => void
  healthUrl?: string
  pollMs?: number
  fetchImpl?: typeof fetch
}

/**
 * Wire TanStack Query's onlineManager (FR-20) to two signals: the browser's
 * online/offline events and backend reachability as observed by the API
 * client. While the backend is unreachable, `/healthz` is polled; queries and
 * mutations are paused (networkMode "online") and resume on reconnect.
 */
export function setupConnectivity({
  client,
  onChange,
  healthUrl = '/healthz',
  pollMs = 5000,
  fetchImpl = (...args) => globalThis.fetch(...args),
}: ConnectivityOptions): () => void {
  let browserOnline = typeof navigator === 'undefined' ? true : navigator.onLine
  let backendReachable = true
  let timer: ReturnType<typeof setTimeout> | null = null
  let setOnline: ((online: boolean) => void) | null = null
  let disposed = false

  const publish = () => {
    setOnline?.(browserOnline && backendReachable)
    onChange?.({ browserOnline, backendReachable })
  }

  const poll = () => {
    timer = null
    if (disposed || backendReachable) return
    fetchImpl(healthUrl, { cache: 'no-store', credentials: 'same-origin' })
      .then((res) => {
        if (res.ok) setReachable(true)
        else schedule()
      })
      .catch(() => {
        schedule()
      })
  }

  const schedule = () => {
    if (timer === null && !disposed) timer = setTimeout(poll, pollMs)
  }

  const setReachable = (reachable: boolean) => {
    if (reachable === backendReachable) return
    backendReachable = reachable
    publish()
    if (!reachable) schedule()
  }

  const onBrowserChange = () => {
    browserOnline = navigator.onLine
    // Coming back online: verify the backend right away.
    if (browserOnline && !backendReachable) {
      if (timer !== null) clearTimeout(timer)
      timer = null
      poll()
    }
    publish()
  }

  onlineManager.setEventListener((set) => {
    setOnline = set
    window.addEventListener('online', onBrowserChange)
    window.addEventListener('offline', onBrowserChange)
    set(browserOnline && backendReachable)
    return () => {
      window.removeEventListener('online', onBrowserChange)
      window.removeEventListener('offline', onBrowserChange)
    }
  })

  const unsubscribe = client.onReachability(setReachable)

  return () => {
    disposed = true
    unsubscribe()
    if (timer !== null) clearTimeout(timer)
  }
}
