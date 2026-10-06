/**
 * The single place an error becomes words.
 *
 * Pages never branch on a raw code. Keeping the mapping here means a new code
 * is handled in one file, and it keeps codes out of components where they
 * would quietly drift from the API.
 */

import { ApiError, isApiError } from './errors.ts'

const GENERIC = 'Something went wrong. Please try again.'

export function describeApiError(error: unknown): string {
  if (!isApiError(error)) {
    return GENERIC
  }

  switch (error.code) {
    case 'INVALID_CREDENTIALS':
      // Deliberately does not say which half was wrong.
      return 'That email and password combination is not correct.'
    case 'USER_CONFLICT':
      return 'That email is already registered.'
    case 'VALIDATION_ERROR':
      return firstDetail(error) ?? 'Please check the details you entered.'
    case 'RATE_LIMITED':
      return describeRateLimit(error)
    case 'UNAUTHENTICATED':
      return 'Your session has ended. Please sign in again.'
    case 'RESOURCE_NOT_FOUND':
      return 'That item no longer exists.'
    case 'RESOURCE_CONFLICT':
      return 'That change conflicts with the current state. Please reload and try again.'
    case 'SERVICE_UNAVAILABLE':
      return 'The service is temporarily unavailable. Please try again shortly.'
    case 'TIMEOUT':
      return 'The server took too long to respond. Please try again.'
    case 'NETWORK_ERROR':
      return 'The server could not be reached. Check that the API is running.'
    case 'ABORTED':
      return 'The request was cancelled.'
    case 'INVALID_JSON':
    case 'INTERNAL_SERVER_ERROR':
    case 'UNEXPECTED_RESPONSE':
      return GENERIC
    default:
      return GENERIC
  }
}

function describeRateLimit(error: ApiError): string {
  const seconds = error.retryAfterSeconds

  if (seconds === undefined) {
    return 'Too many attempts. Please wait a moment and try again.'
  }

  const unit = seconds === 1 ? 'second' : 'seconds'
  return `Too many attempts. Please try again in ${String(seconds)} ${unit}.`
}

/**
 * A 422 carries at most one field today. Surfacing it verbatim is better copy
 * than a generic line, and the message is server-authored, not user input.
 */
function firstDetail(error: ApiError): string | undefined {
  if (error.details === undefined) {
    return undefined
  }

  const entries = Object.entries(error.details)
  const first = entries[0]

  return first === undefined ? undefined : `${first[0]}: ${first[1]}`
}
