/**
 * A transaction receipt, read as untrusted input.
 *
 * A receipt is the only evidence this app ever gets that a submitted call was
 * included in a block, so the parsing here is deliberately unforgiving. The
 * answer comes from an extension, it names a transaction and a target, and it
 * can be stale, malformed or for something else entirely. Anything that does not
 * describe exactly the hash and the contract this screen is asking about is
 * refused rather than rendered, because a receipt drawn next to the wrong hash is
 * worse than no receipt at all.
 *
 * What a receipt does not say is as important as what it does. `status: 0x1`
 * means the call itself did not revert. It does not mean the multisig proposal
 * was confirmed by its owners, executed, indexed, or that the block it sits in is
 * final. The wording in the components follows from that, not from this file.
 */

/** A hex quantity, as a provider sends numbers. */
const HEX_QUANTITY = /^0x[0-9a-fA-F]{1,64}$/

/** A 32-byte hex value. */
const HEX_32 = /^0x[0-9a-fA-F]{64}$/

/** An address, as this app accepts one. */
const ADDRESS = /^0x[0-9a-fA-F]{40}$/

/** What the provider said, reduced to the two things it can mean here. */
export type ReceiptOutcome =
  /**
   * The provider answered with `null`. No receipt is available now. This is not a
   * failure and not evidence that the transaction was dropped: a transaction
   * that is pending, and one that was never broadcast, look the same from here.
   */
  | { kind: 'none' }
  /** The transaction is included in a block, and the call did or did not revert. */
  | {
      kind: 'included'
      /** True when `status` is `0x1`, which means the call did not revert. */
      success: boolean
      /** Decimal digits, for display. */
      blockNumber: string
      /** The block the transaction is currently included in. */
      blockHash: string
    }

/** Why an answer was refused. Each is a different fact and gets its own sentence. */
export type ReceiptRefusal = 'malformed' | 'other-transaction' | 'other-contract'

export type ReceiptParse =
  | { ok: true; outcome: ReceiptOutcome }
  | { ok: false; refusal: ReceiptRefusal }

/** What this screen is asking about, and therefore what an answer must match. */
export type ReceiptExpectation = {
  /** The hash the wallet returned when the transaction was submitted. */
  hash: string
  /** The tracked contract the transaction was addressed to. */
  to: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A hex quantity as a `bigint`, or null when it is not one. */
function quantity(value: unknown): bigint | null {
  if (typeof value !== 'string' || !HEX_QUANTITY.test(value)) {
    return null
  }

  return BigInt(value)
}

/**
 * Reads an `eth_getTransactionReceipt` answer.
 *
 * The order of the checks is the order of what a mistake would cost, not the
 * order the fields appear in. Identity first: an answer about another
 * transaction or another contract is discarded before any of its numbers are
 * looked at, so a well-formed receipt for something else can never be shown as
 * this submission's outcome.
 *
 * `blockNumber` is returned as decimal digits. It is a count, not a quantity in
 * wei, and it is displayed rather than computed with, so a decimal string is the
 * form the rest of this app already uses for exact integers. It is also required
 * to be above zero: block zero holds no user transaction.
 */
export function parseTransactionReceipt(
  value: unknown,
  expected: ReceiptExpectation,
): ReceiptParse {
  if (value === null) {
    return { ok: true, outcome: { kind: 'none' } }
  }

  if (!isRecord(value)) {
    return { ok: false, refusal: 'malformed' }
  }

  const transactionHash = value.transactionHash

  if (typeof transactionHash !== 'string' || !HEX_32.test(transactionHash)) {
    return { ok: false, refusal: 'malformed' }
  }

  if (transactionHash.toLowerCase() !== expected.hash.toLowerCase()) {
    return { ok: false, refusal: 'other-transaction' }
  }

  const to = value.to

  if (typeof to !== 'string' || !ADDRESS.test(to)) {
    return { ok: false, refusal: 'malformed' }
  }

  if (to.toLowerCase() !== expected.to.toLowerCase()) {
    return { ok: false, refusal: 'other-contract' }
  }

  const status = quantity(value.status)

  // A receipt reports both a status and, from before the Byzantium fork, a
  // post-state root. This app understands the status field only: an answer
  // without a usable one cannot be described as success or as reverted, and
  // guessing which would be the whole point of the check.
  if (status === null || (status !== 0n && status !== 1n)) {
    return { ok: false, refusal: 'malformed' }
  }

  const blockNumber = quantity(value.blockNumber)

  if (blockNumber === null || blockNumber <= 0n || blockNumber > BigInt(Number.MAX_SAFE_INTEGER)) {
    return { ok: false, refusal: 'malformed' }
  }

  const blockHash = value.blockHash

  if (typeof blockHash !== 'string' || !HEX_32.test(blockHash)) {
    return { ok: false, refusal: 'malformed' }
  }

  return {
    ok: true,
    outcome: {
      kind: 'included',
      success: status === 1n,
      blockNumber: blockNumber.toString(10),
      blockHash,
    },
  }
}
