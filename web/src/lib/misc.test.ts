import { describe, expect, it } from 'vitest'
import i18next from '@/i18n'
import { ApiError } from './api/client'
import { apiErrorMessage } from './errors'
import { shouldRetry, createQueryClient } from './queryClient'
import { cn } from './utils'

describe('shouldRetry', () => {
  it('retries transient errors at most twice', () => {
    expect(shouldRetry(0, new Error('boom'))).toBe(true)
    expect(shouldRetry(2, new Error('boom'))).toBe(false)
    expect(shouldRetry(0, new ApiError(502, 'upstream_error', ''))).toBe(true)
  })

  it('never retries client errors or network failures', () => {
    expect(shouldRetry(0, new ApiError(404, 'not_found', ''))).toBe(false)
    expect(shouldRetry(0, new ApiError(0, 'network', ''))).toBe(false)
  })

  it('creates a client with online network mode', () => {
    const qc = createQueryClient()
    expect(qc.getDefaultOptions().queries?.networkMode).toBe('online')
  })
})

describe('apiErrorMessage', () => {
  const t = i18next.getFixedT('en')
  it.each([
    ['invalid_credentials', 'rejected this username or password'],
    ['discovery_failed', 'No calendar service'],
    ['forbidden_target', 'blocked network'],
    ['rate_limited', 'Too many attempts'],
    ['upstream_error', "didn't respond"],
    ['network', "can't reach"],
    ['invalid_input', 'invalid'],
    ['read_only', 'read-only'],
    ['unsupported_component', "doesn't accept"],
    ['series_move_unsupported', "This series can't move like this. Move only this event instead."],
    ['series_split_unsupported', "This series can't be split. Change only this event or all events instead."],
    ['conflict', 'changed elsewhere'],
    ['not_found', 'no longer exists'],
    ['unauthenticated', 'session expired'],
    ['csrf_invalid', 'Something went wrong'],
    ['internal', 'Something went wrong'],
  ] as const)('%s', (code, text) => {
    expect(apiErrorMessage(t, new ApiError(400, code, ''))).toContain(text)
  })

  it('includes Retry-After and validation details', () => {
    expect(apiErrorMessage(t, new ApiError(429, 'rate_limited', '', 1))).toBe('Too many attempts. Try again in 1 second.')
    expect(apiErrorMessage(t, new ApiError(429, 'rate_limited', '', 30))).toContain('30 seconds')
    expect(apiErrorMessage(t, new ApiError(400, 'invalid_input', 'title too long'))).toBe('Invalid input: title too long')
    expect(apiErrorMessage(t, new Error('x'))).toBe('Something went wrong. Try again.')
  })

  it('is translated', () => {
    const de = i18next.getFixedT('de')
    expect(apiErrorMessage(de, new ApiError(409, 'conflict', ''))).toContain('anderswo geändert')
    expect(apiErrorMessage(de, new ApiError(400, 'series_move_unsupported', ''))).toBe(
      'So lässt sich diese Serie nicht verschieben. Verschiebe nur diesen Termin.',
    )
    expect(apiErrorMessage(de, new ApiError(400, 'series_split_unsupported', ''))).toBe(
      'Diese Serie lässt sich nicht teilen. Ändere nur diesen Termin oder alle Termine.',
    )
  })
})

describe('cn', () => {
  it('merges tailwind classes', () => {
    const hidden = Math.random() > 2
    expect(cn('px-2', hidden && 'hidden', 'px-4')).toBe('px-4')
  })
})
