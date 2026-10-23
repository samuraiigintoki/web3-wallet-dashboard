import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { describeProviderFailure, readInjectedProvider } from './injected.ts'
import { useGateOpening } from './gatedRead.ts'
import {
  decodeAddressArray,
  decodeUint256,
  formatCount,
  MULTISIG_ADDRESS,
  SELECTOR_GET_OWNERS,
  SELECTOR_THRESHOLD,
  SELECTOR_TRANSACTION_COUNT,
  summaryIsPlausible,
} from './multisig.ts'

/**
 * The multisig's owners, threshold and transaction count, or an honest statement
 * that it was not read.
 *
 * `idle` is not an empty answer: it means this screen had no permission to ask,
 * because nothing is connected, the wallet is on another chain, or the catalog
 * that would confirm the chain has not answered.
 */
export type MultisigState =
  | { status: 'idle' }
  | { status: 'loading' }
  | {
      status: 'loaded'
      owners: readonly string[]
      /** Decimal digits, exact. */
      threshold: string
      /** Decimal digits, exact. */
      transactionCount: string
    }
  | { status: 'error'; message: string }

const MALFORMED = 'The contract answered with data this app cannot read.'

export type UseMultisigSummaryOptions = {
  /** The chain the wallet reports, or null when nothing is connected. */
  chainId: number | null
  /** The account the wallet reports, which only ever contributes to the stamp. */
  account: string | null
  /** Whether this app may ask: the right chain, listed by a catalog that answered. */
  enabled: boolean
  /** The scope the injected provider is read from. The window, in the app. */
  scope?: unknown
}

/**
 * Three read-only `eth_call`s to one fixed contract, at `latest`.
 *
 * What this hook is careful about, and why:
 *
 * It cannot write. The requests carry a target address and a selector and
 * nothing else: no value, no sender, no transaction. A wallet given one of these
 * has nothing to sign.
 *
 * It cannot be redirected. The address and the selectors are constants in
 * `multisig.ts`, so no state, prop or provider answer can point the read at
 * another contract.
 *
 * It cannot show a stale summary. A read is stamped with the account, the chain,
 * the gate opening and a retry count, and an answer whose stamp is no longer
 * current is dropped. A held read that lands after a chain change is therefore
 * discarded rather than drawn as the current state of a different chain.
 *
 * Nothing here implies ownership. The account only contributes to the stamp: it
 * is never compared with the decoded owner list, because reading a contract says
 * nothing about who is allowed to act on it.
 */
export function useMultisigSummary({
  chainId,
  account,
  enabled,
  scope = globalThis,
}: UseMultisigSummaryOptions): {
  state: MultisigState
  retry: () => void
} {
  const provider = useMemo(() => readInjectedProvider(scope), [scope])

  const [nonce, setNonce] = useState(0)
  const opening = useGateOpening(enabled)

  const [result, setResult] = useState<
    | { stamp: string; owners: readonly string[]; threshold: string; transactionCount: string }
    | { stamp: string; message: string }
    | null
  >(null)

  const mountedRef = useRef(true)
  const attemptRef = useRef(0)

  const stamp =
    enabled && account !== null && chainId !== null
      ? `${account}:${String(chainId)}:${String(nonce)}:${String(opening)}`
      : null

  useEffect(() => {
    mountedRef.current = true

    return () => {
      mountedRef.current = false
      attemptRef.current += 1
    }
  }, [])

  useEffect(() => {
    if (stamp === null || provider === null) {
      // A closed gate retires whatever is in flight: its answer belongs to a
      // permission that is over.
      attemptRef.current += 1
      return
    }

    const live = provider
    const attempt = attemptRef.current + 1
    attemptRef.current = attempt

    /** True once this attempt has been superseded or the screen has gone. */
    const abandoned = (): boolean => attemptRef.current !== attempt || !mountedRef.current

    /** One read against the multisig, at the head of the chain. */
    const read = async (data: string): Promise<unknown> =>
      await live.request({
        method: 'eth_call',
        params: [{ to: MULTISIG_ADDRESS, data }, 'latest'],
      })

    void (async () => {
      let ownersRaw: unknown
      let thresholdRaw: unknown
      let countRaw: unknown

      try {
        // Sequential rather than concurrent: three requests to one wallet are
        // not worth a burst, and a wallet that serialises them anyway gains
        // nothing from being asked all at once.
        ownersRaw = await read(SELECTOR_GET_OWNERS)
        if (abandoned()) {
          return
        }

        thresholdRaw = await read(SELECTOR_THRESHOLD)
        if (abandoned()) {
          return
        }

        countRaw = await read(SELECTOR_TRANSACTION_COUNT)
        if (abandoned()) {
          return
        }
      } catch (error) {
        if (abandoned()) {
          return
        }

        // A revert arrives here: an `eth_call` that the contract refuses is a
        // provider error, and it is reported as one rather than as bad data.
        setResult({ stamp, message: describeProviderFailure(error) })
        return
      }

      const owners = decodeAddressArray(ownersRaw)
      const threshold = decodeUint256(thresholdRaw)
      const transactionCount = decodeUint256(countRaw)

      if (owners === null || threshold === null || transactionCount === null) {
        setResult({ stamp, message: MALFORMED })
        return
      }

      if (!summaryIsPlausible(owners, threshold)) {
        // Structurally readable but not a configuration this contract can hold.
        // Showing it would present a broken answer as the wallet's state.
        setResult({ stamp, message: MALFORMED })
        return
      }

      setResult({
        stamp,
        owners,
        threshold: formatCount(threshold),
        transactionCount: formatCount(transactionCount),
      })
    })()
  }, [provider, stamp])

  const retry = useCallback((): void => {
    setNonce((current) => current + 1)
  }, [])

  const state: MultisigState = (() => {
    if (stamp === null) {
      return { status: 'idle' }
    }

    if (result !== null && result.stamp === stamp) {
      return 'owners' in result
        ? {
            status: 'loaded',
            owners: result.owners,
            threshold: result.threshold,
            transactionCount: result.transactionCount,
          }
        : { status: 'error', message: result.message }
    }

    return { status: 'loading' }
  })()

  return { state, retry }
}
