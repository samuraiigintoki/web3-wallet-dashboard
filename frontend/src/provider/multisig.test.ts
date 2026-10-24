import { describe, expect, it } from 'vitest'

import {
  decodeAddressArray,
  decodeUint256,
  formatCount,
  MULTISIG_ADDRESS,
  SELECTOR_GET_OWNERS,
  SELECTOR_THRESHOLD,
  SELECTOR_TRANSACTION_COUNT,
  SEPOLIA_CHAIN_ID,
  summaryIsPlausible,
  ZERO_ADDRESS,
} from './multisig.ts'

const OWNER_A = '14912965632cd9ab70c046e8d23e9b8dfa9f2746'
const OWNER_B = '00000000000000000000000000000000000000ab'

/** Left-pads a hex value to one ABI word. */
function word(hex: string): string {
  return hex.padStart(64, '0')
}

/** The ABI encoding of an `address[]`, as `getOwners()` returns it. */
function encodeAddressArray(addresses: string[]): string {
  const head = word('20')
  const length = word(addresses.length.toString(16))
  const body = addresses.map((address) => word(address.replace(/^0x/, ''))).join('')

  return `0x${head}${length}${body}`
}

describe('the target', () => {
  it('is the verified Sepolia deployment, addressed once', () => {
    expect(MULTISIG_ADDRESS).toBe('0x5B324F41E5889cf94CbA8e909089683a1a97c318')
    expect(SEPOLIA_CHAIN_ID).toBe(11155111)
  })

  it('uses the selectors the compiler produced', () => {
    // Computed with solc 0.8.33 rather than guessed: a wrong selector would
    // revert or, worse, land on a different function of the same contract.
    expect(SELECTOR_GET_OWNERS).toBe('0xa0e67e2b')
    expect(SELECTOR_THRESHOLD).toBe('0x42cde4e8')
    expect(SELECTOR_TRANSACTION_COUNT).toBe('0x2e7700f0')
  })
})

describe('uint256 decoding', () => {
  it('reads zero and small counts', () => {
    expect(decodeUint256(`0x${word('0')}`)).toBe(0n)
    expect(decodeUint256(`0x${word('1')}`)).toBe(1n)
    expect(decodeUint256(`0x${word('ff')}`)).toBe(255n)
  })

  it('keeps values above the safe integer range exact', () => {
    const huge = `0x${'f'.repeat(64)}`

    expect(decodeUint256(huge)).toBe(
      115792089237316195423570985008687907853269984665640564039457584007913129639935n,
    )
    expect(formatCount(decodeUint256(huge)!)).toBe(
      '115792089237316195423570985008687907853269984665640564039457584007913129639935',
    )
    // 2^53 + 1, the first integer a double cannot hold.
    const pastSafe = `0x${(9007199254740993n).toString(16).padStart(64, '0')}`
    expect(formatCount(decodeUint256(pastSafe)!)).toBe('9007199254740993')
  })

  it('refuses anything that is not exactly one word', () => {
    for (const value of [
      undefined,
      null,
      1,
      '',
      '0x',
      '0x1',
      `0x${'0'.repeat(63)}`,
      `0x${'0'.repeat(65)}`,
      `0x${'0'.repeat(64)}00`,
      '0xzz',
      `0x${'g'.repeat(64)}`,
      {},
    ]) {
      expect(decodeUint256(value)).toBeNull()
    }
  })
})

describe('address array decoding', () => {
  it('reads the single-owner array the deployment returns', () => {
    const encoded =
      '0x0000000000000000000000000000000000000000000000000000000000000020' +
      '0000000000000000000000000000000000000000000000000000000000000001' +
      '00000000000000000000000014912965632cd9ab70c046e8d23e9b8dfa9f2746'

    expect(decodeAddressArray(encoded)).toEqual(['0x14912965632cd9ab70c046e8d23e9b8dfa9f2746'])
  })

  it('reads more than one owner, in order', () => {
    expect(decodeAddressArray(encodeAddressArray([OWNER_A, OWNER_B]))).toEqual([
      `0x${OWNER_A}`,
      `0x${OWNER_B}`,
    ])
  })

  it('reads an empty array as empty rather than as a failure', () => {
    expect(decodeAddressArray(encodeAddressArray([]))).toEqual([])
  })

  it('refuses a layout that contradicts itself', () => {
    const good = encodeAddressArray([OWNER_A]).slice(2)

    // Offset that does not point at the head word.
    expect(decodeAddressArray(`0x${word('40')}${good.slice(64)}`)).toBeNull()

    // Length that claims two owners but carries one.
    const shortBody = `${word('20')}${word('2')}${word(`0${OWNER_A}`)}`
    expect(decodeAddressArray(`0x${shortBody}`)).toBeNull()

    // Trailing bytes beyond the declared array.
    expect(decodeAddressArray(`0x${good}${word('0')}`)).toBeNull()

    // Length past the render cap.
    expect(decodeAddressArray(`0x${word('20')}${word('101')}`)).toBeNull()

    // Truncated head.
    expect(decodeAddressArray(`0x${word('20')}`)).toBeNull()
  })

  it('refuses a word that is not a clean address', () => {
    // High twelve bytes not zero.
    const dirty = `0x${word('20')}${word('1')}${'1'.repeat(24)}${OWNER_A}`
    expect(decodeAddressArray(dirty)).toBeNull()

    // A word with a byte above the twenty-byte address width, which an ABI
    // encoder cannot produce for an address however small the value.
    const overflow = `0x${word('20')}${word('1')}${'f'.repeat(64)}`
    expect(decodeAddressArray(overflow)).toBeNull()
  })

  it('refuses non-string payloads', () => {
    for (const value of [undefined, null, 42, ['0x'], { data: '0x' }, '0xzz']) {
      expect(decodeAddressArray(value)).toBeNull()
    }
  })
})

describe('summary plausibility', () => {
  it('accepts the configuration the constructor allows', () => {
    expect(summaryIsPlausible([`0x${OWNER_A}`], 1n)).toBe(true)
    expect(summaryIsPlausible([`0x${OWNER_A}`, `0x${OWNER_B}`], 2n)).toBe(true)
    expect(summaryIsPlausible([`0x${OWNER_A}`, `0x${OWNER_B}`], 1n)).toBe(true)
  })

  it('refuses what the constructor forbids', () => {
    // No owners, no threshold, and a threshold above the owner count.
    expect(summaryIsPlausible([], 1n)).toBe(false)
    expect(summaryIsPlausible([`0x${OWNER_A}`], 0n)).toBe(false)
    expect(summaryIsPlausible([`0x${OWNER_A}`], 2n)).toBe(false)
  })

  it('refuses the zero address as an owner', () => {
    // `MultiSigWallet__ZeroAddressOwner`: the constructor rejects it, so this
    // deployment can never answer with it, however well-formed the encoding is.
    expect(summaryIsPlausible([ZERO_ADDRESS], 1n)).toBe(false)
    expect(summaryIsPlausible([`0x${OWNER_A}`, ZERO_ADDRESS.toLowerCase()], 1n)).toBe(false)
  })

  it('refuses duplicate owners', () => {
    // `MultiSigWallet__DuplicateOwner`.
    expect(summaryIsPlausible([`0x${OWNER_A}`, `0x${OWNER_A}`], 2n)).toBe(false)
    // The same owner written in two cases is still one owner.
    expect(summaryIsPlausible([`0x${OWNER_A}`, `0x${OWNER_A.toUpperCase()}`], 2n)).toBe(false)
    // And the check must not be so eager that distinct owners are refused.
    expect(summaryIsPlausible([`0x${OWNER_A}`, `0x${OWNER_B}`], 2n)).toBe(true)
  })

  it('decodes the zero address and duplicates, and leaves them to the gate', () => {
    // The decoder is about layout. These payloads are well-formed, which is
    // exactly why the invariant check has to exist after it.
    expect(decodeAddressArray(encodeAddressArray([ZERO_ADDRESS]))).toEqual([ZERO_ADDRESS])
    expect(decodeAddressArray(encodeAddressArray([OWNER_A, OWNER_A]))).toEqual([
      `0x${OWNER_A}`,
      `0x${OWNER_A}`,
    ])
  })
})
