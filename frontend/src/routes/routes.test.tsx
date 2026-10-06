import { screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { errorResponse, jsonResponse, stubFetch } from '../test/http.ts'
import { currentPath, memoryStorage, renderApp } from '../test/renderApp.tsx'

const USER = { id: 5, email: 'ada@example.com', createdAt: '2026-10-06T12:00:00Z' }

describe('route guard', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it.each(['/', '/wallets', '/contracts'])(
    'redirects an unauthenticated visit to %s to the login page',
    async (path) => {
      stubFetch(() => jsonResponse({ data: USER }))
      renderApp({ path })

      await waitFor(() => {
        expect(currentPath()).toBe('/login')
      })
      expect(screen.getByRole('heading', { name: 'Sign in' })).toBeDefined()
    },
  )

  it('returns the visitor to the path they asked for after signing in', async () => {
    stubFetch((url) =>
      url.endsWith('/auth/login')
        ? jsonResponse({ data: { token: 'tok', expiresAt: '2026-10-13T00:00:00Z' } })
        : jsonResponse({ data: USER }),
    )
    const { user } = renderApp({ path: '/contracts' })

    await waitFor(() => {
      expect(currentPath()).toBe('/login')
    })

    await user.type(screen.getByLabelText('Email'), 'ada@example.com')
    await user.type(screen.getByLabelText('Password'), 'secret')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    await waitFor(() => {
      expect(currentPath()).toBe('/contracts')
    })
    expect(screen.getByRole('heading', { name: 'Contracts' })).toBeDefined()
  })

  it('falls back to the overview when there was no origin path', async () => {
    stubFetch((url) =>
      url.endsWith('/auth/login')
        ? jsonResponse({ data: { token: 'tok', expiresAt: '2026-10-13T00:00:00Z' } })
        : jsonResponse({ data: USER }),
    )
    const { user } = renderApp({ path: '/login' })

    await user.type(screen.getByLabelText('Email'), 'ada@example.com')
    await user.type(screen.getByLabelText('Password'), 'secret')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    await waitFor(() => {
      expect(currentPath()).toBe('/')
    })
  })

  it('renders a loading state while restoring and does not redirect', async () => {
    const deferred: { release: (() => void) | null } = { release: null }
    stubFetch(
      () =>
        new Promise<Response>((resolve) => {
          deferred.release = () => {
            resolve(jsonResponse({ data: USER }))
          }
        }),
    )
    renderApp({ path: '/wallets', storage: memoryStorage('stored-token') })

    expect(screen.getByRole('status').textContent).toBe('Restoring your session.')
    expect(currentPath()).toBe('/wallets')

    await waitFor(() => {
      expect(deferred.release).not.toBeNull()
    })
    deferred.release?.()

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Wallets' })).toBeDefined()
    })
    expect(currentPath()).toBe('/wallets')
  })

  it('shows the unavailable state with Retry and Sign out when the API is down', async () => {
    stubFetch(() => {
      throw new TypeError('Failed to fetch')
    })
    const storage = memoryStorage('stored-token')
    renderApp({ path: '/', storage })

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'The service is unavailable' }),
      ).toBeDefined()
    })

    expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeDefined()
    expect(currentPath()).toBe('/')
    expect(storage.read()).toBe('stored-token')
  })

  it('signs out locally from the unavailable state and lands on login', async () => {
    stubFetch(() => {
      throw new TypeError('Failed to fetch')
    })
    const storage = memoryStorage('stored-token')
    const { user } = renderApp({ path: '/', storage })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Sign out' })).toBeDefined()
    })

    await user.click(screen.getByRole('button', { name: 'Sign out' }))

    await waitFor(() => {
      expect(currentPath()).toBe('/login')
    })
    expect(storage.read()).toBeNull()
  })

  it('sends a rejected stored token back to the login page', async () => {
    stubFetch(() => errorResponse(401, 'UNAUTHENTICATED'))
    const storage = memoryStorage('corrupted-token')
    renderApp({ path: '/wallets', storage })

    await waitFor(() => {
      expect(currentPath()).toBe('/login')
    })
    expect(storage.read()).toBeNull()
  })
})

describe('guest-only routes', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it.each(['/login', '/register'])(
    'redirects an authenticated visitor away from %s',
    async (path) => {
      stubFetch(() => jsonResponse({ data: USER }))
      renderApp({ path, storage: memoryStorage('stored-token') })

      await waitFor(() => {
        expect(currentPath()).toBe('/')
      })
      expect(screen.getByRole('heading', { name: 'Overview' })).toBeDefined()
    },
  )

  it('lets an anonymous visitor see the login page', async () => {
    stubFetch(() => jsonResponse({ data: USER }))
    renderApp({ path: '/login' })

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Sign in' })).toBeDefined()
    })
    expect(currentPath()).toBe('/login')
  })
})

describe('shell', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows the signed-in email and navigates between the placeholder sections', async () => {
    stubFetch(() => jsonResponse({ data: USER }))
    const { user } = renderApp({ path: '/', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Overview' })).toBeDefined()
    })
    expect(screen.getByText('ada@example.com')).toBeDefined()

    await user.click(screen.getByRole('link', { name: 'Wallets' }))
    expect(currentPath()).toBe('/wallets')

    await user.click(screen.getByRole('link', { name: 'Contracts' }))
    expect(currentPath()).toBe('/contracts')
  })

  it('signs out, revokes server side and returns to the login page', async () => {
    const calls: string[] = []
    stubFetch((url) => {
      calls.push(url)
      return url.endsWith('/auth/logout')
        ? jsonResponse({ data: { message: 'logged out' } })
        : jsonResponse({ data: USER })
    })
    const storage = memoryStorage('stored-token')
    const { user } = renderApp({ path: '/', storage })

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Overview' })).toBeDefined()
    })

    await user.click(screen.getByRole('button', { name: 'Sign out' }))

    await waitFor(() => {
      expect(currentPath()).toBe('/login')
    })
    expect(calls).toContain('/api/v1/auth/logout')
    expect(storage.read()).toBeNull()
  })

  it('still signs out locally and says so when the logout call fails', async () => {
    stubFetch((url) => {
      if (url.endsWith('/auth/logout')) {
        throw new TypeError('Failed to fetch')
      }
      return jsonResponse({ data: USER })
    })
    const storage = memoryStorage('stored-token')
    const { user } = renderApp({ path: '/', storage })

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Overview' })).toBeDefined()
    })

    await user.click(screen.getByRole('button', { name: 'Sign out' }))

    await waitFor(() => {
      expect(currentPath()).toBe('/login')
    })
    expect(storage.read()).toBeNull()
    expect(
      screen.getByText(/the server could not be reached to end the session/i),
    ).toBeDefined()
  })
})

describe('unknown paths', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders a public not-found page without redirecting to login', async () => {
    stubFetch(() => jsonResponse({ data: USER }))
    renderApp({ path: '/nowhere' })

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Page not found' })).toBeDefined()
    })
    expect(currentPath()).toBe('/nowhere')
  })
})
