import { describe, expect, it } from 'vitest'

import { formatWei, parseQuantity } from './balance.ts'

describe('balance quantities', () => {
  it('reads zero', () => {
    expect(parseQuantity('0x0')).toBe(0n)
    expect(parseQuantity('0x00')).toBe(0n)
    expect(formatWei(parseQuantity('0x0')!)).toBe('0')
  })

  it('keeps every digit of a balance above the safe integer range', () => {
    // 1 ether in wei, well past 2^53, and a value with all 64 digits set.
    expect(formatWei(parseQuantity('0xde0b6b3a7640000')!)).toBe('1000000000000000000')

    const maxWei = '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
    const parsed = parseQuantity(maxWei)

    expect(parsed).not.toBeNull()
    expect(formatWei(parsed!)).toBe(
      '115792089237316195423570985008687907853269984665640564039457584007913129639935',
    )

    // The number type would have rounded this away; the string did not.
    expect(String(Number(parsed))).not.toBe(formatWei(parsed!))
  })

  it('accepts a quantity with leading zeros, whose value is unambiguous', () => {
    expect(parseQuantity('0x0010')).toBe(16n)
  })

  it('refuses an over-long quantity even when the excess digits are leading zeroes', () => {
    // Sixty-five zeroes then a one: 66 digits, past the 32-byte width, but its
    // value is 1. The limit is on the digits sent, so this is malformed.
    expect(parseQuantity(`0x${'0'.repeat(65)}1`)).toBeNull()
    expect(parseQuantity(`0x${'0'.repeat(62)}1`)).toBe(1n)
    expect(parseQuantity(`0x${'0'.repeat(64)}`)).toBe(0n)
    expect(parseQuantity(`0x${'0'.repeat(65)}`)).toBeNull()
    expect(parseQuantity(`0x1${'0'.repeat(64)}`)).toBeNull()
  })

  it('refuses anything that is not a quantity', () => {
    for (const value of [
      undefined,
      null,
      0,
      1,
      '',
      '0x',
      '0X1',
      '1',
      '0xzz',
      '0x-1',
      ' 0x1',
      '0x1 ',
      '0x1.5',
      'de0b6b3a7640000',
      `0x${'f'.repeat(65)}`,
      {},
      ['0x1'],
    ]) {
      expect(parseQuantity(value)).toBeNull()
    }
  })
})
