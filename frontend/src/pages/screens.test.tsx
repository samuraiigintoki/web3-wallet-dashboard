import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { emptyProxyFailure, errorResponse, jsonResponse, stubFetch } from '../test/http.ts'
import { currentPath, memoryStorage, renderApp } from '../test/renderApp.tsx'
import { AUTH_FACTS } from '../ui/authFacts.ts'
import { RestoringScreen } from './RestoringScreen.tsx'

const USER = { id: 5, email: 'ada@example.com', createdAt: '2026-10-06T12:00:00Z' }

describe('the frame', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows three labelled destinations and marks the one that is open', async () => {
    stubFetch(() => jsonResponse({ data: USER }))
    renderApp({ path: '/contracts', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Contracts' })).toBeDefined()
    })

    const nav = screen.getByRole('navigation', { name: 'Sections' })
    const links = Array.from(nav.querySelectorAll('a'))
    expect(links.map((link) => link.textContent)).toEqual(['Overview', 'Contracts', 'Wallets'])

    // The open destination is marked on the element that is actually open, and
    // the label is never carried by a shape alone.
    expect(links.map((link) => link.getAttribute('aria-current'))).toEqual([
      null,
      'page',
      null,
    ])
  })

  it('keeps the destination labels readable as text, with no icon-only control', async () => {
    stubFetch(() => jsonResponse({ data: USER }))
    renderApp({ path: '/', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Overview' })).toBeDefined()
    })

    const nav = screen.getByRole('navigation', { name: 'Sections' })
    expect(nav.querySelectorAll('svg, img')).toHaveLength(0)
    for (const label of ['Overview', 'Contracts', 'Wallets']) {
      expect(screen.getByRole('link', { name: label })).toBeDefined()
    }
  })
})

describe('the composed auth page', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('puts the form before the facts, and the facts in order', async () => {
    stubFetch(() => jsonResponse({ data: USER }))
    renderApp({ path: '/login' })

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Sign in to read the record.' })).toBeDefined()
    })

    const form = document.querySelector('form')
    const facts = screen.getByRole('list', { name: '' })
    expect(form).not.toBeNull()
    expect(facts).not.toBeNull()

    // The order is the composition: the form is reachable before anything has
    // to be read.
    const position = form!.compareDocumentPosition(facts!)
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    const items = Array.from(facts!.querySelectorAll('li')).map((item) => item.textContent)
    expect(items).toEqual([...AUTH_FACTS])
    expect(screen.getByRole('heading', { name: 'How this works' })).toBeDefined()
  })

  it('names the screen twice, on purpose, and offers the way to register', async () => {
    stubFetch(() => jsonResponse({ data: USER }))
    renderApp({ path: '/register' })

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'Create an account to read the record.' }),
      ).toBeDefined()
    })

    expect(document.title.startsWith('Create an account · ')).toBe(true)
    expect(screen.getByRole('link', { name: 'Sign in' })).toBeDefined()

    // The password warning belongs here, where a password is chosen.
    expect(screen.getByText(/There is no password reset/)).toBeDefined()
  })
})

describe('the restoring screen', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** A restore that never answers, so the screen stays put while it is read. */
  function pendingRestore() {
    return new Promise<Response>(() => {
      // Never settles: the check is still in flight for the whole test.
    })
  }

  it('shows shapes at once and the status in words only once the wait runs long', () => {
    vi.useFakeTimers()
    stubFetch(() => pendingRestore())
    renderApp({ path: '/', storage: memoryStorage('stored-token') })

    const status = screen.getByRole('status')
    expect(status.textContent).toBe('Restoring your session.')
    // Off screen at first: for a quick answer the shapes say enough.
    expect(status.className).toContain('srOnly')
    expect(screen.getByRole('main').getAttribute('aria-busy')).toBe('true')

    act(() => {
      vi.advanceTimersByTime(1999)
    })
    expect(screen.getByRole('status').className).toContain('srOnly')

    act(() => {
      vi.advanceTimersByTime(1)
    })

    // Visible now, and still the same single live region with the same words,
    // so nobody hears it twice.
    const shown = screen.getByRole('status')
    expect(shown.className).not.toContain('srOnly')
    expect(shown.textContent).toBe('Restoring your session.')
    expect(screen.getAllByRole('status')).toHaveLength(1)

    // Stated, not treated as a failure: no alert, no retry, no error styling.
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('clears its own timer when it unmounts', () => {
    // Mounted on its own: in the application a request that never settles
    // leaves the client's own timeout pending, and this test is about the
    // screen's timer, not that one.
    vi.useFakeTimers()
    const before = vi.getTimerCount()
    const view = render(<RestoringScreen />)

    expect(vi.getTimerCount()).toBe(before + 1)
    view.unmount()
    expect(vi.getTimerCount()).toBe(before)
  })

  it('clears the timer when a deferred answer finally lands', async () => {
    vi.useFakeTimers()
    let answer: ((response: Response) => void) | null = null
    stubFetch(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve
        }),
    )

    renderApp({ path: '/', storage: memoryStorage('stored-token') })

    act(() => {
      vi.advanceTimersByTime(2500)
    })
    expect(screen.getByRole('status').className).not.toContain('srOnly')

    await act(async () => {
      answer?.(jsonResponse({ data: USER }))
    })

    expect(screen.getByRole('heading', { name: 'Overview' })).toBeDefined()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('the unavailable screen', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('describes the failed check, the retained token and the unknown answer', async () => {
    stubFetch(() => {
      throw new TypeError('Failed to fetch')
    })
    renderApp({ path: '/', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined()
    })

    const text = document.body.textContent ?? ''
    // The three facts, and no claim the copy cannot support.
    expect(text).toContain('could not reach the API to check your session')
    expect(text).toContain('still stored on this device')
    expect(text).toMatch(/still accepts that token is unknown/)
    expect(text).toContain('Retry checks the session again')
    expect(text).toContain('Sign out clears this device')
    expect(text).not.toContain('nothing has been lost')
    expect(text).not.toMatch(/changes nothing/)
  })

  it('rechecks on Retry and lands on sign in when the server now rejects the token', async () => {
    let attempt = 0
    stubFetch(() => {
      attempt += 1
      return attempt === 1 ? emptyProxyFailure() : errorResponse(401, 'UNAUTHENTICATED')
    })

    const storage = memoryStorage('stored-token')
    const { user } = renderApp({ path: '/', storage })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined()
    })
    expect(storage.read()).toBe('stored-token')

    await user.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => {
      expect(currentPath()).toBe('/login')
    })
    // The rejected token is gone, which is why the copy does not promise that
    // retrying leaves the device untouched.
    expect(storage.read()).toBeNull()
  })
})
