import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { deferred, installFakeProvider, removeFakeProvider } from '../test/fakeProvider.ts'
import { useBrowserWallet } from './useBrowserWallet.ts'

/**
 * The provider-facing half, on its own.
 *
 * These tests are about the two things a provider makes hard: it can answer out
 * of order, and it can change what it says without being asked. Everything here
 * is asserted against the state the hook presents, because that is what the
 * screen shows.
 */

const ACCOUNT = '0x1e1D0e1D0e1D0e1D0e1D0e1D0e1D0e1D0e1D0e1D'
const OTHER = '0x2e2E2e2E2e2E2e2E2e2E2e2E2e2E2e2E2e2E2e2E'

afterEach(() => {
  removeFakeProvider()
})

describe('the quiet read at load', () => {
  it('shows an unsupported state with no provider, without throwing', () => {
    const { result } = renderHook(() => useBrowserWallet())

    expect(result.current.state).toEqual({ status: 'unsupported' })
  })

  it('reads eth_accounts and the chain, and never asks for access', async () => {
    const provider = installFakeProvider({
      answer: ({ method }) => {
        if (method === 'eth_accounts') {
          return [ACCOUNT]
        }
        if (method === 'eth_chainId') {
          return '0x1'
        }
        throw new Error('the load must not call anything else')
      },
    })

    const { result } = renderHook(() => useBrowserWallet())

    await waitFor(() => {
      expect(result.current.state).toEqual({ status: 'connected', account: ACCOUNT, chainId: 1 })
    })

    expect(provider.requested).toEqual(['eth_accounts', 'eth_chainId'])
    expect(provider.requested).not.toContain('eth_requestAccounts')
  })

  it('shows disconnected when the site has no permission yet, with no prompt', async () => {
    const provider = installFakeProvider()

    const { result } = renderHook(() => useBrowserWallet())

    await waitFor(() => {
      expect(result.current.state).toEqual({ status: 'disconnected', notice: null })
    })

    expect(provider.requested).toEqual(['eth_accounts'])
  })

  it('states a read failure instead of guessing', async () => {
    installFakeProvider({
      answer: () => {
        throw { code: -32603, message: 'internal' }
      },
    })

    const { result } = renderHook(() => useBrowserWallet())

    await waitFor(() => {
      expect(result.current.state.status).toBe('error')
    })

    if (result.current.state.status !== 'error') {
      throw new Error('unreachable')
    }

    expect(result.current.state.message).toContain('-32603')
  })

  it('refuses an unreadable account list and an unreadable chain id', async () => {
    installFakeProvider({ answer: () => 'not a list' })

    const first = renderHook(() => useBrowserWallet())

    await waitFor(() => {
      expect(first.result.current.state.status).toBe('error')
    })

    removeFakeProvider()
    installFakeProvider({
      answer: ({ method }) => (method === 'eth_accounts' ? [ACCOUNT] : 'chain one'),
    })

    const second = renderHook(() => useBrowserWallet())

    await waitFor(() => {
      expect(second.result.current.state.status).toBe('error')
    })
  })
})

describe('connecting', () => {
  it('asks for access only when connect is called', async () => {
    const provider = installFakeProvider({
      answer: ({ method }) => {
        if (method === 'eth_accounts') {
          return []
        }
        if (method === 'eth_requestAccounts') {
          return [ACCOUNT]
        }
        if (method === 'eth_chainId') {
          return '0xaa36a7'
        }
        throw new Error('unexpected method')
      },
    })

    const { result } = renderHook(() => useBrowserWallet())

    await waitFor(() => {
      expect(result.current.state.status).toBe('disconnected')
    })

    expect(provider.requested).not.toContain('eth_requestAccounts')

    await act(async () => {
      await result.current.connect()
    })

    expect(provider.requested).toEqual(['eth_accounts', 'eth_requestAccounts', 'eth_chainId'])
    expect(result.current.state).toEqual({
      status: 'connected',
      account: ACCOUNT,
      chainId: 11155111,
    })
  })

  it('says the prompt was declined, and connects nothing', async () => {
    installFakeProvider({
      answer: ({ method }) => {
        if (method === 'eth_accounts') {
          return []
        }
        throw { code: 4001, message: 'User rejected the request.' }
      },
    })

    const { result } = renderHook(() => useBrowserWallet())

    await waitFor(() => {
      expect(result.current.state.status).toBe('disconnected')
    })

    await act(async () => {
      await result.current.connect()
    })

    expect(result.current.state).toEqual({
      status: 'disconnected',
      notice: 'The connection request was declined in the wallet.',
    })
  })

  it('says nothing is connected when the wallet returns no account', async () => {
    installFakeProvider({
      answer: ({ method }) => {
        if (method === 'eth_requestAccounts') {
          return []
        }
        return []
      },
    })

    const { result } = renderHook(() => useBrowserWallet())

    await waitFor(() => {
      expect(result.current.state.status).toBe('disconnected')
    })

    await act(async () => {
      await result.current.connect()
    })

    expect(result.current.state).toEqual({
      status: 'disconnected',
      notice: 'The wallet returned no account, so nothing is connected.',
    })
  })

  it('shows the connecting state while the wallet is being asked', async () => {
    const answer = deferred<string[]>()

    installFakeProvider({
      answer: ({ method }) => {
        if (method === 'eth_requestAccounts') {
          return answer.promise
        }
        if (method === 'eth_chainId') {
          return '0x1'
        }
        return []
      },
    })

    const { result } = renderHook(() => useBrowserWallet())

    await waitFor(() => {
      expect(result.current.state.status).toBe('disconnected')
    })

    let connecting: Promise<void> = Promise.resolve()

    act(() => {
      connecting = result.current.connect()
    })

    await waitFor(() => {
      expect(result.current.state).toEqual({ status: 'connecting' })
    })

    answer.resolve([ACCOUNT])

    await act(async () => {
      await connecting
    })

    expect(result.current.state.status).toBe('connected')
  })
})

describe('what the provider reports while connected', () => {
  it('follows an account change, and re-reads the chain for it', async () => {
    let accounts = [ACCOUNT]
    const provider = installFakeProvider({
      answer: ({ method }) => {
        if (method === 'eth_accounts') {
          return accounts
        }
        if (method === 'eth_chainId') {
          return '0x1'
        }
        throw new Error('unexpected method')
      },
    })

    const { result } = renderHook(() => useBrowserWallet())

    await waitFor(() => {
      expect(result.current.state.status).toBe('connected')
    })

    accounts = [OTHER]

    act(() => {
      provider.emit('accountsChanged', [OTHER])
    })

    await waitFor(() => {
      expect(result.current.state).toEqual({ status: 'connected', account: OTHER, chainId: 1 })
    })
  })

  it('clears the account when the list is empty', async () => {
    const provider = installFakeProvider({
      answer: ({ method }) => (method === 'eth_accounts' ? [ACCOUNT] : '0x1'),
    })

    const { result } = renderHook(() => useBrowserWallet())

    await waitFor(() => {
      expect(result.current.state.status).toBe('connected')
    })

    act(() => {
      provider.emit('accountsChanged', [])
    })

    expect(result.current.state).toEqual({
      status: 'disconnected',
      notice: 'The wallet reported no connected account.',
    })
  })

  it('follows a chain change and keeps the account', async () => {
    const provider = installFakeProvider({
      answer: ({ method }) => (method === 'eth_accounts' ? [ACCOUNT] : '0x1'),
    })

    const { result } = renderHook(() => useBrowserWallet())

    await waitFor(() => {
      expect(result.current.state.status).toBe('connected')
    })

    act(() => {
      provider.emit('chainChanged', '0x89')
    })

    expect(result.current.state).toEqual({ status: 'connected', account: ACCOUNT, chainId: 137 })
  })

  it('does not turn a chain change into a connection', async () => {
    const provider = installFakeProvider()

    const { result } = renderHook(() => useBrowserWallet())

    await waitFor(() => {
      expect(result.current.state.status).toBe('disconnected')
    })

    act(() => {
      provider.emit('chainChanged', '0x89')
    })

    expect(result.current.state.status).toBe('disconnected')
  })

  it('reports the provider disconnecting', async () => {
    const provider = installFakeProvider({
      answer: ({ method }) => (method === 'eth_accounts' ? [ACCOUNT] : '0x1'),
    })

    const { result } = renderHook(() => useBrowserWallet())

    await waitFor(() => {
      expect(result.current.state.status).toBe('connected')
    })

    act(() => {
      provider.emit('disconnect')
    })

    expect(result.current.state).toEqual({ status: 'disconnected', notice: 'The wallet disconnected.' })
  })

  it('states an unreadable event payload instead of rendering it', async () => {
    const provider = installFakeProvider({
      answer: ({ method }) => (method === 'eth_accounts' ? [ACCOUNT] : '0x1'),
    })

    const { result } = renderHook(() => useBrowserWallet())

    await waitFor(() => {
      expect(result.current.state.status).toBe('connected')
    })

    act(() => {
      provider.emit('accountsChanged', [{ address: ACCOUNT }])
    })

    expect(result.current.state.status).toBe('error')

    act(() => {
      provider.emit('chainChanged', 'optimism')
    })

    expect(result.current.state.status).toBe('error')
  })
})

describe('a chain change during work that is still running', () => {
  it('recovers the initial read instead of leaving the screen checking', async () => {
    const accounts = deferred<string[]>()
    const provider = installFakeProvider({
      answer: ({ method }) => {
        if (method === 'eth_accounts') {
          return accounts.promise
        }
        if (method === 'eth_chainId') {
          return '0x1'
        }
        throw new Error('unexpected method')
      },
    })

    const { result } = renderHook(() => useBrowserWallet())

    // The read is out and nothing has answered yet.
    expect(result.current.state).toEqual({ status: 'checking' })

    act(() => {
      provider.emit('chainChanged', '0x89')
    })

    // The event alone is not a connection: there is still no account.
    expect(result.current.state).toEqual({ status: 'checking' })

    accounts.resolve([ACCOUNT])

    // The read settles, and it settles on the chain the wallet announced after
    // it started rather than the one its own read returned.
    await waitFor(() => {
      expect(result.current.state).toEqual({ status: 'connected', account: ACCOUNT, chainId: 137 })
    })
  })

  it('recovers the initial read when the wallet announces a chain and no account', async () => {
    const accounts = deferred<string[]>()
    const provider = installFakeProvider({
      answer: ({ method }) => (method === 'eth_accounts' ? accounts.promise : '0x1'),
    })

    const { result } = renderHook(() => useBrowserWallet())

    act(() => {
      provider.emit('chainChanged', '0x89')
    })

    accounts.resolve([])

    await waitFor(() => {
      expect(result.current.state).toEqual({ status: 'disconnected', notice: null })
    })
  })

  it('recovers a connect in flight instead of leaving the screen connecting', async () => {
    const grant = deferred<string[]>()
    const provider = installFakeProvider({
      answer: ({ method }) => {
        if (method === 'eth_requestAccounts') {
          return grant.promise
        }
        if (method === 'eth_accounts') {
          return []
        }
        if (method === 'eth_chainId') {
          return '0x1'
        }
        throw new Error('unexpected method')
      },
    })

    const { result } = renderHook(() => useBrowserWallet())

    await waitFor(() => {
      expect(result.current.state.status).toBe('disconnected')
    })

    let connecting: Promise<void> = Promise.resolve()

    act(() => {
      connecting = result.current.connect()
    })

    await waitFor(() => {
      expect(result.current.state).toEqual({ status: 'connecting' })
    })

    act(() => {
      provider.emit('chainChanged', '0x89')
    })

    // Still connecting: the event is not a consent, and the prompt is still open.
    expect(result.current.state).toEqual({ status: 'connecting' })

    grant.resolve([ACCOUNT])

    await act(async () => {
      await connecting
    })

    expect(result.current.state).toEqual({ status: 'connected', account: ACCOUNT, chainId: 137 })
    // One prompt, because the recovery did not ask the wallet again.
    expect(provider.requested.filter((method) => method === 'eth_requestAccounts')).toHaveLength(1)
  })

  it('prefers an announcement that arrives after the chain read started', async () => {
    const chain = deferred<string>()
    const provider = installFakeProvider({
      answer: ({ method }) => {
        if (method === 'eth_accounts') {
          return [ACCOUNT]
        }
        if (method === 'eth_chainId') {
          return chain.promise
        }
        throw new Error('unexpected method')
      },
    })

    const { result } = renderHook(() => useBrowserWallet())

    await waitFor(() => {
      expect(provider.requested).toContain('eth_chainId')
    })

    act(() => {
      provider.emit('chainChanged', '0x89')
    })

    // The older read answers last, and with the chain the wallet has left.
    chain.resolve('0x1')

    await waitFor(() => {
      expect(result.current.state).toEqual({ status: 'connected', account: ACCOUNT, chainId: 137 })
    })
  })
})

describe('listener lifetime', () => {
  it('removes every listener it added on teardown', async () => {
    const provider = installFakeProvider()

    const { unmount } = renderHook(() => useBrowserWallet())

    await waitFor(() => {
      expect(provider.listenerCount()).toBe(3)
    })

    unmount()

    expect(provider.listenerCount()).toBe(0)
    expect([...provider.unsubscribed].sort()).toEqual([...provider.subscribed].sort())
  })

  it('subscribes to nothing when the provider cannot remove listeners', async () => {
    const provider = installFakeProvider({ listeners: false })

    const { result } = renderHook(() => useBrowserWallet())

    await waitFor(() => {
      expect(result.current.state.status).toBe('disconnected')
    })

    expect(provider.subscribed).toEqual([])
  })

  it('applies nothing that arrives after unmount', async () => {
    const held = deferred<string>()
    const provider = installFakeProvider({
      answer: ({ method }) => (method === 'eth_accounts' ? [ACCOUNT] : held.promise),
    })

    const { result, unmount } = renderHook(() => useBrowserWallet())

    await waitFor(() => {
      expect(provider.requested).toContain('eth_chainId')
    })

    unmount()

    held.resolve('0x1')
    await Promise.resolve()

    // The state object is the one left behind at unmount, not a fresh answer.
    expect(result.current.state).toEqual({ status: 'checking' })
  })
})

describe('answers that arrive out of order', () => {
  it('keeps the newer account when an older chain read answers late', async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    let chainReads = 0

    const single = installFakeProvider({
      answer: ({ method }) => {
        if (method === 'eth_accounts') {
          return [ACCOUNT]
        }
        if (method === 'eth_chainId') {
          chainReads += 1
          return chainReads === 1 ? first.promise : second.promise
        }
        throw new Error('unexpected method')
      },
    })

    const { result } = renderHook(() => useBrowserWallet())

    await waitFor(() => {
      expect(chainReads).toBe(1)
    })

    // A newer account change starts a second read while the first is still out.
    act(() => {
      single.emit('accountsChanged', [OTHER])
    })

    await waitFor(() => {
      expect(chainReads).toBe(2)
    })

    second.resolve('0x1')

    await waitFor(() => {
      expect(result.current.state).toEqual({ status: 'connected', account: OTHER, chainId: 1 })
    })

    // The older read answers last, with the old account's chain.
    first.resolve('0x89')
    await Promise.resolve()

    expect(result.current.state).toEqual({ status: 'connected', account: OTHER, chainId: 1 })
  })

  it('does not let a held connect answer overtake a disconnect', async () => {
    const grant = deferred<string[]>()

    const provider = installFakeProvider({
      answer: ({ method }) => {
        if (method === 'eth_requestAccounts') {
          return grant.promise
        }
        if (method === 'eth_chainId') {
          return '0x1'
        }
        return []
      },
    })

    const { result } = renderHook(() => useBrowserWallet())

    await waitFor(() => {
      expect(result.current.state.status).toBe('disconnected')
    })

    let connecting: Promise<void> = Promise.resolve()

    act(() => {
      connecting = result.current.connect()
    })

    await waitFor(() => {
      expect(result.current.state.status).toBe('connecting')
    })

    // The wallet disconnects while the prompt is still open.
    act(() => {
      provider.emit('disconnect')
    })

    expect(result.current.state.status).toBe('disconnected')

    grant.resolve([ACCOUNT])

    await act(async () => {
      await connecting
    })

    // The grant arrived, but it is an answer to a question that is no longer
    // being asked. It must not reconnect the screen.
    expect(result.current.state).toEqual({
      status: 'disconnected',
      notice: 'The wallet disconnected.',
    })
  })
})
