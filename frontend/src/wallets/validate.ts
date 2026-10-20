/**
 * The create rules, mirrored from the server rather than invented here.
 *
 * Every rule below is one the API enforces, in backend/internal/wallet/service.go.
 * A stricter client rule would reject a wallet the server accepts, which reads
 * as a bug to anyone who already has an account, and a looser one would turn a
 * form the user thought was valid into a 422 they have to decode.
 *
 * Two rules are easy to get wrong in JavaScript and are spelled out below:
 * the server trims with Go's `strings.TrimSpace` and counts length in Unicode
 * code points. JavaScript's `trim` and `length` are both different.
 */

import type { Chain } from '../api/index.ts'

/** backend/internal/wallet/service.go: the 42 character `0x` address. */
export const ADDRESS_LENGTH = 42

/** backend/internal/wallet/service.go: validateLabel. */
export const MAX_LABEL_CODE_POINTS = 50

/**
 * The set Go's `unicode.IsSpace` accepts: ASCII whitespace, U+0085 and U+00A0,
 * and every code point with the Unicode `White_Space` property.
 *
 * This is not JavaScript's `trim`, and the two differ in both directions. Go
 * trims U+0085 (next line); JavaScript does not. JavaScript trims U+FEFF (byte
 * order mark); Go does not. Using `trim` here would let a label of only U+0085
 * through as non-empty, and would measure a label differently from the server
 * that is going to store it.
 */
const GO_SPACE =
  /^[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g

/** Mirrors Go's `strings.TrimSpace` on both ends. */
export function goTrimSpace(value: string): string {
  return value.replace(GO_SPACE, '')
}

/**
 * Length in Unicode code points, which is what Go counts when it says 50
 * characters.
 *
 * `value.length` counts UTF-16 units, so an emoji outside the basic plane
 * counts as two and a 50 emoji label would be rejected at 25. Spreading into an
 * array iterates by code point, which is the unit the server is counting.
 */
export function codePointLength(value: string): number {
  return Array.from(value).length
}

/**
 * The address as the server will store it: `strings.ToLower(strings.TrimSpace(address))`.
 *
 * Normalising on this side is what makes the duplicate check honest. The server
 * lowercases before its unique lookup, so a duplicate typed in checksum case
 * collides there; sending the raw value would show a 409 for an address the
 * form appeared to accept, and the saved row would come back spelled
 * differently from what was typed.
 */
export function normalizeAddress(value: string): string {
  return goTrimSpace(value).toLowerCase()
}

/** The label as the server will store it: `strings.TrimSpace(label)`. */
export function normalizeLabel(value: string): string {
  return goTrimSpace(value)
}

/** The field order used to decide which invalid input receives focus. */
export const WALLET_FIELD_ORDER = ['address', 'chainId', 'label'] as const

export function validateAddress(value: string): string | null {
  const address = normalizeAddress(value)

  // The same order the service checks in, so the first message the user sees
  // is the first thing that is wrong with what they typed.
  if (address === '') {
    return 'Enter a wallet address.'
  }

  if (!address.startsWith('0x')) {
    return 'Enter an address starting with 0x.'
  }

  if (codePointLength(address) !== ADDRESS_LENGTH) {
    return `Enter an address that is ${String(ADDRESS_LENGTH)} characters long.`
  }

  if (!/^0x[0-9a-f]{40}$/.test(address)) {
    return 'Enter an address using hexadecimal characters only.'
  }

  return null
}

export function validateLabel(value: string): string | null {
  const label = normalizeLabel(value)

  if (label === '') {
    return 'Enter a label.'
  }

  if (codePointLength(label) > MAX_LABEL_CODE_POINTS) {
    return `Enter a label of ${String(MAX_LABEL_CODE_POINTS)} characters or fewer.`
  }

  return null
}

/**
 * The chain must be one the catalog actually offered.
 *
 * A positive integer is not enough: the server rejects a chain id that is not
 * in the enabled catalog, so a stale option left over from an earlier catalog,
 * or one a test seeded by hand, would reach the API as a 422 the form could
 * have caught.
 */
export function validateChainId(
  chainId: number | null,
  chains: readonly Chain[],
): string | null {
  if (chainId === null || !Number.isSafeInteger(chainId) || chainId <= 0) {
    return 'Select a chain.'
  }

  if (!chains.some((chain) => chain.chainId === chainId)) {
    return 'Select a chain from the list.'
  }

  return null
}

/** The one option label for a chain. Built from the catalog, never hard-coded. */
export function chainOptionLabel(chain: Chain): string {
  return `${chain.name} (${chain.symbol})${chain.isTestnet ? ' testnet' : ''}`
}
