/**
 * The call this app submits: what it validates, and how it is encoded.
 *
 * `submitTransaction(address destination, uint256 value, bytes data)` is the one
 * write in this slice, so it is the one encoding that has to be exact. Getting a
 * word wrong here does not produce a failed request that a user notices: it
 * produces a valid call to the same function with a different destination or a
 * different amount, which the owners might then confirm. The ABI encoding is
 * therefore not this file's own arithmetic: it comes from `viem`, pinned to one
 * exact version, and `encoding.test.ts` pins the result byte for byte with
 * vectors as well as checking the selector against `toFunctionSelector`.
 *
 * `viem` is used for exactly two things, `encodeFunctionData` and (in the test)
 * `toFunctionSelector`. No wallet client, no transport, no `sendTransaction`:
 * the transaction is dispatched through the injected provider, so the app keeps
 * one place where a wallet is asked for anything.
 */

import { encodeFunctionData, type Abi } from 'viem'

/** The one function this app calls on a multisig contract. */
export const SUBMIT_TRANSACTION_ABI = [
  {
    type: 'function',
    name: 'submitTransaction',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'destination', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
    ],
    outputs: [],
  },
] as const satisfies Abi

/** `submitTransaction(address,uint256,bytes)`, the first four bytes of its hash. */
export const SUBMIT_TRANSACTION_SELECTOR = '0xc6427474'

/** An address as this slice accepts it: 0x and exactly twenty bytes. */
const ADDRESS = /^0x[0-9a-fA-F]{40}$/

/** A value as this slice accepts it: decimal digits and nothing else. */
const DECIMAL = /^\d+$/

/** Calldata as the ABI takes it: 0x and whole bytes. */
const HEX_BYTES = /^0x(?:[0-9a-fA-F]{2})*$/

/** The largest value a uint256 can hold. */
const MAX_UINT256 = (1n << 256n) - 1n

/**
 * What the user asked for, validated and normalised.
 *
 * `destination` is lower case, `valueWei` is decimal digits with no leading
 * zeros, and `calldata` is lower case hex. The exact forms are kept so the
 * confirmation can restate what will be submitted instead of what was typed.
 */
export type SubmitRequest = {
  /** The tracked contract the transaction is addressed to. */
  to: string
  /**
   * Always `0x0`. The proposal's amount is an argument inside the calldata; the
   * outer call pays the contract nothing, so a mistaken submit costs gas and a
   * proposal, not a transfer.
   */
  value: '0x0'
  /** The encoded `submitTransaction` call, ready for `eth_sendTransaction`. */
  data: string
  /** The proposed destination, as it will appear in the event. */
  destination: string
  /** The proposed value in wei, exact decimal. */
  valueWei: string
  /** The proposed calldata, as hex. */
  calldata: string
}

/** Which field a message belongs to. */
export type SubmitField = 'destination' | 'valueWei' | 'data'

/** One message per field, only for the fields that are wrong. */
export type SubmitFieldErrors = Partial<Record<SubmitField, string>>

export const FIELD_MESSAGES: Record<SubmitField, string> = {
  destination: 'Enter a destination address: 0x followed by 20 hex bytes.',
  valueWei: 'Enter the value in wei as whole decimal digits, with no sign, comma or decimal point.',
  data: 'Enter the calldata as 0x followed by whole hex bytes, or leave it empty.',
}

export const VALUE_TOO_LARGE = 'That value is larger than a 256-bit unsigned integer can hold.'

/** What the form holds, exactly as it was typed. */
export type SubmitDraft = {
  destination: string
  valueWei: string
  data: string
}

/**
 * A destination address, lower case, or null.
 *
 * No checksum validation: a user pasting a lower-case address from a block
 * explorer is doing nothing wrong, and a mixed-case address whose checksum is
 * wrong is a typo this app cannot distinguish from a formatting preference
 * without also refusing valid input. The address is shown back in full before
 * anything is sent, which is the check that matters.
 */
export function parseDestination(raw: string): string | null {
  const trimmed = raw.trim()

  return ADDRESS.test(trimmed) ? trimmed.toLowerCase() : null
}

/**
 * A uint256 from decimal digits, exactly.
 *
 * `BigInt` and not `Number`: wei is an integer of up to 78 digits, and every
 * value above 2^53 would be silently rounded by `Number`. Nothing in this
 * slice converts wei to a currency, so there is no second unit for these digits
 * to be misread as.
 */
export function parseValueWei(raw: string): bigint | null {
  const trimmed = raw.trim()

  if (!DECIMAL.test(trimmed)) {
    return null
  }

  const value = BigInt(trimmed)

  return value > MAX_UINT256 ? null : value
}

/**
 * Calldata as lower-case hex, or null.
 *
 * An empty field means no calldata and becomes `0x`. Anything else must be whole
 * bytes: `0xabc` is refused rather than padded, because a half byte is a sign
 * the paste was truncated.
 */
export function parseCalldata(raw: string): string | null {
  const trimmed = raw.trim()

  if (trimmed === '') {
    return '0x'
  }

  if (!HEX_BYTES.test(trimmed)) {
    return null
  }

  return trimmed.toLowerCase()
}

/**
 * Encodes a validated proposal into a call on the tracked contract.
 *
 * The outer call carries no value: the amount is the second argument, inside the
 * calldata, so a mistaken submission costs gas and a proposal rather than a
 * transfer. The result is lower case, because that is what is compared in tests
 * and what is shown back to the user.
 */
export function encodeSubmitTransaction(args: {
  /** Validated by `parseDestination`: `0x` and twenty bytes. */
  destination: `0x${string}`
  valueWei: bigint
  /** Validated by `parseCalldata`: `0x` and whole bytes. */
  calldata: `0x${string}`
}): string {
  return encodeFunctionData({
    abi: SUBMIT_TRANSACTION_ABI,
    functionName: 'submitTransaction',
    args: [args.destination, args.valueWei, args.calldata],
  }).toLowerCase()
}

/**
 * Validates what the form holds and encodes it, or says what is wrong.
 *
 * The contract address is not a form field: it comes from the tracked record the
 * page is showing, so there is nothing for a user to mistype and nothing for the
 * form to validate. Everything a user typed is checked here, before the
 * confirmation is drawn, and the same function runs again on the way back in if
 * the confirmation is ever rebuilt.
 */
export function buildSubmission(
  contractAddress: string,
  draft: SubmitDraft,
): { ok: true; request: SubmitRequest } | { ok: false; errors: SubmitFieldErrors } {
  const errors: SubmitFieldErrors = {}

  const destination = parseDestination(draft.destination)

  if (destination === null) {
    errors.destination = FIELD_MESSAGES.destination
  }

  const valueWei = parseValueWei(draft.valueWei)

  if (valueWei === null) {
    const trimmed = draft.valueWei.trim()

    errors.valueWei =
      DECIMAL.test(trimmed) && BigInt(trimmed) > MAX_UINT256
        ? VALUE_TOO_LARGE
        : FIELD_MESSAGES.valueWei
  }

  const calldata = parseCalldata(draft.data)

  if (calldata === null) {
    errors.data = FIELD_MESSAGES.data
  }

  const to = contractAddress.trim().toLowerCase()

  // The tracked address comes from the server, so a bad one is a broken record
  // rather than a user mistake. It still refuses rather than encoding something
  // the API never should have sent.
  if (!ADDRESS.test(to)) {
    errors.destination = 'The tracked contract address is not an address this app can encode.'
  }

  if (destination === null || valueWei === null || calldata === null || !ADDRESS.test(to)) {
    return { ok: false, errors }
  }

  return {
    ok: true,
    request: {
      to,
      value: '0x0',
      // The address and calldata patterns above are what make these casts true:
      // both values start `0x` and hold whole bytes, which is the only thing the
      // encoder's parameter types add.
      data: encodeSubmitTransaction({
        destination: destination as `0x${string}`,
        valueWei,
        calldata: calldata as `0x${string}`,
      }),
      destination,
      valueWei: valueWei.toString(10),
      calldata,
    },
  }
}

/** A transaction hash as a wallet returns one: 0x and thirty-two bytes. */
const TRANSACTION_HASH = /^0x[0-9a-fA-F]{64}$/

/**
 * Whether an answer to `eth_sendTransaction` is a transaction hash.
 *
 * A wallet that answers with something else has not told this app that anything
 * was submitted, and drawing that answer as a hash would be inventing the one
 * piece of evidence the user gets. The value is kept exactly as returned when it
 * is valid: it is an identifier, not a number.
 */
export function parseTransactionHash(value: unknown): string | null {
  return typeof value === 'string' && TRANSACTION_HASH.test(value) ? value : null
}
