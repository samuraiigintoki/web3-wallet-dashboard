import { describe, expect, it } from 'vitest'

import { parseTransactionReceipt } from './receipt.ts'

/**
 * The receipt parser, against answers a wallet really sends and answers it never
 * should.
 *
 * The cases that matter are the ones that would put a wrong outcome on screen: a
 * receipt for another transaction, a receipt for another contract, one with no
 * usable status, and one whose numbers are not numbers. None of them may be
 * rendered as this submission's fate.
 */

const HASH = `0x${'ab'.repeat(32)}`
const OTHER_HASH = `0x${'cd'.repeat(32)}`
const CONTRACT = '0x5b324f41e5889cf94cba8e909089683a1a97c318'
const OTHER_CONTRACT = '0x14912965632cd9ab70c046e8d23e9b8dfa9f2746'
const BLOCK_HASH = `0x${'11'.repeat(32)}`

const expected = { hash: HASH, to: CONTRACT }

function receipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    transactionHash: HASH,
    to: CONTRACT,
    status: '0x1',
    blockNumber: '0x5d2c40',
    blockHash: BLOCK_HASH,
    from: '0x1e1D0e1D0e1D0e1D0e1D0e1D0e1D0e1D0e1D0e1D',
    gasUsed: '0x5208',
    ...overrides,
  }
}

describe('a receipt the provider has not got', () => {
  it('reads null as no receipt available now', () => {
    expect(parseTransactionReceipt(null, expected)).toEqual({
      ok: true,
      outcome: { kind: 'none' },
    })
  })
})

describe('an included transaction', () => {
  it('reads a successful status', () => {
    expect(parseTransactionReceipt(receipt(), expected)).toEqual({
      ok: true,
      outcome: {
        kind: 'included',
        success: true,
        blockNumber: '6106176',
        blockHash: BLOCK_HASH,
      },
    })
  })

  it('reads a reverted status', () => {
    const parsed = parseTransactionReceipt(receipt({ status: '0x0' }), expected)

    expect(parsed.ok).toBe(true)

    if (!parsed.ok || parsed.outcome.kind !== 'included') {
      return
    }

    expect(parsed.outcome.success).toBe(false)
  })

  it('accepts a padded status, because providers disagree about quantity padding', () => {
    const parsed = parseTransactionReceipt(receipt({ status: '0x01' }), expected)

    expect(parsed.ok).toBe(true)

    if (!parsed.ok || parsed.outcome.kind !== 'included') {
      return
    }

    expect(parsed.outcome.success).toBe(true)
  })

  it('compares the hash and the target without caring about case', () => {
    const parsed = parseTransactionReceipt(
      receipt({
        transactionHash: HASH.toUpperCase().replace('0X', '0x'),
        to: CONTRACT.toUpperCase().replace('0X', '0x'),
      }),
      expected,
    )

    expect(parsed.ok).toBe(true)
  })
})

describe('an answer that must not be shown', () => {
  it('refuses a receipt for another transaction', () => {
    expect(parseTransactionReceipt(receipt({ transactionHash: OTHER_HASH }), expected)).toEqual({
      ok: false,
      refusal: 'other-transaction',
    })
  })

  it('refuses a receipt for a transaction to another contract', () => {
    expect(parseTransactionReceipt(receipt({ to: OTHER_CONTRACT }), expected)).toEqual({
      ok: false,
      refusal: 'other-contract',
    })
  })

  it('refuses anything that is not a receipt object', () => {
    for (const value of ['0x1', 1, true, [], [receipt()]]) {
      expect(parseTransactionReceipt(value, expected)).toEqual({
        ok: false,
        refusal: 'malformed',
      })
    }
  })

  it('refuses a receipt with no usable status, rather than guessing the outcome', () => {
    for (const status of [undefined, '0x2', '1', 1, '0x', null, {}]) {
      expect(parseTransactionReceipt(receipt({ status }), expected)).toEqual({
        ok: false,
        refusal: 'malformed',
      })
    }
  })

  it('refuses a block number that is not a positive quantity', () => {
    for (const blockNumber of [undefined, '0x0', '6102592', -1, '0xzz', 6102592]) {
      expect(parseTransactionReceipt(receipt({ blockNumber }), expected)).toEqual({
        ok: false,
        refusal: 'malformed',
      })
    }
  })

  it('refuses a block hash that is not thirty-two bytes', () => {
    for (const blockHash of [undefined, '0x', `0x${'11'.repeat(31)}`, 42]) {
      expect(parseTransactionReceipt(receipt({ blockHash }), expected)).toEqual({
        ok: false,
        refusal: 'malformed',
      })
    }
  })

  it('refuses a missing or malformed hash and target before looking at anything else', () => {
    expect(parseTransactionReceipt(receipt({ transactionHash: undefined }), expected)).toEqual({
      ok: false,
      refusal: 'malformed',
    })
    expect(parseTransactionReceipt(receipt({ to: undefined }), expected)).toEqual({
      ok: false,
      refusal: 'malformed',
    })

    // Identity first: a well-formed receipt for another contract is refused as
    // a different contract, not as a malformed answer.
    expect(
      parseTransactionReceipt(receipt({ to: OTHER_CONTRACT, status: 'nonsense' }), expected),
    ).toEqual({ ok: false, refusal: 'other-contract' })
  })
})
