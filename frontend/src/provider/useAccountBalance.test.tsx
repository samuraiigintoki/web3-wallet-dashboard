import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { deferred, installFakeProvider, removeFakeProvider } from '../test/fakeProvider.ts'
import { useAccountBalance } from './useAccountBalance.ts'

/**
 * The balance read on its own, with a provider this test drives.
 *
 * Every read here is held and released by hand, because the cases that matter
 * are the ones where an answer arrives after the account, the chain, the read
 * itself or the screen has moved on.
 */

const ACCOUNT = '0x1e1D0e1D0e1D0e1D0e1D0e1D0e1D0e1D0e1D0e1D'
const OTHER = '0x2e2E2e2E2e2E2e2E2e2E2e2E2e2E2e2E2e2E2e2E'
const ZERO = '0x0'
const ONE_ETHER = '0xde0b6b3a7640000'
const HUGE = '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

type Options = {
  account?: string | null
  chainId?: number | null
  enabled?: boolean
}

function render(options: Options = {}) {
  return renderHook(
    (props: Options) =>
      useAccountBalance({
        account: props.account === undefined ? ACCOUNT : props.account,
        chainId: props.chainId === undefined ? 1 : props.chainId,
        enabled: props.enabled === undefined ? true : props.enabled,
      }),
    { initialProps: options },
  )
}

/** The provider's record of what was asked, in order. */
function balanceCalls(provider: ReturnType<typeof installFakeProvider>) {
  return provider.calls.filter((call) => call.method === 'eth_getBalance')
}

afterEach(() => {
  removeFakeProvider()
})

describe('the read itself', () => {
  it('asks for the current account at latest, and shows the exact value', async () => {
    const provider = installFakeProvider({ answer: () => ONE_ETHER })

    const { result } = render()

    await waitFor(() => {
      expect(result.current.state).toEqual({ status: 'loaded', wei: '1000000000000000000' })
    })

    expect(provider.calls.map(({ method, params }) => ({ method, params }))).toEqual([
      { method: 'eth_getBalance', params: [ACCOUNT, 'latest'] },
    ])
  })

  it('shows zero as zero rather than treating it as no answer', async () => {
    installFakeProvider({ answer: () => ZERO })

    const { result } = render()

    await waitFor(() => {
      expect(result.current.state).toEqual({ status: 'loaded', wei: '0' })
    })
  })

  it('keeps a balance far above the safe integer range exact', async () => {
    installFakeProvider({ answer: () => HUGE })

    const { result } = render()

    await waitFor(() => {
      expect(result.current.state.status).toBe('loaded')
    })

    if (result.current.state.status !== 'loaded') {
      throw new Error('unreachable')
    }

    expect(result.current.state.wei).toBe(
      '115792089237316195423570985008687907853269984665640564039457584007913129639935',
    )
    expect(result.current.state.wei.length).toBe(78)
  })

  it('states a malformed answer without repeating it', async () => {
    installFakeProvider({ answer: () => 'a lot' })

    const { result } = render()

    await waitFor(() => {
      expect(result.current.state.status).toBe('error')
    })

    if (result.current.state.status !== 'error') {
      throw new Error('unreachable')
    }

    expect(result.current.state.message).toBe(
      'The wallet answered with something that is not a balance quantity.',
    )
    expect(result.current.state.message).not.toContain('a lot')
  })

  it('states a provider failure by its code, never by its message', async () => {
    installFakeProvider({
      answer: () => {
        throw { code: -32603, message: 'internal state 0xdeadbeef' }
      },
    })

    const { result } = render()

    await waitFor(() => {
      expect(result.current.state.status).toBe('error')
    })

    if (result.current.state.status !== 'error') {
      throw new Error('unreachable')
    }

    expect(result.current.state.message).toContain('-32603')
    expect(result.current.state.message).not.toContain('0xdeadbeef')
  })
})

describe('when the read may not happen', () => {
  it('asks nothing without an account', async () => {
    const provider = installFakeProvider({ answer: () => ONE_ETHER })

    const { result } = render({ account: null })

    expect(result.current.state).toEqual({ status: 'idle' })
    await Promise.resolve()

    expect(balanceCalls(provider)).toEqual([])
  })

  it('asks nothing without a chain', async () => {
    const provider = installFakeProvider({ answer: () => ONE_ETHER })

    const { result } = render({ chainId: null })

    expect(result.current.state).toEqual({ status: 'idle' })
    await Promise.resolve()

    expect(balanceCalls(provider)).toEqual([])
  })

  it('asks nothing while the gate is closed, and reads once it opens', async () => {
    const provider = installFakeProvider({ answer: () => ONE_ETHER })

    const { result, rerender } = render({ enabled: false })

    expect(result.current.state).toEqual({ status: 'idle' })
    await Promise.resolve()
    expect(balanceCalls(provider)).toEqual([])

    rerender({ enabled: true })

    await waitFor(() => {
      expect(result.current.state.status).toBe('loaded')
    })

    expect(balanceCalls(provider)).toHaveLength(1)
  })

  it('returns to idle, and drops the figure, when the gate closes again', async () => {
    installFakeProvider({ answer: () => ONE_ETHER })

    const { result, rerender } = render()

    await waitFor(() => {
      expect(result.current.state.status).toBe('loaded')
    })

    rerender({ enabled: false })

    expect(result.current.state).toEqual({ status: 'idle' })
  })
})

describe('a gate that closes and reopens', () => {
  it('hides the old figure until the new read answers', async () => {
    const second = deferred<string>()
    let reads = 0

    installFakeProvider({
      answer: () => {
        reads += 1
        // The first read answers at once; the read after reopening is held.
        return reads === 1 ? ONE_ETHER : second.promise
      },
    })

    const { result, rerender } = render()

    await waitFor(() => {
      expect(result.current.state).toEqual({ status: 'loaded', wei: '1000000000000000000' })
    })

    // The catalog stops confirming the chain, then confirms it again. Same
    // account, same chain, same component: a new permission to ask.
    rerender({ enabled: false })
    expect(result.current.state).toEqual({ status: 'idle' })

    rerender({ enabled: true })

    // The old figure must not reappear while the new read is outstanding.
    expect(result.current.state).toEqual({ status: 'loading' })

    await waitFor(() => {
      expect(reads).toBe(2)
    })

    expect(result.current.state).toEqual({ status: 'loading' })

    second.resolve(ZERO)

    await waitFor(() => {
      expect(result.current.state).toEqual({ status: 'loaded', wei: '0' })
    })
  })

  it('drops a read that finishes while the gate is closed', async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    let reads = 0

    installFakeProvider({
      answer: () => {
        reads += 1
        return reads === 1 ? first.promise : second.promise
      },
    })

    const { result, rerender } = render()

    await waitFor(() => {
      expect(result.current.state).toEqual({ status: 'loading' })
    })

    rerender({ enabled: false })
    expect(result.current.state).toEqual({ status: 'idle' })

    // The answer to the closed gate's read arrives now.
    first.resolve(ONE_ETHER)
    await Promise.resolve()
    expect(result.current.state).toEqual({ status: 'idle' })

    // Reopening starts a new read, and the figure from before the closure does
    // not come back while that read is out.
    rerender({ enabled: true })
    await waitFor(() => {
      expect(reads).toBe(2)
    })

    expect(result.current.state).toEqual({ status: 'loading' })

    second.resolve(ZERO)

    await waitFor(() => {
      expect(result.current.state).toEqual({ status: 'loaded', wei: '0' })
    })
  })

  it('still lets a retry inside one opening replace the figure it had', async () => {
    const held = deferred<string>()
    let reads = 0

    installFakeProvider({
      answer: () => {
        reads += 1
        return reads === 1 ? ONE_ETHER : held.promise
      },
    })

    const { result } = render()

    await waitFor(() => {
      expect(result.current.state.status).toBe('loaded')
    })

    act(() => {
      result.current.retry()
    })

    expect(result.current.state).toEqual({ status: 'loading' })

    held.resolve(ZERO)

    await waitFor(() => {
      expect(result.current.state).toEqual({ status: 'loaded', wei: '0' })
    })
  })
})

describe('answers that arrive too late', () => {
  it('never shows an older account balance after an account change', async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    let reads = 0

    installFakeProvider({
      answer: () => {
        reads += 1
        return reads === 1 ? first.promise : second.promise
      },
    })

    const { result, rerender } = render()

    await waitFor(() => {
      expect(reads).toBe(1)
    })

    rerender({ account: OTHER })

    await waitFor(() => {
      expect(reads).toBe(2)
    })

    second.resolve(ONE_ETHER)

    await waitFor(() => {
      expect(result.current.state).toEqual({ status: 'loaded', wei: '1000000000000000000' })
    })

    // The first account's answer lands last, with a value of its own.
    first.resolve('0x1')
    await Promise.resolve()

    expect(result.current.state).toEqual({ status: 'loaded', wei: '1000000000000000000' })
  })

  it('never shows a balance from the chain the wallet has left', async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    let reads = 0

    installFakeProvider({
      answer: () => {
        reads += 1
        return reads === 1 ? first.promise : second.promise
      },
    })

    const { result, rerender } = render({ chainId: 1 })

    await waitFor(() => {
      expect(reads).toBe(1)
    })

    rerender({ chainId: 137 })

    await waitFor(() => {
      expect(reads).toBe(2)
    })

    second.resolve(ZERO)

    await waitFor(() => {
      expect(result.current.state).toEqual({ status: 'loaded', wei: '0' })
    })

    first.resolve(ONE_ETHER)
    await Promise.resolve()

    expect(result.current.state).toEqual({ status: 'loaded', wei: '0' })
  })

  it('drops a held read when the wallet disconnects', async () => {
    const held = deferred<string>()

    installFakeProvider({ answer: () => held.promise })

    const { result, rerender } = render()

    await waitFor(() => {
      expect(result.current.state.status).toBe('loading')
    })

    rerender({ account: null, chainId: null, enabled: false })

    expect(result.current.state).toEqual({ status: 'idle' })

    held.resolve(ONE_ETHER)
    await Promise.resolve()

    expect(result.current.state).toEqual({ status: 'idle' })
  })

  it('shows nothing after unmount', async () => {
    const held = deferred<string>()

    installFakeProvider({ answer: () => held.promise })

    const { result, unmount } = render()

    await waitFor(() => {
      expect(result.current.state.status).toBe('loading')
    })

    unmount()

    held.resolve(ONE_ETHER)
    await Promise.resolve()

    expect(result.current.state.status).toBe('loading')
  })
})

describe('retrying', () => {
  it('asks again, and ignores the answer to the read it replaced', async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    let reads = 0

    installFakeProvider({
      answer: () => {
        reads += 1
        return reads === 1 ? first.promise : second.promise
      },
    })

    const { result } = render()

    await waitFor(() => {
      expect(reads).toBe(1)
    })

    act(() => {
      result.current.retry()
    })

    await waitFor(() => {
      expect(reads).toBe(2)
    })

    // While the retry is out the screen says so rather than showing the old
    // value as if it were current.
    expect(result.current.state).toEqual({ status: 'loading' })

    second.resolve(ZERO)

    await waitFor(() => {
      expect(result.current.state).toEqual({ status: 'loaded', wei: '0' })
    })

    first.resolve(ONE_ETHER)
    await Promise.resolve()

    expect(result.current.state).toEqual({ status: 'loaded', wei: '0' })
  })

  it('retries a failure with the same account and latest', async () => {
    const provider = installFakeProvider({
      answer: ({ call }) => {
        if (call === 1) {
          throw { code: -32603, message: 'internal' }
        }
        return ONE_ETHER
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
      expect(result.current.state).toEqual({ status: 'loaded', wei: '1000000000000000000' })
    })

    expect(provider.calls).toHaveLength(2)
    expect(provider.calls[1]?.params).toEqual([ACCOUNT, 'latest'])
  })
})
