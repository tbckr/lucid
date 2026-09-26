/**
 * Open-redirect protection for `?redirect=` (NFR-33).
 *
 * Only same-origin relative paths are accepted: the value must start with a
 * single "/", must not start with "//" (protocol-relative), must not contain
 * backslashes (browsers normalize "\" to "/"), control characters or a scheme.
 * Anything else yields `null` and the caller falls back to "/".
 */
export function safeRedirect(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return null
  if (!value.startsWith('/') || value.startsWith('//')) return null
  if (value.includes('\\')) return null
  // eslint-disable-next-line no-control-regex -- intentionally matching control characters
  if (/[\u0000-\u001f\u007f]/.test(value)) return null

  const base = 'https://lucid.invalid'
  let url: URL
  try {
    url = new URL(value, base)
  } catch {
    return null
  }
  if (url.origin !== base) return null

  const path = url.pathname + url.search + url.hash
  // Never bounce back to the login page itself.
  if (url.pathname === '/login') return null
  return path
}

/** Build the login URL that returns to `current` after authentication. */
export function loginPathFor(current: string): string {
  const target = safeRedirect(current)
  if (target === null || target === '/') return '/login'
  return `/login?redirect=${encodeURIComponent(target)}`
}
