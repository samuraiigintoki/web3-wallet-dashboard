/**
 * The one request helper every call goes through.
 *
 * Everything that must be true of every request is enforced here once: the
 * relative base, the bearer header, the single attempt, the timeout, and the
 * translation of any outcome into an ApiError.
 */

import {
  ApiError,
  isServerErrorCode,
  type ApiErrorCode,
} from './errors.ts'
import { isPagination, isRecord, parseErrorDetails } from './guards.ts'
import type { Pagination } from './types.ts'

/**
 * The only base the browser ever uses. Requests are same-origin and the dev
 * server proxies them, so there is no host to configure and the bearer token
 * cannot be sent anywhere else.
 */
export const API_BASE = '/api/v1'

/**
 * One attempt per call with a bounded wait. The backend's EVM client makes a
 * single attempt too, and a hidden retry on a credential route would spend the
 * caller's rate-limit budget without telling them.
 */
export const DEFAULT_TIMEOUT_MS = 10_000

const REQUEST_ID_HEADER = 'X-Request-ID'
const RETRY_AFTER_HEADER = 'Retry-After'

/** JSON.parse failed. A distinct value, because null and undefined are valid JSON. */
const NOT_JSON = Symbol('not-json')

export type CallInit = {
  signal?: AbortSignal
}

export type RequestOptions<T> = {
  method: 'GET' | 'POST'
  /** Relative to API_BASE. Must start with a single slash. */
  path: string
  /** Serialised as JSON. Contains exactly the typed fields and nothing else. */
  body?: unknown
  /** Opt in to the Authorization header. Off by default. */
  auth?: boolean
  guard: (value: unknown) => value is T
  signal?: AbortSignal
}

export type ApiResult<T> = {
  /** null when the response was 204 or had an empty body. */
  data: T | null
  /** Present only on list responses. */
  pagination: Pagination | null
  requestId?: string
}

export type RequestDependencies = {
  getToken: () => string | null
  /**
   * Called once per 401 UNAUTHENTICATED on a request that carried a token.
   * Never called for login's 401 INVALID_CREDENTIALS, which is a form error
   * and not an expired session.
   */
  onUnauthorized: () => void
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export type RequestFn = <T>(options: RequestOptions<T>) => Promise<ApiResult<T>>

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return NOT_JSON
  }
}

/**
 * Rejects anything that is not a path under this origin. Without this, one
 * mistaken absolute URL in a later block would put the session token on
 * another host.
 */
function assertRelativePath(path: string): void {
  const looksAbsolute =
    !path.startsWith('/') || path.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(path)

  if (looksAbsolute) {
    throw new ApiError({
      code: 'UNEXPECTED_RESPONSE',
      status: 0,
      message: 'api path must be relative to the API base',
    })
  }
}

/** Retry-After is documented as a whole number of seconds. Anything else is ignored. */
function parseRetryAfterSeconds(header: string | null): number | undefined {
  if (header === null || !/^\d+$/.test(header.trim())) {
    return undefined
  }

  return Number.parseInt(header.trim(), 10)
}

function unexpectedResponse(status: number, requestId?: string): ApiError {
  return new ApiError({
    code: 'UNEXPECTED_RESPONSE',
    status,
    message: 'the server returned a response this client does not understand',
    requestId,
  })
}

export function createRequest(dependencies: RequestDependencies): RequestFn {
  const {
    getToken,
    onUnauthorized,
    fetchImpl = globalThis.fetch.bind(globalThis),
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = dependencies

  return async function request<T>(
    options: RequestOptions<T>,
  ): Promise<ApiResult<T>> {
    const { method, path, body, auth = false, guard, signal } = options

    assertRelativePath(path)

    const headers: Record<string, string> = { Accept: 'application/json' }

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
    }

    if (auth) {
      const token = getToken()
      if (token !== null && token !== '') {
        // The server checks the case-sensitive prefix "Bearer ", so the
        // spelling here is load bearing.
        headers['Authorization'] = `Bearer ${token}`
      }
    }

    const timeoutController = new AbortController()
    const timeoutId = setTimeout(() => {
      timeoutController.abort()
    }, timeoutMs)

    const combinedSignal =
      signal === undefined
        ? timeoutController.signal
        : AbortSignal.any([signal, timeoutController.signal])

    let response: Response
    try {
      response = await fetchImpl(`${API_BASE}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: combinedSignal,
        // The API is bearer only. Omitting credentials keeps the browser from
        // attaching cookies it does not use.
        credentials: 'omit',
        cache: 'no-store',
      })
    } catch {
      if (timeoutController.signal.aborted) {
        throw new ApiError({
          code: 'TIMEOUT',
          status: 0,
          message: 'the request timed out',
        })
      }
      if (signal?.aborted === true) {
        throw new ApiError({
          code: 'ABORTED',
          status: 0,
          message: 'the request was cancelled',
        })
      }
      // The body of a network failure is never echoed: it can contain the URL
      // and, in some engines, request detail.
      throw new ApiError({
        code: 'NETWORK_ERROR',
        status: 0,
        message: 'the server could not be reached',
      })
    } finally {
      clearTimeout(timeoutId)
    }

    const requestId = response.headers.get(REQUEST_ID_HEADER) ?? undefined
    const text = await response.text()

    if (!response.ok) {
      throw toApiError(response, text, requestId, auth, onUnauthorized)
    }

    if (response.status === 204 || text === '') {
      return { data: null, pagination: null, requestId }
    }

    const payload = tryParseJson(text)
    if (payload === NOT_JSON || !isRecord(payload) || !('data' in payload)) {
      throw unexpectedResponse(response.status, requestId)
    }

    if (!guard(payload.data)) {
      throw unexpectedResponse(response.status, requestId)
    }

    let pagination: Pagination | null = null
    if ('pagination' in payload) {
      if (!isPagination(payload.pagination)) {
        throw unexpectedResponse(response.status, requestId)
      }
      pagination = payload.pagination
    }

    return { data: payload.data, pagination, requestId }
  }
}

function toApiError(
  response: Response,
  text: string,
  requestId: string | undefined,
  auth: boolean,
  onUnauthorized: () => void,
): ApiError {
  const retryAfterSeconds =
    response.status === 429
      ? parseRetryAfterSeconds(response.headers.get(RETRY_AFTER_HEADER))
      : undefined

  const payload = tryParseJson(text)
  const envelope =
    payload !== NOT_JSON && isRecord(payload) && isRecord(payload.error)
      ? payload.error
      : undefined

  let code: ApiErrorCode = 'UNEXPECTED_RESPONSE'
  let message = 'the server returned a response this client does not understand'
  let details: Record<string, string> | undefined

  if (envelope !== undefined && isServerErrorCode(envelope.code)) {
    code = envelope.code
    message =
      typeof envelope.message === 'string' && envelope.message !== ''
        ? envelope.message
        : envelope.code
    details = parseErrorDetails(envelope.details)
  }

  // Only a request that actually carried a token can have had it rejected.
  // Login's 401 is INVALID_CREDENTIALS and never reaches this branch.
  if (auth && response.status === 401 && code === 'UNAUTHENTICATED') {
    onUnauthorized()
  }

  return new ApiError({
    code,
    status: response.status,
    message,
    details,
    requestId,
    retryAfterSeconds,
  })
}
