import { type TFunction } from 'i18next'
import { isApiError, type ApiErrorCode } from './api/client'

/** The reference is this many characters of the request ID: short enough to read out, long enough to find in a log. */
const REFERENCE_LENGTH = 8

/** Errors of a server or its upstream, where a user and an operator need the same log line. */
const REFERENCED_CODES: ReadonlySet<ApiErrorCode> = new Set<ApiErrorCode>([
  'upstream_error',
  'internal',
  'bad_response',
  'discovery_failed',
  'invalid_credentials',
  'unsupported_component',
])

/**
 * Short reference for an error that points to a server or upstream problem:
 * the first characters of the request ID, which is on every server log line of
 * the request (FR-36). Null for other errors and for one without an ID.
 */
export function errorReference(err: unknown): string | null {
  if (!isApiError(err) || err.requestId === null || !REFERENCED_CODES.has(err.code)) return null
  return err.requestId.slice(0, REFERENCE_LENGTH)
}

/** "Reference: 3f9a1c2b" for a toast's description; undefined if the error has no reference. */
export function referenceDescription(t: TFunction, err: unknown): string | undefined {
  const ref = errorReference(err)
  return ref === null ? undefined : t('diagnostics.reference', { ref })
}

/**
 * The toast action "Report a problem" for an error with a reference (FR-36), which runs `onReport`; undefined for
 * any other error. A toast with an ID passes it even then: sonner merges a new toast into a live one of its ID,
 * which would keep the old action.
 */
export function reportAction(
  t: TFunction,
  err: unknown,
  onReport: () => void,
): { label: string; onClick: () => void } | undefined {
  return errorReference(err) === null ? undefined : { label: t('diagnostics.open'), onClick: onReport }
}

/** Localized, actionable message for an API error. */
export function apiErrorMessage(t: TFunction, err: unknown): string {
  if (!isApiError(err)) return t('errors.generic')
  switch (err.code) {
    case 'invalid_credentials':
      return t('errors.invalid_credentials')
    case 'discovery_failed':
      return t('errors.discovery_failed')
    case 'forbidden_target':
      return t('errors.forbidden_target')
    case 'rate_limited':
      return err.retryAfter !== null
        ? t('errors.rate_limited_retry', { count: err.retryAfter })
        : t('errors.rate_limited')
    case 'upstream_error':
      return t('errors.upstream_error')
    case 'network':
      return t('errors.network')
    case 'invalid_input':
      return err.message ? t('errors.invalid_input_detail', { detail: err.message }) : t('errors.invalid_input')
    case 'read_only':
      return t('errors.read_only')
    case 'unsupported_component':
      return t('errors.unsupported_component')
    case 'series_move_unsupported':
      return t('errors.series_move_unsupported')
    case 'series_split_unsupported':
      return t('errors.series_split_unsupported')
    case 'conflict':
      return t('errors.conflict')
    case 'not_found':
      return t('errors.not_found')
    case 'unauthenticated':
      return t('errors.unauthenticated')
    case 'csrf_invalid':
    case 'precondition_required':
    case 'bad_response':
    case 'internal':
      return t('errors.generic')
  }
}
