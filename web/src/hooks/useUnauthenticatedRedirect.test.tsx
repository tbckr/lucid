import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook } from '@testing-library/react'
import { type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api/client'
import { emptyReport, useUi } from '@/stores/ui'
import { jsonResponse, urlOf } from '@/test/fixtures'
import { queryKeys } from './queries'
import { useUnauthenticatedRedirect } from './useUnauthenticatedRedirect'

afterEach(() => {
  window.history.replaceState(null, '', '/')
  useUi.setState({ signedOut: false, report: emptyReport })
})

/** Mount the hook on a cache whose session says `authenticated`, then let a request answer 401 unauthenticated. */
async function unauthenticatedWhile(authenticated: boolean): Promise<QueryClient> {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) =>
    Promise.resolve(
      urlOf(input).endsWith('/session')
        ? jsonResponse(200, { authenticated: false, csrfToken: 'anon' })
        : jsonResponse(401, { error: { code: 'unauthenticated', message: 'not logged in' } }),
    ),
  )
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(queryKeys.session, { authenticated, csrfToken: 't' })
  queryClient.setQueryData(queryKeys.calendars, { calendars: [] })
  renderHook(() => {
    useUnauthenticatedRedirect()
  }, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  })
  await expect(api.request('/calendars')).rejects.toMatchObject({ code: 'unauthenticated' })
  return queryClient
}

describe('useUnauthenticatedRedirect', () => {
  it('sends a signed-in session that ended to the login page, and notes that it ended unasked (FR-36)', async () => {
    window.history.replaceState(null, '', '/week?d=2025-03-02')
    useUi.setState({
      report: {
        ...emptyReport,
        candidates: [{ objectId: 'o1', kind: 'event', label: 'Dentist', calendarId: 'c1' }],
        shown: new Map([['o1', { status: 'shown', text: 'BEGIN:VCALENDAR' }]]),
        included: new Set(['o1']),
      },
    })

    const queryClient = await unauthenticatedWhile(true)

    expect(useUi.getState().signedOut).toBe(true)
    expect(window.location.pathname + window.location.search).toBe(`/login?redirect=${encodeURIComponent('/week?d=2025-03-02')}`)
    // The items of the account that is gone, what was shown of them and its data go with it.
    expect(useUi.getState().report).toEqual(emptyReport)
    expect(queryClient.getQueryData(queryKeys.calendars)).toBeUndefined()
    expect(queryClient.getQueryState(queryKeys.session)?.isInvalidated).toBe(true)
  })

  it('notes nothing for a session that was not signed in', async () => {
    window.history.replaceState(null, '', '/login')

    await unauthenticatedWhile(false)

    expect(useUi.getState().signedOut).toBe(false)
    expect(window.location.pathname).toBe('/login')
  })
})
