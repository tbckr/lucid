import { MutationObserver, onlineManager, QueryClient, QueryObserver } from '@tanstack/react-query'
import { afterEach, describe, expect, it } from 'vitest'
import { ApiClient, isApiError } from '@/lib/api/client'
import { jsonResponse, urlOf } from '@/test/fixtures'
import { loadedAt, refreshAll } from './refresh'

interface Call {
  path: string
  revalidate: string | undefined
}

const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).forEach((c) => {
    c()
  })
  onlineManager.setOnline(true)
})

/** A QueryClient over an ApiClient that answers `{}`, or 502 for the paths in `failing`, and logs each request. */
function setup(failing: string[] = []) {
  const calls: Call[] = []
  const fetch = ((url: RequestInfo | URL, init?: RequestInit) => {
    const path = urlOf(url).replace('/api/v1', '')
    calls.push({ path, revalidate: (init?.headers as Record<string, string>)['X-Lucid-Revalidate'] })
    return Promise.resolve(
      failing.includes(path)
        ? jsonResponse(502, { error: { code: 'upstream_error', message: 'down' } })
        : jsonResponse(200, {}),
    )
  }) as typeof globalThis.fetch
  const client = new ApiClient('/api/v1', fetch)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } })
  cleanups.push(() => {
    qc.clear()
  })
  /** Puts `key` on screen, loaded at `updatedAt` (never, if 0); its query GETs `path`. */
  const show = (key: readonly unknown[], path: string, updatedAt = 1) => {
    if (updatedAt > 0) qc.setQueryData(key, {}, { updatedAt })
    const observer = new QueryObserver(qc, {
      queryKey: key,
      queryFn: async ({ signal }) => {
        await client.request(path, { signal })
        return {}
      },
    })
    cleanups.push(observer.subscribe(() => undefined))
  }
  return { calls, client, qc, show }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('refreshAll', () => {
  it('reloads what is on screen past the backend cache, but not the session', async () => {
    const { calls, client, qc, show } = setup()
    show(['session'], '/session')
    show(['calendars'], '/calendars')
    show(['events', 'c1', 's', 'e'], '/calendars/c1/events')
    show(['todos', 'c1'], '/calendars/c1/todos')

    const result = await refreshAll(qc, client)

    expect(calls.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: '/calendars', revalidate: '1' },
      { path: '/calendars/c1/events', revalidate: '1' },
      { path: '/calendars/c1/todos', revalidate: '1' },
    ])
    expect(result).toEqual({ failed: false, errors: [], shownAt: null })
  })

  it('has what is off screen reload when it is shown again', async () => {
    const { calls, client, qc } = setup()
    qc.setQueryData(['events', 'c1', 'last week'], {})

    await refreshAll(qc, client)

    expect(calls).toEqual([])
    expect(qc.getQueryState(['events', 'c1', 'last week'])?.isInvalidated).toBe(true)
  })

  it('waits for a change being saved before it reloads', async () => {
    const { calls, client, qc, show } = setup()
    show(['todos', 'c1'], '/calendars/c1/todos')
    let save!: () => void
    const mutation = new MutationObserver(qc, {
      mutationFn: () =>
        new Promise<void>((resolve) => {
          save = resolve
        }),
    })
    void mutation.mutate()

    const refreshing = refreshAll(qc, client)
    await tick()
    expect(calls).toEqual([])

    save()
    await refreshing
    expect(calls.map((c) => c.path)).toEqual(['/calendars/c1/todos'])
  })

  it('reports what failed to reload, and when the oldest data still shown was loaded', async () => {
    const { client, qc, show } = setup(['/calendars/c1/events', '/calendars/c2/todos'])
    show(['calendars'], '/calendars', 500)
    show(['events', 'c1', 's', 'e'], '/calendars/c1/events', 3000)
    show(['todos', 'c2'], '/calendars/c2/todos', 2000)

    const { failed, errors, shownAt } = await refreshAll(qc, client)

    expect(failed).toBe(true)
    expect(errors).toHaveLength(2)
    expect(errors.every((e) => isApiError(e, 'upstream_error'))).toBe(true)
    expect(shownAt).toBe(2000)
  })

  it('fails when it could only queue what to reload, as Lucid went offline', async () => {
    const { calls, client, qc, show } = setup()
    show(['todos', 'c1'], '/calendars/c1/todos', 2000)
    onlineManager.setOnline(false)

    const result = await refreshAll(qc, client)

    expect(calls).toEqual([])
    expect(result).toEqual({ failed: true, errors: [], shownAt: 2000 })
  })

  it('tells no time when what failed was never loaded', async () => {
    const { client, qc, show } = setup(['/calendars/c1/todos'])
    show(['todos', 'c1'], '/calendars/c1/todos', 0)
    await tick()

    const { errors, shownAt } = await refreshAll(qc, client)

    expect(errors).toHaveLength(1)
    expect(shownAt).toBeNull()
  })
})

describe('loadedAt', () => {
  it('is when the oldest calendar data on screen was loaded', () => {
    const { qc, show } = setup()
    show(['session'], '/session', 1000)
    show(['calendars'], '/calendars', 3000)
    show(['events', 'c1', 's', 'e'], '/calendars/c1/events', 2000)
    qc.setQueryData(['events', 'c1', 'last week'], {}, { updatedAt: 1500 })

    expect(loadedAt(qc)).toBe(2000)
  })

  it('is null before anything is loaded', () => {
    const { qc } = setup()
    expect(loadedAt(qc)).toBeNull()
  })
})
