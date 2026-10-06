import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { errorResponse, jsonResponse, plainTextResponse, stubFetch } from '../test/http.ts'
import { AuthProvider } from './AuthProvider.tsx'
import { createTokenStorage, type TokenStorage } from './storage.ts'
import { useAuth } from './useAuth.ts'

const USER = { id: 11, email: 'ada@example.com', createdAt: '2026-10-06T10:00:00Z' }

function memoryStorage(initial: string | null = null): TokenStorage {
  const storage = createTokenStorage(() => null)
  if (initial !== null) {
    storage.write(initial)
  }
  return storage
}

function renderAuth(storage: TokenStorage, options: { strict?: boolean } = {}) {
  return renderHook(() => useAuth(), {
    reactStrictMode: options.strict ?? false,
    wrapper: ({ children }: { children: ReactNode }) => (
      <AuthProvider storage={storage}>{children}</AuthProvider>
    ),
  })
}

function deferredResponse() {
  let release: (response: Response) => void = () => undefined
  const promise = new Promise<Response>((resolve) => {
    release = resolve
  })

  return {
    promise,
    release,
    responder: (_url: string, init: RequestInit): Promise<Response> =>
      new Promise<Response>((resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        })
        void promise.then(resolve)
      }),
  }
}

describe('restore on load', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('starts anonymous and makes no request when no token is stored', async () => {
    const fetchStub = stubFetch(() => jsonResponse({ data: USER }))
    const { result } = renderAuth(memoryStorage())

    await waitFor(() => {
      expect(result.current.session.status).toBe('anonymous')
    })
    expect(fetchStub.mock).not.toHaveBeenCalled()
  })

  it('restores an authenticated session from a stored token', async () => {
    stubFetch(() => jsonResponse({ data: USER }))
    const storage = memoryStorage('stored-token')
    const { result } = renderAuth(storage)

    await waitFor(() => {
      expect(result.current.session.status).toBe('authenticated')
    })
    expect(result.current.session).toEqual({ status: 'authenticated', user: USER })
    expect(storage.read()).toBe('stored-token')
  })

  it('clears the token and goes anonymous on a 401', async () => {
    stubFetch(() => errorResponse(401, 'UNAUTHENTICATED'))
    const storage = memoryStorage('dead-token')
    const { result } = renderAuth(storage)

    await waitFor(() => {
      expect(result.current.session.status).toBe('anonymous')
    })
    expect(storage.read()).toBeNull()
  })

  it.each([
    [
      'a stopped API',
      () => {
        throw new TypeError('Failed to fetch')
      },
    ],
    ['a rate limit', () => errorResponse(429, 'RATE_LIMITED')],
    ['a server error', () => errorResponse(500, 'INTERNAL_SERVER_ERROR')],
    ['a gateway failure', () => plainTextResponse(502, '')],
  ])('keeps the token and reports unavailable on %s', async (_label, responder) => {
    stubFetch(responder)
    const storage = memoryStorage('kept-token')
    const { result } = renderAuth(storage)

    await waitFor(() => {
      expect(result.current.session.status).toBe('unavailable')
    })
    expect(storage.read()).toBe('kept-token')
  })

  it('reaches authenticated on a retry after the API comes back', async () => {
    let fail = true
    stubFetch(() => {
      if (fail) {
        throw new TypeError('Failed to fetch')
      }
      return jsonResponse({ data: USER })
    })
    const { result } = renderAuth(memoryStorage('kept-token'))

    await waitFor(() => {
      expect(result.current.session.status).toBe('unavailable')
    })

    fail = false
    act(() => {
      result.current.retryRestore()
    })

    await waitFor(() => {
      expect(result.current.session.status).toBe('authenticated')
    })
  })

  it('signs out locally from unavailable without calling the server', async () => {
    const fetchStub = stubFetch(() => {
      throw new TypeError('Failed to fetch')
    })
    const storage = memoryStorage('kept-token')
    const { result } = renderAuth(storage)

    await waitFor(() => {
      expect(result.current.session.status).toBe('unavailable')
    })

    const callsBefore = fetchStub.mock.mock.calls.length
    act(() => {
      result.current.signOutLocally()
    })

    expect(result.current.session.status).toBe('anonymous')
    expect(storage.read()).toBeNull()
    expect(fetchStub.mock.mock.calls.length).toBe(callsBefore)
  })

  it('applies the restore once under StrictMode', async () => {
    const fetchStub = stubFetch(() => jsonResponse({ data: USER }))
    const { result } = renderAuth(memoryStorage('stored-token'), { strict: true })

    await waitFor(() => {
      expect(result.current.session.status).toBe('authenticated')
    })
    expect(result.current.session).toEqual({ status: 'authenticated', user: USER })
    expect(fetchStub.mock.mock.calls.length).toBeGreaterThan(0)
  })
})

describe('login', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('stores the token, then loads the identity', async () => {
    const fetchStub = stubFetch((url) =>
      url.endsWith('/auth/login')
        ? jsonResponse({ data: { token: 'fresh-token', expiresAt: '2026-10-13T00:00:00Z' } })
        : jsonResponse({ data: USER }),
    )
    const storage = memoryStorage()
    const { result } = renderAuth(storage)

    await act(async () => {
      await result.current.login({ email: 'ada@example.com', password: 'pw' })
    })

    expect(result.current.session).toEqual({ status: 'authenticated', user: USER })
    expect(storage.read()).toBe('fresh-token')
    expect(fetchStub.calls.map((call) => call.url)).toEqual([
      '/api/v1/auth/login',
      '/api/v1/users/me',
    ])
  })

  it('stores nothing when the credentials are rejected', async () => {
    stubFetch(() => errorResponse(401, 'INVALID_CREDENTIALS'))
    const storage = memoryStorage()
    const { result } = renderAuth(storage)

    await expect(
      act(async () => {
        await result.current.login({ email: 'ada@example.com', password: 'wrong' })
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' })

    expect(storage.read()).toBeNull()
    expect(result.current.session.status).toBe('anonymous')
  })

  it('clears the issued token when the identity call fails afterwards', async () => {
    stubFetch((url) =>
      url.endsWith('/auth/login')
        ? jsonResponse({ data: { token: 'fresh-token', expiresAt: '2026-10-13T00:00:00Z' } })
        : errorResponse(500, 'INTERNAL_SERVER_ERROR'),
    )
    const storage = memoryStorage()
    const { result } = renderAuth(storage)

    await expect(
      act(async () => {
        await result.current.login({ email: 'ada@example.com', password: 'pw' })
      }),
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' })

    expect(storage.read()).toBeNull()
    expect(result.current.session.status).toBe('anonymous')
  })
})

describe('logout', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('revokes server side, then clears local state', async () => {
    const fetchStub = stubFetch((url) =>
      url.endsWith('/auth/logout')
        ? jsonResponse({ data: { message: 'logged out' } })
        : jsonResponse({ data: USER }),
    )
    const storage = memoryStorage('stored-token')
    const { result } = renderAuth(storage)

    await waitFor(() => {
      expect(result.current.session.status).toBe('authenticated')
    })

    await act(async () => {
      await result.current.logout()
    })

    expect(result.current.session.status).toBe('anonymous')
    expect(storage.read()).toBeNull()
    expect(result.current.logoutProblem).toBeNull()
    expect(fetchStub.calls.some((call) => call.url.endsWith('/auth/logout'))).toBe(true)
  })

  it('clears local state and reports the problem when the server call fails', async () => {
    stubFetch((url) => {
      if (url.endsWith('/auth/logout')) {
        throw new TypeError('Failed to fetch')
      }
      return jsonResponse({ data: USER })
    })
    const storage = memoryStorage('stored-token')
    const { result } = renderAuth(storage)

    await waitFor(() => {
      expect(result.current.session.status).toBe('authenticated')
    })

    await act(async () => {
      await result.current.logout()
    })

    expect(result.current.session.status).toBe('anonymous')
    expect(storage.read()).toBeNull()
    expect(result.current.logoutProblem).toBe(
      'The server could not be reached. Check that the API is running.',
    )
  })

  it('clears local state when the server rejects the token outright', async () => {
    stubFetch((url) =>
      url.endsWith('/auth/logout')
        ? errorResponse(401, 'UNAUTHENTICATED')
        : jsonResponse({ data: USER }),
    )
    const storage = memoryStorage('stored-token')
    const { result } = renderAuth(storage)

    await waitFor(() => {
      expect(result.current.session.status).toBe('authenticated')
    })

    await act(async () => {
      await result.current.logout()
    })

    expect(result.current.session.status).toBe('anonymous')
    expect(storage.read()).toBeNull()
  })
})

describe('superseded results', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('ignores an identity response that lands after the user signed out', async () => {
    const deferred = deferredResponse()
    stubFetch(deferred.responder)
    const storage = memoryStorage('stored-token')
    const { result } = renderAuth(storage)

    expect(result.current.session.status).toBe('restoring')

    act(() => {
      result.current.signOutLocally()
    })
    expect(result.current.session.status).toBe('anonymous')

    await act(async () => {
      deferred.release(jsonResponse({ data: USER }))
      await Promise.resolve()
    })

    expect(result.current.session.status).toBe('anonymous')
    expect(storage.read()).toBeNull()
  })
})

describe('storage failure', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('still signs in when localStorage is unavailable', async () => {
    stubFetch((url) =>
      url.endsWith('/auth/login')
        ? jsonResponse({ data: { token: 'fresh-token', expiresAt: '2026-10-13T00:00:00Z' } })
        : jsonResponse({ data: USER }),
    )
    const throwing = createTokenStorage(
      () =>
        ({
          getItem: () => {
            throw new DOMException('SecurityError')
          },
          setItem: () => {
            throw new DOMException('SecurityError')
          },
          removeItem: () => undefined,
        }) as unknown as Storage,
    )
    const { result } = renderAuth(throwing)

    await act(async () => {
      await result.current.login({ email: 'ada@example.com', password: 'pw' })
    })

    expect(result.current.session).toEqual({ status: 'authenticated', user: USER })
  })
})
