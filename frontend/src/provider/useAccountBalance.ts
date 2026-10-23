import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { describeProviderFailure, readInjectedProvider } from './injected.ts'
import { formatWei, parseQuantity } from './balance.ts'

/**
 * The native balance of the account the browser wallet reports, or an honest
 * statement that it was not read.
 *
 * `idle` is not an error and not an empty answer: it means this screen had no
 * reason to ask, because there is no account, the chain is not one the app
 * lists, or the catalog that would say so has not answered.
 */
export type BalanceState =
  | { status: 'idle' }
  | { status: 'loading' }
  /** The exact integer count of wei, as decimal digits. */
  | { status: 'loaded'; wei: string }
  | { status: 'error'; message: string }

const UNREADABLE_QUANTITY =
  'The wallet answered with something that is not a balance quantity.'

export type UseAccountBalanceOptions = {
  /** The account the wallet reports, or null when nothing is connected. */
  account: string | null
  /** The chain the wallet reports, or null when nothing is connected. */
  chainId: number | null
  /**
   * Whether this screen may ask. False until the catalog has said the chain is
   * one it lists, which is why a chain the app does not list is never queried.
   */
  enabled: boolean
  /** The scope the injected provider is read from. The window, in the app. */
  scope?: unknown
}

/**
 * One `eth_getBalance` read for one account on one chain.
 *
 * Three properties matter and each has a test.
 *
 * The request carries the current account and `latest`, and nothing else. It is a
 * read: it cannot prompt, cannot sign and cannot move anything.
 *
 * The answer is exact. It is parsed as a `bigint` and displayed as decimal wei,
 * so a balance above 2^53 is shown digit for digit rather than rounded.
 *
 * The answer is owned. A read is stamped with the account, chain, gate and
 * attempt that started it, and a result whose stamp is not the current one is
 * never displayed: not after an account change, not after a chain change, not
 * after a disconnect, not after a retry and not after unmount.
 */
export function useAccountBalance({
  account,
  chainId,
  enabled,
  scope = globalThis,
}: UseAccountBalanceOptions): {
  state: BalanceState
  retry: () => void
} {
  const provider = useMemo(() => readInjectedProvider(scope), [scope])

  /** A retry of the same account and chain, newest last. */
  const [nonce, setNonce] = useState(0)

  /**
   * How many times the gate has opened.
   *
   * The gate is the app's permission to ask: a listed chain, a connected account
   * and a catalog that has answered. When it closes and later reopens for the
   * same account and chain, that is a new permission, not the old one resumed,
   * and the figure from before the closure describes a moment the app has since
   * lost sight of. Counting the openings puts the closure into the stamp, so a
   * result from the previous opening can never match again.
   *
   * The transition is noticed during render rather than in an effect, because
   * the stamp is built during render and one frame of the old stamp is one frame
   * of the old figure.
   */
  const [opening, setOpening] = useState(0)
  const [gateWasOpen, setGateWasOpen] = useState(enabled)

  if (gateWasOpen !== enabled) {
    setGateWasOpen(enabled)

    if (enabled) {
      setOpening((current) => current + 1)
    }
  }

  /**
   * The last finished read, with the stamp it belongs to.
   *
   * Only completed reads are stored. `loading` is derived below from the absence
   * of a finished read for the current stamp, which is what keeps a superseded
   * result from appearing as the current one for even a frame.
   */
  const [result, setResult] = useState<
    { stamp: string; wei: string } | { stamp: string; message: string } | null
  >(null)

  const mountedRef = useRef(true)

  const stamp =
    enabled && account !== null && chainId !== null
      ? `${account}:${String(chainId)}:${String(nonce)}:${String(opening)}`
      : null

  const attemptRef = useRef(0)

  useEffect(() => {
    mountedRef.current = true

    return () => {
      mountedRef.current = false
      // A read that answers after the screen is gone settles nothing.
      attemptRef.current += 1
    }
  }, [])

  useEffect(() => {
    if (stamp === null || account === null || chainId === null || provider === null) {
      // A closed gate retires whatever is in flight. Its answer belongs to an
      // opening that is over, and storing it would only make it harder to see
      // that it must never be shown again.
      attemptRef.current += 1
      return
    }

    const live = provider
    const attempt = attemptRef.current + 1
    attemptRef.current = attempt

    void (async () => {
      let quantity: bigint | null

      try {
        quantity = parseQuantity(
          await live.request({
            method: 'eth_getBalance',
            // The account this read is for, at the head of the chain. No block
            // number and no historical read: the question is what this account
            // holds now.
            params: [account, 'latest'],
          }),
        )
      } catch (error) {
        if (attemptRef.current !== attempt || !mountedRef.current) {
          return
        }

        setResult({ stamp, message: describeProviderFailure(error) })
        return
      }

      if (attemptRef.current !== attempt || !mountedRef.current) {
        return
      }

      if (quantity === null) {
        setResult({ stamp, message: UNREADABLE_QUANTITY })
        return
      }

      setResult({ stamp, wei: formatWei(quantity) })
    })()
  }, [account, chainId, provider, stamp])

  /**
   * Starts the same read again, for a failure the user can reasonably repeat.
   *
   * The nonce is part of the stamp, so bumping it retires whatever is out and
   * shows `loading` until the new answer arrives.
   */
  const retry = useCallback((): void => {
    setNonce((current) => current + 1)
  }, [])

  const state: BalanceState = (() => {
    if (stamp === null) {
      return { status: 'idle' }
    }

    if (result !== null && result.stamp === stamp) {
      return 'wei' in result
        ? { status: 'loaded', wei: result.wei }
        : { status: 'error', message: result.message }
    }

    return { status: 'loading' }
  })()

  return { state, retry }
}
