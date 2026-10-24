import { useMemo } from 'react'

import type { SubmitTransactionPayload } from '../api/index.ts'
import type { BrowserWalletState } from '../provider/useBrowserWallet.ts'
import {
  executeGate,
  runExecution,
  type ExecutePreflight,
} from './execute.ts'
import type { MultisigGate } from './gate.ts'
import { useMultisigAction, type MultisigActionPhase } from './useMultisigAction.ts'

/**
 * Executing one threshold-satisfied proposal.
 *
 * The procedure is the shared one: a preflight, a review, one dispatch, one stamp
 * per phase, an account and chain recheck immediately before sending, and one
 * send at a time. What is here is what makes this executing: the gate's
 * sentences, the anchored reads and the verdict, and the wider preflight the
 * review is built from.
 */
export type ExecutePhase = MultisigActionPhase<ExecutePreflight>

/** A refusal in the wallet, for this action. */
const DECLINED = 'The execution was declined in the wallet.'

export type UseExecuteTransactionOptions = {
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

export function useExecuteTransaction({
  contractAddress,
  contractChainId,
  index,
  payload,
  wallet,
  scope = globalThis,
}: UseExecuteTransactionOptions): {
  phase: ExecutePhase
  gate: MultisigGate
  check: () => Promise<void>
  cancel: () => void
  submit: () => Promise<void>
  retry: () => void
} {
  const gate = useMemo(
    () => executeGate(contractAddress, contractChainId, wallet),
    [contractAddress, contractChainId, wallet],
  )

  return useMultisigAction<ExecutePreflight>({
    contractAddress,
    contractChainId,
    index,
    payload,
    wallet,
    gate,
    run: runExecution,
    declined: DECLINED,
    scope,
  })
}
