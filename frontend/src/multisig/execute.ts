/**
 * Executing one threshold-satisfied proposal: what is checked, and what is sent.
 *
 * `executeTransaction(uint256 _txIndex)` is not like confirming or revoking. It
 * calls the proposal's destination with the proposal's value and calldata, so it
 * can move funds or run code in another contract. Everything in this file exists
 * because of that difference: the evidence is wider, the reads are anchored to
 * one block, and the refusals are stricter.
 *
 * What the contract itself does, from the source at `f34634c`,
 * `src/MultiSigWallet.sol`:
 *
 * - reverts with `MultiSigWallet__TxDoesNotExist` when the index is out of range,
 * - reverts with `MultiSigWallet__TxAlreadyExecuted` when the proposal is done,
 * - counts confirmations across the current owner set and reverts with
 *   `MultiSigWallet__NotEnoughConfirmations` when the count is below `threshold`,
 * - marks the proposal executed and then calls `to` with `value` and `data`,
 *   reverting with `MultiSigWallet__TxExecutionFailed` if that call fails,
 * - emits `ExecuteTransaction(msg.sender, _txIndex)` only on success,
 * - and is `onlyOwner`, so the caller has to be an owner.
 *
 * Note what it does not require: the caller need not be one of the confirming
 * owners. Requiring that here would refuse executions the contract would allow,
 * which is a different kind of wrong, so the preflight does not add it.
 *
 * Selector: `executeTransaction(uint256)` is `0xee22610b`, computed with `viem`'s
 * `toFunctionSelector` and found in the runtime bytecode deployed at
 * `0x5B324F41E5889cf94CbA8e909089683a1a97c318` on chain 11155111.
 */

import { encodeFunctionData, type Abi } from 'viem'

import type { ContractEvent, SubmitTransactionPayload } from '../api/index.ts'
import {
  decodeAddressArray,
  decodeUint256,
  summaryIsPlausible,
} from '../provider/multisig.ts'
import {
  blockTag,
  CONFIGURATION_ABI,
  decodeBlockNumber,
  encodeConfiguration,
  MAX_ANCHORED_OWNERS,
} from './anchored.ts'
import type { BrowserWalletState } from '../provider/useBrowserWallet.ts'
import {
  checkEligibility,
  decodeProposal,
  decodeBool,
  decodeUint,
  proposalMatchesEvent,
  type Eligibility,
  type EligibilityRefusal,
  type Preflight,
} from './confirm.ts'
import { walletGate, type MultisigGate } from './gate.ts'

/**
 * Re-exported from `anchored.ts`, where execution and status share them, so the
 * C7 tests and callers keep one import site.
 */
export { CONFIGURATION_ABI, decodeBlockNumber }
import {
  MALFORMED_ANSWER,
  type ActionOutcome,
  type ActionReadContext,
} from './useMultisigAction.ts'

/** `executeTransaction(uint256)`, the one call this slice sends. */
export const EXECUTE_SELECTOR = '0xee22610b'

export const EXECUTE_ABI = [
  {
    type: 'function',
    name: 'executeTransaction',
    stateMutability: 'nonpayable',
    inputs: [{ name: '_txIndex', type: 'uint256' }],
    outputs: [],
  },
] as const satisfies Abi

/**
 * The cap execution has used since C7, now the shared one in `anchored.ts`.
 *
 * Status reads one confirmation per owner for the same reason execution does, so
 * the number is one constant rather than two that could drift apart.
 */
export const MAX_EXECUTION_OWNERS = MAX_ANCHORED_OWNERS

/**
 * The calldata for one execution.
 *
 * One 32-byte word, the row's own index. The tests pin the exact bytes because a
 * wrong word here would execute a different proposal, with that proposal's
 * destination, value and calldata.
 */
export function encodeExecuteTransaction(index: bigint): string {
  return encodeFunctionData({
    abi: EXECUTE_ABI,
    functionName: 'executeTransaction',
    args: [index],
  }).toLowerCase()
}

/**
 * The same eligibility rule as the own-confirmation actions, in execution's
 * words. The rule is checked once and only the sentence differs.
 */
const EXECUTE_REFUSALS: Record<EligibilityRefusal, string> = {
  'not-submission': 'Only a submitted proposal can be executed.',
  'other-contract': 'Executing is only available on the verified Sepolia multisig contract.',
  'other-chain': 'Executing is only available on chain 11155111.',
  'unreadable-index': 'This event does not name a proposal this app can read.',
  'unreadable-payload': 'This event does not carry the proposal this app can read.',
}

export function checkExecuteEligibility(
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
    reason: EXECUTE_REFUSALS[eligibility.refusal],
  }
}

/** The gate for executing, worded for executing. */
export function executeGate(
  contractAddress: string,
  contractChainId: number,
  wallet: BrowserWalletState,
): MultisigGate {
  return walletGate(contractAddress, contractChainId, wallet, {
    unavailable: 'Executing is only available on the verified Sepolia multisig contract.',
    connect: 'Connect a wallet to execute a proposal.',
  })
}

/** Everything the execution preflight read, at one block. */
export type ExecuteReads = {
  /** The block every read in this preflight was anchored to. */
  block: bigint
  /** `isOwner(account)`, anchored. */
  isOwner: boolean
  /** `getTransactionCount()`, anchored. */
  transactionCount: bigint
  /** `transactions(index)`, anchored. */
  proposal: { to: string; valueWei: bigint; data: string; executed: boolean }
  /** `getOwners()`, anchored. */
  owners: readonly string[]
  /** `threshold()`, anchored. */
  threshold: bigint
  /** `isConfirmed(index, owner)` for each owner above, in the same order. */
  confirmations: readonly boolean[]
}

/** A preflight that passed, with everything the review has to restate. */
export type ExecutePreflight = Preflight & {
  /** The block all of this was read at, in decimal, for display. */
  block: string
  /** The contract's threshold at that block. */
  threshold: bigint
  /** How many owners had confirmed at that block. */
  confirmedCount: number
  /** How many owners the contract reported at that block. */
  ownerCount: number
}

/**
 * The verdict on the anchored reads.
 *
 * The order follows what a mistake would cost. Ownership and existence come
 * first because nothing else means anything without them. The tuple check is this
 * app's own, and it is the same one the other two actions make: the contract has
 * to hold the proposal the row describes, or the index is not evidence of what
 * would be executed. Then the configuration is checked for plausibility, then the
 * length, and only then the confirmations.
 *
 * The confirmation count is the whole point of this action. It is computed here
 * from the per-owner reads at the anchored block, never from the multisig summary
 * the page may already hold and never from indexed `ConfirmTransaction` rows:
 * either would be a record of a moment that is not this one.
 */
export function evaluateExecutePreflight(
  reads: ExecuteReads,
  index: bigint,
  payload: SubmitTransactionPayload,
): ActionOutcome<ExecutePreflight> {
  if (!reads.isOwner) {
    return {
      ok: false,
      reason: 'The connected account is not an owner of this contract, so it cannot execute.',
    }
  }

  if (index >= reads.transactionCount) {
    return { ok: false, reason: 'The contract has no proposal at this index.' }
  }

  if (reads.proposal.executed) {
    return { ok: false, reason: 'This proposal has already been executed.' }
  }

  if (!proposalMatchesEvent(reads.proposal, payload)) {
    return {
      ok: false,
      reason:
        "The contract's record of this proposal does not match the indexed event, so this app will not execute it.",
    }
  }

  if (reads.owners.length > MAX_EXECUTION_OWNERS) {
    return {
      ok: false,
      reason: `The contract reports ${String(
        reads.owners.length,
      )} owners, and this app will only execute from a list of at most ${String(
        MAX_EXECUTION_OWNERS,
      )}.`,
    }
  }

  if (!summaryIsPlausible(reads.owners, reads.threshold)) {
    return {
      ok: false,
      reason:
        "The contract's owner list and threshold are not a configuration this app can believe, so it will not execute.",
    }
  }

  // The reads and the owner list have to line up before a count means anything.
  // Reached only once the configuration is believable, so the refusals above are
  // still the ones a caller sees first.
  if (reads.confirmations.length !== reads.owners.length) {
    return { ok: false, reason: MALFORMED_ANSWER }
  }

  const confirmedCount = reads.confirmations.filter(Boolean).length

  if (BigInt(confirmedCount) < reads.threshold) {
    return {
      ok: false,
      reason: `This proposal has ${String(confirmedCount)} of the ${reads.threshold.toString(
        10,
      )} confirmations this contract requires, so it cannot be executed yet.`,
    }
  }

  return {
    ok: true,
    preflight: {
      index,
      indexText: index.toString(10),
      data: encodeExecuteTransaction(index),
      proposal: reads.proposal,
      block: reads.block.toString(10),
      threshold: reads.threshold,
      confirmedCount,
      ownerCount: reads.owners.length,
    },
  }
}

/**
 * Executing: the anchored reads, then the verdict.
 *
 * The block number is read first and validated, and every `eth_call` in this
 * preflight is made at that block. Six facts and one read per owner describe one
 * state of the contract only if they are answered at one block; at `latest` a
 * confirmation could land between two of them and the count would describe no
 * state that ever existed.
 *
 * The number of reads is bounded by `MAX_EXECUTION_OWNERS` before any per-owner
 * read is issued, so a hostile or broken owner list cannot turn one preflight into
 * thousands of wallet requests.
 */
export async function runExecution(
  context: ActionReadContext,
): Promise<ActionOutcome<ExecutePreflight> | null> {
  const blockRaw = await context.request('eth_blockNumber')
  if (!context.live()) {
    return null
  }

  const block = decodeBlockNumber(blockRaw)

  if (block === null) {
    return {
      ok: false,
      reason: 'The chain did not answer with a block number this app can read, so nothing was sent.',
    }
  }

  const tag = blockTag(block)

  const ownerRaw = await context.call(context.encode('isOwner', [context.account]), tag)
  if (!context.live()) {
    return null
  }

  const countRaw = await context.call(context.encode('getTransactionCount', []), tag)
  if (!context.live()) {
    return null
  }

  const proposalRaw = await context.call(context.encode('transactions', [context.index]), tag)
  if (!context.live()) {
    return null
  }

  const ownersRaw = await context.call(encodeConfiguration('getOwners'), tag)
  if (!context.live()) {
    return null
  }

  const thresholdRaw = await context.call(encodeConfiguration('threshold'), tag)
  if (!context.live()) {
    return null
  }

  const isOwner = decodeBool(ownerRaw)
  const transactionCount = decodeUint(countRaw)
  const proposal = decodeProposal(proposalRaw)
  const owners = decodeAddressArray(ownersRaw)
  const threshold = decodeUint256(thresholdRaw)

  if (
    isOwner === null ||
    transactionCount === null ||
    proposal === null ||
    owners === null ||
    threshold === null
  ) {
    return { ok: false, reason: MALFORMED_ANSWER }
  }

  // Refused here rather than after the per-owner reads: the cap exists to bound
  // this preflight, and a list past it is not read at all. The same goes for a
  // configuration the contract cannot be in, which needs no confirmations to
  // reject.
  if (owners.length > MAX_EXECUTION_OWNERS || !summaryIsPlausible(owners, threshold)) {
    return evaluateExecutePreflight(
      {
        block,
        isOwner,
        transactionCount,
        proposal,
        owners,
        threshold,
        confirmations: [],
      },
      context.index,
      context.payload,
    )
  }

  const confirmations: boolean[] = []

  for (const owner of owners) {
    const raw = await context.call(
      context.encode('isConfirmed', [context.index, owner.toLowerCase()]),
      tag,
    )

    if (!context.live()) {
      return null
    }

    const confirmed = decodeBool(raw)

    if (confirmed === null) {
      return { ok: false, reason: MALFORMED_ANSWER }
    }

    confirmations.push(confirmed)
  }

  return evaluateExecutePreflight(
    { block, isOwner, transactionCount, proposal, owners, threshold, confirmations },
    context.index,
    context.payload,
  )
}
