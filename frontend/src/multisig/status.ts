/**
 * One proposal's live state, read on request and anchored to one block.
 *
 * The event view is a record of what the chain emitted. It is not a statement
 * about the contract now: a proposal can gain confirmations, be executed, or be
 * at an index the contract has since moved past. This module answers the other
 * question, and it answers it from the contract alone.
 *
 * What makes this a read rather than an action:
 *
 * - Nothing is sent. There is no calldata, no wallet prompt and no review, and
 *   the only provider methods used are `eth_blockNumber` and `eth_call`.
 * - Nothing is refused for the viewer's sake. Not being an owner, the proposal
 *   already being executed, and the threshold not being met are three facts about
 *   the proposal, not three reasons to withhold it. They are reported.
 * - It fails closed on anything it cannot read. A malformed block number, owner
 *   list, threshold, tuple or confirmation answer produces a sentence and no
 *   status, because a partly decoded snapshot is not a snapshot.
 *
 * What it refuses outright, because the answer would be about something else:
 *
 * - A contract record of the proposal that is not the one the indexed event
 *   describes. The index would then point at a different proposal, and drawing
 *   its confirmations beside this row would be attributing one proposal's state
 *   to another.
 * - An owner list longer than `MAX_ANCHORED_OWNERS`, before any per-owner read.
 * - An owner and threshold configuration the contract cannot be in, also before
 *   any per-owner read, so a hostile answer cannot choose how many requests this
 *   app makes.
 *
 * The reads are `getTransactionCount()`, `transactions(index)`, `getOwners()`,
 * `threshold()`, one `isConfirmed(index, owner)` per owner, and finally
 * `isOwner(account)` for the viewer's own attribution. The count is read before
 * the tuple because an index past the end of the array would make
 * `transactions(index)` revert; the range is checked instead, and an index with
 * no live proposal is its own answer rather than a failure.
 */

import type { SubmitTransactionPayload } from '../api/index.ts'
import {
  decodeAddressArray,
  decodeUint256,
  summaryIsPlausible,
} from '../provider/multisig.ts'
import type { BrowserWalletState } from '../provider/useBrowserWallet.ts'
import {
  blockTag,
  decodeBlockNumber,
  encodeConfiguration,
  MAX_ANCHORED_OWNERS,
} from './anchored.ts'
import {
  checkEligibility,
  decodeBool,
  decodeProposal,
  decodeUint,
  proposalMatchesEvent,
  type Eligibility,
  type EligibilityRefusal,
  type Proposal,
} from './confirm.ts'
import { walletGate, type MultisigGate } from './gate.ts'
import type { ActionReadContext } from './useMultisigAction.ts'

/**
 * What an unreadable answer is called here.
 *
 * The write actions say "so nothing was sent", which is true of them and false of
 * a read: this one has nothing to send and nothing to withhold, so it says so.
 */
export const STATUS_MALFORMED =
  'The contract answered with data this app cannot read, so no live status is shown.'

/** One owner, and whether the contract reported a confirmation from them. */
export type OwnerConfirmation = {
  /** The owner, as the contract listed them. */
  owner: string
  /** `isConfirmed(index, owner)` at the snapshot block. */
  confirmed: boolean
}

/** One proposal as the contract held it at one block. */
export type ProposalStatus = {
  /** The block every read below was anchored to. */
  block: bigint
  /** That block in decimal, for display. */
  blockText: string
  /** The row's index, which the contract still holds a proposal at. */
  index: bigint
  /** That index in decimal, for display. */
  indexText: string
  /** The contract's record of the proposal, which matched the indexed event. */
  proposal: Proposal
  /** Whether the contract reported the proposal as executed at this block. */
  executed: boolean
  /** The owner set at this block. */
  owners: readonly string[]
  /** The threshold at this block, as a count. */
  threshold: bigint
  /** One entry per owner, in the contract's order. */
  confirmations: readonly OwnerConfirmation[]
  /** How many owners the contract reported as having confirmed. */
  confirmedCount: number
  /** Whether the count above meets the threshold at this block. */
  thresholdMet: boolean
  /** Whether the connected account is an owner of this contract. */
  viewerIsOwner: boolean
  /** Whether the connected account is among the confirmed owners. */
  viewerConfirmed: boolean
}

/**
 * What one status read produced.
 *
 * `absent` is its own answer rather than a refusal: the contract is answering
 * fine, and what it says is that it holds no proposal at this index. `refused` is
 * this app declining to describe the contract, which is a different sentence and
 * a different thing to do about it.
 */
export type StatusOutcome =
  | { kind: 'live'; status: ProposalStatus }
  | { kind: 'absent'; blockText: string; indexText: string; transactionCount: string }
  | { kind: 'refused'; reason: string }

/** The status reads, before any judgement of them. */
export type StatusReads = {
  block: bigint
  transactionCount: bigint
  proposal: Proposal
  owners: readonly string[]
  threshold: bigint
  confirmations: readonly boolean[]
  /** `isOwner(account)` at the anchored block. */
  viewerIsOwner: boolean
  /** The account those reads were made for, lower cased. */
  account: string
}

/** The three answers a snapshot needs before any per-owner read is worth making. */
export type Snapshot = {
  proposal: Proposal
  owners: readonly string[]
  threshold: bigint
}

/**
 * Whether this app will describe this snapshot at all, and why not.
 *
 * The three refusals here are the ones that do not need a single confirmation:
 * an owner list too long to read one confirmation per owner, a configuration the
 * contract cannot be in, and a proposal that is not the one the indexed row
 * describes. They are separated from the rest of the verdict so that the reader
 * can apply them before it issues a per-owner read, and so that applying them
 * twice cannot produce two different answers.
 *
 * The cap and the configuration come first because they bound the work: a hostile
 * or broken answer must not be able to decide how many requests this app makes.
 * The mismatch is checked here too, and that is the point of it: a tuple that
 * disagrees with the row is never given a status, so nothing downstream can build
 * one from the wrong proposal.
 */
export function snapshotRefusal(snapshot: Snapshot, payload: SubmitTransactionPayload): string | null {
  if (snapshot.owners.length > MAX_ANCHORED_OWNERS) {
    return `The contract reports ${String(
      snapshot.owners.length,
    )} owners, and this app will only read the status of a contract with at most ${String(
      MAX_ANCHORED_OWNERS,
    )}.`
  }

  if (!summaryIsPlausible(snapshot.owners, snapshot.threshold)) {
    return "The contract's owner list and threshold are not a configuration this app can believe, so it will not report a live status."
  }

  if (!proposalMatchesEvent(snapshot.proposal, payload)) {
    return "The contract's record of this proposal does not match the indexed event, so this app will not present it as this row's live status."
  }

  return null
}

/**
 * The status of one snapshot, once every read behind it has been made.
 *
 * A snapshot that `snapshotRefusal` refuses never becomes a status: the refusal
 * is returned instead, so the only way to reach the status object below is a
 * proposal the row describes, an owner list this app can read, and a count that
 * was computed from the same block as the threshold beside it.
 */
export function evaluateStatus(
  reads: StatusReads,
  index: bigint,
  payload: SubmitTransactionPayload,
): StatusOutcome {
  const refusal = snapshotRefusal(reads, payload)

  if (refusal !== null) {
    return { kind: 'refused', reason: refusal }
  }

  // The reads and the owner list have to line up before a count means anything,
  // and the count is what the whole snapshot is for.
  if (reads.confirmations.length !== reads.owners.length) {
    return { kind: 'refused', reason: STATUS_MALFORMED }
  }

  const confirmations = reads.owners.map((owner, position) => ({
    owner,
    confirmed: reads.confirmations[position] === true,
  }))

  const confirmedCount = confirmations.filter((entry) => entry.confirmed).length
  const viewer = reads.viewerIsOwner
    ? confirmations.some(
        (entry) =>
          entry.confirmed && entry.owner.toLowerCase() === reads.account.toLowerCase(),
      )
    : false

  return {
    kind: 'live',
    status: {
      block: reads.block,
      blockText: reads.block.toString(10),
      index,
      indexText: index.toString(10),
      proposal: reads.proposal,
      executed: reads.proposal.executed,
      owners: reads.owners,
      threshold: reads.threshold,
      confirmations,
      confirmedCount,
      thresholdMet: BigInt(confirmedCount) >= reads.threshold,
      viewerIsOwner: reads.viewerIsOwner,
      viewerConfirmed: viewer,
    },
  }
}

/** The same eligibility rule as the write actions, in this read's words. */
const STATUS_REFUSALS: Record<EligibilityRefusal, string> = {
  'not-submission': 'Only a submitted proposal has a live status this app can read.',
  'other-contract': 'Live status is only available on the verified Sepolia multisig contract.',
  'other-chain': 'Live status is only available on chain 11155111.',
  'unreadable-index': 'This event does not name a proposal this app can read.',
  'unreadable-payload': 'This event does not carry the proposal this app can read.',
}

export function checkStatusEligibility(
  event: Parameters<typeof checkEligibility>[0],
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
    reason: STATUS_REFUSALS[eligibility.refusal],
  }
}

/** The gate for reading a status, worded for reading one. */
export function statusGate(
  contractAddress: string,
  contractChainId: number,
  wallet: BrowserWalletState,
): MultisigGate {
  return walletGate(contractAddress, contractChainId, wallet, {
    unavailable: 'Live status is only available on the verified Sepolia multisig contract.',
    connect: 'Connect a wallet on Sepolia to read this proposal from the contract.',
  })
}

/**
 * One status read: the block, then every fact at that block.
 *
 * The order is the security property as much as the parsing is. The block comes
 * first and everything else is anchored to it, so the count, the threshold and
 * the confirmations describe one state of the contract. The count comes before
 * the tuple, so an index with no proposal is answered without a reverting call.
 * The cap and the configuration are judged before any per-owner read, so the
 * number of requests is fixed by this app and not by the contract's answer.
 */
export async function runStatus(context: ActionReadContext): Promise<StatusOutcome | null> {
  const blockRaw = await context.request('eth_blockNumber')
  if (!context.live()) {
    return null
  }

  const block = decodeBlockNumber(blockRaw)

  if (block === null) {
    return {
      kind: 'refused',
      reason:
        'The chain did not answer with a block number this app can read, so no live status was read.',
    }
  }

  const tag = blockTag(block)

  const countRaw = await context.call(context.encode('getTransactionCount', []), tag)
  if (!context.live()) {
    return null
  }

  const transactionCount = decodeUint(countRaw)

  if (transactionCount === null) {
    return { kind: 'refused', reason: STATUS_MALFORMED }
  }

  // Past the end of the array `transactions(index)` reverts, and a revert here
  // would be reported as a provider failure rather than as the plain fact that
  // this contract holds no proposal at this index.
  if (context.index >= transactionCount) {
    return {
      kind: 'absent',
      blockText: block.toString(10),
      indexText: context.index.toString(10),
      transactionCount: transactionCount.toString(10),
    }
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

  const proposal = decodeProposal(proposalRaw)
  const owners = decodeAddressArray(ownersRaw)
  const threshold = decodeUint256(thresholdRaw)

  if (proposal === null || owners === null || threshold === null) {
    return { kind: 'refused', reason: STATUS_MALFORMED }
  }

  // Judged before the per-owner reads: a list past the cap, a configuration the
  // contract cannot be in, or a tuple that is not this row's needs no
  // confirmations to refuse, and refusing here keeps the number of requests
  // bounded by this app rather than by the contract's answer.
  const refusal = snapshotRefusal({ proposal, owners, threshold }, context.payload)

  if (refusal !== null) {
    return { kind: 'refused', reason: refusal }
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
      return { kind: 'refused', reason: STATUS_MALFORMED }
    }

    confirmations.push(confirmed)
  }

  const ownerRaw = await context.call(context.encode('isOwner', [context.account]), tag)
  if (!context.live()) {
    return null
  }

  const viewerIsOwner = decodeBool(ownerRaw)

  if (viewerIsOwner === null) {
    return { kind: 'refused', reason: STATUS_MALFORMED }
  }

  return evaluateStatus(
    {
      block,
      transactionCount,
      proposal,
      owners,
      threshold,
      confirmations,
      viewerIsOwner,
      account: context.account,
    },
    context.index,
    context.payload,
  )
}
