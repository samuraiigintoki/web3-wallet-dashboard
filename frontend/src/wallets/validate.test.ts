import { describe, expect, it } from 'vitest'

import type { Chain } from '../api/index.ts'
import {
  MAX_LABEL_CODE_POINTS,
  chainOptionLabel,
  codePointLength,
  goTrimSpace,
  normalizeAddress,
  normalizeLabel,
  validateAddress,
  validateChainId,
  validateLabel,
} from './validate.ts'

const SEPOLIA: Chain = { chainId: 11155111, name: 'Sepolia', symbol: 'ETH', isTestnet: true }
const ETHEREUM: Chain = { chainId: 1, name: 'Ethereum', symbol: 'ETH', isTestnet: false }

const CATALOG: readonly Chain[] = [ETHEREUM, SEPOLIA]

const VALID_ADDRESS = '0x00000000000000000000000000000000000000a1'

describe('goTrimSpace', () => {
  it('trims the ASCII whitespace both languages agree on', () => {
    expect(goTrimSpace('  hi  ')).toBe('hi')
    expect(goTrimSpace('\t\n\v\f\r hi \r\f\v\n\t')).toBe('hi')
  })

  it('trims U+0085, which Go trims and JavaScript does not', () => {
    // strings.TrimSpace uses unicode.IsSpace, and U+0085 is in it. JavaScript's
    // trim is specified against WhiteSpace and LineTerminator, which excludes
    // it, so a label of only next-line characters is blank to the server and
    // non-blank to `trim`.
    expect('\u0085hi\u0085'.trim()).toBe('\u0085hi\u0085')
    expect(goTrimSpace('\u0085hi\u0085')).toBe('hi')
  })

  it('trims U+00A0 and the Unicode space separators', () => {
    expect(goTrimSpace('\u00a0hi\u00a0')).toBe('hi')
    expect(goTrimSpace('\u3000hi\u2028')).toBe('hi')
  })

  it('leaves U+FEFF alone, because Go does not trim it', () => {
    // The other direction of the same difference. JavaScript trims the byte
    // order mark, Go does not, so counting it as whitespace would reject or
    // shorten a label the server is happy to store.
    expect('\uFEFFhi'.trim()).toBe('hi')
    expect(goTrimSpace('\uFEFFhi')).toBe('\uFEFFhi')
  })

  it('leaves the inside of a value alone', () => {
    expect(goTrimSpace(' a b ')).toBe('a b')
  })
})

describe('codePointLength', () => {
  it('counts an astral character as one', () => {
    // Two UTF-16 units, one code point. The server counts runes, so this is
    // one character of a label's budget, not two.
    expect('\u{1F600}'.length).toBe(2)
    expect(codePointLength('\u{1F600}')).toBe(1)
  })

  it('counts a combining pair as its two code points', () => {
    expect(codePointLength('e\u0301')).toBe(2)
  })
})

describe('validateAddress', () => {
  it('accepts a well formed address', () => {
    expect(validateAddress(VALID_ADDRESS)).toBeNull()
  })

  it('accepts an address in checksum case and normalises it', () => {
    // The server lowercases before it stores and before its unique lookup, so
    // sending the raw value would show a duplicate error for an address the
    // form appeared to accept.
    expect(validateAddress(VALID_ADDRESS.toUpperCase())).toBeNull()
    expect(normalizeAddress(VALID_ADDRESS.toUpperCase())).toBe(VALID_ADDRESS)
  })

  it('trims before it checks', () => {
    expect(validateAddress(`  ${VALID_ADDRESS}  `)).toBeNull()
    expect(normalizeAddress(`  ${VALID_ADDRESS} `)).toBe(VALID_ADDRESS)
  })

  it.each([
    ['an empty value', ''],
    ['only whitespace', '   '],
    ['only U+0085', '\u0085'],
  ])('rejects %s', (_name, value) => {
    expect(validateAddress(value)).toBe('Enter a wallet address.')
  })

  it('rejects an address that does not start with 0x', () => {
    expect(validateAddress(VALID_ADDRESS.slice(2))).toBe('Enter an address starting with 0x.')
  })

  it('rejects an address of the wrong length', () => {
    expect(validateAddress('0x0000')).toContain('42 characters long')
    expect(validateAddress(`${VALID_ADDRESS}00`)).toContain('42 characters long')
  })

  it('rejects a 42 character value that is not hexadecimal', () => {
    const notHex = `0x${'z'.repeat(40)}`
    expect(validateAddress(notHex)).toBe('Enter an address using hexadecimal characters only.')
  })
})

describe('validateLabel', () => {
  it('accepts a short label', () => {
    expect(validateLabel('Treasury')).toBeNull()
  })

  it('accepts exactly the maximum and rejects one more', () => {
    const atLimit = 'a'.repeat(MAX_LABEL_CODE_POINTS)
    const overLimit = 'a'.repeat(MAX_LABEL_CODE_POINTS + 1)

    expect(validateLabel(atLimit)).toBeNull()
    expect(validateLabel(overLimit)).toContain('50 characters or fewer')
  })

  it('counts astral characters as one each', () => {
    // Fifty emoji is a legal label: the server counts runes. A UTF-16 check
    // would call this a hundred characters and reject a label the API accepts.
    const fifty = '\u{1F600}'.repeat(MAX_LABEL_CODE_POINTS)

    expect(codePointLength(fifty)).toBe(MAX_LABEL_CODE_POINTS)
    expect(validateLabel(fifty)).toBeNull()
    expect(validateLabel(`${fifty}\u{1F600}`)).toContain('50 characters or fewer')
  })

  it('measures after trimming, the way the server does', () => {
    const padding = ' '.repeat(10)
    const label = `${padding}${'a'.repeat(MAX_LABEL_CODE_POINTS)}${padding}`

    expect(validateLabel(label)).toBeNull()
    expect(normalizeLabel(label)).toBe('a'.repeat(MAX_LABEL_CODE_POINTS))
  })

  it('treats a label of only U+0085 as empty, the way Go does', () => {
    expect(validateLabel('\u0085\u0085')).toBe('Enter a label.')
  })

  it('treats a label of only U+FEFF as a real label, the way Go does', () => {
    expect(validateLabel('\uFEFF')).toBeNull()
    expect(normalizeLabel('\uFEFF')).toBe('\uFEFF')
  })

  it.each([
    ['an empty value', ''],
    ['only spaces', '   '],
    ['only a tab', '\t'],
  ])('rejects %s', (_name, value) => {
    expect(validateLabel(value)).toBe('Enter a label.')
  })
})

describe('validateChainId', () => {
  it('accepts a chain the catalog offered', () => {
    expect(validateChainId(SEPOLIA.chainId, CATALOG)).toBeNull()
  })

  it.each([
    ['nothing selected', null],
    ['zero', 0],
    ['a negative id', -1],
    ['a float', 1.5],
    ['an unsafe integer', 2 ** 53],
  ])('rejects %s', (_name, value) => {
    expect(validateChainId(value, CATALOG)).toBe('Select a chain.')
  })

  it('rejects a positive chain the catalog does not offer', () => {
    // The server answers an unsupported chain id with 422, so a stale option
    // from an earlier catalog is caught here rather than by the API.
    expect(validateChainId(999, CATALOG)).toBe('Select a chain from the list.')
  })

  it('rejects every chain when the catalog is empty', () => {
    expect(validateChainId(1, [])).toBe('Select a chain from the list.')
  })
})

describe('chainOptionLabel', () => {
  it('marks a testnet and leaves a mainnet alone', () => {
    expect(chainOptionLabel(SEPOLIA)).toBe('Sepolia (ETH) testnet')
    expect(chainOptionLabel(ETHEREUM)).toBe('Ethereum (ETH)')
  })
})
