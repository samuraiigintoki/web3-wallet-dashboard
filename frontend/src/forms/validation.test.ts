import { describe, expect, it } from 'vitest'

import {
  codePointLength,
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
