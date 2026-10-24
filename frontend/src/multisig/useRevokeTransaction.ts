import { useMemo } from 'react'

import type { SubmitTransactionPayload } from '../api/index.ts'
import type { BrowserWalletState } from '../provider/useBrowserWallet.ts'
import type { PreflightOutcome, PreflightReads } from './confirm.ts'
import { evaluateRevokePreflight, revokeGate } from './revoke.ts'
import { useMultisigAction, type MultisigActionPhase } from './useMultisigAction.ts'

/**
 * Revoking your own confirmation on one indexed proposal.
 *
 * The procedure is the one in `useMultisigAction`, shared with confirming: four
 * read-only calls, a review, one dispatch, one stamp per phase. What is here is
 * what makes this revoking: the gate's sentences, the verdict that refuses an
 * account whose confirmation is not there, and the calldata.
 */
export type RevokePhase = MultisigActionPhase

export type RevokeGate = { open: boolean; reason: string }

/** A refusal in the wallet, for this action. */
const DECLINED = 'The revocation was declined in the wallet.'

export type UseRevokeTransactionOptions = {
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

export function useRevokeTransaction({
  contractAddress,
  contractChainId,
  index,
  payload,
  wallet,
  scope = globalThis,
}: UseRevokeTransactionOptions): {
  phase: RevokePhase
  gate: RevokeGate
  check: () => Promise<void>
  cancel: () => void
  submit: () => Promise<void>
  retry: () => void
} {
  const gate = useMemo(
    () => revokeGate(contractAddress, contractChainId, wallet),
    [contractAddress, contractChainId, wallet],
  )

  return useMultisigAction({
    contractAddress,
    contractChainId,
    index,
    payload,
    wallet,
    gate,
    decide: decideRevocation,
    declined: DECLINED,
    scope,
  })
}

/** The verdict, held at module scope so the hook sees a stable function. */
function decideRevocation(
  reads: PreflightReads,
  index: bigint,
  payload: SubmitTransactionPayload,
): PreflightOutcome {
  return evaluateRevokePreflight(reads, index, payload)
}
