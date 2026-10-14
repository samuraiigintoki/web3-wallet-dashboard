import { describe, expect, it } from 'vitest'

import {
  codePointLength,
  utf8ByteLength,
  MAX_PASSWORD_BYTES,
  MIN_PASSWORD_RUNES,
  validateNewPassword,
  validatePassword,
} from './validation.ts'

const shortMessage = 'Your password must be at least 15 characters.'
const bytesMessage = 'Your password must be 72 bytes or fewer.'

describe('validateNewPassword', () => {
  it('accepts the boundary and one code point above it', () => {
    expect(validateNewPassword('a'.repeat(MIN_PASSWORD_RUNES))).toBeNull()
    expect(validateNewPassword('a'.repeat(MIN_PASSWORD_RUNES + 1))).toBeNull()
  })

  it('rejects one code point below the boundary', () => {
    expect(validateNewPassword('a'.repeat(MIN_PASSWORD_RUNES - 1))).toBe(shortMessage)
  })

  it('counts code points, so fourteen astral characters are still too short', () => {
    const fourteen = '𝄞'.repeat(14)
    expect(fourteen.length).toBe(28)
    expect(codePointLength(fourteen)).toBe(14)
    expect(validateNewPassword(fourteen)).toBe(shortMessage)
    expect(validateNewPassword('𝄞'.repeat(MIN_PASSWORD_RUNES))).toBeNull()
  })

  it('rejects a whitespace-only password as blank, however long', () => {
    expect(validateNewPassword('')).toBe('Enter your password.')
    expect(validateNewPassword(' '.repeat(MIN_PASSWORD_RUNES))).toBe('Enter your password.')
  })

  it('treats U+0085 as blank, because the server does and .trim() does not', () => {
    // Reproduced against the API: fifteen of these are blank to Go, and
    // JavaScript's trim() leaves them alone.
    const nextLines = '\u0085'.repeat(MIN_PASSWORD_RUNES)
    expect(nextLines.trim()).not.toBe('')
    expect(utf8ByteLength(nextLines)).toBe(30)
    expect(validateNewPassword(nextLines)).toBe('Enter your password.')
  })

  it('accepts U+FEFF, because the server does and .trim() treats it as blank', () => {
    // The mirror image: fifteen of these satisfy the server's rules at 15 code
    // points and 45 bytes, and JavaScript's trim() would call them empty.
    const byteOrderMarks = '\uFEFF'.repeat(MIN_PASSWORD_RUNES)
    expect(byteOrderMarks.trim()).toBe('')
    expect(utf8ByteLength(byteOrderMarks)).toBe(45)
    expect(validateNewPassword(byteOrderMarks)).toBeNull()
  })

  it('counts the padding, so fifteen code points including spaces are accepted', () => {
    expect(validateNewPassword('  ' + 'a'.repeat(11) + '  ')).toBeNull()
    expect(validateNewPassword('  ' + 'a'.repeat(10) + '  ')).toBe(shortMessage)
  })

  it('still rejects a password over the byte ceiling', () => {
    const tooLong = 'é'.repeat(37)
    expect(tooLong.length).toBeLessThan(MAX_PASSWORD_BYTES)
    expect(validateNewPassword(tooLong)).toBe(bytesMessage)
  })
})

describe('validatePassword, the login rule', () => {
  it('applies no minimum, so a short legacy password still submits', () => {
    expect(validatePassword('short')).toBeNull()
    expect(validatePassword('a')).toBeNull()
  })

  it('still asks for something and still applies the byte ceiling', () => {
    expect(validatePassword('')).toBe('Enter your password.')
    expect(validatePassword('é'.repeat(37))).toBe(bytesMessage)
  })
})
