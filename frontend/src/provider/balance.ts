/**
 * A balance quantity, read as a number without losing a digit.
 *
 * `eth_getBalance` answers with a hex quantity. JavaScript's `number` holds 53
 * bits exactly and a wei balance routinely needs 60 or more, so every conversion
 * through `Number` here would be a silent rounding of the user's money. The
 * quantity is therefore parsed into a `bigint` and printed with `toString(10)`,
 * which is exact at any size.
 *
 * Nothing in this file knows about decimals, symbols or fiat. A native balance is
 * an integer count of wei on the chain the wallet is on, and that is all this
 * slice claims.
 */

/**
 * The largest quantity this slice will accept: 32 bytes, the width of a uint256.
 *
 * A chain balance is a uint256, so a longer answer is not a large balance, it is
 * a malformed one. Capping it also keeps a hostile extension from making the page
 * hold an arbitrarily long integer.
 */
const MAX_HEX_DIGITS = 64

const QUANTITY = /^0x[0-9a-fA-F]+$/

/**
 * Reads a hex quantity, or null when the answer is not one.
 *
 * Accepted: `0x` followed by one to sixty-four hex digits, which includes `0x0`
 * for a zero balance. Refused: everything else, including an empty quantity, a
 * decimal number, a JavaScript number, a negative value and a padded string. A
 * quantity with leading zeros is accepted, because its value is unambiguous and
 * refusing it would reject a correct answer from a provider that pads.
 */
export function parseQuantity(value: unknown): bigint | null {
  if (typeof value !== 'string' || !QUANTITY.test(value)) {
    return null
  }

  const digits = value.slice(2)

  // The limit is on the digits the provider sent, not on their value. A quantity
  // padded past the width is malformed even when the padding is zeroes and the
  // value would fit, so this check comes before anything is normalised away.
  if (digits.length > MAX_HEX_DIGITS) {
    return null
  }

  return BigInt(`0x${digits}`)
}

/** The exact decimal form of a quantity, for display next to the unit. */
export function formatWei(value: bigint): string {
  return value.toString(10)
}
