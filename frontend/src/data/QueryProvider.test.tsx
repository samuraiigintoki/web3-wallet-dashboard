import { act, screen, waitFor } from '@testing-library/react'
import { QueryClient } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { errorResponse, jsonResponse, pendingResponse, stubFetch } from '../test/http.ts'
import { otherTabStores } from '../test/crossTab.ts'
import { createTokenStorage, SESSION_TOKEN_KEY } from '../auth/storage.ts'
import { currentPath, renderApp } from '../test/renderApp.tsx'
import { PAGE_SIZE } from '../wallets/page.ts'

const TOKEN_A = 'token-a'
const TOKEN_B = 'token-b'
const TOKEN_A_REPLACEMENT = 'token-a-again'

const USER_A = { id: 5, email: 'ada@example.com', createdAt: '2026-10-06T12:00:00Z' }
const USER_B = { id: 9, email: 'grace@example.com', createdAt: '2026-10-07T12:00:00Z' }

const WALLET_A = {
  id: 7,
  address: '0x00000000000000000000000000000000000000a1',
  chainId: 11155111,
  label: 'Ada primary',
  createdAt: '2026-10-01T10:00:00Z',
}

const WALLET_B = {
  id: 21,
  address: '0x00000000000000000000000000000000000000b2',
  chainId: 11155111,
  label: 'Grace primary',
  createdAt: '2026-10-02T11:30:00Z',
}

const WALLET_STALE = {
  id: 99,
  address: '0x0000000000000000000000000000000000000099',
  chainId: 11155111,
  label: 'Superseded page',
  createdAt: '2026-10-03T09:00:00Z',
}

const ONE_PAGE = { page: 1, pageSize: PAGE_SIZE, totalItems: 1, totalPages: 1 }

function pageResponse(wallets: unknown[], pagination: Record<string, number> = ONE_PAGE) {
  return jsonResponse({ data: wallets, pagination })
}

function tokenOf(init: RequestInit): string {
  return (new Headers(init.headers).get('authorization') ?? '').replace('Bearer ', '')
}

function userForToken(token: string) {
  return token === TOKEN_B ? USER_B : USER_A
}

function button(name: string): HTMLButtonElement {
  return screen.getByRole('button', { name }) as HTMLButtonElement
}

/**
 * A client whose entries nothing but the identity transition can collect: the
 * default collection window is long, so a missing entry means it was removed.
 */
function inspectableClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 60_000 } } })
}

/** Starts this tab on a credential the real shared store already holds. */
function storageHolding(token: string) {
  window.localStorage.setItem(SESSION_TOKEN_KEY, token)
  return createTokenStorage()
}

/**
 * Lets released promises settle and React render without asserting anything, so
 * a later "this is not on screen" means the answer was discarded and not merely
 * not processed yet.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('identity-bound wallet data', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    window.localStorage.clear()
  })

  it('makes no wallet request until the identity has been validated', async () => {
    const held = pendingResponse<Response>()
    let walletCalls = 0

    stubFetch((url) => {
      if (url.includes('/users/me')) {
        return held.promise
      }
      walletCalls += 1
      return pageResponse([])
    })

    const storage = storageHolding(TOKEN_A)
    renderApp({ path: '/wallets', storage })

    await waitFor(() => {
      expect(screen.getByText('Restoring your session.')).toBeDefined()
    })
    expect(walletCalls).toBe(0)

    held.resolve(jsonResponse({ data: USER_A }))

    await waitFor(() => {
      expect(walletCalls).toBe(1)
    })
  })

  it('shows the new account and never shows a row the previous session loaded', async () => {
    const lateA = pendingResponse<Response>()
    const lateB = pendingResponse<Response>()
    let walletCalls = 0

    stubFetch((url, init) => {
      if (url.includes('/users/me')) {
        return jsonResponse({ data: userForToken(tokenOf(init)) })
      }

      walletCalls += 1
      return walletCalls === 1 ? lateA.promise : lateB.promise
    })

    const storage = storageHolding(TOKEN_A)
    renderApp({ path: '/wallets', storage })

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('Loading wallets')
    })

    // Another tab signs in as another account while this read is still open.
    otherTabStores(TOKEN_B)

    await waitFor(() => {
      expect(screen.getByText(USER_B.email)).toBeDefined()
    })
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('Loading wallets')
    })
    // The replacement is loading, and nothing from the old account is on screen.
    expect(screen.queryByText(WALLET_A.label)).toBeNull()

    lateB.resolve(pageResponse([WALLET_B]))

    await waitFor(() => {
      expect(screen.getByText(WALLET_B.label)).toBeDefined()
    })

    // The superseded answer arrives now, for an identity nobody is presenting.
    lateA.resolve(pageResponse([WALLET_A]))
    await settle()

    expect(screen.queryByText(WALLET_A.label)).toBeNull()
    expect(screen.getByText(WALLET_B.label)).toBeDefined()
  })

  it('sends each wallet request with the credential of the identity it belongs to', async () => {
    const lateA = pendingResponse<Response>()
    let walletCalls = 0
    const sentTokens: string[] = []

    stubFetch((url, init) => {
      if (url.includes('/users/me')) {
        return jsonResponse({ data: userForToken(tokenOf(init)) })
      }

      walletCalls += 1
      sentTokens.push(tokenOf(init))
      return walletCalls === 1 ? lateA.promise : pageResponse([WALLET_B])
    })

    renderApp({ path: '/wallets', storage: storageHolding(TOKEN_A) })

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('Loading wallets')
    })

    otherTabStores(TOKEN_B)

    await waitFor(() => {
      expect(screen.getByText(WALLET_B.label)).toBeDefined()
    })

    expect(sentTokens).toEqual([TOKEN_A, TOKEN_B])
    lateA.resolve(pageResponse([WALLET_A]))
    await settle()
  })

  it('keeps the new session signed in when a late 401 from the old credential arrives', async () => {
    const lateA = pendingResponse<Response>()
    let walletCalls = 0

    stubFetch((url, init) => {
      if (url.includes('/users/me')) {
        return jsonResponse({ data: userForToken(tokenOf(init)) })
      }

      walletCalls += 1
      return walletCalls === 1 ? lateA.promise : pageResponse([WALLET_B])
    })

    const storage = storageHolding(TOKEN_A)
    renderApp({ path: '/wallets', storage })

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('Loading wallets')
    })

    otherTabStores(TOKEN_B)

    await waitFor(() => {
      expect(screen.getByText(WALLET_B.label)).toBeDefined()
    })

    // A 401 describing a credential this tab no longer holds: it belongs to a
    // session nobody is using, so it must not end the one that is.
    lateA.resolve(errorResponse(401, 'UNAUTHENTICATED'))
    await settle()

    expect(currentPath()).toBe('/wallets')
    expect(window.localStorage.getItem(SESSION_TOKEN_KEY)).toBe(TOKEN_B)
    expect(screen.getByText(WALLET_B.label)).toBeDefined()
  })

  it('treats a new credential for the same user as a new identity', async () => {
    const stale = pendingResponse<Response>()
    let walletCalls = 0
    const sentTokens: string[] = []

    stubFetch((url, init) => {
      // Same account, new credential: /users/me answers for both.
      if (url.includes('/users/me')) {
        return jsonResponse({ data: USER_A })
      }

      walletCalls += 1
      sentTokens.push(tokenOf(init))
      return walletCalls === 1 ? stale.promise : pageResponse([WALLET_A])
    })

    const storage = storageHolding(TOKEN_A)
    renderApp({ path: '/wallets', storage })

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('Loading wallets')
    })

    otherTabStores(TOKEN_A_REPLACEMENT)

    await waitFor(() => {
      expect(screen.getByText(WALLET_A.label)).toBeDefined()
    })
    expect(sentTokens).toEqual([TOKEN_A, TOKEN_A_REPLACEMENT])

    // The first read's answer describes the same user under the old credential.
    stale.resolve(pageResponse([WALLET_STALE], { ...ONE_PAGE, totalItems: 1, totalPages: 1 }))
    await settle()

    expect(screen.queryByText(WALLET_STALE.label)).toBeNull()
    expect(screen.getByText(WALLET_A.label)).toBeDefined()
  })

  /**
   * The gap this covers: clearing the credential and going anonymous is not the
   * same as ending the identity. Without retiring the generation and dropping
   * the data capability, the query layer never learns the session is gone, so
   * the pages it owns stay in the cache and a read still running keeps running.
   *
   * The client is built with a long collection window, so nothing but the
   * identity transition can explain a missing entry.
   */
  it('retires the data identity when the credential this tab uses is rejected', async () => {
    const queryClient = inspectableClient()
    const heldPageTwo = pendingResponse<Response>()
    let walletCalls = 0

    stubFetch((url, init) => {
      if (url.includes('/users/me')) {
        return jsonResponse({ data: userForToken(tokenOf(init)) })
      }

      walletCalls += 1
      return walletCalls === 1
        ? pageResponse([WALLET_A], {
            page: 1,
            pageSize: PAGE_SIZE,
            totalItems: 21,
            totalPages: 2,
          })
        : heldPageTwo.promise
    })

    const storage = storageHolding(TOKEN_A)
    const { user } = renderApp({ path: '/wallets', storage, queryClient })

    await waitFor(() => {
      expect(screen.getByText(WALLET_A.label)).toBeDefined()
    })
    expect(queryClient.getQueryCache().getAll()).toHaveLength(1)

    // A second protected read on the same identity, still open.
    await user.click(button('Next'))
    await waitFor(() => {
      expect(walletCalls).toBe(2)
    })

    // The API rejects the credential this tab is actually using.
    heldPageTwo.resolve(errorResponse(401, 'UNAUTHENTICATED'))

    await waitFor(() => {
      expect(currentPath()).toBe('/login')
    })
    expect(storage.read()).toBeNull()

    // Both pages are gone, not just unreachable, and no read was started for a
    // session that no longer exists.
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0)
    await settle()
    expect(walletCalls).toBe(2)
  })

  it('drops the cached page when the session ends', async () => {
    const stale = pendingResponse<Response>()
    let walletCalls = 0

    stubFetch((url, init) => {
      if (url.includes('/users/me')) {
        return jsonResponse({ data: userForToken(tokenOf(init)) })
      }
      if (url.includes('/auth/logout')) {
        return jsonResponse({ data: { message: 'signed out' } })
      }

      walletCalls += 1
      return walletCalls === 1 ? pageResponse([WALLET_A]) : stale.promise
    })

    const storage = storageHolding(TOKEN_A)
    const { user } = renderApp({ path: '/wallets', storage })

    await waitFor(() => {
      expect(screen.getByText(WALLET_A.label)).toBeDefined()
    })
    expect(walletCalls).toBe(1)

    await user.click(screen.getByRole('button', { name: 'Sign out' }))

    await waitFor(() => {
      expect(currentPath()).toBe('/login')
    })

    // Back in as the other account: the page is fetched again, and the row the
    // previous session left in the cache is gone with it.
    otherTabStores(TOKEN_B)
    stale.resolve(pageResponse([WALLET_B]))

    await waitFor(() => {
      expect(screen.getByText(WALLET_B.label)).toBeDefined()
    })
    expect(screen.queryByText(WALLET_A.label)).toBeNull()
    expect(walletCalls).toBe(2)
  })
})
