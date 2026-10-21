import { render } from '@testing-library/react'
import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import i18next from '@/i18n'
import { ApiError, type ApiErrorCode } from './api/client'
import { errorReference, REFERENCE_TOAST_MS, referenceDescription, referenceDuration, reportAction } from './errors'

const ID = '0123456789abcdef'

describe('errorReference', () => {
  it('is the first 8 characters of the request ID of a server error', () => {
    expect(errorReference(new ApiError(502, 'upstream_error', '', null, ID))).toBe('01234567')
  })

  it.each<ApiErrorCode>([
    'upstream_error',
    'internal',
    'bad_response',
    'discovery_failed',
    'invalid_credentials',
    'unsupported_component',
  ])('is given for %s', (code) => {
    expect(errorReference(new ApiError(500, code, '', null, ID))).toBe('01234567')
  })

  it.each<ApiErrorCode>([
    'conflict',
    'not_found',
    'unauthenticated',
    'csrf_invalid',
    'rate_limited',
    'invalid_input',
    'forbidden_target',
    'read_only',
    'network',
    'precondition_required',
    'series_move_unsupported',
    'series_split_unsupported',
  ])('is not given for %s', (code) => {
    expect(errorReference(new ApiError(409, code, '', null, ID))).toBeNull()
  })

  it('is null without a request ID', () => {
    expect(errorReference(new ApiError(502, 'upstream_error', ''))).toBeNull()
  })

  it('keeps an ID shorter than 8 characters whole', () => {
    expect(errorReference(new ApiError(500, 'internal', '', null, 'abc'))).toBe('abc')
  })

  it('is null for anything but an ApiError', () => {
    expect(errorReference(new Error('boom'))).toBeNull()
    expect(errorReference(null)).toBeNull()
    expect(errorReference({ requestId: ID, code: 'internal' })).toBeNull()
  })
})

describe('referenceDescription', () => {
  const err = new ApiError(502, 'upstream_error', '', null, ID)

  it('names the reference', () => {
    expect(referenceDescription(i18next.getFixedT('en'), err)).toBe('Reference: 01234567')
  })

  it('is translated', () => {
    expect(referenceDescription(i18next.getFixedT('de'), err)).toBe('Referenz: 01234567')
  })

  it('is undefined without a reference', () => {
    expect(referenceDescription(i18next.getFixedT('en'), new ApiError(409, 'conflict', '', null, ID))).toBeUndefined()
  })
})

describe('referenceDuration', () => {
  it('keeps a toast with a reference for 10 seconds', () => {
    expect(REFERENCE_TOAST_MS).toBe(10_000)
    expect(referenceDuration(new ApiError(502, 'upstream_error', '', null, ID))).toBe(REFERENCE_TOAST_MS)
  })

  it("leaves any other toast at sonner's default", () => {
    expect(referenceDuration(new ApiError(409, 'conflict', '', null, ID))).toBeUndefined()
    expect(referenceDuration(new ApiError(502, 'upstream_error', ''))).toBeUndefined()
    expect(referenceDuration(undefined)).toBeUndefined()
  })
})

describe('reportAction', () => {
  it('opens the problem report from an error with a reference (FR-36)', () => {
    const onReport = vi.fn()
    const action = reportAction(i18next.getFixedT('de'), new ApiError(502, 'upstream_error', '', null, ID), onReport)
    // Named in words, with the life buoy of every way to the report.
    const { container } = render(createElement('div', null, action?.label))
    expect(container).toHaveTextContent('Problem melden')
    expect(container.querySelector('svg.lucide-life-buoy')).toHaveAttribute('aria-hidden', 'true')
    action?.onClick()
    expect(onReport).toHaveBeenCalledTimes(1)
  })

  it('is undefined without a reference', () => {
    const t = i18next.getFixedT('en')
    expect(reportAction(t, new ApiError(409, 'conflict', '', null, ID), vi.fn())).toBeUndefined()
    expect(reportAction(t, new ApiError(502, 'upstream_error', ''), vi.fn())).toBeUndefined()
  })
})
