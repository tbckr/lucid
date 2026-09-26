import { describe, expect, it, vi } from 'vitest'
import { apiEvent, bodyOf, jsonResponse, todo, urlOf } from '@/test/fixtures'
import { ApiClient } from './client'
import { createEndpoints } from './endpoints'

function setup(...responses: Response[]) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetch = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: urlOf(url), init: init ?? {} })
    const r = responses.shift()
    return r ? Promise.resolve(r) : Promise.reject(new Error('no response'))
  }) as unknown as typeof globalThis.fetch
  const client = new ApiClient('/api/v1', fetch)
  client.setCsrfToken('tok')
  return { api: createEndpoints(client), client, calls }
}

describe('endpoints', () => {
  it('login stores the rotated CSRF token', async () => {
    const { api, client, calls } = setup(jsonResponse(200, { authenticated: true, username: 'u', csrfToken: 'rotated' }))
    const s = await api.login({ serverUrl: 'example.com', username: 'u', password: 'p' })
    expect(s.authenticated).toBe(true)
    expect(client.token).toBe('rotated')
    expect(bodyOf(calls[0]?.init)).toEqual({ serverUrl: 'example.com', username: 'u', password: 'p' })
  })

  it('logout clears the token', async () => {
    const { api, client } = setup(new Response(null, { status: 204 }))
    await api.logout()
    expect(client.token).toBeNull()
  })

  it('lists calendars (null → empty)', async () => {
    const { api } = setup(jsonResponse(200, { calendars: null }))
    expect(await api.listCalendars()).toEqual([])
  })

  it('lists events with an encoded range and isolates corrupted items', async () => {
    const { api, calls } = setup(jsonResponse(200, { events: [apiEvent(), { key: 'broken' }] }))
    const res = await api.listEvents('cal/1', new Date('2026-09-01T00:00:00Z'), new Date('2026-10-01T00:00:00Z'))
    expect(calls[0]?.url).toBe(
      '/api/v1/calendars/cal%2F1/events?start=2026-09-01T00%3A00%3A00.000Z&end=2026-10-01T00%3A00%3A00.000Z',
    )
    expect(res.events).toHaveLength(1)
    expect(res.corrupted).toHaveLength(1)
  })

  it('creates, updates and deletes events with If-Match', async () => {
    const e = apiEvent()
    const { api, calls } = setup(jsonResponse(201, e), jsonResponse(200, e), new Response(null, { status: 204 }))
    const input = {
      title: 'x',
      description: '',
      location: '',
      start: e.start,
      end: e.end,
      allDay: false,
      timezone: 'UTC',
      rrule: '',
    }
    await api.createEvent('c1', input)
    await api.updateEvent('e1', '"7"', { ...input, instanceStart: e.start })
    await api.deleteEvent('e1', '"7"')
    expect(calls.map((c) => [c.init.method, c.url])).toEqual([
      ['POST', '/api/v1/calendars/c1/events'],
      ['PUT', '/api/v1/events/e1'],
      ['DELETE', '/api/v1/events/e1'],
    ])
    expect((calls[1]?.init.headers as Record<string, string>)['If-Match']).toBe('"7"')
    expect(bodyOf(calls[1]?.init).instanceStart).toBe(e.start)
  })

  it('handles todos', async () => {
    const t = todo()
    const { api, calls } = setup(
      jsonResponse(200, { todos: [t, { id: 1 }] }),
      jsonResponse(201, t),
      jsonResponse(200, t),
      new Response(null, { status: 204 }),
    )
    const list = await api.listTodos('c1')
    expect(list.todos).toHaveLength(1)
    expect(list.corrupted).toHaveLength(1)
    const input = { title: 'x', description: '', checklist: [], due: null, dueAllDay: false, priority: 0, status: 'NEEDS-ACTION' as const }
    await api.createTodo('c1', input)
    await api.updateTodo('t1', '"1"', input)
    await api.deleteTodo('t1', '"1"')
    expect(calls.map((c) => c.url)).toEqual([
      '/api/v1/calendars/c1/todos',
      '/api/v1/calendars/c1/todos',
      '/api/v1/todos/t1',
      '/api/v1/todos/t1',
    ])
  })

  it('getSession delegates to the client', async () => {
    const { api, client } = setup(jsonResponse(200, { authenticated: false, csrfToken: 'x' }))
    await api.getSession()
    expect(client.token).toBe('x')
  })
})
