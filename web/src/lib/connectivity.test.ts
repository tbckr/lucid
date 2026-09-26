import { onlineManager } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClient } from './api/client'
import { setupConnectivity } from './connectivity'

describe('setupConnectivity (FR-20)', () => {
  let dispose: (() => void) | undefined

  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    dispose?.()
    vi.useRealTimers()
  })

  function setup(health: () => Promise<Response>) {
    const failing = vi.fn(() => Promise.reject(new TypeError('offline')))
    const client = new ApiClient('/api/v1', failing)
    const onChange = vi.fn()
    const healthFetch = vi.fn(health)
    dispose = setupConnectivity({
      client,
      onChange,
      pollMs: 1000,
      fetchImpl: healthFetch,
    })
    return { client, onChange, healthFetch }
  }

  it('goes offline on network errors and polls /healthz until it recovers', async () => {
    let healthy = false
    const { client, onChange, healthFetch } = setup(() =>
      healthy ? Promise.resolve(new Response('{}', { status: 200 })) : Promise.reject(new TypeError('down')),
    )
    expect(onlineManager.isOnline()).toBe(true)

    await expect(client.request('/calendars')).rejects.toMatchObject({ code: 'network' })
    expect(onlineManager.isOnline()).toBe(false)
    expect(onChange).toHaveBeenLastCalledWith({ browserOnline: true, backendReachable: false })

    await vi.advanceTimersByTimeAsync(1000)
    expect(healthFetch).toHaveBeenCalledTimes(1)
    expect(onlineManager.isOnline()).toBe(false)

    healthy = true
    await vi.advanceTimersByTimeAsync(1000)
    expect(healthFetch).toHaveBeenCalledTimes(2)
    expect(onlineManager.isOnline()).toBe(true)
    expect(onChange).toHaveBeenLastCalledWith({ browserOnline: true, backendReachable: true })

    // No more polling once reachable.
    await vi.advanceTimersByTimeAsync(5000)
    expect(healthFetch).toHaveBeenCalledTimes(2)
  })

  it('keeps polling on non-OK health responses', async () => {
    const { client, healthFetch } = setup(() => Promise.resolve(new Response('', { status: 503 })))
    await expect(client.request('/x')).rejects.toBeDefined()
    await vi.advanceTimersByTimeAsync(3000)
    expect(healthFetch).toHaveBeenCalledTimes(3)
    expect(onlineManager.isOnline()).toBe(false)
  })

  it('follows browser online/offline events and re-checks the backend when back online', async () => {
    const { client, onChange, healthFetch } = setup(() => Promise.resolve(new Response('{}', { status: 200 })))
    const spy = vi.spyOn(navigator, 'onLine', 'get')

    spy.mockReturnValue(false)
    window.dispatchEvent(new Event('offline'))
    expect(onlineManager.isOnline()).toBe(false)
    expect(onChange).toHaveBeenLastCalledWith({ browserOnline: false, backendReachable: true })

    await expect(client.request('/x')).rejects.toBeDefined()
    spy.mockReturnValue(true)
    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(0)
    expect(healthFetch).toHaveBeenCalledTimes(1)
    expect(onlineManager.isOnline()).toBe(true)
  })
})
