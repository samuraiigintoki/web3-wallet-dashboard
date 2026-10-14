import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  announceStorageChange,
  announceStoredCredential,
  otherTabClearsStorage,
  otherTabRemoves,
  otherTabStores,
  otherTabStoresSilently,
} from '../test/crossTab.ts'
import { errorResponse, jsonResponse, plainTextResponse, stubFetch } from '../test/http.ts'
import { AuthProvider } from './AuthProvider.tsx'
import { createTokenStorage, SESSION_TOKEN_KEY, type TokenStorage } from './storage.ts'
import { useAuth } from './useAuth.ts'

const USER = { id: 11, email: 'ada@example.com', createdAt: '2026-10-06T10:00:00Z' }
const OTHER_USER = { id: 12, email: 'grace@example.com', createdAt: '2026-10-07T09:00:00Z' }

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

/** The Authorization header a recorded call carried, if any. */
function authorizationOf(init: RequestInit): string | null {
  return new Headers(init.headers).get('Authorization')
}

/** Answers a credential-checking call from the credential it carries. */
function identityFrom(tokens: Record<string, unknown>) {
  return (_url: string, init: RequestInit): Response => {
    const token = (authorizationOf(init) ?? '').replace('Bearer ', '')
    const user = tokens[token]
    return user === undefined
      ? errorResponse(401, 'UNAUTHENTICATED')
      : jsonResponse({ data: user })
  }
}

/**
 * A response delivered on demand, whatever happened to the request since. An
 * answer the client had already produced can reach a caller after the identity
 * moved on, and that is the race the guards have to survive.
 */
function lateResponse() {
  let release: (response: Response) => void = () => undefined
  const promise = new Promise<Response>((resolve) => {
    release = resolve
  })

  return { release, responder: (): Promise<Response> => promise }
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

describe('retry from the unavailable state', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('retries the restore when a token is still stored', async () => {
    let attempts = 0
    stubFetch(() => {
      attempts += 1
      if (attempts === 1) {
        throw new TypeError('Failed to fetch')
      }
      return jsonResponse({ data: USER })
    })
    const { result } = renderAuth(memoryStorage('stored-token'))

    await waitFor(() => {
      expect(result.current.session.status).toBe('unavailable')
    })

    act(() => {
      result.current.retryRestore()
    })

    await waitFor(() => {
      expect(result.current.session.status).toBe('authenticated')
    })
  })

  it('goes anonymous instead of restoring forever when the token is gone', async () => {
    stubFetch(() => {
      throw new TypeError('Failed to fetch')
    })
    const storage = memoryStorage('stored-token')
    const { result } = renderAuth(storage)

    await waitFor(() => {
      expect(result.current.session.status).toBe('unavailable')
    })

    // What another tab's sign-out does to the shared key.
    storage.clear()

    act(() => {
      result.current.retryRestore()
    })

    await waitFor(() => {
      expect(result.current.session.status).toBe('anonymous')
    })
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

describe('cross-tab identity', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    window.localStorage.clear()
  })

  it('goes anonymous without a request when another tab signs out', async () => {
    const fetchStub = stubFetch(() => jsonResponse({ data: USER }))
    window.localStorage.setItem(SESSION_TOKEN_KEY, 'tab-a-token')
    const { result } = renderAuth(createTokenStorage())

    await waitFor(() => {
      expect(result.current.session.status).toBe('authenticated')
    })
    const callsBefore = fetchStub.mock.mock.calls.length

    await act(async () => {
      otherTabRemoves()
    })

    expect(result.current.session.status).toBe('anonymous')
    expect(fetchStub.mock.mock.calls.length).toBe(callsBefore)
  })

  it('goes anonymous without a request when another tab clears storage', async () => {
    const fetchStub = stubFetch(() => jsonResponse({ data: USER }))
    window.localStorage.setItem(SESSION_TOKEN_KEY, 'tab-a-token')
    const { result } = renderAuth(createTokenStorage())

    await waitFor(() => {
      expect(result.current.session.status).toBe('authenticated')
    })
    const callsBefore = fetchStub.mock.mock.calls.length

    await act(async () => {
      otherTabClearsStorage()
    })

    expect(result.current.session.status).toBe('anonymous')
    expect(fetchStub.mock.mock.calls.length).toBe(callsBefore)
  })

  it('stops presenting the old user, then authenticates the credential another tab stored', async () => {
    const late = lateResponse()
    stubFetch((_url, init) =>
      authorizationOf(init) === 'Bearer tab-b-token'
        ? late.responder()
        : jsonResponse({ data: USER }),
    )
    window.localStorage.setItem(SESSION_TOKEN_KEY, 'tab-a-token')
    const { result } = renderAuth(createTokenStorage())

    await waitFor(() => {
      expect(result.current.session.status).toBe('authenticated')
    })

    act(() => {
      otherTabStores('tab-b-token')
    })

    // The old identity is not presented while its replacement is being checked.
    expect(result.current.session.status).toBe('restoring')

    await act(async () => {
      late.release(jsonResponse({ data: OTHER_USER }))
    })

    await waitFor(() => {
      expect(result.current.session).toEqual({ status: 'authenticated', user: OTHER_USER })
    })
  })

  it('clears a credential another tab stored when the server rejects it', async () => {
    stubFetch((_url, init) =>
      authorizationOf(init) === 'Bearer tab-b-token'
        ? errorResponse(401, 'UNAUTHENTICATED')
        : jsonResponse({ data: USER }),
    )
    window.localStorage.setItem(SESSION_TOKEN_KEY, 'tab-a-token')
    const { result } = renderAuth(createTokenStorage())

    await waitFor(() => {
      expect(result.current.session.status).toBe('authenticated')
    })

    await act(async () => {
      otherTabStores('tab-b-token')
    })

    await waitFor(() => {
      expect(result.current.session.status).toBe('anonymous')
    })
    expect(window.localStorage.getItem(SESSION_TOKEN_KEY)).toBeNull()
  })

  it('keeps a credential another tab stored when the server cannot be asked', async () => {
    stubFetch((_url, init) => {
      if (authorizationOf(init) === 'Bearer tab-b-token') {
        throw new TypeError('Failed to fetch')
      }
      return jsonResponse({ data: USER })
    })
    window.localStorage.setItem(SESSION_TOKEN_KEY, 'tab-a-token')
    const { result } = renderAuth(createTokenStorage())

    await waitFor(() => {
      expect(result.current.session.status).toBe('authenticated')
    })

    await act(async () => {
      otherTabStores('tab-b-token')
    })

    await waitFor(() => {
      expect(result.current.session.status).toBe('unavailable')
    })
    expect(window.localStorage.getItem(SESSION_TOKEN_KEY)).toBe('tab-b-token')
  })

  it('follows the value in the store rather than the one a delivery describes', async () => {
    const fetchStub = stubFetch(
      identityFrom({ 'tab-a-token': USER, 'tab-c-token': OTHER_USER }),
    )
    window.localStorage.setItem(SESSION_TOKEN_KEY, 'tab-a-token')
    const { result } = renderAuth(createTokenStorage())

    await waitFor(() => {
      expect(result.current.session.status).toBe('authenticated')
    })

    // Two writes landed before either notification was handled, so the delivery
    // that arrives now describes the value in between.
    window.localStorage.setItem(SESSION_TOKEN_KEY, 'tab-c-token')
    await act(async () => {
      announceStorageChange({ key: SESSION_TOKEN_KEY, newValue: 'tab-b-token' })
    })

    await waitFor(() => {
      expect(result.current.session).toEqual({ status: 'authenticated', user: OTHER_USER })
    })
    const lastMe = fetchStub.calls.filter((call) => call.url.endsWith('/users/me')).at(-1)
    expect(lastMe === undefined ? null : authorizationOf(lastMe.init)).toBe('Bearer tab-c-token')
  })

  it('ignores a delivery for an unrelated key or another storage area', async () => {
    const fetchStub = stubFetch(() => jsonResponse({ data: USER }))
    window.localStorage.setItem(SESSION_TOKEN_KEY, 'tab-a-token')
    const { result } = renderAuth(createTokenStorage())

    await waitFor(() => {
      expect(result.current.session.status).toBe('authenticated')
    })
    const callsBefore = fetchStub.mock.mock.calls.length

    await act(async () => {
      announceStorageChange({ key: 'unrelated-key', newValue: 'value' })
      window.sessionStorage.setItem(SESSION_TOKEN_KEY, 'tab-b-token')
      announceStorageChange({ key: SESSION_TOKEN_KEY, storageArea: window.sessionStorage })
    })

    expect(result.current.session).toEqual({ status: 'authenticated', user: USER })
    expect(fetchStub.mock.mock.calls.length).toBe(callsBefore)
    expect(window.localStorage.getItem(SESSION_TOKEN_KEY)).toBe('tab-a-token')
  })

  it('sends the credential the screen was authorized under, not one another tab stored', async () => {
    const fetchStub = stubFetch((url) =>
      url.endsWith('/auth/logout')
        ? jsonResponse({ data: { message: 'logged out' } })
        : jsonResponse({ data: USER }),
    )
    window.localStorage.setItem(SESSION_TOKEN_KEY, 'tab-a-token')
    const { result } = renderAuth(createTokenStorage())

    await waitFor(() => {
      expect(result.current.session.status).toBe('authenticated')
    })

    // Another tab has stored a credential, and this tab has not handled the
    // notification yet: the screen still belongs to user A.
    otherTabStoresSilently('tab-b-token')

    await act(async () => {
      await result.current.logout()
    })

    const logoutCall = fetchStub.calls.find((call) => call.url.endsWith('/auth/logout'))
    expect(logoutCall === undefined ? null : authorizationOf(logoutCall.init)).toBe(
      'Bearer tab-a-token',
    )
  })

  it('does not erase a credential another tab already stored', async () => {
    stubFetch((url, init) => {
      if (url.endsWith('/auth/logout')) {
        return errorResponse(401, 'UNAUTHENTICATED')
      }
      return identityFrom({ 'tab-a-token': USER, 'tab-b-token': OTHER_USER })(url, init)
    })
    window.localStorage.setItem(SESSION_TOKEN_KEY, 'tab-a-token')
    const { result } = renderAuth(createTokenStorage())

    await waitFor(() => {
      expect(result.current.session.status).toBe('authenticated')
    })

    otherTabStoresSilently('tab-b-token')

    // A 401 for the credential this tab holds ends that credential, but the
    // store now holds one this tab does not own.
    await act(async () => {
      await result.current.logout()
    })

    expect(window.localStorage.getItem(SESSION_TOKEN_KEY)).toBe('tab-b-token')

    // Once the notification for that change arrives, the tab follows it.
    await act(async () => {
      announceStoredCredential('tab-b-token')
    })

    await waitFor(() => {
      expect(result.current.session).toEqual({ status: 'authenticated', user: OTHER_USER })
    })
  })

  it('does not check the identity again for a delivery of the credential it holds', async () => {
    const fetchStub = stubFetch((url) =>
      url.endsWith('/auth/login')
        ? jsonResponse({ data: { token: 'fresh-token', expiresAt: '2026-10-20T00:00:00Z' } })
        : jsonResponse({ data: USER }),
    )
    const { result } = renderAuth(createTokenStorage())

    await act(async () => {
      await result.current.login({ email: 'ada@example.com', password: 'pw' })
    })
    const meCalls = (): number =>
      fetchStub.calls.filter((call) => call.url.endsWith('/users/me')).length
    expect(meCalls()).toBe(1)

    await act(async () => {
      announceStoredCredential('fresh-token')
    })

    expect(meCalls()).toBe(1)
    expect(result.current.session).toEqual({ status: 'authenticated', user: USER })
  })

  it('stops listening when the provider unmounts', async () => {
    const fetchStub = stubFetch(() => jsonResponse({ data: USER }))
    const removeListener = vi.spyOn(window, 'removeEventListener')
    window.localStorage.setItem(SESSION_TOKEN_KEY, 'tab-a-token')
    const { result, unmount } = renderAuth(createTokenStorage())

    await waitFor(() => {
      expect(result.current.session.status).toBe('authenticated')
    })
    const callsBefore = fetchStub.mock.mock.calls.length

    unmount()
    expect(removeListener).toHaveBeenCalledWith('storage', expect.any(Function))

    otherTabStores('tab-b-token')
    expect(fetchStub.mock.mock.calls.length).toBe(callsBefore)
  })

  it('checks the stored credential once under StrictMode', async () => {
    const fetchStub = stubFetch(() => jsonResponse({ data: USER }))
    window.localStorage.setItem(SESSION_TOKEN_KEY, 'tab-a-token')
    const { result } = renderAuth(createTokenStorage(), { strict: true })

    await waitFor(() => {
      expect(result.current.session).toEqual({ status: 'authenticated', user: USER })
    })

    expect(fetchStub.calls.filter((call) => call.url.endsWith('/users/me')).length).toBe(1)
  })

  it('makes no request when the store cannot be read', async () => {
    const fetchStub = stubFetch(() => jsonResponse({ data: USER }))
    const unreadable = createTokenStorage(
      () =>
        ({
          getItem: () => {
            throw new DOMException('SecurityError')
          },
          setItem: () => undefined,
          removeItem: () => undefined,
        }) as unknown as Storage,
    )
    const { result } = renderAuth(unreadable)

    await waitFor(() => {
      expect(result.current.session.status).toBe('anonymous')
    })
    expect(fetchStub.mock).not.toHaveBeenCalled()
  })

  it('keeps the identity it has when the store stops being readable', async () => {
    let broken = false
    const store = {
      getItem: (key: string): string | null => {
        if (broken) {
          throw new DOMException('SecurityError')
        }
        return window.localStorage.getItem(key)
      },
      setItem: (key: string, value: string): void => {
        window.localStorage.setItem(key, value)
      },
      removeItem: (key: string): void => {
        window.localStorage.removeItem(key)
      },
    } as unknown as Storage

    const fetchStub = stubFetch(() => jsonResponse({ data: USER }))
    window.localStorage.setItem(SESSION_TOKEN_KEY, 'tab-a-token')
    const { result } = renderAuth(createTokenStorage(() => store))

    await waitFor(() => {
      expect(result.current.session.status).toBe('authenticated')
    })
    const callsBefore = fetchStub.mock.mock.calls.length

    window.localStorage.setItem(SESSION_TOKEN_KEY, 'tab-b-token')
    broken = true
    await act(async () => {
      announceStorageChange({ key: SESSION_TOKEN_KEY, newValue: 'tab-b-token' })
    })

    // The change cannot be read, so nothing is claimed about it.
    expect(result.current.session).toEqual({ status: 'authenticated', user: USER })
    expect(fetchStub.mock.mock.calls.length).toBe(callsBefore)
  })

  it('goes anonymous without a request when another tab signs out after a sign-in here', async () => {
    const fetchStub = stubFetch((url, init) =>
      url.endsWith('/auth/login')
        ? jsonResponse({ data: { token: 'own-tab-token', expiresAt: '2026-10-20T00:00:00Z' } })
        : identityFrom({ 'own-tab-token': USER })(url, init),
    )
    const { result } = renderAuth(createTokenStorage())

    await act(async () => {
      await result.current.login({ email: 'ada@example.com', password: 'pw' })
    })
    expect(result.current.session).toEqual({ status: 'authenticated', user: USER })
    const callsBefore = fetchStub.mock.mock.calls.length

    // The credential this tab signed in with is the shared one, and the
    // removal has to reach a tab that made the sign-in itself.
    await act(async () => {
      otherTabRemoves()
    })

    expect(result.current.session).toEqual({ status: 'anonymous' })
    expect(fetchStub.mock.mock.calls.length).toBe(callsBefore)
  })

  it('adopts a credential another tab stores after a sign-in here', async () => {
    const late = lateResponse()
    stubFetch((url, init) => {
      if (url.endsWith('/auth/login')) {
        return jsonResponse({ data: { token: 'own-tab-token', expiresAt: '2026-10-20T00:00:00Z' } })
      }

      return authorizationOf(init) === 'Bearer other-tab-token'
        ? late.responder()
        : jsonResponse({ data: USER })
    })
    const { result } = renderAuth(createTokenStorage())

    await act(async () => {
      await result.current.login({ email: 'ada@example.com', password: 'pw' })
    })
    expect(result.current.session).toEqual({ status: 'authenticated', user: USER })

    act(() => {
      otherTabStores('other-tab-token')
    })
    expect(result.current.session.status).toBe('restoring')

    await act(async () => {
      late.release(jsonResponse({ data: OTHER_USER }))
    })

    await waitFor(() => {
      expect(result.current.session).toEqual({ status: 'authenticated', user: OTHER_USER })
    })
  })

  it('ends this tab without erasing a credential another tab stored', async () => {
    stubFetch((url) =>
      url.endsWith('/auth/logout')
        ? jsonResponse({ data: { message: 'logged out' } })
        : jsonResponse({ data: USER }),
    )
    window.localStorage.setItem(SESSION_TOKEN_KEY, 'tab-a-token')
    const { result } = renderAuth(createTokenStorage())

    await waitFor(() => {
      expect(result.current.session.status).toBe('authenticated')
    })

    // Another tab has stored a credential and this tab has not handled the
    // notification: the store holds one this tab does not own.
    otherTabStoresSilently('tab-b-token')

    await act(async () => {
      await result.current.logout()
    })

    // The session this tab was showing is over, and the credential the other
    // tab stored is not this tab's to erase.
    expect(result.current.session).toEqual({ status: 'anonymous' })
    expect(window.localStorage.getItem(SESSION_TOKEN_KEY)).toBe('tab-b-token')
  })
})

describe('superseded identity work', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    window.localStorage.clear()
  })

  it('ignores a restore answered after the credential was replaced', async () => {
    const late = lateResponse()
    stubFetch((_url, init) =>
      authorizationOf(init) === 'Bearer tab-a-token'
        ? late.responder()
        : jsonResponse({ data: OTHER_USER }),
    )
    window.localStorage.setItem(SESSION_TOKEN_KEY, 'tab-a-token')
    const { result } = renderAuth(createTokenStorage())

    expect(result.current.session.status).toBe('restoring')

    await act(async () => {
      otherTabStores('tab-b-token')
    })
    await waitFor(() => {
      expect(result.current.session).toEqual({ status: 'authenticated', user: OTHER_USER })
    })

    // The answer to the first check arrives late and must not resurrect it.
    await act(async () => {
      late.release(jsonResponse({ data: USER }))
    })

    expect(result.current.session).toEqual({ status: 'authenticated', user: OTHER_USER })
    expect(window.localStorage.getItem(SESSION_TOKEN_KEY)).toBe('tab-b-token')
  })

  it('does not clear a newer credential when a 401 for the old one arrives late', async () => {
    const late = lateResponse()
    stubFetch((_url, init) =>
      authorizationOf(init) === 'Bearer tab-a-token'
        ? late.responder()
        : jsonResponse({ data: OTHER_USER }),
    )
    window.localStorage.setItem(SESSION_TOKEN_KEY, 'tab-a-token')
    const { result } = renderAuth(createTokenStorage())

    expect(result.current.session.status).toBe('restoring')

    await act(async () => {
      otherTabStores('tab-b-token')
    })
    await waitFor(() => {
      expect(result.current.session).toEqual({ status: 'authenticated', user: OTHER_USER })
    })

    await act(async () => {
      late.release(errorResponse(401, 'UNAUTHENTICATED'))
    })

    expect(result.current.session).toEqual({ status: 'authenticated', user: OTHER_USER })
    expect(window.localStorage.getItem(SESSION_TOKEN_KEY)).toBe('tab-b-token')
  })

  it('does not store a token a superseded sign-in was issued', async () => {
    const late = lateResponse()
    stubFetch((url, init) => {
      if (url.endsWith('/auth/login')) {
        return late.responder()
      }
      return identityFrom({ 'tab-a-token': USER, 'tab-b-token': OTHER_USER })(url, init)
    })
    const { result } = renderAuth(createTokenStorage())

    let signIn: Promise<void> = Promise.resolve()
    let superseded: unknown = null
    await act(async () => {
      signIn = result.current.login({ email: 'ada@example.com', password: 'pw' })
      // Claimed from the start: this sign-in is expected to reject once the
      // credential it was started under is replaced, and a rejection nobody is
      // holding yet is reported as an unhandled rejection that buries real ones.
      void signIn.catch((error: unknown) => {
        superseded = error
      })
    })

    await act(async () => {
      otherTabStores('tab-b-token')
    })
    await waitFor(() => {
      expect(result.current.session).toEqual({ status: 'authenticated', user: OTHER_USER })
    })

    await act(async () => {
      late.release(
        jsonResponse({ data: { token: 'issued-then-superseded', expiresAt: '2026-10-20T00:00:00Z' } }),
      )
    })

    await act(async () => {
      await signIn.catch(() => undefined)
    })
    expect(superseded).toMatchObject({ code: 'ABORTED' })
    expect(window.localStorage.getItem(SESSION_TOKEN_KEY)).toBe('tab-b-token')
    expect(result.current.session).toEqual({ status: 'authenticated', user: OTHER_USER })
  })

  it('does not end a newer session when a logout completes after a replacement', async () => {
    const late = lateResponse()
    stubFetch((url, init) => {
      if (url.endsWith('/auth/logout')) {
        return late.responder()
      }
      return identityFrom({ 'tab-a-token': USER, 'tab-b-token': OTHER_USER })(url, init)
    })
    window.localStorage.setItem(SESSION_TOKEN_KEY, 'tab-a-token')
    const { result } = renderAuth(createTokenStorage())

    await waitFor(() => {
      expect(result.current.session.status).toBe('authenticated')
    })

    let signOut: Promise<void> = Promise.resolve()
    await act(async () => {
      signOut = result.current.logout()
    })

    await act(async () => {
      otherTabStores('tab-b-token')
    })
    await waitFor(() => {
      expect(result.current.session).toEqual({ status: 'authenticated', user: OTHER_USER })
    })

    await act(async () => {
      late.release(jsonResponse({ data: { message: 'logged out' } }))
      await signOut
    })

    expect(result.current.session).toEqual({ status: 'authenticated', user: OTHER_USER })
    expect(window.localStorage.getItem(SESSION_TOKEN_KEY)).toBe('tab-b-token')
  })
})
