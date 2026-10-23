import { screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { User } from '../api/index.ts'
import { deferred, installFakeProvider, removeFakeProvider } from '../test/fakeProvider.ts'
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

/**
 * The panel's own state line.
 *
 * Scoped rather than global: the balance value has a live region of its own, and
 * a test that asked for "the" status could match either.
 */
function status(): string {
  const line = panel().querySelector(':scope > p[role="status"]')

  return line?.textContent ?? ''
}

function balanceText(): string {
  return panel().querySelector('.browser-wallet__facts')?.textContent ?? ''
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

  it('comes back with a usable control when the chain moves during the load', async () => {
    const accounts = deferred<string[]>()
    const provider = installFakeProvider({
      answer: ({ method }) => (method === 'eth_accounts' ? accounts.promise : '0x1'),
    })
    apiFetch()

    renderApp({ path: '/', storage: memoryStorage('stored-token') })

    // The load is still out, and the wallet announces a chain it has moved to.
    await waitFor(() => {
      expect(status()).toContain('Checking this browser for a wallet.')
    })

    provider.emit('chainChanged', '0x89')

    accounts.resolve([])

    // The screen settles on an answer, and the control a user needs is there.
    await waitFor(() => {
      expect(status()).toContain('Not connected to a browser wallet.')
    })

    expect(button('Connect wallet')).not.toBeNull()
    expect(status()).not.toContain('Checking')
  })

  it('shows the exact balance as wei for a chain the catalog lists', async () => {
    installFakeProvider({
      answer: ({ method }) => {
        if (method === 'eth_accounts') {
          return [ACCOUNT]
        }
        if (method === 'eth_chainId') {
          return '0xaa36a7'
        }
        if (method === 'eth_getBalance') {
          return '0xde0b6b3a7640000'
        }
        throw new Error(`unexpected method: ${method}`)
      },
    })
    const fetchStub = apiFetch(() => jsonResponse({ data: [SEPOLIA] }))

    renderApp({ path: '/', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(balanceText()).toContain('1000000000000000000 wei')
    })

    // The read happened in the browser: the balance itself never became an API
    // call, and no wallet or auth route was touched.
    expect(fetchStub.calls.filter((call) => call.url.includes('getBalance'))).toEqual([])
    expect(fetchStub.calls.filter((call) => call.url.includes('/wallets'))).toEqual([])
    expect(fetchStub.calls.filter((call) => call.url.includes('/auth/'))).toEqual([])
  })

  it('does not ask for a balance on a chain the catalog does not list', async () => {
    const provider = installFakeProvider({
      answer: ({ method }) => {
        if (method === 'eth_accounts') {
          return [ACCOUNT]
        }
        if (method === 'eth_chainId') {
          return '0x89'
        }
        throw new Error(`unexpected method: ${method}`)
      },
    })
    apiFetch()

    renderApp({ path: '/', storage: memoryStorage('stored-token') })

    // The chain name settles first: the gate reads the catalog, so waiting for
    // the balance alone would catch it while the catalog was still out.
    await waitFor(() => {
      expect(balanceText()).toContain("Not in this app's chain catalog")
    })

    expect(balanceText()).toContain('Not read.')
    expect(balanceText()).toContain('does not list the chain')
    expect(provider.requested).not.toContain('eth_getBalance')
  })

  it('does not ask for a balance when the catalog cannot be read', async () => {
    const provider = installFakeProvider({
      answer: ({ method }) => {
        if (method === 'eth_accounts') {
          return [ACCOUNT]
        }
        if (method === 'eth_chainId') {
          return '0xaa36a7'
        }
        throw new Error(`unexpected method: ${method}`)
      },
    })
    apiFetch(() => errorResponse(503, 'SERVICE_UNAVAILABLE'))

    renderApp({ path: '/', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(balanceText()).toContain('Not read.')
    })

    // The reason names the catalog, whether the first attempt is still out or the
    // query has given up: either way this app has no chain facts and says so
    // rather than showing a figure it could not place.
    expect(balanceText()).toMatch(/chain catalog/)
    expect(balanceText()).not.toMatch(/wei/)
    expect(provider.requested).not.toContain('eth_getBalance')
  })

  it('states a failed balance read, and retries it on request', async () => {
    let reads = 0
    installFakeProvider({
      answer: ({ method }) => {
        if (method === 'eth_accounts') {
          return [ACCOUNT]
        }
        if (method === 'eth_chainId') {
          return '0xaa36a7'
        }
        if (method === 'eth_getBalance') {
          reads += 1
          if (reads === 1) {
            throw { code: -32603, message: 'boom' }
          }
          return '0x1'
        }
        throw new Error(`unexpected method: ${method}`)
      },
    })
    apiFetch()

    const { user } = renderApp({ path: '/', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(balanceText()).toContain('The balance could not be read.')
    })

    expect(balanceText()).toContain('-32603')
    expect(balanceText()).not.toContain('boom')

    await user.click(button('Read the balance again')!)

    await waitFor(() => {
      expect(balanceText()).toContain('1 wei')
    })

    expect(reads).toBe(2)
  })

  it('never displays a held balance for the account the wallet has left', async () => {
    const held = deferred<string>()
    let reads = 0
    const provider = installFakeProvider({
      answer: ({ method }) => {
        if (method === 'eth_accounts') {
          return [ACCOUNT]
        }
        if (method === 'eth_chainId') {
          return '0xaa36a7'
        }
        if (method === 'eth_getBalance') {
          reads += 1
          // The first account's read never finishes in time; the second answers.
          return reads === 1 ? held.promise : '0x2'
        }
        throw new Error(`unexpected method: ${method}`)
      },
    })
    apiFetch()

    renderApp({ path: '/', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(reads).toBe(1)
    })

    provider.emit('accountsChanged', [OTHER])

    await waitFor(() => {
      expect(balanceText()).toContain('2 wei')
    })

    held.resolve('0xde0b6b3a7640000')

    await waitFor(() => {
      expect(balanceText()).toContain('2 wei')
    })

    expect(balanceText()).not.toContain('1000000000000000000')
  })

  it('shows the balance as not read once the wallet disconnects', async () => {
    const provider = installFakeProvider({
      answer: ({ method }) => {
        if (method === 'eth_accounts') {
          return [ACCOUNT]
        }
        if (method === 'eth_chainId') {
          return '0xaa36a7'
        }
        if (method === 'eth_getBalance') {
          return '0xde0b6b3a7640000'
        }
        throw new Error(`unexpected method: ${method}`)
      },
    })
    apiFetch()

    renderApp({ path: '/', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(balanceText()).toContain('1000000000000000000 wei')
    })

    provider.emit('accountsChanged', [])

    await waitFor(() => {
      expect(status()).toContain('Not connected to a browser wallet.')
    })

    expect(balanceText()).toBe('')
    expect(within(panel()).queryByText(/wei/)).toBeNull()
  })

  it('writes nothing to the API while it reads a balance, and keeps the credential', async () => {
    installFakeProvider({
      answer: ({ method }) => {
        if (method === 'eth_accounts') {
          return [ACCOUNT]
        }
        if (method === 'eth_chainId') {
          return '0xaa36a7'
        }
        if (method === 'eth_getBalance') {
          return '0xde0b6b3a7640000'
        }
        throw new Error(`unexpected method: ${method}`)
      },
    })
    const fetchStub = apiFetch()

    window.localStorage.clear()
    const storage = createTokenStorage(() => window.localStorage)
    storage.write('stored-token')

    renderApp({ path: '/', storage })

    await waitFor(() => {
      expect(balanceText()).toContain('1000000000000000000 wei')
    })

    const writes = fetchStub.calls.filter((call) => {
      const method = call.init.method ?? 'GET'
      return method !== 'GET'
    })

    expect(writes).toEqual([])
    expect(storage.read()).toBe('stored-token')
    expect(window.localStorage.getItem(SESSION_TOKEN_KEY)).toBe('stored-token')
    expect(screen.getByText('ada@example.com')).toBeDefined()
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
