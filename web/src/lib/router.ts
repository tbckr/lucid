import { useSyncExternalStore } from 'react'

/**
 * A tiny history-based router: the app has two screens (login, calendar),
 * so a full router would be overkill.
 */

const EVENT = 'lucid:navigate'

function subscribe(cb: () => void): () => void {
  window.addEventListener('popstate', cb)
  window.addEventListener(EVENT, cb)
  return () => {
    window.removeEventListener('popstate', cb)
    window.removeEventListener(EVENT, cb)
  }
}

function snapshot(): string {
  return window.location.pathname + window.location.search + window.location.hash
}

/** Navigate to a same-origin path. */
export function navigate(path: string, { replace = false }: { replace?: boolean } = {}): void {
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error(`refusing to navigate to ${path}`)
  if (path === snapshot()) return
  if (replace) window.history.replaceState(null, '', path)
  else window.history.pushState(null, '', path)
  window.dispatchEvent(new Event(EVENT))
}

/** Current path + search + hash, re-rendering on navigation. */
export function useLocation(): { href: string; pathname: string; search: URLSearchParams } {
  const href = useSyncExternalStore(subscribe, snapshot, () => '/')
  const url = new URL(href, 'https://lucid.invalid')
  return { href, pathname: url.pathname, search: url.searchParams }
}
