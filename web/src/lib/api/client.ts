import { type z } from 'zod'
import { errorBodySchema, sessionSchema, type Session } from './schemas'

/** Error codes defined in docs/API.md plus client-side codes. */
export type ApiErrorCode =
  | 'invalid_input'
  | 'forbidden_target'
  | 'unauthenticated'
  | 'invalid_credentials'
  | 'csrf_invalid'
  | 'read_only'
  | 'unsupported_component'
  | 'not_found'
  | 'conflict'
  | 'discovery_failed'
  | 'precondition_required'
  | 'rate_limited'
  | 'upstream_error'
  | 'internal'
  /** The request never reached the backend (offline, DNS, connection refused). */
  | 'network'
  /** The response did not match the documented contract. */
  | 'bad_response'

const KNOWN_CODES = new Set<string>([
  'invalid_input',
  'forbidden_target',
  'unauthenticated',
  'invalid_credentials',
  'csrf_invalid',
  'read_only',
  'unsupported_component',
  'not_found',
  'conflict',
  'discovery_failed',
  'precondition_required',
  'rate_limited',
  'upstream_error',
  'internal',
])

export class ApiError extends Error {
  readonly status: number
  readonly code: ApiErrorCode
  /** Seconds from the Retry-After header (429). */
  readonly retryAfter: number | null

  constructor(status: number, code: ApiErrorCode, message: string, retryAfter: number | null = null) {
    super(message || code)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.retryAfter = retryAfter
  }
}

export function isApiError(err: unknown, code?: ApiErrorCode): err is ApiError {
  return err instanceof ApiError && (code === undefined || err.code === code)
}

/** Status → code fallback for error responses without a JSON body. */
function codeForStatus(status: number): ApiErrorCode {
  switch (status) {
    case 400:
      return 'invalid_input'
    case 401:
      return 'unauthenticated'
    case 404:
      return 'not_found'
    case 409:
      return 'conflict'
    case 428:
      return 'precondition_required'
    case 429:
      return 'rate_limited'
    case 502:
    case 503:
    case 504:
      return 'upstream_error'
    default:
      return 'internal'
  }
}

function parseRetryAfter(value: string | null): number | null {
  if (value === null || value.trim() === '') return null
  const secs = Number(value)
  if (Number.isFinite(secs)) return Math.max(0, Math.ceil(secs))
  const date = Date.parse(value)
  if (Number.isNaN(date)) return null
  return Math.max(0, Math.ceil((date - Date.now()) / 1000))
}

/** Convert a non-2xx response into an ApiError following the documented error shape. */
export async function parseErrorResponse(res: Response): Promise<ApiError> {
  const retryAfter = parseRetryAfter(res.headers.get('Retry-After'))
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    // Not JSON (e.g. a reverse proxy error page); fall back to the status.
  }
  const parsed = errorBodySchema.safeParse(body)
  if (parsed.success) {
    const { code, message } = parsed.data.error
    const known: ApiErrorCode = KNOWN_CODES.has(code) ? (code as ApiErrorCode) : codeForStatus(res.status)
    return new ApiError(res.status, known, message, retryAfter)
  }
  return new ApiError(res.status, codeForStatus(res.status), res.statusText, retryAfter)
}

export interface RequestOptions<T> {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
  /** Sent verbatim as If-Match (PUT/DELETE of events and todos). */
  etag?: string
  /** Validates the JSON body of a successful response. */
  schema?: z.ZodType<T>
  signal?: AbortSignal
}

type Listener = () => void

/**
 * Thin fetch wrapper implementing the conventions of docs/API.md:
 * CSRF token (kept in memory only), If-Match, error shape, one retry after
 * `csrf_invalid`, and a hook for `unauthenticated`.
 */
export class ApiClient {
  private csrfToken: string | null = null
  private sessionRefresh: Promise<Session> | null = null
  private readonly unauthenticatedListeners = new Set<Listener>()
  private readonly networkListeners = new Set<(reachable: boolean) => void>()

  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(baseUrl = '/api/v1', fetchImpl: typeof fetch = (...args) => globalThis.fetch(...args)) {
    this.baseUrl = baseUrl
    this.fetchImpl = fetchImpl
  }

  get token(): string | null {
    return this.csrfToken
  }

  setCsrfToken(token: string | null): void {
    this.csrfToken = token
  }

  /** Called when any request fails with 401 unauthenticated. */
  onUnauthenticated(listener: Listener): () => void {
    this.unauthenticatedListeners.add(listener)
    return () => this.unauthenticatedListeners.delete(listener)
  }

  /** Called with false when the backend is unreachable, true when a request succeeds again. */
  onReachability(listener: (reachable: boolean) => void): () => void {
    this.networkListeners.add(listener)
    return () => this.networkListeners.delete(listener)
  }

  private emitReachability(reachable: boolean): void {
    this.networkListeners.forEach((l) => {
      l(reachable)
    })
  }

  /** GET /session; updates the in-memory CSRF token. Concurrent calls share one request. */
  async fetchSession(signal?: AbortSignal): Promise<Session> {
    if (this.sessionRefresh) return this.sessionRefresh
    const p = this.send('/session', { method: 'GET', schema: sessionSchema, ...(signal ? { signal } : {}) }, false)
      .then((s) => {
        this.csrfToken = s.csrfToken
        return s
      })
      .finally(() => {
        this.sessionRefresh = null
      })
    this.sessionRefresh = p
    return p
  }

  async request<T = undefined>(path: string, opts: RequestOptions<T> = {}): Promise<T> {
    return this.send(path, opts, true)
  }

  private async send<T>(path: string, opts: RequestOptions<T>, allowCsrfRetry: boolean): Promise<T> {
    const method = opts.method ?? 'GET'
    const mutating = method !== 'GET'
    if (mutating && this.csrfToken === null) {
      await this.fetchSession()
    }

    const headers: Record<string, string> = { Accept: 'application/json' }
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
    if (mutating && this.csrfToken !== null) headers['X-CSRF-Token'] = this.csrfToken
    if (opts.etag !== undefined) headers['If-Match'] = opts.etag

    let res: Response
    try {
      res = await this.fetchImpl(this.baseUrl + path, {
        method,
        headers,
        credentials: 'same-origin',
        cache: 'no-store',
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      })
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err
      this.emitReachability(false)
      throw new ApiError(0, 'network', err instanceof Error ? err.message : 'network error')
    }
    this.emitReachability(true)

    if (!res.ok) {
      const error = await parseErrorResponse(res)
      if (error.code === 'csrf_invalid' && allowCsrfRetry) {
        this.csrfToken = null
        await this.fetchSession()
        return this.send(path, opts, false)
      }
      if (error.code === 'unauthenticated') {
        this.unauthenticatedListeners.forEach((l) => {
          l()
        })
      }
      throw error
    }

    if (res.status === 204 || !opts.schema) {
      return undefined as T
    }
    let json: unknown
    try {
      json = await res.json()
    } catch {
      throw new ApiError(res.status, 'bad_response', 'response is not valid JSON')
    }
    const parsed = opts.schema.safeParse(json)
    if (!parsed.success) {
      throw new ApiError(res.status, 'bad_response', parsed.error.message)
    }
    return parsed.data
  }
}

export const api = new ApiClient()
