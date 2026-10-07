import { type TFunction } from 'i18next'
import { isApiError } from './api/client'

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
