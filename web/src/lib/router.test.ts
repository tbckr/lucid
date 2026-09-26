import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { navigate, useLocation } from './router'

describe('router', () => {
  it('pushes, replaces and notifies subscribers', () => {
    const { result } = renderHook(() => useLocation())
    act(() => {
      navigate('/login?redirect=%2Fweek')
    })
    expect(result.current.pathname).toBe('/login')
    expect(result.current.search.get('redirect')).toBe('/week')
    const length = window.history.length
    act(() => {
      navigate('/', { replace: true })
    })
    expect(result.current.href).toBe('/')
    expect(window.history.length).toBe(length)
    // Navigating to the current location is a no-op.
    act(() => {
      navigate('/')
    })
    expect(window.history.length).toBe(length)
  })

  it('reacts to popstate', () => {
    const { result } = renderHook(() => useLocation())
    act(() => {
      window.history.pushState(null, '', '/elsewhere')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(result.current.pathname).toBe('/elsewhere')
  })

  it('refuses external targets', () => {
    expect(() => {
      navigate('//evil.example')
    }).toThrow()
    expect(() => {
      navigate('https://evil.example')
    }).toThrow()
  })
})
