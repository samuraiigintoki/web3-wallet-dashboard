import { screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { User } from '../api/index.ts'
import { deferred, installFakeProvider, removeFakeProvider } from '../test/fakeProvider.ts'
import { errorResponse, jsonResponse, stubFetch, type FetchStub } from '../test/http.ts'
import { memoryStorage, renderApp } from '../test/renderApp.tsx'
import { MULTISIG_ADDRESS, SELECTOR_GET_OWNERS, SELECTOR_THRESHOLD, SELECTOR_TRANSACTION_COUNT } from './multisig.ts'

/**
 * The multisig area as the user sees it, inside the authenticated app.
 *
 * The provider is the object on `window.ethereum` that production code reads, so
 * these tests exercise the same path a wallet takes, including the chain the
 * wallet reports and the catalog the app fetches.
 */

const USER: User = { id: 5, email: 'ada@example.com', createdAt: '2026-10-06T12:00:00Z' }
const ACCOUNT = '0x1e1D0e1D0e1D0e1D0e1D0e1D0e1D0e1D0e1D0e1D'
const OWNER = '0x14912965632cd9ab70c046e8d23e9b8dfa9f2746'

const SEPOLIA = { chainId: 11155111, name: 'Sepolia', symbol: 'ETH', isTestnet: true }
const ETHEREUM = { chainId: 1, name: 'Ethereum', symbol: 'ETH', isTestnet: false }

function word(hex: string): string {
  return hex.padStart(64, '0')
}

const OWNERS_ONE = `0x${word('20')}${word('1')}${word('14912965632cd9ab70c046e8d23e9b8dfa9f2746')}`
const THRESHOLD_ONE = `0x${word('1')}`
const COUNT_ZERO = `0x${word('0')}`

function contractAnswer(data: string): string | null {
  if (data === SELECTOR_GET_OWNERS) {
    return OWNERS_ONE
  }
  if (data === SELECTOR_THRESHOLD) {
    return THRESHOLD_ONE
  }
  if (data === SELECTOR_TRANSACTION_COUNT) {
    return COUNT_ZERO
  }
  return null
}

function apiFetch(chains: () => Response = () => jsonResponse({ data: [ETHEREUM, SEPOLIA] })): FetchStub {
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

function contract(overrides: Partial<Record<string, unknown>> = {}) {
  return installFakeProvider({
    answer: ({ method, params }) => {
      if (method === 'eth_accounts') {
        return [ACCOUNT]
      }
      if (method === 'eth_chainId') {
        return '0xaa36a7'
      }
      if (method === 'eth_getBalance') {
        return '0x0'
      }
      if (method === 'eth_call') {
        const call = params?.[0] as { data?: string } | undefined
        const data = call?.data ?? ''

        if (data in overrides) {
          return overrides[data]
        }

        return contractAnswer(data) ?? '0x'
      }
      throw new Error(`unexpected method: ${method}`)
    },
  })
}

function summary(): HTMLElement {
  return screen.getByRole('region', { name: 'Multisig contract' })
}

function summaryStatus(): string {
  const line = summary().querySelector(':scope > p[role="status"]')

  return line?.textContent ?? ''
}

function facts(): string {
  return summary().textContent ?? ''
}

afterEach(() => {
  removeFakeProvider()
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

describe('multisig summary', () => {
  it('shows the verified deployment and what it reports', async () => {
    const provider = contract()
    apiFetch()

    renderApp({ path: '/', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(summaryStatus()).toContain('Reading the contract.')
    })

    await waitFor(() => {
      expect(facts()).toContain(OWNER)
    })

    expect(facts()).toContain(MULTISIG_ADDRESS)
    expect(facts()).toContain('Sepolia (11155111)')
    expect(facts()).toContain('Owners (1)')
    expect(facts()).toContain('Threshold')
    expect(facts()).toContain('Transactions')

    // Three reads, all eth_call, all to the fixed contract.
    expect(provider.calls.filter((call) => call.method === 'eth_call')).toHaveLength(3)
    expect(provider.requested).not.toContain('eth_sendTransaction')
    expect(provider.requested).not.toContain('personal_sign')
  })

  it('says why the summary is unavailable when the wallet is on another chain', async () => {
    const provider = installFakeProvider({
      answer: ({ method }) => {
        if (method === 'eth_accounts') {
          return [ACCOUNT]
        }
        if (method === 'eth_chainId') {
          return '0x1'
        }
        if (method === 'eth_getBalance') {
          return '0x0'
        }
        throw new Error(`unexpected method: ${method}`)
      },
    })
    apiFetch()

    renderApp({ path: '/', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(summaryStatus()).toContain('reads the multisig on Sepolia (11155111)')
    })

    expect(summaryStatus()).toContain('Not read.')
    expect(summaryStatus()).toContain('chain 1')
    expect(provider.requested).not.toContain('eth_call')
  })

  it('says why the summary is unavailable when nothing is connected', async () => {
    const provider = installFakeProvider({
      answer: ({ method }) => {
        if (method === 'eth_accounts') {
          return []
        }
        throw new Error(`unexpected method: ${method}`)
      },
    })
    apiFetch()

    renderApp({ path: '/', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(summaryStatus()).toContain('No connected account.')
    })

    expect(provider.requested).not.toContain('eth_call')
  })

  it('says why the summary is unavailable while the catalog is loading', async () => {
    const held = deferred<Response>()
    const provider = contract()
    apiFetch(() => held.promise as unknown as Response)

    renderApp({ path: '/', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(summaryStatus()).toContain('chain catalog is still being read')
    })

    expect(provider.requested).not.toContain('eth_call')

    held.resolve(jsonResponse({ data: [SEPOLIA] }))

    await waitFor(() => {
      expect(facts()).toContain(OWNER)
    })
  })

  it('says why the summary is unavailable when the catalog fails', async () => {
    const provider = contract()
    apiFetch(() => errorResponse(503, 'SERVICE_UNAVAILABLE'))

    renderApp({ path: '/', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(summaryStatus()).toContain('chain catalog could not be read')
    })

    expect(provider.requested).not.toContain('eth_call')
  })

  it('says why the summary is unavailable when the catalog does not list Sepolia', async () => {
    const provider = contract()
    apiFetch(() => jsonResponse({ data: [ETHEREUM] }))

    renderApp({ path: '/', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(summaryStatus()).toContain('does not list Sepolia')
    })

    expect(provider.requested).not.toContain('eth_call')
  })

  it('shows a malformed answer as a failure rather than as data', async () => {
    contract({ [SELECTOR_GET_OWNERS]: `0x${word('1')}` })
    apiFetch()

    renderApp({ path: '/', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(summaryStatus()).toContain('The contract could not be read.')
    })

    expect(summaryStatus()).toContain('data this app cannot read')
    expect(facts()).not.toContain(OWNER)
  })

  it('retries a failed read on request', async () => {
    let reads = 0
    const provider = installFakeProvider({
      answer: ({ method, params }) => {
        if (method === 'eth_accounts') {
          return [ACCOUNT]
        }
        if (method === 'eth_chainId') {
          return '0xaa36a7'
        }
        if (method === 'eth_getBalance') {
          return '0x0'
        }
        if (method === 'eth_call') {
          reads += 1
          if (reads === 1) {
            throw { code: 3, message: 'execution reverted' }
          }
          const call = params?.[0] as { data?: string } | undefined
          return contractAnswer(call?.data ?? '') ?? '0x'
        }
        throw new Error(`unexpected method: ${method}`)
      },
    })
    apiFetch()

    const { user } = renderApp({ path: '/', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(summaryStatus()).toContain('The contract could not be read.')
    })

    expect(summaryStatus()).toContain('3')
    expect(summaryStatus()).not.toContain('execution reverted')

    await user.click(within(summary()).getByRole('button', { name: 'Read the contract again' }))

    await waitFor(() => {
      expect(facts()).toContain(OWNER)
    })

    expect(provider.requested.filter((method) => method === 'eth_call')).toHaveLength(4)
  })

  it('never draws a held answer after the wallet leaves Sepolia', async () => {
    const heldOwners = deferred<string>()
    let ownerReads = 0
    const provider = installFakeProvider({
      answer: ({ method, params }) => {
        if (method === 'eth_accounts') {
          return [ACCOUNT]
        }
        if (method === 'eth_chainId') {
          return '0xaa36a7'
        }
        if (method === 'eth_getBalance') {
          return '0x0'
        }
        if (method === 'eth_call') {
          const call = params?.[0] as { data?: string } | undefined
          const data = call?.data ?? ''

          if (data === SELECTOR_GET_OWNERS) {
            ownerReads += 1
            return heldOwners.promise
          }

          return contractAnswer(data) ?? '0x'
        }
        throw new Error(`unexpected method: ${method}`)
      },
    })
    apiFetch()

    renderApp({ path: '/', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(ownerReads).toBe(1)
    })

    provider.emit('chainChanged', '0x1')

    await waitFor(() => {
      expect(summaryStatus()).toContain('reads the multisig on Sepolia')
    })

    heldOwners.resolve(OWNERS_ONE)
    await Promise.resolve()

    expect(facts()).not.toContain(OWNER)
    expect(summaryStatus()).toContain('Not read.')
  })

  it('does not associate the connected account with the owners', async () => {
    installFakeProvider({
      answer: ({ method, params }) => {
        if (method === 'eth_accounts') {
          return [ACCOUNT]
        }
        if (method === 'eth_chainId') {
          return '0xaa36a7'
        }
        if (method === 'eth_getBalance') {
          return '0x0'
        }
        if (method === 'eth_call') {
          const call = params?.[0] as { data?: string } | undefined
          return contractAnswer(call?.data ?? '') ?? '0x'
        }
        throw new Error(`unexpected method: ${method}`)
      },
    })
    apiFetch()

    renderApp({ path: '/', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(facts()).toContain(OWNER)
    })

    // The connected account is not the owner of this deployment, and nothing on
    // the page says that it is.
    expect(facts()).not.toContain(ACCOUNT)
    expect(within(summary()).getByText(/does not show that the connected account is an owner/)).toBeDefined()
  })
})
