import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { type ReactNode } from 'react'
import { toast } from 'sonner'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isReported, markReported } from '@/lib/refresh'
import { jsonResponse, urlOf } from '@/test/fixtures'
import { defaultSettings, useSettings } from '@/stores/settings'
import { useUi } from '@/stores/ui'
import { useLoadErrorToast, useRefresh } from './useRefresh'

afterEach(() => {
  vi.useRealTimers()
  useSettings.setState(defaultSettings)
  useUi.setState({ backendReachable: true })
  toast.dismiss()
})

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  return { queryClient, wrapper }
}

describe('useRefresh', () => {
  it('spins a full turn even when it is quick, then shows it is done for a moment', async () => {
    vi.useFakeTimers()
    const { wrapper } = setup()
    const { result } = renderHook(() => useRefresh(), { wrapper })

    act(() => {
      result.current.refresh()
    })
    expect(result.current.state).toBe('running')
    await act(() => vi.advanceTimersByTimeAsync(599))
    expect(result.current.state).toBe('running')
    await act(() => vi.advanceTimersByTimeAsync(1))
    expect(result.current.state).toBe('done')
    await act(() => vi.advanceTimersByTimeAsync(1499))
    expect(result.current.state).toBe('done')
    await act(() => vi.advanceTimersByTimeAsync(1))
    expect(result.current.state).toBe('idle')
  })

  it('ignores another refresh while one runs', async () => {
    vi.useFakeTimers()
    const { queryClient, wrapper } = setup()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    const { result } = renderHook(() => useRefresh(), { wrapper })

    act(() => {
      result.current.refresh()
      result.current.refresh()
    })
    await act(() => vi.advanceTimersByTimeAsync(600))
    expect(invalidate).toHaveBeenCalledTimes(1)

    act(() => {
      result.current.refresh()
    })
    await act(() => vi.advanceTimersByTimeAsync(600))
    expect(invalidate).toHaveBeenCalledTimes(2)
  })

  it('clears the load and refresh toasts once it succeeds', async () => {
    vi.useFakeTimers()
    const dismiss = vi.spyOn(toast, 'dismiss')
    const { wrapper } = setup()
    const { result } = renderHook(() => useRefresh(), { wrapper })

    act(() => {
      result.current.refresh()
    })
    await act(() => vi.advanceTimersByTimeAsync(600))
    expect(dismiss.mock.calls.map(([id]) => id).sort()).toEqual(['events-load', 'refresh', 'repeats-load'])
  })

  it('stops spinning and says so if it breaks', async () => {
    vi.useFakeTimers()
    const error = vi.spyOn(toast, 'error')
    const { queryClient, wrapper } = setup()
    vi.spyOn(queryClient, 'invalidateQueries').mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useRefresh(), { wrapper })

    act(() => {
      result.current.refresh()
    })
    await act(() => vi.advanceTimersByTimeAsync(600))
    expect(result.current.state).toBe('idle')
    expect(error).toHaveBeenCalledWith("Couldn't refresh. Try again in a moment.", { id: 'refresh' })
  })

  it("does nothing while Lucid can't reach its server", () => {
    const { queryClient, wrapper } = setup()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    useUi.setState({ backendReachable: false })
    const { result } = renderHook(() => useRefresh(), { wrapper })

    act(() => {
      result.current.refresh()
    })
    expect(result.current.state).toBe('idle')
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('on a failure, says which state is still shown, in place of the load toasts', async () => {
    useSettings.setState({ timeFormat: '24h' })
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) =>
      Promise.resolve(
        urlOf(input).includes('/events')
          ? jsonResponse(502, { error: { code: 'upstream_error', message: 'down' } })
          : jsonResponse(200, {}),
      ),
    )
    const error = vi.spyOn(toast, 'error')
    const dismiss = vi.spyOn(toast, 'dismiss')
    const { queryClient, wrapper } = setup()
    const key = ['events', 'c1', 's', 'e']
    const loaded = new Date()
    loaded.setHours(14, 32, 0, 0)
    queryClient.setQueryData(key, { events: [] }, { updatedAt: loaded.getTime() })
    const { result } = renderHook(
      () => {
        useQuery({
          queryKey: key,
          queryFn: () => fetch('/api/v1/calendars/c1/events').then((r) => (r.ok ? r.json() : Promise.reject(new Error('502')))),
          staleTime: Number.POSITIVE_INFINITY,
        })
        return useRefresh()
      },
      { wrapper },
    )

    act(() => {
      result.current.refresh()
    })
    await waitFor(() => {
      expect(error).toHaveBeenCalledWith("Couldn't refresh. Showing what was loaded at 14:32.", { id: 'refresh' })
    })
    expect(result.current.state).toBe('idle')
    expect(dismiss).toHaveBeenCalledWith('events-load')
    expect(dismiss).toHaveBeenCalledWith('repeats-load')
    expect(isReported(queryClient.getQueryState(key)?.error)).toBe(true)
  })
})

describe('useLoadErrorToast', () => {
  const render = (error: unknown, refreshing: boolean) =>
    renderHook((p: { error: unknown; refreshing: boolean }) => {
      useLoadErrorToast(p.error, 'events-load', 'Some events failed.', p.refreshing)
    }, { initialProps: { error, refreshing } })

  it('tells about a new load error', () => {
    const error = vi.spyOn(toast, 'error')
    render(new Error('502'), false)
    expect(error).toHaveBeenCalledWith('Some events failed.', { id: 'events-load' })
  })

  it('holds back while a refresh runs, and stays quiet about what the refresh told', () => {
    const error = vi.spyOn(toast, 'error')
    const told = new Error('told by the refresh')
    const { rerender } = render(told, true)
    expect(error).not.toHaveBeenCalled()

    markReported([told])
    rerender({ error: told, refreshing: false })
    expect(error).not.toHaveBeenCalled()

    rerender({ error: new Error('later'), refreshing: false })
    expect(error).toHaveBeenCalledTimes(1)
  })

  it('tells about one the refresh did not, once it ends', () => {
    const error = vi.spyOn(toast, 'error')
    const { rerender } = render(new Error('502'), true)
    rerender({ error: new Error('502 again'), refreshing: false })
    expect(error).toHaveBeenCalledTimes(1)
  })
})
