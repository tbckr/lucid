import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { jsonResponse, urlOf } from '@/test/fixtures'
import { ApiClient, ApiError, isApiError, parseErrorResponse } from './client'

interface Call {
  url: string
  init: RequestInit
}

function mockFetch(...responses: (Response | Error | DOMException)[]) {
  const calls: Call[] = []
  const fn = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: urlOf(url), init: init ?? {} })
    const next = responses.shift()
    if (!next) throw new Error('unexpected request ' + urlOf(url))
    return next instanceof Response ? Promise.resolve(next) : Promise.reject(next)
  })
  return { fetch: fn as unknown as typeof fetch, calls }
}

const headers = (c: Call | undefined) => (c?.init.headers ?? {}) as Record<string, string>
const session = (token: string, authenticated = true) => jsonResponse(200, { authenticated, csrfToken: token })

describe('ApiClient', () => {
  it('fetches a session before the first mutation and sends X-CSRF-Token', async () => {
    const { fetch, calls } = mockFetch(session('tok1'), new Response(null, { status: 204 }))
    const client = new ApiClient('/api/v1', fetch)
    await client.request('/auth/logout', { method: 'POST' })
    expect(calls.map((c) => c.url)).toEqual(['/api/v1/session', '/api/v1/auth/logout'])
    expect(headers(calls[1])['X-CSRF-Token']).toBe('tok1')
    expect(calls[1]?.init.credentials).toBe('same-origin')
  })

  it('does not send the CSRF header on GET', async () => {
    const { fetch, calls } = mockFetch(jsonResponse(200, { ok: true }))
    const client = new ApiClient('/api/v1', fetch)
    client.setCsrfToken('tok')
    await client.request('/calendars')
    expect(headers(calls[0])['X-CSRF-Token']).toBeUndefined()
  })

  it('sends If-Match verbatim and JSON bodies', async () => {
    const { fetch, calls } = mockFetch(jsonResponse(200, { id: 'x' }))
    const client = new ApiClient('/api/v1', fetch)
    client.setCsrfToken('tok')
    const res = await client.request('/events/x', {
      method: 'PUT',
      etag: '"abc"',
      body: { title: 'T' },
      schema: z.object({ id: z.string() }),
    })
    expect(res).toEqual({ id: 'x' })
    expect(headers(calls[0])['If-Match']).toBe('"abc"')
    expect(headers(calls[0])['Content-Type']).toBe('application/json')
    expect(calls[0]?.init.body).toBe('{"title":"T"}')
  })

  it('refetches the session and retries once on csrf_invalid', async () => {
    const { fetch, calls } = mockFetch(
      jsonResponse(403, { error: { code: 'csrf_invalid', message: 'bad token' } }),
      session('fresh'),
      new Response(null, { status: 204 }),
    )
    const client = new ApiClient('/api/v1', fetch)
    client.setCsrfToken('stale')
    await client.request('/events/x', { method: 'DELETE', etag: '"1"' })
    expect(calls.map((c) => c.url)).toEqual(['/api/v1/events/x', '/api/v1/session', '/api/v1/events/x'])
    expect(headers(calls[2])['X-CSRF-Token']).toBe('fresh')
    expect(client.token).toBe('fresh')
  })

  it('gives up after one CSRF retry', async () => {
    const csrf = () => jsonResponse(403, { error: { code: 'csrf_invalid', message: '' } })
    const { fetch, calls } = mockFetch(csrf(), session('t2'), csrf())
    const client = new ApiClient('/api/v1', fetch)
    client.setCsrfToken('t1')
    await expect(client.request('/x', { method: 'POST' })).rejects.toMatchObject({ code: 'csrf_invalid', status: 403 })
    expect(calls).toHaveLength(3)
  })

  it('does not retry read_only (also 403)', async () => {
    const { fetch, calls } = mockFetch(jsonResponse(403, { error: { code: 'read_only', message: 'nope' } }))
    const client = new ApiClient('/api/v1', fetch)
    client.setCsrfToken('t')
    await expect(client.request('/x', { method: 'POST' })).rejects.toMatchObject({ code: 'read_only', message: 'nope' })
    expect(calls).toHaveLength(1)
  })

  it('notifies listeners on unauthenticated', async () => {
    const { fetch } = mockFetch(jsonResponse(401, { error: { code: 'unauthenticated', message: '' } }))
    const client = new ApiClient('/api/v1', fetch)
    const listener = vi.fn()
    const off = client.onUnauthenticated(listener)
    await expect(client.request('/calendars')).rejects.toBeInstanceOf(ApiError)
    expect(listener).toHaveBeenCalledOnce()
    off()
  })

  it('does not treat invalid_credentials as a session loss', async () => {
    const { fetch } = mockFetch(jsonResponse(401, { error: { code: 'invalid_credentials', message: '' } }))
    const client = new ApiClient('/api/v1', fetch)
    client.setCsrfToken('t')
    const listener = vi.fn()
    client.onUnauthenticated(listener)
    await expect(client.request('/auth/login', { method: 'POST', body: {} })).rejects.toMatchObject({
      code: 'invalid_credentials',
    })
    expect(listener).not.toHaveBeenCalled()
  })

  it('maps network failures to code "network" and reports reachability', async () => {
    const { fetch } = mockFetch(new TypeError('Failed to fetch'), jsonResponse(200, {}))
    const client = new ApiClient('/api/v1', fetch)
    const reach = vi.fn()
    client.onReachability(reach)
    await expect(client.request('/calendars')).rejects.toMatchObject({ code: 'network', status: 0 })
    expect(reach).toHaveBeenLastCalledWith(false)
    await client.request('/calendars')
    expect(reach).toHaveBeenLastCalledWith(true)
  })

  it('rethrows aborts unchanged', async () => {
    const abort = new DOMException('aborted', 'AbortError')
    const { fetch } = mockFetch(abort)
    const client = new ApiClient('/api/v1', fetch)
    await expect(client.request('/calendars')).rejects.toBe(abort)
  })

  it('rejects responses that violate the schema or are not JSON', async () => {
    const { fetch } = mockFetch(jsonResponse(200, { id: 1 }), new Response('<html>', { status: 200 }))
    const client = new ApiClient('/api/v1', fetch)
    const schema = z.object({ id: z.string() })
    await expect(client.request('/a', { schema })).rejects.toMatchObject({ code: 'bad_response' })
    await expect(client.request('/b', { schema })).rejects.toMatchObject({ code: 'bad_response' })
  })

  it('shares one in-flight session request', async () => {
    const { fetch, calls } = mockFetch(session('one'))
    const client = new ApiClient('/api/v1', fetch)
    const [a, b] = await Promise.all([client.fetchSession(), client.fetchSession()])
    expect(a).toEqual(b)
    expect(calls).toHaveLength(1)
  })

  it('uses the global fetch by default', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, { authenticated: false, csrfToken: 'g' }))
    const client = new ApiClient()
    await client.fetchSession()
    expect(spy).toHaveBeenCalledWith('/api/v1/session', expect.anything())
  })
})

describe('parseErrorResponse', () => {
  it('parses the documented error shape and Retry-After seconds', async () => {
    const err = await parseErrorResponse(
      jsonResponse(429, { error: { code: 'rate_limited', message: 'slow down' } }, { 'Retry-After': '12' }),
    )
    expect(err).toMatchObject({ status: 429, code: 'rate_limited', message: 'slow down', retryAfter: 12 })
  })

  it('parses Retry-After HTTP dates', async () => {
    const date = new Date(Date.now() + 5_000).toUTCString()
    const err = await parseErrorResponse(new Response(null, { status: 429, headers: { 'Retry-After': date } }))
    expect(err.retryAfter).toBeGreaterThanOrEqual(3)
    expect(err.retryAfter).toBeLessThanOrEqual(6)
    const bad = await parseErrorResponse(new Response(null, { status: 429, headers: { 'Retry-After': 'soon' } }))
    expect(bad.retryAfter).toBeNull()
  })

  it.each([
    [400, 'invalid_input'],
    [401, 'unauthenticated'],
    [403, 'internal'],
    [404, 'not_found'],
    [409, 'conflict'],
    [428, 'precondition_required'],
    [429, 'rate_limited'],
    [502, 'upstream_error'],
    [503, 'upstream_error'],
    [500, 'internal'],
  ])('falls back to the status for non-JSON %i responses', async (status, code) => {
    const err = await parseErrorResponse(new Response('<html>oops</html>', { status }))
    expect(err.code).toBe(code)
  })

  it.each([
    [422, 'unsupported_component'],
    [400, 'series_move_unsupported'],
  ])('keeps the code of a %i %s', async (status, code) => {
    const err = await parseErrorResponse(jsonResponse(status, { error: { code, message: 'm' } }))
    expect(err.code).toBe(code)
  })

  it('maps unknown codes by status', async () => {
    const err = await parseErrorResponse(jsonResponse(409, { error: { code: 'weird', message: 'm' } }))
    expect(err.code).toBe('conflict')
    expect(err.message).toBe('m')
  })
})

describe('isApiError', () => {
  it('narrows by code', () => {
    const e = new ApiError(409, 'conflict', '')
    expect(isApiError(e)).toBe(true)
    expect(isApiError(e, 'conflict')).toBe(true)
    expect(isApiError(e, 'not_found')).toBe(false)
    expect(isApiError(new Error('x'))).toBe(false)
    expect(e.message).toBe('conflict')
  })
})
