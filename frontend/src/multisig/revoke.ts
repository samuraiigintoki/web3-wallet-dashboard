/**
 * Revoking your own confirmation: what is checked, and what is sent.
 *
 * `revokeConfirmation(uint256 _txIndex)` removes the caller's own confirmation
 * from one proposal. It is the exact inverse of `confirmTransaction` on the
 * contract, and this file is its inverse on this screen, so it reuses the same
 * ABI, the same decoders and the same tuple-to-event comparison rather than
 * keeping a second copy of any of them. What it does not reuse is the verdict:
 * confirming needs the account to have *not* confirmed, and revoking needs it to
 * have confirmed.
 *
 * The authority for "is my confirmation active" is `isConfirmed(index, account)`
 * read from the contract in this preflight. An indexed `ConfirmTransaction` event
 * is a record of something that happened, not a statement about the contract now:
 * the same owner may have revoked and confirmed again since, and a screen that
 * trusted the event would offer to revoke a confirmation that is not there.
 *
 * Selector: `revokeConfirmation(uint256)` is `0x20ea8d86`, computed with `viem`'s
 * `toFunctionSelector` and found in the runtime bytecode deployed at
 * `0x5B324F41E5889cf94CbA8e909089683a1a97c318` on chain 11155111, next to
 * `confirmTransaction` (`0xc01a8c84`) and `executeTransaction` (`0xee22610b`).
 */

import { encodeFunctionData, type Abi } from 'viem'

import type { ContractEvent, SubmitTransactionPayload } from '../api/index.ts'
import type { BrowserWalletState } from '../provider/useBrowserWallet.ts'
import { SEPOLIA_CHAIN_ID } from '../provider/multisig.ts'
import {
  checkEligibility,
  proposalMatchesEvent,
  type Eligibility,
  type EligibilityRefusal,
  type PreflightOutcome,
  type PreflightReads,
} from './confirm.ts'
import { walletGate, type MultisigGate } from './gate.ts'

/** `revokeConfirmation(uint256)`, the one call this slice sends. */
export const REVOKE_SELECTOR = '0x20ea8d86'

export const REVOKE_ABI = [
  {
    type: 'function',
    name: 'revokeConfirmation',
    stateMutability: 'nonpayable',
    inputs: [{ name: '_txIndex', type: 'uint256' }],
    outputs: [],
  },
] as const satisfies Abi

/**
 * The calldata for one revocation.
 *
 * One 32-byte word, the row's own index, encoded by `viem`. The tests pin the
 * exact bytes because a wrong word here would revoke a confirmation on a
 * different proposal.
 */
export function encodeRevokeTransaction(index: bigint): string {
  return encodeFunctionData({
    abi: REVOKE_ABI,
    functionName: 'revokeConfirmation',
    args: [index],
  }).toLowerCase()
}

/**
 * The same eligibility rule as confirming, in revoking's own words.
 *
 * The rule is checked once, in `checkEligibility`, and only the sentence differs:
 * a user pressing "Revoke my confirmation" on a row that is not a submission
 * should be told about revoking. The refusal code carries the rule across, so the
 * two actions cannot drift apart.
 */
const REVOKE_REFUSALS: Record<EligibilityRefusal, string> = {
  'not-submission': 'Only a submitted proposal can have a confirmation revoked.',
  'other-contract': 'Revoking is only available on the verified Sepolia multisig contract.',
  'other-chain': `Revoking is only available on chain ${String(SEPOLIA_CHAIN_ID)}.`,
  'unreadable-index': 'This event does not name a proposal this app can read.',
  'unreadable-payload': 'This event does not carry the proposal this app can read.',
}

export function checkRevokeEligibility(
  event: ContractEvent,
  contractAddress: string,
  contractChainId: number,
): Eligibility {
  const eligibility = checkEligibility(event, contractAddress, contractChainId)

  if (eligibility.eligible) {
    return eligibility
  }

  return {
    eligible: false,
    refusal: eligibility.refusal,
    reason: REVOKE_REFUSALS[eligibility.refusal],
  }
}

/** The gate for revoking, worded for revoking. */
export function revokeGate(
  contractAddress: string,
  contractChainId: number,
  wallet: BrowserWalletState,
): MultisigGate {
  return walletGate(contractAddress, contractChainId, wallet, {
    unavailable: 'Revoking is only available on the verified Sepolia multisig contract.',
    connect: 'Connect a wallet to revoke your confirmation.',
  })
}

/**
 * The verdict on the four reads for a revocation.
 *
 * The order is the order the contract itself would refuse, and each refusal is
 * its own sentence because each is a different thing to do. The one that matters
 * most here is the fourth: an account that has not confirmed this proposal has
 * nothing to revoke, and offering the action anyway would produce a wallet prompt
 * that can only revert.
 *
 * The last check is this app's own, and it is the same one confirming makes: the
 * contract's proposal has to be the one the event describes, or the index is not
 * trustworthy evidence of which confirmation would be revoked.
 */
export function evaluateRevokePreflight(
  reads: PreflightReads,
  index: bigint,
  payload: SubmitTransactionPayload,
): PreflightOutcome {
  if (!reads.isOwner) {
    return {
      ok: false,
      reason:
        'The connected account is not an owner of this contract, so it cannot revoke a confirmation.',
    }
  }

  if (index >= reads.transactionCount) {
    return { ok: false, reason: 'The contract has no proposal at this index.' }
  }

  if (reads.proposal.executed) {
    return { ok: false, reason: 'This proposal has already been executed.' }
  }

  if (!reads.alreadyConfirmed) {
    return {
      ok: false,
      reason: 'This account has not confirmed this proposal, so there is no confirmation to revoke.',
    }
  }

  if (!proposalMatchesEvent(reads.proposal, payload)) {
    return {
      ok: false,
      reason:
        "The contract's record of this proposal does not match the indexed event, so this app will not revoke a confirmation on it.",
    }
  }

  return {
    ok: true,
    preflight: {
      index,
      indexText: index.toString(10),
      data: encodeRevokeTransaction(index),
      proposal: reads.proposal,
    },
  }
}
