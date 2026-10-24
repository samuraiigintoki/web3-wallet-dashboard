import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { BrowserWalletState } from '../provider/useBrowserWallet.ts'
import {
  deferred,
  installFakeProvider,
  removeFakeProvider,
  type FakeProvider,
} from '../test/fakeProvider.ts'
import {
  useSubmitTransaction,
  type CatalogFact,
  type SubmitTarget,
  type UseSubmitTransactionOptions,
} from './useSubmitTransaction.ts'

/**
 * The submission lifecycle, with a provider this test drives.
 *
 * The cases here are the ones a wallet makes possible and a happy path hides: a
 * rejection, an answer that never becomes a hash, a second press while the first
 * send is outstanding, an account or chain that moves between the confirmation
 * and the dispatch, and a result that arrives after the screen has gone. None of
 * them may reach `eth_sendTransaction` when they should not, and none of them may
 * be drawn as a submission.
 */

const ACCOUNT = '0x1e1D0e1D0e1D0e1D0e1D0e1D0e1D0e1D0e1D0e1D'
const OTHER = '0x2e2E2e2E2e2E2e2E2e2E2e2E2e2E2e2E2e2E2e2E'
const SEPOLIA = 11155111
const HASH = `0x${'ab'.repeat(32)}`

const CONTRACT: SubmitTarget = {
  id: 7,
  address: '0x5b324f41e5889cf94cba8e909089683a1a97c318',
  chainId: SEPOLIA,
}

const DESTINATION = '0x14912965632cd9ab70c046e8d23e9b8dfa9f2746'

/** The same call the encoder test pins to a reference vector. */
const ENCODED_ONE_ETHER_DEADBEEF =
  '0xc642747400000000000000000000000014912965632cd9ab70c046e8d23e9b8dfa9f2746' +
  '0000000000000000000000000000000000000000000000000de0b6b3a7640000' +
  '0000000000000000000000000000000000000000000000000000000000000060' +
  '0000000000000000000000000000000000000000000000000000000000000004' +
  'deadbeef00000000000000000000000000000000000000000000000000000000'

type Answers = {
  accounts?: () => unknown
  chain?: () => unknown
  send?: () => unknown
}

function provider(answers: Answers = {}): FakeProvider {
  let accountReads = 0
  let chainReads = 0

  return installFakeProvider({
    answer: ({ method }) => {
      if (method === 'eth_accounts') {
        accountReads += 1
        return answers.accounts === undefined ? [ACCOUNT] : answers.accounts()
      }

      if (method === 'eth_chainId') {
        chainReads += 1
        return answers.chain === undefined ? `0x${SEPOLIA.toString(16)}` : answers.chain()
      }

      if (method === 'eth_sendTransaction') {
        return answers.send === undefined ? HASH : answers.send()
      }

      throw new Error(`unexpected method ${method}`)
    },
  })
}

/** The `eth_sendTransaction` requests the provider actually received. */
function sends(fake: FakeProvider): FakeProvider['calls'] {
  return fake.calls.filter((call) => call.method === 'eth_sendTransaction')
}

/** A wallet that has connected the test account on the contract's chain. */
function connected(account = ACCOUNT, chainId = SEPOLIA): BrowserWalletState {
  return { status: 'connected', account, chainId }
}

function options(overrides: Partial<UseSubmitTransactionOptions> = {}): UseSubmitTransactionOptions {
  return {
    contract: CONTRACT,
    wallet: connected(),
    catalog: 'listed' as CatalogFact,
    ...overrides,
  }
}

/** Fills the form and moves to the confirmation. */
function confirm(
  result: { current: ReturnType<typeof useSubmitTransaction> },
  draft = { destination: DESTINATION, valueWei: '1000000000000000000', data: '0xdeadbeef' },
): void {
  act(() => {
    result.current.setField('destination', draft.destination)
    result.current.setField('valueWei', draft.valueWei)
    result.current.setField('data', draft.data)
  })

  act(() => {
    result.current.review()
  })
}

type RenderOptions = Partial<UseSubmitTransactionOptions>

function render(initial: RenderOptions = {}) {
  return renderHook((props: RenderOptions) => useSubmitTransaction(options(props)), {
    initialProps: initial,
  })
}

afterEach(() => {
  removeFakeProvider()
})

describe('the gate', () => {
  it('offers review with an account on the contract chain, listed by the catalog', () => {
    provider()

    const { result } = render()

    expect(result.current.gate.open).toBe(true)
  })

  it('closes for a chain mismatch, naming both chains', () => {
    provider()

    const { result } = render({ wallet: connected(ACCOUNT, 1) })

    expect(result.current.gate.open).toBe(false)
    expect(result.current.gate.reason).toContain('chain 1')
    expect(result.current.gate.reason).toContain(String(SEPOLIA))
  })

  it('closes when the catalog has not listed the chain, for each catalog fact', () => {
    provider()

    for (const catalog of ['loading', 'failed', 'unlisted'] as const) {
      const { result } = render({ catalog })

      expect(result.current.gate.open).toBe(false)
      expect(result.current.gate.reason).not.toBe('')
    }
  })

  it('tells a wallet that is still being checked apart from one that is not connected', () => {
    provider()

    const checking = render({ wallet: { status: 'checking' } })
    const disconnected = render({ wallet: { status: 'disconnected', notice: null } })
    const unsupported = render({ wallet: { status: 'unsupported' } })
    const broken = render({ wallet: { status: 'error', message: 'redacted' } })

    const reasons = [
      checking.result.current.gate.reason,
      disconnected.result.current.gate.reason,
      unsupported.result.current.gate.reason,
      broken.result.current.gate.reason,
    ]

    // Four different facts, four different sentences: a spinner is not a
    // disconnected wallet, and a browser with no wallet is not one either.
    expect(new Set(reasons).size).toBe(4)
    expect(disconnected.result.current.gate.reason).toBe('No connected account.')
    expect(checking.result.current.gate.reason).toBe('Checking the browser wallet.')
    expect(unsupported.result.current.gate.reason).toContain('No browser wallet')
  })
})

describe('the form', () => {
  it('reports each bad field and stays on the form', () => {
    provider()

    const { result } = render()

    confirm(result, { destination: 'nope', valueWei: '1.5', data: '0xabc' })

    expect(result.current.phase.kind).toBe('editing')
    expect(result.current.errors.destination).toBeDefined()
    expect(result.current.errors.valueWei).toBeDefined()
    expect(result.current.errors.data).toBeDefined()
  })

  it('cannot reach the confirmation while the gate is closed, even with valid input', () => {
    provider()

    const { result } = render({ wallet: connected(ACCOUNT, 1) })

    confirm(result)

    expect(result.current.phase.kind).toBe('editing')
  })
})

describe('dispatch', () => {
  it('sends exactly one transaction, addressed to the contract, with no call value', async () => {
    const ethereum = provider()
    const { result } = render()

    confirm(result)
    expect(result.current.phase.kind).toBe('confirming')

    await act(async () => {
      await result.current.submit()
    })

    const sent = sends(ethereum)

    expect(sent).toHaveLength(1)
    expect(sent[0]!.params).toEqual([
      {
        from: ACCOUNT,
        to: CONTRACT.address,
        value: '0x0',
        data: ENCODED_ONE_ETHER_DEADBEEF,
      },
    ])

    expect(result.current.phase.kind).toBe('submitted')
  })

  it('shows the hash the wallet returned, exactly', async () => {
    provider()

    const { result } = render()

    confirm(result)

    await act(async () => {
      await result.current.submit()
    })

    expect(result.current.phase).toEqual({
      kind: 'submitted',
      request: expect.objectContaining({ valueWei: '1000000000000000000' }),
      hash: HASH,
    })
  })

  it('reads the account and chain again immediately before dispatching', async () => {
    const ethereum = provider()
    const { result } = render()

    confirm(result)

    await act(async () => {
      await result.current.submit()
    })

    const methods = ethereum.calls.map((call) => call.method)

    // The re-check happens after the confirmation and before the send, in that
    // order, and nothing else is asked.
    expect(methods).toEqual(['eth_accounts', 'eth_chainId', 'eth_sendTransaction'])
  })

  it('refuses a second dispatch while one is in flight', async () => {
    const held = deferred<unknown>()
    const ethereum = provider({ send: () => held.promise })

    const { result } = render()

    confirm(result)

    act(() => {
      void result.current.submit()
      void result.current.submit()
    })

    await waitFor(() => {
      expect(result.current.phase.kind).toBe('sending')
    })

    expect(sends(ethereum)).toHaveLength(1)

    await act(async () => {
      held.resolve(HASH)
      await Promise.resolve()
    })

    expect(result.current.phase.kind).toBe('submitted')
  })
})

describe('refusals and failures', () => {
  it('reports a wallet rejection as a refusal and sends nothing further', async () => {
    const ethereum = provider({
      send: () => {
        throw Object.assign(new Error('User rejected the request.'), { code: 4001 })
      },
    })
    const { result } = render()

    confirm(result)

    await act(async () => {
      await result.current.submit()
    })

    expect(result.current.phase.kind).toBe('failed')

    if (result.current.phase.kind !== 'failed') {
      return
    }

    expect(result.current.phase.declined).toBe(true)
    expect(result.current.phase.message).toBe('The transaction was declined in the wallet.')
    // The provider's own text is never repeated.
    expect(result.current.phase.message).not.toContain('User rejected')
    // No retry, and no second attempt.
    expect(sends(ethereum)).toHaveLength(1)
  })

  it('reports a provider error with its code and no provider message', async () => {
    provider({
      send: () => {
        throw Object.assign(new Error('insufficient funds for gas * price + value'), { code: -32000 })
      },
    })
    const { result } = render()

    confirm(result)

    await act(async () => {
      await result.current.submit()
    })

    expect(result.current.phase.kind).toBe('failed')

    if (result.current.phase.kind !== 'failed') {
      return
    }

    expect(result.current.phase.declined).toBe(false)
    expect(result.current.phase.message).toContain('-32000')
    expect(result.current.phase.message).not.toContain('insufficient funds')
  })

  it('refuses an answer that is not a transaction hash', async () => {
    provider({ send: () => ({ ok: true }) })

    const { result } = render()

    confirm(result)

    await act(async () => {
      await result.current.submit()
    })

    expect(result.current.phase.kind).toBe('failed')

    if (result.current.phase.kind !== 'failed') {
      return
    }

    expect(result.current.phase.message).toContain('did not answer with a transaction hash')
  })

  it('aborts without dispatching when the wallet switched account after the confirmation', async () => {
    // The confirmation was drawn for ACCOUNT. The wallet has moved on since,
    // and the re-check is the only thing standing between that and a signature.
    const ethereum = provider({ accounts: () => [OTHER] })

    const { result } = render()

    confirm(result)

    await act(async () => {
      await result.current.submit()
    })

    expect(result.current.phase.kind).toBe('failed')

    if (result.current.phase.kind !== 'failed') {
      return
    }

    expect(result.current.phase.message).toBe('The wallet is now on a different account, so nothing was sent.')
    expect(sends(ethereum)).toHaveLength(0)
  })

  it('aborts without dispatching when the wallet switched chain after the confirmation', async () => {
    const ethereum = provider({ chain: () => '0x1' })

    const { result } = render()

    confirm(result)

    await act(async () => {
      await result.current.submit()
    })

    expect(result.current.phase.kind).toBe('failed')

    if (result.current.phase.kind !== 'failed') {
      return
    }

    expect(result.current.phase.message).toContain('chain 1')
    expect(sends(ethereum)).toHaveLength(0)
  })

  it('aborts without dispatching when the wallet reports no account', async () => {
    const ethereum = provider({ accounts: () => [] })

    const { result } = render()

    confirm(result)

    await act(async () => {
      await result.current.submit()
    })

    expect(result.current.phase.kind).toBe('failed')
    expect(sends(ethereum)).toHaveLength(0)
  })
})

describe('stale results', () => {
  it('does not draw a submitted hash after the account changed', async () => {
    const held = deferred<unknown>()
    provider({ send: () => held.promise })

    const { result, rerender } = render()

    confirm(result)

    act(() => {
      void result.current.submit()
    })

    await waitFor(() => {
      expect(result.current.phase.kind).toBe('sending')
    })

    // The wallet announces a different account while the send is outstanding.
    rerender({ wallet: connected(OTHER) })

    await act(async () => {
      held.resolve(HASH)
      await Promise.resolve()
    })

    expect(result.current.phase.kind).toBe('editing')
  })

  it('does not bring an earlier hash back when the account returns', async () => {
    provider()

    const { result, rerender } = render()

    confirm(result)

    await act(async () => {
      await result.current.submit()
    })

    expect(result.current.phase.kind).toBe('submitted')

    // The wallet moves away and back. Nothing was pressed in between, so there
    // is no submission to show for the context it has returned to.
    rerender({ wallet: connected(OTHER) })
    expect(result.current.phase.kind).toBe('editing')

    rerender({ wallet: connected(ACCOUNT) })
    expect(result.current.phase.kind).toBe('editing')
  })

  it('does not draw a submitted hash after the contract changed', async () => {
    const held = deferred<unknown>()
    provider({ send: () => held.promise })

    const { result, rerender } = render()

    confirm(result)

    act(() => {
      void result.current.submit()
    })

    await waitFor(() => {
      expect(result.current.phase.kind).toBe('sending')
    })

    rerender({ contract: { ...CONTRACT, id: 8, address: '0x14912965632cd9ab70c046e8d23e9b8dfa9f2746' } })

    await act(async () => {
      held.resolve(HASH)
      await Promise.resolve()
    })

    expect(result.current.phase.kind).toBe('editing')
  })

  it('sets nothing after unmount', async () => {
    const held = deferred<unknown>()
    provider({ send: () => held.promise })

    const complaints: unknown[][] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      complaints.push(args)
    })

    try {
      const { result, unmount } = render()

      confirm(result)

      act(() => {
        void result.current.submit()
      })

      await waitFor(() => {
        expect(result.current.phase.kind).toBe('sending')
      })

      unmount()

      await act(async () => {
        held.resolve(HASH)
        await Promise.resolve()
      })

      // React reports a state update on a gone tree through console.error. An
      // answer that is dropped by the hook says nothing at all.
      expect(complaints).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })

  it('drops the confirmation when the chain changes, so the wallet is not prompted', async () => {
    const ethereum = provider()

    const { result, rerender } = render()

    confirm(result)
    expect(result.current.phase.kind).toBe('confirming')

    rerender({ wallet: connected(ACCOUNT, 1) })

    expect(result.current.phase.kind).toBe('editing')

    await act(async () => {
      await result.current.submit()
    })

    expect(sends(ethereum)).toHaveLength(0)
  })

  it('cancelling retires an in-flight answer', async () => {
    const held = deferred<unknown>()
    provider({ send: () => held.promise })

    const { result } = render()

    confirm(result)

    act(() => {
      void result.current.submit()
    })

    await waitFor(() => {
      expect(result.current.phase.kind).toBe('sending')
    })

    // Cancel is disabled while sending, and calls through it are refused too.
    act(() => {
      result.current.cancel()
    })

    expect(result.current.phase.kind).toBe('sending')

    await act(async () => {
      held.resolve(HASH)
      await Promise.resolve()
    })

    expect(result.current.phase.kind).toBe('submitted')
  })
})
