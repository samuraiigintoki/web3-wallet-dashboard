import { screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { errorResponse, jsonResponse, stubFetch } from '../test/http.ts'
import { currentPath, renderApp } from '../test/renderApp.tsx'

const USER = { id: 5, email: 'ada@example.com', createdAt: '2026-10-06T12:00:00Z' }

// A Response body can be read once, so each call needs a fresh one.
const loginOk = (): Response =>
  jsonResponse({ data: { token: 'issued-token', expiresAt: '2026-10-13T00:00:00Z' } })

function stubLogin(loginResponse: () => Response) {
  return stubFetch((url) =>
    url.endsWith('/auth/login') ? loginResponse() : jsonResponse({ data: USER }),
  )
}

async function fillAndSubmit(
  user: ReturnType<typeof renderApp>['user'],
  email: string,
  password: string,
) {
  await user.type(screen.getByLabelText('Email'), email)
  await user.type(screen.getByLabelText('Password'), password)
  await user.click(screen.getByRole('button', { name: 'Sign in' }))
}

describe('login page', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('blocks a blank submit without calling the API', async () => {
    const fetchStub = stubLogin(loginOk)
    const { user } = renderApp({ path: '/login' })

    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(screen.getByText('Enter your email address.')).toBeDefined()
    expect(screen.getByText('Enter your password.')).toBeDefined()
    expect(fetchStub.mock).not.toHaveBeenCalled()
  })

  it('rejects an email with no @ before calling the API', async () => {
    const fetchStub = stubLogin(loginOk)
    const { user } = renderApp({ path: '/login' })

    await fillAndSubmit(user, 'ada-at-example', 'secret')

    expect(screen.getByText('Enter an email address that contains @.')).toBeDefined()
    expect(fetchStub.mock).not.toHaveBeenCalled()
  })

  it('sends the password exactly as typed, with no trimming', async () => {
    const fetchStub = stubLogin(loginOk)
    const { user } = renderApp({ path: '/login' })

    await fillAndSubmit(user, 'ada@example.com', '  spaced secret  ')

    await waitFor(() => {
      expect(currentPath()).toBe('/')
    })
    const loginCall = fetchStub.calls.find((call) => call.url.endsWith('/auth/login'))
    expect(JSON.parse(String(loginCall?.init.body))).toEqual({
      email: 'ada@example.com',
      password: '  spaced secret  ',
    })
  })

  it('stores the token and shows the shell on success', async () => {
    stubLogin(loginOk)
    const { user, storage } = renderApp({ path: '/login' })

    await fillAndSubmit(user, 'ada@example.com', 'secret')

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Overview' })).toBeDefined()
    })
    expect(storage.read()).toBe('issued-token')
  })

  it('shows the credential message on a 401 and keeps the user on the page', async () => {
    stubLogin(() => errorResponse(401, 'INVALID_CREDENTIALS'))
    const { user, storage } = renderApp({ path: '/login' })

    await fillAndSubmit(user, 'ada@example.com', 'wrong')

    await waitFor(() => {
      expect(
        screen.getByText('That email and password combination is not correct.'),
      ).toBeDefined()
    })
    expect(currentPath()).toBe('/login')
    expect(storage.read()).toBeNull()
  })

  it('announces the retry delay on a 429', async () => {
    stubLogin(() =>
      errorResponse(429, 'RATE_LIMITED', { headers: { 'Retry-After': '18' } }),
    )
    const { user } = renderApp({ path: '/login' })

    await fillAndSubmit(user, 'ada@example.com', 'secret')

    await waitFor(() => {
      expect(
        screen.getByText('Too many attempts. Please try again in 18 seconds.'),
      ).toBeDefined()
    })
  })

  it('announces errors through an alert region rather than colour alone', async () => {
    stubLogin(() => errorResponse(401, 'INVALID_CREDENTIALS'))
    const { user } = renderApp({ path: '/login' })

    await fillAndSubmit(user, 'ada@example.com', 'wrong')

    await waitFor(() => {
      const alerts = screen.getAllByRole('alert').map((node) => node.textContent)
      expect(alerts).toContain('That email and password combination is not correct.')
    })
  })

  it('renders a 422 detail at the named field', async () => {
    stubLogin(() =>
      errorResponse(422, 'VALIDATION_ERROR', {
        details: { email: 'must contain @' },
      }),
    )
    const { user } = renderApp({ path: '/login' })

    await fillAndSubmit(user, 'ada@example.com', 'secret')

    await waitFor(() => {
      expect(screen.getByText('must contain @')).toBeDefined()
    })
    expect(screen.getByLabelText('Email').getAttribute('aria-invalid')).toBe('true')
  })

  it('blocks a double submit while the request is pending', async () => {
    const deferred: { release: (() => void) | null } = { release: null }
    const fetchStub = stubFetch(
      (url) =>
        new Promise<Response>((resolve) => {
          deferred.release = () => {
            resolve(
              url.endsWith('/auth/login')
                ? jsonResponse({
                    data: { token: 'issued-token', expiresAt: '2026-10-13T00:00:00Z' },
                  })
                : jsonResponse({ data: USER }),
            )
          }
        }),
    )
    const { user } = renderApp({ path: '/login' })

    await user.type(screen.getByLabelText('Email'), 'ada@example.com')
    await user.type(screen.getByLabelText('Password'), 'secret')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    const button = screen.getByRole('button', { name: 'Signing in' })
    expect(button.hasAttribute('disabled')).toBe(true)

    await user.click(button)
    expect(fetchStub.mock).toHaveBeenCalledTimes(1)

    await waitFor(() => {
      expect(deferred.release).not.toBeNull()
    })
    deferred.release?.()
  })

  it('uses the correct autocomplete hints', async () => {
    stubLogin(loginOk)
    renderApp({ path: '/login' })

    expect(screen.getByLabelText('Email').getAttribute('autocomplete')).toBe('email')
    expect(screen.getByLabelText('Password').getAttribute('autocomplete')).toBe(
      'current-password',
    )
  })
})
