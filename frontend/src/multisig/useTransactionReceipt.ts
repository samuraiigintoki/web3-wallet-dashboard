import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { describeProviderFailure, readInjectedProvider } from '../provider/injected.ts'
import type { BrowserWalletState } from '../provider/useBrowserWallet.ts'
import {
  parseTransactionReceipt,
  type ReceiptRefusal,
  type ReceiptOutcome,
} from './receipt.ts'
import type { SubmitTarget } from './useSubmitTransaction.ts'

/**
 * What the last manual check of the receipt found.
 *
 * `none` is the provider saying it has no receipt for this hash right now. It is
 * not an error, and it is not evidence that the transaction was dropped: a
 * transaction that is still pending and one that was never broadcast are the same
 * answer from here. `included` says only that the transaction is in a block and
 * whether the call reverted in it.
 */
export type ReceiptState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'none' }
  | { kind: 'included'; success: boolean; blockNumber: string; blockHash: string }
  | { kind: 'error'; message: string }

/** Why the check is not offered, when it is not. */
export type ReceiptGate = { available: boolean; reason: string }

const MALFORMED = 'The wallet answered with something that is not a transaction receipt.'

const REFUSALS: Record<ReceiptRefusal, string> = {
  malformed: MALFORMED,
  'other-transaction':
    'The wallet answered about a different transaction, so the answer was not used.',
  'other-contract':
    'The wallet answered about a transaction to a different contract, so the answer was not used.',
}

export type UseTransactionReceiptOptions = {
  /** The hash the wallet returned. In memory for this screen only. */
  hash: string
  /** The tracked contract the transaction was addressed to. */
  contract: SubmitTarget
  /** The browser wallet, for its state as well as its account and chain. */
  wallet: BrowserWalletState
  /** The scope the injected provider is read from. The window, in the app. */
  scope?: unknown
}

/**
 * The chain and the account still have to be the ones the hash belongs to.
 *
 * A receipt is addressable by hash from any chain, so a wallet that switches
 * chain would happily answer about a hash it knows nothing about, and another
 * chain's node could hold a different transaction under the same identifier. The
 * read is only offered when the wallet is connected to the contract's chain.
 */
export function receiptGate(
  contract: SubmitTarget,
  wallet: BrowserWalletState,
): ReceiptGate {
  switch (wallet.status) {
    case 'checking':
      return { available: false, reason: 'Checking the browser wallet.' }
    case 'unsupported':
      return { available: false, reason: 'No browser wallet was found in this browser.' }
    case 'error':
      return { available: false, reason: 'The browser wallet could not be read.' }
    case 'connecting':
      return { available: false, reason: 'Waiting for the wallet to grant access.' }
    case 'disconnected':
      return { available: false, reason: 'No connected account.' }
    case 'connected':
      break
  }

  if (wallet.chainId !== contract.chainId) {
    return {
      available: false,
      reason: `The wallet is on chain ${String(wallet.chainId)}, and this transaction was submitted on chain ${String(
        contract.chainId,
      )}.`,
    }
  }

  return { available: true, reason: '' }
}

/**
 * One manual `eth_getTransactionReceipt`, per click, for one submitted hash.
 *
 * The rules, and what each is for:
 *
 * - Read only. The only method this hook calls is `eth_getTransactionReceipt`,
 *   with the hash and nothing else. It cannot send, sign or spend.
 * - One request per click. A press while a check is in flight does nothing, so a
 *   user who clicks twice cannot make the wallet answer twice.
 * - No polling and no retry. There is no interval, no backoff and no automatic
 *   second attempt; a null answer stands until the user asks again, and a failure
 *   waits for the user to decide.
 * - Killed by context. Every result is stamped with the hash, the contract, the
 *   chain and the account, and an answer whose stamp is no longer current is
 *   dropped: a changed hash, a changed contract, a chain change, a different
 *   account, a newer check or an unmount all make an older answer describe a
 *   situation this screen has lost sight of.
 * - Redacted. A provider failure is reported through `describeProviderFailure`,
 *   which never repeats the provider's own text, and a malformed or mismatched
 *   answer gets this module's own sentence rather than anything the wallet said.
 *
 * Nothing here makes a receipt final. A later check of the same hash may answer
 * differently after a reorg, and the interface says "included", not "confirmed".
 */
export function useTransactionReceipt({
  hash,
  contract,
  wallet,
  scope = globalThis,
}: UseTransactionReceiptOptions): {
  state: ReceiptState
  gate: ReceiptGate
  check: () => Promise<void>
} {
  const provider = useMemo(() => readInjectedProvider(scope), [scope])

  const account = wallet.status === 'connected' ? wallet.account : null
  const chainId = wallet.status === 'connected' ? wallet.chainId : null

  const stamp =
    account === null || chainId === null
      ? null
      : `${account.toLowerCase()}:${String(chainId)}:${String(contract.id)}:${contract.address.toLowerCase()}:${hash.toLowerCase()}`

  const [lastStamp, setLastStamp] = useState<string | null>(stamp)
  const [stored, setStored] = useState<{ stamp: string; state: ReceiptState } | null>(null)

  /**
   * A change of hash, contract, chain or account drops what the old one said.
   *
   * Done during render, so no frame shows the previous context's receipt beside
   * the new context's hash. Not keeping it at all, rather than merely not drawing
   * it, is what stops an old success reappearing if the user navigates back to
   * the hash it belonged to.
   */
  if (lastStamp !== stamp) {
    setLastStamp(stamp)
    setStored(null)
  }

  const mountedRef = useRef(true)
  const attemptRef = useRef(0)
  const checkingRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true

    return () => {
      mountedRef.current = false
      attemptRef.current += 1
      checkingRef.current = false
    }
  }, [])

  const gate = receiptGate(contract, wallet)

  const state: ReceiptState =
    stored !== null && stamp !== null && stored.stamp === stamp ? stored.state : { kind: 'idle' }

  const check = useCallback(async (): Promise<void> => {
    const live = provider

    if (live === null || stamp === null || !gate.available) {
      return
    }

    if (checkingRef.current) {
      return
    }

    const attempt = attemptRef.current + 1
    attemptRef.current = attempt
    checkingRef.current = true

    const current = (): boolean => attemptRef.current === attempt && mountedRef.current

    const settle = (next: ReceiptState): void => {
      if (current()) {
        setStored({ stamp, state: next })
      }
    }

    setStored({ stamp, state: { kind: 'checking' } })

    try {
      let answer: unknown

      try {
        answer = await live.request({
          method: 'eth_getTransactionReceipt',
          params: [hash],
        })
      } catch (error) {
        settle({ kind: 'error', message: describeProviderFailure(error) })
        return
      }

      if (!current()) {
        return
      }

      const parsed = parseTransactionReceipt(answer, { hash, to: contract.address })

      if (!parsed.ok) {
        settle({ kind: 'error', message: REFUSALS[parsed.refusal] })
        return
      }

      settle(fromOutcome(parsed.outcome))
    } finally {
      checkingRef.current = false
    }
  }, [contract.address, gate.available, hash, provider, stamp])

  return { state, gate, check }
}

/** The receipt outcome as the state this hook exposes. */
function fromOutcome(outcome: ReceiptOutcome): ReceiptState {
  return outcome.kind === 'none'
    ? { kind: 'none' }
    : {
        kind: 'included',
        success: outcome.success,
        blockNumber: outcome.blockNumber,
        blockHash: outcome.blockHash,
      }
}
