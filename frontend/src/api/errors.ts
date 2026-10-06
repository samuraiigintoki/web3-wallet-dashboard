/**
 * One error type for every failure the client can produce, so callers never
 * have to tell a thrown TypeError from a rejected response.
 */

/**
 * The stable codes the API documents, mirroring
 * backend/internal/httpapi/errors.go. A code that is not in this list is not
 * passed through to the UI: it becomes UNEXPECTED_RESPONSE, so a server change
 * can never silently reach a branch that was never written for it.
 */
export const SERVER_ERROR_CODES = [
  'INVALID_JSON',
  'VALIDATION_ERROR',
  'RESOURCE_CONFLICT',
  'RESOURCE_NOT_FOUND',
  'INTERNAL_SERVER_ERROR',
  'SERVICE_UNAVAILABLE',
  'INVALID_CREDENTIALS',
  'UNAUTHENTICATED',
  'USER_CONFLICT',
  'RATE_LIMITED',
] as const

export type ServerErrorCode = (typeof SERVER_ERROR_CODES)[number]

/**
 * Failures that never reach the API, or reach it and come back as something
 * the contract does not describe.
 *
 * UNEXPECTED_RESPONSE is routine rather than theoretical. The Go mux answers
 * an unmatched path or a method mismatch in plain text, and the Vite dev proxy
 * answers an empty 502 with text/plain when the API is not running.
 */
export const CLIENT_ERROR_CODES = [
  'NETWORK_ERROR',
  'TIMEOUT',
  'ABORTED',
  'UNEXPECTED_RESPONSE',
] as const

export type ClientErrorCode = (typeof CLIENT_ERROR_CODES)[number]

export type ApiErrorCode = ServerErrorCode | ClientErrorCode

export function isServerErrorCode(value: unknown): value is ServerErrorCode {
  return (
    typeof value === 'string' &&
    (SERVER_ERROR_CODES as readonly string[]).includes(value)
  )
}

export type ApiErrorInit = {
  code: ApiErrorCode
  /** HTTP status, or 0 when no response arrived. */
  status: number
  message: string
  /** Field-keyed detail from a 422. At most one key today. */
  details?: Record<string, string>
  /** X-Request-ID, so a user-reported failure can be found in the access log. */
  requestId?: string
  /** Whole seconds from Retry-After. Present on 429 only. */
  retryAfterSeconds?: number
}

export class ApiError extends Error {
  readonly code: ApiErrorCode
  readonly status: number
  readonly details?: Record<string, string>
  readonly requestId?: string
  readonly retryAfterSeconds?: number

  constructor(init: ApiErrorInit) {
    super(init.message)
    this.name = 'ApiError'
    this.code = init.code
    this.status = init.status
    this.details = init.details
    this.requestId = init.requestId
    this.retryAfterSeconds = init.retryAfterSeconds
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError
}
