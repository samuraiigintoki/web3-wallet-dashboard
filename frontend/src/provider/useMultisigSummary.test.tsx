import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { deferred, installFakeProvider, removeFakeProvider } from '../test/fakeProvider.ts'
import { MULTISIG_ADDRESS, SELECTOR_GET_OWNERS, SELECTOR_THRESHOLD, SELECTOR_TRANSACTION_COUNT } from './multisig.ts'
import { useMultisigSummary } from './useMultisigSummary.ts'

/**
 * The contract read on its own, with a provider this test drives.
 *
 * The cases that matter are the ones a wallet makes possible: an answer that
 * arrives after the chain moved, a gate that closes mid-read, and a contract
 * that answers with something the ABI cannot have produced.
 */

const ACCOUNT = '0x1e1D0e1D0e1D0e1D0e1D0e1D0e1D0e1D0e1D0e1D'
const OTHER = '0x2e2E2e2E2e2E2e2E2e2E2e2E2e2E2e2E2e2E2e2E'
const OWNER = '0x14912965632cd9ab70c046e8d23e9b8dfa9f2746'

function word(hex: string): string {
  return hex.padStart(64, '0')
}

/** Exactly what the deployment answers for `getOwners()`. */
const OWNERS_ONE =
  '0x' +
  word('20') +
  word('1') +
  word('14912965632cd9ab70c046e8d23e9b8dfa9f2746')

const THRESHOLD_ONE = `0x${word('1')}`
const COUNT_ZERO = `0x${word('0')}`

type Answer = (data: string) => unknown

const ANSWERS: Record<string, string> = {
  [SELECTOR_GET_OWNERS]: OWNERS_ONE,
  [SELECTOR_THRESHOLD]: THRESHOLD_ONE,
  [SELECTOR_TRANSACTION_COUNT]: COUNT_ZERO,
}

function answering(overrides: Partial<Record<string, unknown>> = {}): Answer {
  return (data) => {
    if (data in overrides) {
      return overrides[data]
    }

    return ANSWERS[data] ?? '0x'
  }
}

type Options = {
  account?: string | null
  chainId?: number | null
  enabled?: boolean
}

function render(options: Options = {}) {
  return renderHook(
    (props: Options) =>
      useMultisigSummary({
        account: props.account === undefined ? ACCOUNT : props.account,
        chainId: props.chainId === undefined ? 11155111 : props.chainId,
        enabled: props.enabled === undefined ? true : props.enabled,
      }),
    { initialProps: options },
  )
}

afterEach(() => {
  removeFakeProvider()
})

describe('the read', () => {
  it('asks the contract three questions, by selector, at latest', async () => {
    const provider = installFakeProvider({ answer: ({ params }) => {
      const call = params?.[0] as { to?: string; data?: string } | undefined
      return answering()(call?.data ?? '')
    } })

    const { result } = render()

    await waitFor(() => {
      expect(result.current.state.status).toBe('loaded')
    })

    expect(provider.calls.map((call) => call.method)).toEqual(['eth_call', 'eth_call', 'eth_call'])

    const requests = provider.calls.map((call) => call.params as unknown[])

    for (const [index, selector] of [
      SELECTOR_GET_OWNERS,
      SELECTOR_THRESHOLD,
      SELECTOR_TRANSACTION_COUNT,
    ].entries()) {
      const [target, block] = requests[index] as [Record<string, unknown>, string]

      expect(target).toEqual({ to: MULTISIG_ADDRESS, data: selector })
      expect(block).toBe('latest')
    }
  })

  it('shows the deployment as it is: one owner, threshold 1, no transactions', async () => {
    installFakeProvider({ answer: ({ params }) => {
      const call = params?.[0] as { data?: string } | undefined
      return answering()(call?.data ?? '')
    } })

    const { result } = render()

    await waitFor(() => {
      expect(result.current.state).toEqual({
        status: 'loaded',
        owners: [OWNER],
        threshold: '1',
        transactionCount: '0',
      })
    })
  })

  it('keeps a large count exact', async () => {
    const huge = (2n ** 200n).toString(16)
    installFakeProvider({
      answer: ({ params }) => {
        const call = params?.[0] as { data?: string } | undefined
        return answering({ [SELECTOR_TRANSACTION_COUNT]: `0x${word(huge)}` })(call?.data ?? '')
      },
    })

    const { result } = render()

    await waitFor(() => {
      expect(result.current.state.status).toBe('loaded')
    })

    if (result.current.state.status !== 'loaded') {
      throw new Error('unreachable')
    }

    expect(result.current.state.transactionCount).toBe((2n ** 200n).toString(10))
  })
})

describe('what counts as unreadable', () => {
  it('refuses return data that is not the ABI shape', async () => {
    installFakeProvider({
      answer: ({ params }) => {
        const call = params?.[0] as { data?: string } | undefined
        // The owners answer is a bare word where an array belongs.
        return answering({ [SELECTOR_GET_OWNERS]: THRESHOLD_ONE })(call?.data ?? '')
      },
    })

    const { result } = render()

    await waitFor(() => {
      expect(result.current.state.status).toBe('error')
    })

    if (result.current.state.status !== 'error') {
      throw new Error('unreachable')
    }

    expect(result.current.state.message).toBe('The contract answered with data this app cannot read.')
  })

  it('refuses a summary the contract could not hold', async () => {
    // One owner, threshold two: the constructor rejects it, so the answer is not
    // this contract's state whatever it says.
    installFakeProvider({
      answer: ({ params }) => {
        const call = params?.[0] as { data?: string } | undefined
        return answering({ [SELECTOR_THRESHOLD]: `0x${word('2')}` })(call?.data ?? '')
      },
    })

    const { result } = render()

    await waitFor(() => {
      expect(result.current.state.status).toBe('error')
    })
  })

  it('reports a revert as a failure, without the provider message', async () => {
    installFakeProvider({
      answer: () => {
        throw { code: 3, message: 'execution reverted: MultiSigWallet__EmptyOwnersArray' }
      },
    })

    const { result } = render()

    await waitFor(() => {
      expect(result.current.state.status).toBe('error')
    })

    if (result.current.state.status !== 'error') {
      throw new Error('unreachable')
    }

    expect(result.current.state.message).toContain('3')
    expect(result.current.state.message).not.toContain('MultiSigWallet__EmptyOwnersArray')
  })

  it('retries a failed read with the same three questions', async () => {
    let attempt = 0
    const provider = installFakeProvider({
      answer: ({ params }) => {
        const call = params?.[0] as { data?: string } | undefined
        attempt += 1

        if (attempt === 1) {
          throw { code: -32603, message: 'internal' }
        }

        return answering()(call?.data ?? '')
      },
    })

    const { result } = render()

    await waitFor(() => {
      expect(result.current.state.status).toBe('error')
    })

    act(() => {
      result.current.retry()
    })

    await waitFor(() => {
      expect(result.current.state.status).toBe('loaded')
    })

    expect(provider.calls).toHaveLength(4)
    expect(provider.calls.filter((call) => call.method !== 'eth_call')).toEqual([])
  })
})

describe('when the read may not happen', () => {
  it('asks nothing without an account, without a chain, or with the gate closed', async () => {
    const provider = installFakeProvider({ answer: () => OWNERS_ONE })

    const none = render({ account: null })
    expect(none.result.current.state).toEqual({ status: 'idle' })

    const noChain = render({ chainId: null })
    expect(noChain.result.current.state).toEqual({ status: 'idle' })

    const closed = render({ enabled: false })
    expect(closed.result.current.state).toEqual({ status: 'idle' })

    await Promise.resolve()

    expect(provider.calls).toEqual([])
  })

  it('reads once the gate opens, and drops the summary when it closes', async () => {
    installFakeProvider({
      answer: ({ params }) => {
        const call = params?.[0] as { data?: string } | undefined
        return answering()(call?.data ?? '')
      },
    })

    const { result, rerender } = render({ enabled: false })

    rerender({ enabled: true })

    await waitFor(() => {
      expect(result.current.state.status).toBe('loaded')
    })

    rerender({ enabled: false })

    expect(result.current.state).toEqual({ status: 'idle' })
  })
})

describe('answers that arrive too late', () => {
  it('never shows a summary for the chain the wallet has left', async () => {
    const firstOwners = deferred<string>()
    const secondOwners = deferred<string>()
    let ownerReads = 0

    installFakeProvider({
      answer: ({ params }) => {
        const call = params?.[0] as { data?: string } | undefined
        const data = call?.data ?? ''

        if (data === SELECTOR_GET_OWNERS) {
          ownerReads += 1
          return ownerReads === 1 ? firstOwners.promise : secondOwners.promise
        }

        return answering()(data)
      },
    })

    const { result, rerender } = render({ chainId: 11155111 })

    await waitFor(() => {
      expect(ownerReads).toBe(1)
    })

    // The app closes the gate the moment the chain is not Sepolia, which is the
    // path a real user takes when their wallet moves.
    rerender({ chainId: 1, enabled: false })

    // The Sepolia read is still open and answers last, with a different owner
    // set. It must not land on the screen.
    firstOwners.resolve(
      `0x${word('20')}${word('1')}${word('2222222222222222222222222222222222222222')}`,
    )
    await Promise.resolve()

    expect(result.current.state).toEqual({ status: 'idle' })
  })

  it('never shows a held Sepolia answer after the gate reopens for it', async () => {
    const firstOwners = deferred<string>()
    const secondOwners = deferred<string>()
    let ownerReads = 0

    installFakeProvider({
      answer: ({ params }) => {
        const call = params?.[0] as { data?: string } | undefined
        const data = call?.data ?? ''

        if (data === SELECTOR_GET_OWNERS) {
          ownerReads += 1
          return ownerReads === 1 ? firstOwners.promise : secondOwners.promise
        }

        return answering()(data)
      },
    })

    const { result, rerender } = render()

    await waitFor(() => {
      expect(ownerReads).toBe(1)
    })

    rerender({ enabled: false })
    rerender({ enabled: true })

    await waitFor(() => {
      expect(ownerReads).toBe(2)
    })

    // The read from before the closure answers now. It belongs to a permission
    // that is over, so the screen keeps waiting for the current read.
    firstOwners.resolve(
      `0x${word('20')}${word('1')}${word('7777777777777777777777777777777777777777')}`,
    )
    await Promise.resolve()

    expect(result.current.state).toEqual({ status: 'loading' })

    secondOwners.resolve(
      `0x${word('20')}${word('1')}${word('8888888888888888888888888888888888888888')}`,
    )

    await waitFor(() => {
      expect(result.current.state.status).toBe('loaded')
    })

    if (result.current.state.status !== 'loaded') {
      throw new Error('unreachable')
    }

    expect(result.current.state.owners).toEqual(['0x8888888888888888888888888888888888888888'])
  })

  it('never shows a summary for the account the wallet has left', async () => {
    const first = deferred<string>()
    let ownerReads = 0

    installFakeProvider({
      answer: ({ params }) => {
        const call = params?.[0] as { data?: string } | undefined
        const data = call?.data ?? ''

        if (data === SELECTOR_GET_OWNERS) {
          ownerReads += 1
          return ownerReads === 1 ? first.promise : `0x${word('20')}${word('1')}${word('3333333333333333333333333333333333333333')}`
        }

        return answering()(data)
      },
    })

    const { result, rerender } = render()

    await waitFor(() => {
      expect(ownerReads).toBe(1)
    })

    rerender({ account: OTHER })

    await waitFor(() => {
      expect(result.current.state.status).toBe('loaded')
    })

    if (result.current.state.status !== 'loaded') {
      throw new Error('unreachable')
    }

    expect(result.current.state.owners).toEqual(['0x3333333333333333333333333333333333333333'])

    first.resolve(`0x${word('20')}${word('1')}${word('4444444444444444444444444444444444444444')}`)
    await Promise.resolve()

    if (result.current.state.status !== 'loaded') {
      throw new Error('unreachable')
    }

    expect(result.current.state.owners).toEqual(['0x3333333333333333333333333333333333333333'])
  })

  it('drops a held read when the gate closes, and does not revive it on reopening', async () => {
    const held = deferred<string>()
    let ownerReads = 0

    installFakeProvider({
      answer: ({ params }) => {
        const call = params?.[0] as { data?: string } | undefined
        const data = call?.data ?? ''

        if (data === SELECTOR_GET_OWNERS) {
          ownerReads += 1
          return ownerReads === 1 ? held.promise : `0x${word('20')}${word('1')}${word('5555555555555555555555555555555555555555')}`
        }

        return answering()(data)
      },
    })

    const { result, rerender } = render()

    await waitFor(() => {
      expect(ownerReads).toBe(1)
    })

    rerender({ enabled: false })
    expect(result.current.state).toEqual({ status: 'idle' })

    held.resolve(`0x${word('20')}${word('1')}${word('6666666666666666666666666666666666666666')}`)
    await Promise.resolve()

    expect(result.current.state).toEqual({ status: 'idle' })

    rerender({ enabled: true })

    expect(result.current.state).toEqual({ status: 'loading' })

    await waitFor(() => {
      expect(result.current.state.status).toBe('loaded')
    })

    if (result.current.state.status !== 'loaded') {
      throw new Error('unreachable')
    }

    expect(result.current.state.owners).toEqual(['0x5555555555555555555555555555555555555555'])
  })

  it('shows nothing after unmount', async () => {
    const held = deferred<string>()

    installFakeProvider({
      answer: ({ params }) => {
        const call = params?.[0] as { data?: string } | undefined
        return call?.data === SELECTOR_GET_OWNERS ? held.promise : answering()(call?.data ?? '')
      },
    })

    const { result, unmount } = render()

    await waitFor(() => {
      expect(result.current.state).toEqual({ status: 'loading' })
    })

    unmount()

    held.resolve(OWNERS_ONE)
    await Promise.resolve()

    expect(result.current.state).toEqual({ status: 'loading' })
  })
})

describe('what is never called', () => {
  it('issues read-only calls only', async () => {
    const provider = installFakeProvider({
      answer: ({ params }) => {
        const call = params?.[0] as { data?: string } | undefined
        return answering()(call?.data ?? '')
      },
    })

    const { result } = render()

    await waitFor(() => {
      expect(result.current.state.status).toBe('loaded')
    })

    const forbidden = [
      'eth_sendTransaction',
      'eth_sign',
      'personal_sign',
      'eth_signTypedData',
      'eth_signTypedData_v4',
      'wallet_switchEthereumChain',
      'wallet_addEthereumChain',
      'eth_estimateGas',
      'eth_sendRawTransaction',
    ]

    for (const method of forbidden) {
      expect(provider.requested).not.toContain(method)
    }

    // And the only methods this hook asks for at all.
    expect([...new Set(provider.requested)]).toEqual(['eth_call'])
  })
})
