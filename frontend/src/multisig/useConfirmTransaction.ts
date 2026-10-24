import { useMemo } from 'react'

import type { SubmitTransactionPayload } from '../api/index.ts'
import type { BrowserWalletState } from '../provider/useBrowserWallet.ts'
import { runConfirmation } from './reads.ts'
import { walletGate } from './gate.ts'
import { useMultisigAction, type MultisigActionPhase } from './useMultisigAction.ts'

/**
 * Confirming one indexed proposal.
 *
 * Everything about how the four reads, the review, the one dispatch and the
 * lifetime stamps work lives in `useMultisigAction`, because revoking is the same
 * procedure with the opposite verdict. What is here is only what makes this
 * confirming: the gate's sentences, the verdict that refuses an already confirmed
 * proposal, and the calldata.
 */
export type ConfirmPhase = MultisigActionPhase

export type ConfirmGate = { open: boolean; reason: string }

/**
 * The gate for confirming.
 *
 * A confirmation is addressed to one fixed contract on one fixed chain, so the
 * wallet has to be connected to that chain before anything is read: an `eth_call`
 * is answered by whichever chain the wallet is on, and reads from another chain
 * would describe a different contract at the same address.
 */
export function confirmGate(
  contractAddress: string,
  contractChainId: number,
  wallet: BrowserWalletState,
): ConfirmGate {
  return walletGate(contractAddress, contractChainId, wallet, {
    unavailable: 'Confirming is only available on the verified Sepolia multisig contract.',
    connect: 'Connect a wallet to confirm a proposal.',
  })
}

/** A refusal in the wallet, for this action. */
const DECLINED = 'The confirmation was declined in the wallet.'

export type UseConfirmTransactionOptions = {
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

export function useConfirmTransaction({
  contractAddress,
  contractChainId,
  index,
  payload,
  wallet,
  scope = globalThis,
}: UseConfirmTransactionOptions): {
  phase: ConfirmPhase
  gate: ConfirmGate
  check: () => Promise<void>
  cancel: () => void
  submit: () => Promise<void>
  retry: () => void
} {
  const gate = useMemo(
    () => confirmGate(contractAddress, contractChainId, wallet),
    [contractAddress, contractChainId, wallet],
  )

  return useMultisigAction({
    contractAddress,
    contractChainId,
    index,
    payload,
    wallet,
    gate,
    run: runConfirmation,
    declined: DECLINED,
    scope,
  })
}
