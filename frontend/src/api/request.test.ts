import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  emptyProxyFailure,
  errorResponse,
  failingBodyResponse,
  hangingBodyResponse,
  hangingFetch,
  jsonResponse,
  plainTextResponse,
  stubFetch,
} from '../test/http.ts'
import { ApiError, SERVER_ERROR_CODES } from './errors.ts'
import { isPagination, isRecord, isUser } from './guards.ts'
import { API_BASE, createRequest, type RequestDependencies } from './request.ts'

const TOKEN = 'session-token-value-that-must-never-leak'

const USER = { id: 7, email: 'ada@example.com', createdAt: '2026-10-06T00:00:00Z' }

function deps(overrides: Partial<RequestDependencies> = {}): RequestDependencies {
  return {
    getToken: () => null,
    onUnauthorized: () => undefined,
    ...overrides,
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

describe('request helper, outgoing request', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('resolves paths against the relative API base and never an absolute URL', async () => {
    const fetchStub = stubFetch(() => jsonResponse({ data: USER }))
    const request = createRequest(deps())

    await request({ method: 'GET', path: '/users/me', guard: isUser })

    expect(fetchStub.lastCall().url).toBe(`${API_BASE}/users/me`)
    expect(fetchStub.lastCall().url.startsWith('/')).toBe(true)
  })

  it.each([
    'https://evil.example.com/api/v1/users/me',
    'http://localhost:8080/users/me',
    '//evil.example.com/users/me',
    'users/me',
  ])('rejects the non-relative path %s without calling fetch', async (path) => {
    const fetchStub = stubFetch(() => jsonResponse({ data: USER }))
    const request = createRequest(deps({ getToken: () => TOKEN }))

    await expect(
      request({ method: 'GET', path, auth: true, guard: isUser }),
    ).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE', status: 0 })

    expect(fetchStub.mock).not.toHaveBeenCalled()
  })

  it('sends the exact case-sensitive bearer header when a call opts in', async () => {
    const fetchStub = stubFetch(() => jsonResponse({ data: USER }))
    const request = createRequest(deps({ getToken: () => TOKEN }))

    await request({ method: 'GET', path: '/users/me', auth: true, guard: isUser })

    const rawHeaders = fetchStub.lastCall().init.headers as Record<string, string>
    expect(rawHeaders['Authorization']).toBe(`Bearer ${TOKEN}`)
  })

  it('omits the bearer header on login and register even when a token exists', async () => {
    const fetchStub = stubFetch(() => jsonResponse({ data: USER }))
    const request = createRequest(deps({ getToken: () => TOKEN }))

    await request({
      method: 'POST',
      path: '/auth/register',
      body: { email: 'ada@example.com', password: 'secret' },
      guard: isUser,
    })

    expect(fetchStub.headers()['authorization']).toBeUndefined()
  })

  it('omits the bearer header when the call opts in but no token is stored', async () => {
    const fetchStub = stubFetch(() => jsonResponse({ data: USER }))
    const request = createRequest(deps({ getToken: () => null }))

    await request({ method: 'GET', path: '/users/me', auth: true, guard: isUser })

    expect(fetchStub.headers()['authorization']).toBeUndefined()
  })

  it('sends exactly the typed fields, because the server rejects unknown keys', async () => {
    const fetchStub = stubFetch(() => jsonResponse({ data: USER }))
    const request = createRequest(deps())

    await request({
      method: 'POST',
      path: '/auth/register',
      body: { email: 'ada@example.com', password: 'secret' },
      guard: isUser,
    })

    expect(fetchStub.body()).toEqual({ email: 'ada@example.com', password: 'secret' })
  })

  it('omits cookies and disables caching', async () => {
    const fetchStub = stubFetch(() => jsonResponse({ data: USER }))
    const request = createRequest(deps())

    await request({ method: 'GET', path: '/users/me', guard: isUser })

    expect(fetchStub.lastCall().init.credentials).toBe('omit')
    expect(fetchStub.lastCall().init.cache).toBe('no-store')
  })

  it('makes exactly one attempt and does not retry a failure', async () => {
    const fetchStub = stubFetch(() => errorResponse(500, 'INTERNAL_SERVER_ERROR'))
    const request = createRequest(deps())

    await expect(
      request({ method: 'GET', path: '/users/me', guard: isUser }),
    ).rejects.toBeInstanceOf(ApiError)

    expect(fetchStub.mock).toHaveBeenCalledTimes(1)
  })
})

describe('request helper, success parsing', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('unwraps the data envelope', async () => {
    stubFetch(() => jsonResponse({ data: USER }))
    const request = createRequest(deps())

    const result = await request({ method: 'GET', path: '/users/me', guard: isUser })

    expect(result.data).toEqual(USER)
    expect(result.pagination).toBeNull()
  })

  it('unwraps the pagination envelope on a list response', async () => {
    stubFetch(() =>
      jsonResponse({
        data: ['first', 'second'],
        pagination: { page: 2, pageSize: 20, totalItems: 42, totalPages: 3 },
      }),
    )
    const request = createRequest(deps())

    const result = await request({
      method: 'GET',
      path: '/wallets',
      guard: isStringArray,
    })

    expect(result.data).toEqual(['first', 'second'])
    expect(isPagination(result.pagination)).toBe(true)
    expect(result.pagination).toEqual({
      page: 2,
      pageSize: 20,
      totalItems: 42,
      totalPages: 3,
    })
  })

  it('treats 204 as a success with no body', async () => {
    stubFetch(() => new Response(null, { status: 204 }))
    const request = createRequest(deps())

    const result = await request({ method: 'POST', path: '/auth/logout', guard: isUser })

    expect(result.data).toBeNull()
  })

  it('treats a 200 with an empty body as a success with no body', async () => {
    stubFetch(() => new Response('', { status: 200 }))
    const request = createRequest(deps())

    const result = await request({ method: 'POST', path: '/auth/logout', guard: isUser })

    expect(result.data).toBeNull()
  })

  it('rejects a success body that does not match the guard', async () => {
    stubFetch(() => jsonResponse({ data: { id: 'seven', email: 1 } }))
    const request = createRequest(deps())

    await expect(
      request({ method: 'GET', path: '/users/me', guard: isUser }),
    ).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE', status: 200 })
  })

  it('rejects a success body with no data key', async () => {
    stubFetch(() => jsonResponse(USER))
    const request = createRequest(deps())

    await expect(
      request({ method: 'GET', path: '/users/me', guard: isUser }),
    ).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' })
  })

  it('rejects a list response whose pagination is malformed', async () => {
    stubFetch(() => jsonResponse({ data: [], pagination: { page: 'one' } }))
    const request = createRequest(deps())

    await expect(
      request({ method: 'GET', path: '/wallets', guard: isStringArray }),
    ).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' })
  })

  it('captures the request id from the response headers', async () => {
    stubFetch(() =>
      jsonResponse({ data: USER }, { headers: { 'X-Request-ID': 'abc-123' } }),
    )
    const request = createRequest(deps())

    const result = await request({ method: 'GET', path: '/users/me', guard: isUser })

    expect(result.requestId).toBe('abc-123')
  })
})

describe('request helper, error mapping', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it.each(SERVER_ERROR_CODES)('passes the documented code %s through', async (code) => {
    stubFetch(() => errorResponse(400, code))
    const request = createRequest(deps())

    await expect(
      request({ method: 'GET', path: '/users/me', guard: isUser }),
    ).rejects.toMatchObject({ code, status: 400 })
  })

  it('maps an unrecognised server code to UNEXPECTED_RESPONSE', async () => {
    stubFetch(() => errorResponse(400, 'TEAPOT_OVERFLOW'))
    const request = createRequest(deps())

    await expect(
      request({ method: 'GET', path: '/users/me', guard: isUser }),
    ).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE', status: 400 })
  })

  it('maps the mux plain-text 404 to UNEXPECTED_RESPONSE with the real status', async () => {
    stubFetch(() => plainTextResponse(404, '404 page not found\n'))
    const request = createRequest(deps())

    await expect(
      request({ method: 'GET', path: '/users/nope', guard: isUser }),
    ).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE', status: 404 })
  })

  it('maps the mux plain-text 405 to UNEXPECTED_RESPONSE with the real status', async () => {
    stubFetch(() => plainTextResponse(405, 'Method Not Allowed\n'))
    const request = createRequest(deps())

    await expect(
      request({ method: 'GET', path: '/auth/login', guard: isUser }),
    ).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE', status: 405 })
  })

  it('maps the empty dev-proxy 502 to UNEXPECTED_RESPONSE', async () => {
    stubFetch(() => emptyProxyFailure())
    const request = createRequest(deps())

    await expect(
      request({ method: 'GET', path: '/users/me', guard: isUser }),
    ).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE', status: 502 })
  })

  it('carries 422 details through', async () => {
    stubFetch(() =>
      errorResponse(422, 'VALIDATION_ERROR', {
        details: { email: 'must contain @' },
      }),
    )
    const request = createRequest(deps())

    await expect(
      request({ method: 'POST', path: '/auth/register', body: {}, guard: isUser }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      status: 422,
      details: { email: 'must contain @' },
    })
  })

  it('reads Retry-After as whole seconds on a 429', async () => {
    stubFetch(() =>
      errorResponse(429, 'RATE_LIMITED', { headers: { 'Retry-After': '24' } }),
    )
    const request = createRequest(deps())

    await expect(
      request({ method: 'POST', path: '/auth/login', body: {}, guard: isUser }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: 24 })
  })

  it('ignores a Retry-After that is not whole seconds', async () => {
    stubFetch(() =>
      errorResponse(429, 'RATE_LIMITED', {
        headers: { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' },
      }),
    )
    const request = createRequest(deps())

    await expect(
      request({ method: 'POST', path: '/auth/login', body: {}, guard: isUser }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: undefined })
  })

  it('maps a network failure, a timeout and a caller abort to three distinct codes', async () => {
    stubFetch(() => {
      throw new TypeError('Failed to fetch')
    })
    const networkRequest = createRequest(deps())
    await expect(
      networkRequest({ method: 'GET', path: '/users/me', guard: isUser }),
    ).rejects.toMatchObject({ code: 'NETWORK_ERROR', status: 0 })

    vi.unstubAllGlobals()
    stubFetch(hangingFetch)
    const timeoutRequest = createRequest(deps({ timeoutMs: 5 }))
    await expect(
      timeoutRequest({ method: 'GET', path: '/users/me', guard: isUser }),
    ).rejects.toMatchObject({ code: 'TIMEOUT', status: 0 })

    vi.unstubAllGlobals()
    stubFetch(hangingFetch)
    const abortRequest = createRequest(deps())
    const controller = new AbortController()
    const pending = abortRequest({
      method: 'GET',
      path: '/users/me',
      guard: isUser,
      signal: controller.signal,
    })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED', status: 0 })
  })

  it('captures the request id on an error response', async () => {
    stubFetch(() =>
      errorResponse(500, 'INTERNAL_SERVER_ERROR', {
        headers: { 'X-Request-ID': 'trace-9' },
      }),
    )
    const request = createRequest(deps())

    await expect(
      request({ method: 'GET', path: '/users/me', guard: isUser }),
    ).rejects.toMatchObject({ requestId: 'trace-9' })
  })
})

describe('request helper, unauthorized handling', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('fires onUnauthorized once for a 401 UNAUTHENTICATED on a token-carrying call', async () => {
    stubFetch(() => errorResponse(401, 'UNAUTHENTICATED'))
    const onUnauthorized = vi.fn()
    const request = createRequest(deps({ getToken: () => TOKEN, onUnauthorized }))

    await expect(
      request({ method: 'GET', path: '/users/me', auth: true, guard: isUser }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })

    expect(onUnauthorized).toHaveBeenCalledTimes(1)
  })

  it('never fires onUnauthorized for login\u2019s 401 INVALID_CREDENTIALS', async () => {
    stubFetch(() => errorResponse(401, 'INVALID_CREDENTIALS'))
    const onUnauthorized = vi.fn()
    const request = createRequest(deps({ getToken: () => TOKEN, onUnauthorized }))

    await expect(
      request({ method: 'POST', path: '/auth/login', body: {}, guard: isUser }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' })

    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('never fires onUnauthorized when the call opted in but no token was stored', async () => {
    stubFetch(() => errorResponse(401, 'UNAUTHENTICATED'))
    const onUnauthorized = vi.fn()
    // Opting in with nothing stored sends no header, so this 401 is not a
    // rejected session and must not end one.
    const request = createRequest(deps({ getToken: () => null, onUnauthorized }))

    await expect(
      request({ method: 'GET', path: '/users/me', auth: true, guard: isUser }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })

    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('never fires onUnauthorized for a 401 on a route that never opts in', async () => {
    stubFetch(() => errorResponse(401, 'UNAUTHENTICATED'))
    const onUnauthorized = vi.fn()
    const request = createRequest(deps({ getToken: () => TOKEN, onUnauthorized }))

    await expect(
      request({ method: 'POST', path: '/auth/register', body: {}, guard: isUser }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })

    expect(onUnauthorized).not.toHaveBeenCalled()
  })
})

describe('request helper, body phase', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('maps a body that fails after the headers to an ApiError, not a raw TypeError', async () => {
    stubFetch(() => failingBodyResponse(200))
    const request = createRequest(deps())

    const error = await request({
      method: 'GET',
      path: '/users/me',
      guard: isUser,
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ code: 'NETWORK_ERROR', status: 0 })
  })

  it('maps a failing body on an error response to an ApiError too', async () => {
    stubFetch(() => failingBodyResponse(500))
    const request = createRequest(deps())

    const error = await request({
      method: 'GET',
      path: '/users/me',
      guard: isUser,
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ code: 'NETWORK_ERROR' })
  })

  it('times out a body that never arrives, so the timeout bounds the whole call', async () => {
    stubFetch(() => hangingBodyResponse(200))
    const request = createRequest(deps({ timeoutMs: 20 }))

    const started = Date.now()
    const error = await request({
      method: 'GET',
      path: '/users/me',
      guard: isUser,
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ code: 'TIMEOUT', status: 0 })
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('maps a caller abort during the body read to ABORTED', async () => {
    stubFetch(() => hangingBodyResponse(200))
    const request = createRequest(deps())
    const controller = new AbortController()

    const pending = request({
      method: 'GET',
      path: '/users/me',
      guard: isUser,
      signal: controller.signal,
    })
    const settled = pending.catch((caught: unknown) => caught)
    controller.abort()

    const error = await settled
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ code: 'ABORTED', status: 0 })
  })
})

describe('request helper, token containment', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps the token out of error text and out of the console', async () => {
    const consoleSpies = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'info').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
      vi.spyOn(console, 'debug').mockImplementation(() => undefined),
    ]

    stubFetch(() => errorResponse(401, 'UNAUTHENTICATED', { message: 'unauthenticated' }))
    const request = createRequest(deps({ getToken: () => TOKEN }))

    const error = await request({
      method: 'GET',
      path: '/users/me',
      auth: true,
      guard: isUser,
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ApiError)
    const serialised = JSON.stringify({
      message: (error as ApiError).message,
      stack: (error as ApiError).stack,
      error,
    })
    expect(serialised).not.toContain(TOKEN)

    for (const spy of consoleSpies) {
      expect(spy).not.toHaveBeenCalled()
    }
  })

  it('keeps the token out of a network failure error', async () => {
    stubFetch(() => {
      throw new TypeError(`Failed to fetch ${TOKEN}`)
    })
    const request = createRequest(deps({ getToken: () => TOKEN }))

    const error = await request({
      method: 'GET',
      path: '/users/me',
      auth: true,
      guard: isUser,
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).message).not.toContain(TOKEN)
    expect(isRecord(error)).toBe(true)
  })
})
