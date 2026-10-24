import { useCallback, useEffect, useMemo, useRef } from 'react'

import type { SubmitTransactionPayload } from '../api/index.ts'
import {
  describeProviderFailure,
  readInjectedProvider,
} from '../provider/injected.ts'
import type { BrowserWalletState } from '../provider/useBrowserWallet.ts'
import { encodeRead } from './confirm.ts'
import type { MultisigGate } from './gate.ts'
import { runStatus, statusGate, type StatusOutcome } from './status.ts'
import type { ActionReadContext } from './useMultisigAction.ts'
import { useStampedState } from './useStampedState.ts'

/**
 * Reading one proposal's live status.
 *
 * Read-only, so it is not the write hook with its checks disabled: there is no
 * review, no dispatch, no acknowledgement and no receipt here, and nothing in
 * this file can call `eth_sendTransaction`. What it keeps from the write actions
 * is their lifetime rule, which a read needs just as much: an answer stamped with
 * an account, chain, contract or index that has since changed is not this row's
 * answer any more, so it is neither drawn nor kept.
 *
 * Nothing is read until the user asks. There is no effect that reads on mount, no
 * interval, and no reread after a result: the only way a new read happens is
 * another press.
 */
export type StatusPhase =
  | { kind: 'idle' }
  | { kind: 'reading' }
  | { kind: 'done'; outcome: StatusOutcome & { kind: 'live' | 'absent' } }
  | { kind: 'refused'; reason: string }

export type UseProposalStatusOptions = {
  /** The tracked contract's address, as the server record has it. */
  contractAddress: string
  /** The tracked contract's chain, as the server record has it. */
  contractChainId: number
  /** The proposal index from this row's event. */
  index: bigint
  /** This row's event payload, which the contract's own record must match. */
  payload: SubmitTransactionPayload
  /** The browser wallet, for its state as well as its account and chain. */
  wallet: BrowserWalletState
  /** The scope the injected provider is read from. The window, in the app. */
  scope?: unknown
}

export function useProposalStatus({
  contractAddress,
  contractChainId,
  index,
  payload,
  wallet,
  scope = globalThis,
}: UseProposalStatusOptions): {
  phase: StatusPhase
  gate: MultisigGate
  read: () => Promise<void>
  clear: () => void
} {
  const provider = useMemo(() => readInjectedProvider(scope), [scope])

  const gate = useMemo(
    () => statusGate(contractAddress, contractChainId, wallet),
    [contractAddress, contractChainId, wallet],
  )

  const account = wallet.status === 'connected' ? wallet.account : null
  const chainId = wallet.status === 'connected' ? wallet.chainId : null
  const accountArg = account === null ? null : account.toLowerCase()

  const stamp =
    account === null || chainId === null
      ? null
      : `${accountArg}:${String(chainId)}:${contractAddress.toLowerCase()}:${index.toString(10)}`

  const { value: stored, set: setStored } = useStampedState<StatusPhase>(stamp)

  const mountedRef = useRef(true)
  const attemptRef = useRef(0)

  useEffect(() => {
    mountedRef.current = true

    return () => {
      mountedRef.current = false
      attemptRef.current += 1
    }
  }, [])


  /**
   * A change of account, chain, contract or index retires any read in flight.
   *
   * The stamp alone would not be enough: a wallet that moves away and back again
   * restores the old stamp, and an answer that was requested before the move
   * would then be drawn as if nothing had happened. Bumping the attempt here
   * makes the move final for anything already in flight, and starts nothing.
   */
  useEffect(() => {
    attemptRef.current += 1
  }, [stamp])

  const read = useCallback(async (): Promise<void> => {
    const live = provider

    if (live === null || stamp === null || accountArg === null || !gate.open) {
      return
    }

    const attempt = attemptRef.current + 1
    attemptRef.current = attempt

    const current = (): boolean => attemptRef.current === attempt && mountedRef.current

    const settle = (next: StatusPhase): void => {
      if (current()) {
        setStored(next)
      }
    }

    setStored({ kind: 'reading' })

    const context: ActionReadContext = {
      account: accountArg,
      index,
      payload,
      encode: encodeRead,
      call: async (data: string, blockTag = 'latest'): Promise<unknown> =>
        await live.request({
          method: 'eth_call',
          params: [{ to: contractAddress, data }, blockTag],
        }),
      request: async (method: string, params?: readonly unknown[]): Promise<unknown> =>
        await live.request(params === undefined ? { method } : { method, params }),
      live: current,
    }

    try {
      const outcome = await runStatus(context)

      // Retired mid-read: the row, the account or the screen changed, so there is
      // nothing to say about this answer.
      if (outcome === null) {
        return
      }

      settle(
        outcome.kind === 'refused'
          ? { kind: 'refused', reason: outcome.reason }
          : { kind: 'done', outcome },
      )
    } catch (error) {
      settle({ kind: 'refused', reason: describeProviderFailure(error) })
    }
  }, [accountArg, contractAddress, gate.open, index, payload, provider, setStored, stamp])

  /** Leaves the result without reading again. */
  const clear = useCallback((): void => {
    attemptRef.current += 1
    setStored(null)
  }, [setStored])

  const phase: StatusPhase = stored ?? { kind: 'idle' }

  return { phase, gate, read, clear }
}
