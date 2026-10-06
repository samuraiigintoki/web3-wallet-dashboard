import { screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { errorResponse, jsonResponse, stubFetch } from '../test/http.ts'
import { currentPath, renderApp } from '../test/renderApp.tsx'

const USER = { id: 9, email: 'grace@example.com', createdAt: '2026-10-06T12:00:00Z' }

function stubRegister(registerResponse: () => Response) {
  return stubFetch((url) =>
    url.endsWith('/auth/register') ? registerResponse() : jsonResponse({ data: USER }),
  )
}

async function fill(
  user: ReturnType<typeof renderApp>['user'],
  values: { email: string; password: string; confirmation: string },
) {
  await user.type(screen.getByLabelText('Email'), values.email)
  await user.type(screen.getByLabelText('Password'), values.password)
  await user.type(screen.getByLabelText('Confirm password'), values.confirmation)
}

describe('register page', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends the account to /login with a notice and the email prefilled', async () => {
    stubRegister(() => jsonResponse({ data: USER }, { status: 201 }))
    const { user, storage } = renderApp({ path: '/register' })

    await fill(user, {
      email: 'grace@example.com',
      password: 'a good password',
      confirmation: 'a good password',
    })
    await user.click(screen.getByRole('button', { name: 'Create account' }))

    await waitFor(() => {
      expect(currentPath()).toBe('/login')
    })
    expect(
      screen.getByText('Your account is ready. Sign in to continue.'),
    ).toBeDefined()
    expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe(
      'grace@example.com',
    )
    // No auto-login: register issues no token, so nothing is stored.
    expect(storage.read()).toBeNull()
  })

  it('never prefills the password on the login page', async () => {
    stubRegister(() => jsonResponse({ data: USER }, { status: 201 }))
    const { user } = renderApp({ path: '/register' })

    await fill(user, {
      email: 'grace@example.com',
      password: 'a good password',
      confirmation: 'a good password',
    })
    await user.click(screen.getByRole('button', { name: 'Create account' }))

    await waitFor(() => {
      expect(currentPath()).toBe('/login')
    })
    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('')
  })

  it('blocks submit on a confirm-password mismatch and calls nothing', async () => {
    const fetchStub = stubRegister(() => jsonResponse({ data: USER }, { status: 201 }))
    const { user } = renderApp({ path: '/register' })

    await fill(user, {
      email: 'grace@example.com',
      password: 'a good password',
      confirmation: 'a typo password',
    })
    await user.click(screen.getByRole('button', { name: 'Create account' }))

    expect(screen.getByText('The two passwords do not match.')).toBeDefined()
    expect(fetchStub.mock).not.toHaveBeenCalled()
    expect(currentPath()).toBe('/register')
  })

  it('never puts the confirmation in the request body', async () => {
    const fetchStub = stubRegister(() => jsonResponse({ data: USER }, { status: 201 }))
    const { user } = renderApp({ path: '/register' })

    await fill(user, {
      email: 'grace@example.com',
      password: 'a good password',
      confirmation: 'a good password',
    })
    await user.click(screen.getByRole('button', { name: 'Create account' }))

    await waitFor(() => {
      expect(fetchStub.mock).toHaveBeenCalled()
    })
    const body = fetchStub.body()
    expect(body).toEqual({ email: 'grace@example.com', password: 'a good password' })
    expect(Object.keys(body as Record<string, unknown>)).toEqual(['email', 'password'])
  })

  it('sends the password untrimmed', async () => {
    const fetchStub = stubRegister(() => jsonResponse({ data: USER }, { status: 201 }))
    const { user } = renderApp({ path: '/register' })

    await fill(user, {
      email: 'grace@example.com',
      password: ' padded ',
      confirmation: ' padded ',
    })
    await user.click(screen.getByRole('button', { name: 'Create account' }))

    await waitFor(() => {
      expect(fetchStub.mock).toHaveBeenCalled()
    })
    expect(fetchStub.body()).toEqual({
      email: 'grace@example.com',
      password: ' padded ',
    })
  })

  it('rejects a password over 72 UTF-8 bytes before calling the API', async () => {
    const fetchStub = stubRegister(() => jsonResponse({ data: USER }, { status: 201 }))
    const { user } = renderApp({ path: '/register' })

    // 37 two-byte characters is 74 bytes but only 37 characters, so a
    // string-length check would let it through.
    const tooLong = 'é'.repeat(37)
    await fill(user, {
      email: 'grace@example.com',
      password: tooLong,
      confirmation: tooLong,
    })
    await user.click(screen.getByRole('button', { name: 'Create account' }))

    expect(screen.getByText('Your password must be 72 bytes or fewer.')).toBeDefined()
    expect(fetchStub.mock).not.toHaveBeenCalled()
  })

  it('accepts a password of exactly 72 bytes', async () => {
    const fetchStub = stubRegister(() => jsonResponse({ data: USER }, { status: 201 }))
    const { user } = renderApp({ path: '/register' })

    const exact = 'é'.repeat(36)
    await fill(user, {
      email: 'grace@example.com',
      password: exact,
      confirmation: exact,
    })
    await user.click(screen.getByRole('button', { name: 'Create account' }))

    await waitFor(() => {
      expect(fetchStub.mock).toHaveBeenCalled()
    })
  })

  it('shows the conflict message on a 409', async () => {
    stubRegister(() => errorResponse(409, 'USER_CONFLICT'))
    const { user } = renderApp({ path: '/register' })

    await fill(user, {
      email: 'grace@example.com',
      password: 'a good password',
      confirmation: 'a good password',
    })
    await user.click(screen.getByRole('button', { name: 'Create account' }))

    await waitFor(() => {
      expect(screen.getByText('That email is already registered.')).toBeDefined()
    })
    expect(currentPath()).toBe('/register')
  })

  it('renders a 422 detail at the named field', async () => {
    stubRegister(() =>
      errorResponse(422, 'VALIDATION_ERROR', {
        details: { password: 'password exceeds maximum allowed length of 72 bytes' },
      }),
    )
    const { user } = renderApp({ path: '/register' })

    await fill(user, {
      email: 'grace@example.com',
      password: 'a good password',
      confirmation: 'a good password',
    })
    await user.click(screen.getByRole('button', { name: 'Create account' }))

    await waitFor(() => {
      expect(
        screen.getByText('password exceeds maximum allowed length of 72 bytes'),
      ).toBeDefined()
    })
    expect(screen.getByLabelText('Password').getAttribute('aria-invalid')).toBe('true')
  })

  it('blocks a double submit while the request is pending', async () => {
    const deferred: { release: (() => void) | null } = { release: null }
    const fetchStub = stubFetch(
      () =>
        new Promise<Response>((resolve) => {
          deferred.release = () => {
            resolve(jsonResponse({ data: USER }, { status: 201 }))
          }
        }),
    )
    const { user } = renderApp({ path: '/register' })

    await fill(user, {
      email: 'grace@example.com',
      password: 'a good password',
      confirmation: 'a good password',
    })
    await user.click(screen.getByRole('button', { name: 'Create account' }))

    const button = screen.getByRole('button', { name: 'Creating account' })
    expect(button.hasAttribute('disabled')).toBe(true)

    await user.click(button)
    expect(fetchStub.mock).toHaveBeenCalledTimes(1)

    await waitFor(() => {
      expect(deferred.release).not.toBeNull()
    })
    deferred.release?.()
  })

  it('uses the new-password autocomplete hint on both password inputs', () => {
    stubRegister(() => jsonResponse({ data: USER }, { status: 201 }))
    renderApp({ path: '/register' })

    expect(screen.getByLabelText('Password').getAttribute('autocomplete')).toBe(
      'new-password',
    )
    expect(screen.getByLabelText('Confirm password').getAttribute('autocomplete')).toBe(
      'new-password',
    )
  })
})
