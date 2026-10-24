import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { BrowserWalletState } from '../provider/useBrowserWallet.ts'
import {
  deferred,
  installFakeProvider,
  removeFakeProvider,
  type FakeProvider,
} from '../test/fakeProvider.ts'
import type { SubmitTarget } from './useSubmitTransaction.ts'
import {
  receiptGate,
  useTransactionReceipt,
  type UseTransactionReceiptOptions,
} from './useTransactionReceipt.ts'

/**
 * One manual receipt read, with a provider this test drives.
 *
 * What is checked: one request per press, a null answer standing as its own
 * state, the two included outcomes, three kinds of refused answer, redacted
 * provider text, and every way a held read can become an answer nobody should
 * see.
 */

const ACCOUNT = '0x1e1D0e1D0e1D0e1D0e1D0e1D0e1D0e1D0e1D0e1D'
const OTHER = '0x2e2E2e2E2e2E2e2E2e2E2e2E2e2E2e2E2e2E2e2E'
const CONTRACT = '0x5b324f41e5889cf94cba8e909089683a1a97c318'
const OTHER_CONTRACT = '0x14912965632cd9ab70c046e8d23e9b8dfa9f2746'
const SEPOLIA = 11155111
const HASH = `0x${'ab'.repeat(32)}`
const OTHER_HASH = `0x${'cd'.repeat(32)}`
const BLOCK_HASH = `0x${'11'.repeat(32)}`

const TARGET: SubmitTarget = { id: 7, address: CONTRACT, chainId: SEPOLIA }

function connected(account = ACCOUNT, chainId = SEPOLIA): BrowserWalletState {
  return { status: 'connected', account, chainId }
}

function receipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    transactionHash: HASH,
    to: CONTRACT,
    status: '0x1',
    blockNumber: '0x5d2c40',
    blockHash: BLOCK_HASH,
    ...overrides,
  }
}

function provider(answer: () => unknown = () => receipt()): FakeProvider {
  return installFakeProvider({
    answer: ({ method }) => {
      if (method === 'eth_getTransactionReceipt') {
        return answer()
      }

      throw new Error(`unexpected method ${method}`)
    },
  })
}

function receiptCalls(fake: FakeProvider): FakeProvider['calls'] {
  return fake.calls.filter((call) => call.method === 'eth_getTransactionReceipt')
}

function options(overrides: Partial<UseTransactionReceiptOptions> = {}): UseTransactionReceiptOptions {
  return {
    hash: HASH,
    contract: TARGET,
    wallet: connected(),
    ...overrides,
  }
}

function render(initial: Partial<UseTransactionReceiptOptions> = {}) {
  return renderHook((props: Partial<UseTransactionReceiptOptions>) => useTransactionReceipt(options(props)), {
    initialProps: initial,
  })
}

afterEach(() => {
  removeFakeProvider()
})

describe('the gate', () => {
  it('offers the check on the chain the transaction was submitted on', () => {
    provider()

    const { result } = render()

    expect(result.current.gate.available).toBe(true)
  })

  it('refuses it on another chain, naming both', () => {
    provider()

    const { result } = render({ wallet: connected(ACCOUNT, 1) })

    expect(result.current.gate.available).toBe(false)
    expect(result.current.gate.reason).toContain('chain 1')
    expect(result.current.gate.reason).toContain(String(SEPOLIA))
  })

  it('tells checking, disconnected, unsupported and broken apart', () => {
    provider()

    const walletStates: BrowserWalletState[] = [
      { status: 'checking' },
      { status: 'disconnected', notice: null },
      { status: 'unsupported' },
      { status: 'error', message: 'redacted' },
      { status: 'connecting' },
    ]

    const reasons = walletStates.map((wallet) => receiptGate(TARGET, wallet).reason)

    expect(new Set(reasons).size).toBe(walletStates.length)
    expect(walletStates.every((wallet) => !receiptGate(TARGET, wallet).available)).toBe(true)
  })
})

describe('one check', () => {
  it('starts idle and asks for nothing until it is asked', () => {
    const fake = provider()

    const { result } = render()

    expect(result.current.state.kind).toBe('idle')
    expect(receiptCalls(fake)).toHaveLength(0)
  })

  it('makes exactly one request for one press, and none for a second press while it is held', async () => {
    const held = deferred<unknown>()
    const fake = provider(() => held.promise)
    const { result } = render()

    act(() => {
      void result.current.check()
      void result.current.check()
    })

    await waitFor(() => {
      expect(result.current.state.kind).toBe('checking')
    })

    expect(receiptCalls(fake)).toHaveLength(1)
    expect(receiptCalls(fake)[0]!.params).toEqual([HASH])

    await act(async () => {
      held.resolve(receipt())
      await Promise.resolve()
    })

    expect(result.current.state.kind).toBe('included')
  })

  it('reads a success and a revert as different outcomes', async () => {
    let status = '0x1'
    provider(() => receipt({ status }))
    const { result } = render()

    await act(async () => {
      await result.current.check()
    })

    expect(result.current.state).toEqual({
      kind: 'included',
      success: true,
      blockNumber: '6106176',
      blockHash: BLOCK_HASH,
    })

    status = '0x0'

    await act(async () => {
      await result.current.check()
    })

    expect(result.current.state).toEqual({
      kind: 'included',
      success: false,
      blockNumber: '6106176',
      blockHash: BLOCK_HASH,
    })
  })

  it('treats null as no receipt available, and finds one on a later check', async () => {
    let answer: unknown = null
    const fake = provider(() => answer)
    const { result } = render()

    await act(async () => {
      await result.current.check()
    })

    expect(result.current.state.kind).toBe('none')

    answer = receipt()

    await act(async () => {
      await result.current.check()
    })

    expect(result.current.state.kind).toBe('included')
    // Two presses, two requests: nothing polled in between.
    expect(receiptCalls(fake)).toHaveLength(2)
  })

  it('describes a provider failure with its code and never its text', async () => {
    provider(() => {
      throw Object.assign(new Error('header not found: node is syncing'), { code: -32000 })
    })
    const { result } = render()

    await act(async () => {
      await result.current.check()
    })

    expect(result.current.state.kind).toBe('error')

    if (result.current.state.kind !== 'error') {
      return
    }

    expect(result.current.state.message).toContain('-32000')
    expect(result.current.state.message).not.toContain('syncing')
  })

  it('refuses a receipt for another transaction', async () => {
    provider(() => receipt({ transactionHash: OTHER_HASH }))
    const { result } = render()

    await act(async () => {
      await result.current.check()
    })

    expect(result.current.state).toEqual({
      kind: 'error',
      message: 'The wallet answered about a different transaction, so the answer was not used.',
    })
  })

  it('refuses a receipt for a transaction to another contract', async () => {
    provider(() => receipt({ to: OTHER_CONTRACT }))
    const { result } = render()

    await act(async () => {
      await result.current.check()
    })

    expect(result.current.state.kind).toBe('error')

    if (result.current.state.kind !== 'error') {
      return
    }

    expect(result.current.state.message).toContain('different contract')
  })

  it('refuses a structurally unusable answer with its own sentence', async () => {
    provider(() => ({ status: '0x1' }))
    const { result } = render()

    await act(async () => {
      await result.current.check()
    })

    expect(result.current.state).toEqual({
      kind: 'error',
      message: 'The wallet answered with something that is not a transaction receipt.',
    })
  })

  it('does nothing at all while the gate is closed', async () => {
    const fake = provider()
    const { result } = render({ wallet: connected(ACCOUNT, 1) })

    await act(async () => {
      await result.current.check()
    })

    expect(receiptCalls(fake)).toHaveLength(0)
    expect(result.current.state.kind).toBe('idle')
  })
})

describe('a held answer in a context that moved on', () => {
  it('is dropped when the chain changes', async () => {
    const held = deferred<unknown>()
    provider(() => held.promise)

    const { result, rerender } = render()

    act(() => {
      void result.current.check()
    })

    await waitFor(() => {
      expect(result.current.state.kind).toBe('checking')
    })

    rerender({ wallet: connected(ACCOUNT, 1) })

    await act(async () => {
      held.resolve(receipt())
      await Promise.resolve()
    })

    expect(result.current.state.kind).toBe('idle')
  })

  it('is dropped when the account changes', async () => {
    const held = deferred<unknown>()
    provider(() => held.promise)

    const { result, rerender } = render()

    act(() => {
      void result.current.check()
    })

    await waitFor(() => {
      expect(result.current.state.kind).toBe('checking')
    })

    rerender({ wallet: connected(OTHER) })

    await act(async () => {
      held.resolve(receipt())
      await Promise.resolve()
    })

    expect(result.current.state.kind).toBe('idle')
  })

  it('is dropped when the hash changes, and does not come back with the old one', async () => {
    const held = deferred<unknown>()
    provider(() => held.promise)

    const { result, rerender } = render()

    act(() => {
      void result.current.check()
    })

    await waitFor(() => {
      expect(result.current.state.kind).toBe('checking')
    })

    rerender({ hash: OTHER_HASH })

    await act(async () => {
      held.resolve(receipt())
      await Promise.resolve()
    })

    expect(result.current.state.kind).toBe('idle')

    // Back to the first hash: the answer that arrived in between belongs to
    // neither context and is not resurrected.
    rerender({ hash: HASH })

    expect(result.current.state.kind).toBe('idle')
  })

  it('is dropped when the contract changes', async () => {
    const held = deferred<unknown>()
    provider(() => held.promise)

    const { result, rerender } = render()

    act(() => {
      void result.current.check()
    })

    await waitFor(() => {
      expect(result.current.state.kind).toBe('checking')
    })

    rerender({ contract: { ...TARGET, id: 8, address: OTHER_CONTRACT } })

    await act(async () => {
      held.resolve(receipt())
      await Promise.resolve()
    })

    expect(result.current.state.kind).toBe('idle')
  })

  it('is dropped when the screen goes', async () => {
    const held = deferred<unknown>()
    provider(() => held.promise)

    const complaints: unknown[][] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      complaints.push(args)
    })

    try {
      const { result, unmount } = render()

      act(() => {
        void result.current.check()
      })

      await waitFor(() => {
        expect(result.current.state.kind).toBe('checking')
      })

      unmount()

      await act(async () => {
        held.resolve(receipt())
        await Promise.resolve()
      })

      expect(complaints).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })
})
