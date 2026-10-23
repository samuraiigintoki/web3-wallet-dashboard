import { screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { User } from '../api/index.ts'
import { installFakeProvider, removeFakeProvider } from '../test/fakeProvider.ts'
import { errorResponse, jsonResponse, stubFetch, type FetchStub } from '../test/http.ts'
import { memoryStorage, renderApp } from '../test/renderApp.tsx'
import { createTokenStorage, SESSION_TOKEN_KEY } from '../auth/storage.ts'

/**
 * The panel as the user sees it, inside the authenticated shell.
 *
 * The provider is real in the sense that matters: it is an object on
 * `window.ethereum`, read by production code. The backend is stubbed, because
 * what this screen does with the API is one public catalog read and no
 * credential of any kind.
 */

const USER: User = { id: 5, email: 'ada@example.com', createdAt: '2026-10-06T12:00:00Z' }
const ACCOUNT = '0x1e1D0e1D0e1D0e1D0e1D0e1D0e1D0e1D0e1D0e1D'
const OTHER = '0x2e2E2e2E2e2E2e2E2e2E2e2E2e2E2e2E2e2E2e2E'

const SEPOLIA = { chainId: 11155111, name: 'Sepolia', symbol: 'ETH', isTestnet: true }

function apiFetch(chains: () => Response = () => jsonResponse({ data: [SEPOLIA] })): FetchStub {
  return stubFetch((url: string) => {
    if (url.includes('/users/me')) {
      return jsonResponse({ data: USER })
    }

    if (url.includes('/chains')) {
      return chains()
    }

    throw new Error(`unexpected request: ${url}`)
  })
}

function panel(): HTMLElement {
  return screen.getByRole('region', { name: 'Browser wallet' })
}

function status(): string {
  return within(panel()).getByRole('status').textContent ?? ''
}

function button(name: string): HTMLButtonElement | null {
  return within(panel()).queryByRole('button', { name }) as HTMLButtonElement | null
}

afterEach(() => {
  removeFakeProvider()
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

describe('browser wallet panel', () => {
  it('says no wallet was found, without throwing or asking for one', async () => {
    const fetchStub = apiFetch()

    renderApp({ path: '/', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(status()).toContain('No browser wallet was found in this browser.')
    })

    expect(button('Connect wallet')).toBeNull()
    expect(fetchStub.calls.some((call) => call.url.includes('/chains'))).toBe(false)
  })

  it('shows the account and the catalog name of the chain the provider reports', async () => {
    installFakeProvider({
      answer: ({ method }) => {
        if (method === 'eth_accounts') {
          return [ACCOUNT]
        }
        if (method === 'eth_chainId') {
          return '0xaa36a7'
        }
        throw new Error('the page load must not call anything else')
      },
    })
    const fetchStub = apiFetch()

    renderApp({ path: '/', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(status()).toContain('Connected to a browser wallet.')
    })

    await waitFor(() => {
      expect(within(panel()).getByText('Sepolia')).toBeDefined()
    })

    expect(within(panel()).getByText(ACCOUNT)).toBeDefined()
    expect(within(panel()).getByText('11155111')).toBeDefined()

    // The chain name came from the app's own catalog, and the catalog read
    // carried no credential even though a session exists.
    const chainCall = fetchStub.calls.find((call) => call.url.includes('/chains'))
    expect(chainCall).toBeDefined()
    expect(new Headers(chainCall?.init.headers).get('authorization')).toBeNull()
  })

  it('calls a chain the catalog does not list unsupported, and still shows it', async () => {
    installFakeProvider({
      answer: ({ method }) => {
        if (method === 'eth_accounts') {
          return [ACCOUNT]
        }
        if (method === 'eth_chainId') {
          return '0x89'
        }
        throw new Error('unexpected method')
      },
    })
    apiFetch()

    renderApp({ path: '/', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(status()).toContain('which this app does not list')
    })

    expect(status()).toContain('137')
    expect(within(panel()).getByText('137')).toBeDefined()
    expect(within(panel()).getByText("Not in this app's chain catalog")).toBeDefined()
  })

  it('does not judge the chain when the catalog cannot be read', async () => {
    installFakeProvider({
      answer: ({ method }) => {
        if (method === 'eth_accounts') {
          return [ACCOUNT]
        }
        if (method === 'eth_chainId') {
          return '0x89'
        }
        throw new Error('unexpected method')
      },
    })
    apiFetch(() => errorResponse(503, 'SERVICE_UNAVAILABLE'))

    renderApp({ path: '/', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(within(panel()).getByText('Not read')).toBeDefined()
    })

    expect(status()).toBe('Connected to a browser wallet.')
    expect(within(panel()).getByText(/chain catalog could not be read/)).toBeDefined()
    expect(within(panel()).queryByText(/does not list/)).toBeNull()
  })

  it('connects only when the button is pressed', async () => {
    let granted = false
    const provider = installFakeProvider({
      answer: ({ method }) => {
        if (method === 'eth_requestAccounts') {
          granted = true
          return [ACCOUNT]
        }
        if (method === 'eth_accounts') {
          return granted ? [ACCOUNT] : []
        }
        if (method === 'eth_chainId') {
          return '0x1'
        }
        throw new Error('unexpected method')
      },
    })
    apiFetch()

    const { user } = renderApp({ path: '/', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(status()).toContain('Not connected to a browser wallet.')
    })

    expect(provider.requested).not.toContain('eth_requestAccounts')

    await user.click(button('Connect wallet')!)

    await waitFor(() => {
      expect(status()).toContain('Connected to a browser wallet.')
    })

    expect(provider.requested).toContain('eth_requestAccounts')
    expect(within(panel()).getByText(ACCOUNT)).toBeDefined()
  })

  it('follows the provider changing account and chain', async () => {
    let accounts = [ACCOUNT]
    let chain = '0x1'
    const provider = installFakeProvider({
      answer: ({ method }) => (method === 'eth_accounts' ? accounts : chain),
    })
    apiFetch()

    renderApp({ path: '/', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(within(panel()).getByText(ACCOUNT)).toBeDefined()
    })

    accounts = [OTHER]

    await waitFor(() => {
      provider.emit('accountsChanged', [OTHER])
      expect(within(panel()).getByText(OTHER)).toBeDefined()
    })

    chain = '0xaa36a7'
    provider.emit('chainChanged', '0xaa36a7')

    await waitFor(() => {
      expect(within(panel()).getByText('Sepolia')).toBeDefined()
    })

    // An empty list clears the account rather than leaving the last one up.
    provider.emit('accountsChanged', [])

    await waitFor(() => {
      expect(status()).toContain('Not connected to a browser wallet.')
    })

    expect(within(panel()).queryByText(OTHER)).toBeNull()
  })

  it('leaves the app session and its credential alone', async () => {
    let granted = false
    const provider = installFakeProvider({
      answer: ({ method }) => {
        if (method === 'eth_requestAccounts') {
          granted = true
          return [ACCOUNT]
        }
        if (method === 'eth_accounts') {
          return granted ? [ACCOUNT] : []
        }
        return '0x1'
      },
    })
    const fetchStub = apiFetch()

    window.localStorage.clear()
    const storage = createTokenStorage(() => window.localStorage)
    storage.write('stored-token')

    const { user } = renderApp({ path: '/', storage })

    await waitFor(() => {
      expect(screen.getByText('ada@example.com')).toBeDefined()
    })

    await waitFor(() => {
      expect(button('Connect wallet')).not.toBeNull()
    })

    const authCallsBefore = fetchStub.calls.filter((call) => call.url.includes('/auth/')).length

    await user.click(button('Connect wallet')!)

    await waitFor(() => {
      expect(within(panel()).getByText(ACCOUNT)).toBeDefined()
    })

    provider.emit('accountsChanged', [OTHER])
    provider.emit('chainChanged', '0x89')
    provider.emit('disconnect')

    await waitFor(() => {
      expect(status()).toContain('Not connected to a browser wallet.')
    })

    // Same credential, same session, and no auth call made on any of it.
    expect(storage.read()).toBe('stored-token')
    expect(window.localStorage.getItem(SESSION_TOKEN_KEY)).toBe('stored-token')
    expect(screen.getByText('ada@example.com')).toBeDefined()
    expect(fetchStub.calls.filter((call) => call.url.includes('/auth/')).length).toBe(authCallsBefore)
    expect(fetchStub.calls.filter((call) => call.url.includes('/users/me')).length).toBe(1)
  })
})
