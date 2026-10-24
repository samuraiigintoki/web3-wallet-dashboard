/**
 * Confirming one indexed proposal: what is checked, and what is sent.
 *
 * `confirmTransaction(uint256 _txIndex)` is the whole write. Everything else in
 * this file is a read that has to pass before the wallet is opened, because the
 * indexed event is a record of what was submitted, not a statement about the
 * contract now. Between the event being indexed and this screen being opened the
 * proposal may have been executed, this account may have confirmed it already, or
 * the contract may be a different deployment entirely.
 *
 * The ABI and its selectors, verified rather than assumed:
 *
 * - Source: `samuraiigintoki/multisig-wallet` at commit `f34634c`,
 *   `src/MultiSigWallet.sol`, which declares
 *   `confirmTransaction(uint256)`, `isOwner(address)`, `isConfirmed(uint256,address)`,
 *   `transactions(uint256)`, `threshold()` and `getTransactionCount()`.
 * - Selectors computed with `viem`'s `toFunctionSelector`: `0xc01a8c84`,
 *   `0x2f54bf6e`, `0x80f59a65`, `0x9ace38c2`, `0x42cde4e8`, `0x2e7700f0`.
 * - All six appear in the runtime bytecode deployed at
 *   `0x5B324F41E5889cf94CbA8e909089683a1a97c318` on chain 11155111, which is why
 *   the selector constants below are safe to compare against.
 *
 * `transactions(uint256)` is the public-array getter for
 * `struct Transaction { address to; uint256 value; bytes data; bool executed; }`,
 * so it returns exactly those four members and no confirmation count. Whether an
 * account has confirmed is a separate mapping read, which is why the preflight
 * needs both.
 */

import { encodeFunctionData, type Abi } from 'viem'

import type { ContractEvent, SubmitTransactionPayload } from '../api/index.ts'
import { MULTISIG_ADDRESS, SEPOLIA_CHAIN_ID } from '../provider/multisig.ts'

/** `confirmTransaction(uint256)` */
export const CONFIRM_SELECTOR = '0xc01a8c84'

/** The four readable calls the preflight makes, and nothing else. */
export const PREFLIGHT_ABI = [
  {
    type: 'function',
    name: 'isOwner',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'getTransactionCount',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'transactions',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'uint256' }],
    outputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'executed', type: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'isConfirmed',
    stateMutability: 'view',
    inputs: [
      { name: '', type: 'uint256' },
      { name: '', type: 'address' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const satisfies Abi

/** `confirmTransaction(uint256)`, the one call this slice sends. */
export const CONFIRM_ABI = [
  {
    type: 'function',
    name: 'confirmTransaction',
    stateMutability: 'nonpayable',
    inputs: [{ name: '_txIndex', type: 'uint256' }],
    outputs: [],
  },
] as const satisfies Abi

/** The largest value a uint256 can hold. */
const MAX_UINT256 = (1n << 256n) - 1n

/** A whole return payload: hex bytes, even length. */
const HEX = /^0x(?:[0-9a-fA-F]{2})*$/

/** An address as the ABI left-pads it: twelve zero bytes, then twenty. */
const ADDRESS_WORD = /^0x0{24}[0-9a-fA-F]{40}$/

/** Decimal digits, the form the server uses for a uint256. */
const DECIMAL = /^\d+$/

/**
 * The calldata for one confirmation.
 *
 * The index is the event's own `multisigTxIndex`, parsed to a `bigint` and
 * encoded by `viem`: one 32-byte word, and nothing else. A wrong word here would
 * confirm a different proposal, which is why the exact bytes are pinned in the
 * tests.
 */
export function encodeConfirmTransaction(index: bigint): string {
  return encodeFunctionData({
    abi: CONFIRM_ABI,
    functionName: 'confirmTransaction',
    args: [index],
  }).toLowerCase()
}

/**
 * The proposal index an event names, or null.
 *
 * The server sends `multisigTxIndex` as a decimal string. It is read with
 * `BigInt` and bounded by the uint256 ceiling: a value that is not whole decimal
 * digits, or one that no ABI word could hold, names no proposal and is refused
 * rather than coerced.
 */
export function parseProposalIndex(raw: unknown): bigint | null {
  if (typeof raw !== 'string' || !DECIMAL.test(raw)) {
    return null
  }

  const index = BigInt(raw)

  return index > MAX_UINT256 ? null : index
}

function bytesOf(value: unknown): string | null {
  if (typeof value !== 'string' || !HEX.test(value)) {
    return null
  }

  return value.slice(2)
}

function wordAt(body: string, index: number): string | null {
  const start = index * 64
  const word = body.slice(start, start + 64)

  return word.length === 64 ? `0x${word}` : null
}

/** One 32-byte word as a boolean, or null when it is not one. */
export function decodeBool(value: unknown): boolean | null {
  const body = bytesOf(value)

  if (body === null || body.length !== 64) {
    return null
  }

  if (body === '0'.repeat(64)) {
    return false
  }

  if (`0x${body}` === `0x${'0'.repeat(63)}1`) {
    return true
  }

  return null
}

/** One 32-byte word as an exact integer. */
export function decodeUint(value: unknown): bigint | null {
  const body = bytesOf(value)

  if (body === null || body.length !== 64) {
    return null
  }

  return BigInt(`0x${body}`)
}

/** What the contract holds for one proposal. */
export type Proposal = {
  /** The address the proposal would call. */
  to: string
  /** The value it would send, exact. */
  valueWei: bigint
  /** The calldata it would send. */
  data: string
  executed: boolean
}

/**
 * The `transactions(uint256)` tuple, or null.
 *
 * The layout is the four struct members: `to`, `value`, an offset to `data`
 * (always 128, because the first three are fixed size), `executed`, then the
 * length of `data` and its right-padded bytes. Every one of those is checked
 * against the payload length rather than trusted, and a payload with trailing
 * bytes beyond the declared calldata is refused: a getter that returns more than
 * its struct holds is not the answer this decoder was built for.
 */
export function decodeProposal(value: unknown): Proposal | null {
  const body = bytesOf(value)

  if (body === null) {
    return null
  }

  const toWord = wordAt(body, 0)
  const valueWord = wordAt(body, 1)
  const offsetWord = wordAt(body, 2)
  const executedWord = wordAt(body, 3)

  if (toWord === null || valueWord === null || offsetWord === null || executedWord === null) {
    return null
  }

  if (!ADDRESS_WORD.test(toWord)) {
    return null
  }

  if (BigInt(offsetWord) !== 128n) {
    return null
  }

  const lengthWord = wordAt(body, 4)

  if (lengthWord === null) {
    return null
  }

  const length = BigInt(lengthWord)

  // A calldata length beyond what a block could carry is malformed by
  // construction, and it also bounds the arithmetic below.
  if (length > 1_000_000n) {
    return null
  }

  const dataBytes = Number(length)
  const paddedWords = BigInt(Math.ceil(dataBytes / 32))
  const expectedLength = (5n + paddedWords) * 64n

  if (BigInt(body.length) !== expectedLength) {
    return null
  }

  const dataBody = body.slice(5 * 64, 5 * 64 + dataBytes * 2)

  const executed =
    executedWord === `0x${'0'.repeat(64)}`
      ? false
      : executedWord === `0x${'0'.repeat(63)}1`
        ? true
        : null

  if (executed === null) {
    return null
  }

  return {
    to: `0x${toWord.slice(26)}`,
    valueWei: BigInt(valueWord),
    data: `0x${dataBody}`.toLowerCase(),
    executed,
  }
}

/**
 * Whether this screen may offer a confirmation for a row at all.
 *
 * Two facts have to hold and neither is about the user: the event must be a
 * submission, and the contract must be the deployment whose functions this app
 * knows. A tracked contract at any other address may be a different multisig, a
 * proxy, or not a multisig at all, and sending it a selector this app inferred
 * from a different source would be a write to something nobody verified.
 */
/**
 * Why an event names no action this app can take.
 *
 * The code is the same for every action and the sentence is not: a refusal reads
 * "Confirming is only available..." on one button and "Revoking is only
 * available..." on the other. Returning the reason and not only its prose lets
 * each action word the same rule for itself, without a second copy of the rule.
 */
export type EligibilityRefusal =
  /** The row is not a submission, so it names no proposal to act on. */
  | 'not-submission'
  /** The tracked contract is not the deployment this app knows how to write to. */
  | 'other-contract'
  /** The contract is not on the chain this app writes to. */
  | 'other-chain'
  /** The row's index is not one an ABI word could hold. */
  | 'unreadable-index'
  /** The row's payload is not the submission payload this app reads. */
  | 'unreadable-payload'

export type Eligibility =
  | { eligible: true; index: bigint; event: ContractEvent; payload: SubmitTransactionPayload }
  | { eligible: false; refusal: EligibilityRefusal; reason: string }

export function checkEligibility(
  event: ContractEvent,
  contractAddress: string,
  contractChainId: number,
): Eligibility {
  if (event.eventName !== 'SubmitTransaction') {
    return {
      eligible: false,
      refusal: 'not-submission',
      reason: 'Only a submitted proposal can be confirmed.',
    }
  }

  if (contractAddress.toLowerCase() !== MULTISIG_ADDRESS.toLowerCase()) {
    return {
      eligible: false,
      refusal: 'other-contract',
      reason: 'Confirming is only available on the verified Sepolia multisig contract.',
    }
  }

  if (contractChainId !== SEPOLIA_CHAIN_ID) {
    return {
      eligible: false,
      refusal: 'other-chain',
      reason: `Confirming is only available on chain ${String(SEPOLIA_CHAIN_ID)}.`,
    }
  }

  const index = parseProposalIndex(event.multisigTxIndex)

  if (index === null) {
    return {
      eligible: false,
      refusal: 'unreadable-index',
      reason: 'This event does not name a proposal this app can read.',
    }
  }

  const payload = event.payload as SubmitTransactionPayload

  if (
    typeof payload.to !== 'string' ||
    typeof payload.valueWei !== 'string' ||
    typeof payload.data !== 'string'
  ) {
    return {
      eligible: false,
      refusal: 'unreadable-payload',
      reason: 'This event does not carry the proposal this app can read.',
    }
  }

  return { eligible: true, index, event, payload }
}

/**
 * Whether the contract's record of the proposal is the one the event describes.
 *
 * The address and the calldata are compared without regard to case, and the value
 * by exact integer: the event carries wei as a decimal string and the contract
 * carries it as a word, and the only honest comparison is numeric. A mismatch
 * means the index in this event now points at a different proposal, which can
 * happen if the event came from another contract or the index was never right,
 * and confirming it would act on something the user was never shown.
 */
export function proposalMatchesEvent(proposal: Proposal, payload: SubmitTransactionPayload): boolean {
  if (proposal.to.toLowerCase() !== payload.to.toLowerCase()) {
    return false
  }

  if (proposal.data.toLowerCase() !== payload.data.toLowerCase()) {
    return false
  }

  if (!DECIMAL.test(payload.valueWei)) {
    return false
  }

  return proposal.valueWei === BigInt(payload.valueWei)
}

/** Everything the preflight read, as the contract answered it. */
export type PreflightReads = {
  /** `isOwner(account)`. */
  isOwner: boolean
  /** `getTransactionCount()`. */
  transactionCount: bigint
  /** `transactions(index)`. */
  proposal: Proposal
  /** `isConfirmed(index, account)`. */
  alreadyConfirmed: boolean
}

/** A preflight that passed, with everything the review step has to restate. */
export type Preflight = {
  index: bigint
  indexText: string
  /** The confirmation call, ready for `eth_sendTransaction`. */
  data: string
  /** The proposal as the contract holds it, which was checked against the event. */
  proposal: Proposal
}

export type PreflightOutcome =
  | { ok: true; preflight: Preflight }
  | { ok: false; reason: string }

/**
 * The preflight's verdict, in the order the contract itself would refuse.
 *
 * Each refusal is its own sentence because each is a different thing to do:
 * another owner has to confirm, a proposal that does not exist is nothing to
 * act on, an executed proposal is finished, and one this account already
 * confirmed needs no second confirmation. The last check is this app's own and
 * the strictest: the contract's proposal has to be the one the event describes,
 * or the index is not trustworthy evidence of what would be confirmed.
 */
export function evaluatePreflight(
  reads: PreflightReads,
  index: bigint,
  payload: SubmitTransactionPayload,
): PreflightOutcome {
  if (!reads.isOwner) {
    return {
      ok: false,
      reason: 'The connected account is not an owner of this contract, so it cannot confirm.',
    }
  }

  if (index >= reads.transactionCount) {
    return { ok: false, reason: 'The contract has no proposal at this index.' }
  }

  if (reads.proposal.executed) {
    return { ok: false, reason: 'This proposal has already been executed.' }
  }

  if (reads.alreadyConfirmed) {
    return { ok: false, reason: 'This account has already confirmed this proposal.' }
  }

  if (!proposalMatchesEvent(reads.proposal, payload)) {
    return {
      ok: false,
      reason:
        "The contract's record of this proposal does not match the indexed event, so this app will not confirm it.",
    }
  }

  return {
    ok: true,
    preflight: {
      index,
      indexText: index.toString(10),
      data: encodeConfirmTransaction(index),
      proposal: reads.proposal,
    },
  }
}
