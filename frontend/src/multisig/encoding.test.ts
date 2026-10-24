import { toFunctionSelector } from 'viem'
import { describe, expect, it } from 'vitest'

import {
  SUBMIT_TRANSACTION_ABI,
  buildSubmission,
  encodeSubmitTransaction,
  parseCalldata,
  parseDestination,
  parseTransactionHash,
  parseValueWei,
  SUBMIT_TRANSACTION_SELECTOR,
  VALUE_TOO_LARGE,
} from './encoding.ts'

/**
 * The encoder, pinned to bytes rather than to an implementation.
 *
 * Every constant in `VECTORS` was generated with `viem` 2.57.11 in a scratch
 * directory, using `encodeFunctionData` on the same ABI, and pasted here as a
 * literal. The encoder now calls that same function, so these vectors do double
 * duty: they state what the app sends, and they fail loudly if a dependency
 * upgrade, a refactor or a hand-rolled optimisation ever changes a byte of it.
 * Nothing in the rest of the suite asserts the calldata, so this file is where
 * that promise lives.
 *
 * The cases are chosen for the ways this encoding can go wrong: an empty bytes
 * argument (no words after the length), a payload shorter than a word, a payload
 * that straddles two words, a value at the uint256 ceiling, and a value written
 * with leading zeros that must normalise rather than change the encoding.
 */

const MAX_UINT256 = '115792089237316195423570985008687907853269984665640564039457584007913129639935'

type Vector = {
  name: string
  contract: string
  destination: string
  valueWei: string
  calldata: string
  encoded: string
}

const VECTORS: Vector[] = [
  {
    name: 'empty calldata and a zero value',
    contract: '0x5b324f41e5889cf94cba8e909089683a1a97c318',
    destination: '0x00000000000000000000000000000000000000ff',
    valueWei: '0',
    calldata: '0x',
    encoded:
      '0xc642747400000000000000000000000000000000000000000000000000000000000000ff' +
      '0000000000000000000000000000000000000000000000000000000000000000' +
      '0000000000000000000000000000000000000000000000000000000000000060' +
      '0000000000000000000000000000000000000000000000000000000000000000',
  },
  {
    name: 'one ether and a four-byte payload',
    contract: '0x5b324f41e5889cf94cba8e909089683a1a97c318',
    destination: '0x14912965632cd9ab70c046e8d23e9b8dfa9f2746',
    valueWei: '1000000000000000000',
    calldata: '0xdeadbeef',
    encoded:
      '0xc642747400000000000000000000000014912965632cd9ab70c046e8d23e9b8dfa9f2746' +
      '0000000000000000000000000000000000000000000000000de0b6b3a7640000' +
      '0000000000000000000000000000000000000000000000000000000000000060' +
      '0000000000000000000000000000000000000000000000000000000000000004' +
      'deadbeef00000000000000000000000000000000000000000000000000000000',
  },
  {
    name: 'a thirty-six byte payload that straddles two words',
    contract: '0x5b324f41e5889cf94cba8e909089683a1a97c318',
    destination: '0x5B324F41E5889cf94CbA8e909089683a1a97c318',
    valueWei: '123456789012345678901234567890',
    calldata:
      '0x6a7612020000000000000000000000000000000000000000000000000000000000000001',
    encoded:
      '0xc64274740000000000000000000000005b324f41e5889cf94cba8e909089683a1a97c318' +
      '00000000000000000000000000000000000000018ee90ff6c373e0ee4e3f0ad2' +
      '0000000000000000000000000000000000000000000000000000000000000060' +
      '0000000000000000000000000000000000000000000000000000000000000024' +
      '6a76120200000000000000000000000000000000000000000000000000000000' +
      '0000000100000000000000000000000000000000000000000000000000000000',
  },
  {
    name: 'the uint256 ceiling and a one-byte payload',
    contract: '0x5b324f41e5889cf94cba8e909089683a1a97c318',
    destination: '0x00000000000000000000000000000000000000ff',
    valueWei: MAX_UINT256,
    calldata: '0x00',
    encoded:
      '0xc642747400000000000000000000000000000000000000000000000000000000000000ff' +
      'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' +
      '0000000000000000000000000000000000000000000000000000000000000060' +
      '0000000000000000000000000000000000000000000000000000000000000001' +
      '0000000000000000000000000000000000000000000000000000000000000000',
  },
  {
    name: 'a value written with leading zeros',
    contract: '0x5b324f41e5889cf94cba8e909089683a1a97c318',
    destination: '0x00000000000000000000000000000000000000ff',
    valueWei: '0000000000000000000000000001',
    calldata: '0x',
    encoded:
      '0xc642747400000000000000000000000000000000000000000000000000000000000000ff' +
      '0000000000000000000000000000000000000000000000000000000000000001' +
      '0000000000000000000000000000000000000000000000000000000000000060' +
      '0000000000000000000000000000000000000000000000000000000000000000',
  },
  {
    name: 'a thirty-three byte payload, padded to a second word',
    contract: '0x5b324f41e5889cf94cba8e909089683a1a97c318',
    destination: '0x14912965632cd9ab70c046e8d23e9b8dfa9f2746',
    valueWei: '1',
    calldata: `0x${'ab'.repeat(33)}`,
    encoded:
      '0xc642747400000000000000000000000014912965632cd9ab70c046e8d23e9b8dfa9f2746' +
      '0000000000000000000000000000000000000000000000000000000000000001' +
      '0000000000000000000000000000000000000000000000000000000000000060' +
      '0000000000000000000000000000000000000000000000000000000000000021' +
      `${'ab'.repeat(32)}` +
      'ab00000000000000000000000000000000000000000000000000000000000000',
  },
]

describe('submitTransaction encoding', () => {
  it('uses the selector the hash of the signature gives', () => {
    // keccak256("submitTransaction(address,uint256,bytes)")[0..4]: the constant
    // the app prefixes its calldata with, checked against the ABI rather than
    // against a copy of itself.
    expect(SUBMIT_TRANSACTION_SELECTOR).toBe(toFunctionSelector(SUBMIT_TRANSACTION_ABI[0]))
    expect(SUBMIT_TRANSACTION_SELECTOR).toBe('0xc6427474')
  })

  for (const vector of VECTORS) {
    it(`matches the reference for ${vector.name}`, () => {
      const built = buildSubmission(vector.contract, {
        destination: vector.destination,
        valueWei: vector.valueWei,
        data: vector.calldata,
      })

      expect(built.ok).toBe(true)

      if (!built.ok) {
        return
      }

      expect(built.request.data).toBe(vector.encoded)
      // The call itself pays the contract nothing.
      expect(built.request.value).toBe('0x0')
      expect(built.request.to).toBe(vector.contract.toLowerCase())
    })
  }

  it('encodes a checksummed destination to the same bytes as the lower case form', () => {
    const checksummed = '0x5B324F41E5889cf94CbA8e909089683a1a97c318'

    expect(parseDestination(checksummed)).toBe(checksummed.toLowerCase())

    const upper = encodeSubmitTransaction({
      destination: parseDestination(checksummed) as `0x${string}`,
      valueWei: 0n,
      calldata: '0x',
    })
    const lower = encodeSubmitTransaction({
      destination: parseDestination(checksummed.toLowerCase()) as `0x${string}`,
      valueWei: 0n,
      calldata: '0x',
    })

    expect(upper).toBe(lower)
    expect(upper.startsWith(SUBMIT_TRANSACTION_SELECTOR)).toBe(true)
  })

  it('keeps a value above the safe integer range exact', () => {
    const built = buildSubmission('0x5b324f41e5889cf94cba8e909089683a1a97c318', {
      destination: '0x00000000000000000000000000000000000000ff',
      valueWei: '9007199254740993',
      data: '0x',
    })

    expect(built.ok).toBe(true)

    if (!built.ok) {
      return
    }

    // 2^53 + 1, which Number cannot hold. The word carries it unchanged.
    expect(BigInt(`0x${built.request.data.slice(74, 138)}`)).toBe(9007199254740993n)
    expect(built.request.valueWei).toBe('9007199254740993')
  })
})

describe('validation', () => {
  it('refuses an address that is not twenty bytes', () => {
    expect(parseDestination('0x1234')).toBeNull()
    expect(parseDestination('14912965632cd9ab70c046e8d23e9b8dfa9f2746')).toBeNull()
    expect(parseDestination(`0x${'a'.repeat(41)}`)).toBeNull()
  })

  it('refuses a value that is not plain decimal digits', () => {
    for (const value of ['', '  ', '-1', '+1', '1.5', '1,000', '0x10', '1e18', 'one']) {
      expect(parseValueWei(value)).toBeNull()
    }
  })

  it('refuses a value above the uint256 ceiling and accepts the ceiling', () => {
    expect(parseValueWei(MAX_UINT256)).toBe(BigInt(MAX_UINT256))
    expect(parseValueWei('115792089237316195423570985008687907853269984665640564039457584007913129639936')).toBeNull()
  })

  it('names the ceiling in the message rather than the generic one', () => {
    const built = buildSubmission('0x5b324f41e5889cf94cba8e909089683a1a97c318', {
      destination: '0x00000000000000000000000000000000000000ff',
      valueWei: '115792089237316195423570985008687907853269984665640564039457584007913129639936',
      data: '0x',
    })

    expect(built.ok).toBe(false)

    if (built.ok) {
      return
    }

    expect(built.errors.valueWei).toBe(VALUE_TOO_LARGE)
  })

  it('refuses calldata that is not whole bytes', () => {
    expect(parseCalldata('0xabc')).toBeNull()
    expect(parseCalldata('deadbeef')).toBeNull()
    expect(parseCalldata('0xzz')).toBeNull()
  })

  it('reads an empty calldata field as no calldata', () => {
    expect(parseCalldata('')).toBe('0x')
    expect(parseCalldata('   ')).toBe('0x')
    expect(parseCalldata('0x')).toBe('0x')
  })

  it('reports one message per bad field and builds nothing', () => {
    const built = buildSubmission('0x5b324f41e5889cf94cba8e909089683a1a97c318', {
      destination: 'nope',
      valueWei: '1.5',
      data: '0xabc',
    })

    expect(built.ok).toBe(false)

    if (built.ok) {
      return
    }

    expect(Object.keys(built.errors).sort()).toEqual(['data', 'destination', 'valueWei'])
  })

  it('refuses to encode against a contract address that is not an address', () => {
    const built = buildSubmission('0xnot-a-contract', {
      destination: '0x00000000000000000000000000000000000000ff',
      valueWei: '1',
      data: '0x',
    })

    expect(built.ok).toBe(false)
  })
})

describe('the returned hash', () => {
  it('accepts thirty-two bytes of hex in either case', () => {
    const lower = `0x${'ab'.repeat(32)}`

    expect(parseTransactionHash(lower)).toBe(lower)
    expect(parseTransactionHash(`0x${'AB'.repeat(32)}`)).toBe(`0x${'AB'.repeat(32)}`)
  })

  it('refuses anything else, rather than echoing it as a hash', () => {
    for (const value of [null, undefined, 42, {}, '', '0x', `0x${'ab'.repeat(31)}`, `0x${'ab'.repeat(33)}`]) {
      expect(parseTransactionHash(value)).toBeNull()
    }
  })
})
