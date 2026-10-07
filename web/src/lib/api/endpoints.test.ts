import { describe, expect, it, vi } from 'vitest'
import { apiEvent, bodyOf, jsonResponse, occurrence, todo, urlOf } from '@/test/fixtures'
import i18n from '@/i18n'
import { apiErrorMessage } from '../errors'
import { ApiClient, isApiError } from './client'
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

  it('reads the series ETag and the undo token after deleting one event', async () => {
    const { api, calls } = setup(jsonResponse(200, { etag: '"5"', undoToken: 'tok' }, { ETag: '"5"' }))
    expect(await api.deleteOccurrence('e1', '2026-03-13T08:00:00Z', '"4"')).toEqual({ etag: '"5"', undoToken: 'tok' })
    expect(calls.map((c) => [c.init.method, c.url])).toEqual([
      ['DELETE', '/api/v1/events/e1/occurrences/2026-03-13T08%3A00%3A00Z'],
    ])
    expect((calls[0]?.init.headers as Record<string, string>)['If-Match']).toBe('"4"')
  })

  it('resolves with nothing once the series is gone', async () => {
    const { api } = setup(new Response(null, { status: 204 }))
    expect(await api.deleteOccurrence('e1', '2026-03-20T08:00:00Z', '"8"')).toBeUndefined()
  })

  it('splits a series at an occurrence and reads the new series, the old one\'s ETag and the undo token', async () => {
    const moved = apiEvent({ id: 'e2', etag: '"n1"', recurring: true, recurrenceId: '2025-03-17T08:00:00Z', first: true })
    const { api, calls } = setup(jsonResponse(200, { event: moved, etag: '"s2"', undoToken: 'tok' }))
    const input = {
      title: 'x',
      description: '',
      location: '',
      start: moved.start,
      end: moved.end,
      allDay: false,
      timezone: 'UTC',
      rrule: 'FREQ=WEEKLY',
    }
    const res = await api.updateFollowing('e1', '2025-03-17T08:00:00Z', '"s1"', input)
    expect(res.event.id).toBe('e2')
    expect(res.event.first).toBe(true)
    expect(res.etag).toBe('"s2"')
    expect(res.undoToken).toBe('tok')
    expect(calls.map((c) => [c.init.method, c.url])).toEqual([
      ['PUT', '/api/v1/events/e1/following/2025-03-17T08%3A00%3A00Z'],
    ])
    expect((calls[0]?.init.headers as Record<string, string>)['If-Match']).toBe('"s1"')
    expect(bodyOf(calls[0]?.init)).toEqual(input)
  })

  it('reads a split without an old ETag or an undo token', async () => {
    const { api } = setup(jsonResponse(200, { event: apiEvent() }))
    const res = await api.updateFollowing('e1', '2025-03-17T08:00:00Z', '"s1"', {
      title: 'x',
      description: '',
      location: '',
      start: '2026-09-25T08:00:00Z',
      end: '2026-09-25T09:00:00Z',
      allDay: false,
      timezone: 'UTC',
      rrule: '',
    })
    expect(res.etag).toBe('')
    expect(res.undoToken).toBeUndefined()
  })

  it('ends a series before an occurrence and reads its new ETag and undo token', async () => {
    const { api, calls } = setup(jsonResponse(200, { etag: '"5"', undoToken: 'tok' }, { ETag: '"5"' }))
    expect(await api.deleteFollowing('e1', '2025-03-17T08:00:00Z', '"4"')).toEqual({ etag: '"5"', undoToken: 'tok' })
    expect(calls.map((c) => [c.init.method, c.url])).toEqual([
      ['DELETE', '/api/v1/events/e1/following/2025-03-17T08%3A00%3A00Z'],
    ])
    expect((calls[0]?.init.headers as Record<string, string>)['If-Match']).toBe('"4"')
  })

  it('resolves with nothing once ending the series deleted it', async () => {
    const { api } = setup(new Response(null, { status: 204 }))
    expect(await api.deleteFollowing('e1', '2025-03-17T08:00:00Z', '"8"')).toBeUndefined()
  })

  it('names a series that cannot be split in either direction', async () => {
    const refused = () =>
      jsonResponse(400, { error: { code: 'series_split_unsupported', message: 'the series has attendees' } })
    const { api } = setup(refused(), refused())
    const input = {
      title: 'x',
      description: '',
      location: '',
      start: '2026-09-25T08:00:00Z',
      end: '2026-09-25T09:00:00Z',
      allDay: false,
      timezone: 'UTC',
      rrule: '',
    }
    for (const call of [
      api.updateFollowing('e1', '2025-03-17T08:00:00Z', '"1"', input),
      api.deleteFollowing('e1', '2025-03-17T08:00:00Z', '"1"'),
    ]) {
      const err: unknown = await call.catch((e: unknown) => e)
      expect(isApiError(err, 'series_split_unsupported')).toBe(true)
      expect(apiErrorMessage(i18n.getFixedT('en'), err)).toBe(
        "This series can't be split. Change only this event or all events instead.",
      )
    }
  })

  it('undoes a change of an event series with its token, no If-Match', async () => {
    const { api, calls } = setup(jsonResponse(200, {}))
    expect(await api.undoEvent('e1', 'tok')).toEqual({ etag: '', copyKept: false })
    expect(calls[0]?.url).toBe('/api/v1/events/e1/undo')
    expect(calls[0]?.init.method).toBe('POST')
    expect(bodyOf(calls[0]?.init)).toEqual({ token: 'tok' })
    expect((calls[0]?.init.headers as Record<string, string>)['If-Match']).toBeUndefined()
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
    const input = { title: 'x', description: '', checklist: [], start: null, startAllDay: false, due: null, dueAllDay: false, priority: 0, status: 'NEEDS-ACTION' as const }
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

  it('undoes a todo with its token, no If-Match', async () => {
    const t = { ...todo(), copyKept: true }
    const { api, calls } = setup(jsonResponse(200, t))
    const restored = await api.undoTodo('t1', 'tok')
    expect(calls[0]?.url).toBe('/api/v1/todos/t1/undo')
    expect(calls[0]?.init.method).toBe('POST')
    expect(bodyOf(calls[0]?.init)).toEqual({ token: 'tok' })
    expect((calls[0]?.init.headers as Record<string, string>)['If-Match']).toBeUndefined()
    expect(restored.copyKept).toBe(true)
  })

  it('lists todo occurrences with an encoded range and isolates corrupted items', async () => {
    const { api, calls } = setup(jsonResponse(200, { occurrences: [occurrence(), { key: 'broken' }] }))
    const res = await api.listTodoOccurrences('c1', new Date('2026-09-01T00:00:00Z'), new Date('2026-10-01T00:00:00Z'))
    expect(calls[0]?.url).toBe(
      '/api/v1/calendars/c1/todos/occurrences?start=2026-09-01T00%3A00%3A00.000Z&end=2026-10-01T00%3A00%3A00.000Z',
    )
    expect(res.occurrences).toHaveLength(1)
    expect(res.corrupted).toHaveLength(1)
  })

  it('getSession delegates to the client', async () => {
    const { api, client } = setup(jsonResponse(200, { authenticated: false, csrfToken: 'x' }))
    await api.getSession()
    expect(client.token).toBe('x')
  })
})
