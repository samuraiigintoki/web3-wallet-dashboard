import { describe, expect, it } from 'vitest'

import { resolveApiBase } from './apiBase.ts'

/**
 * The API base a build is compiled against.
 *
 * The default is the local one, and every existing test depends on it, so the
 * cases here are the ones that only happen in a deployment: an absolute API
 * origin, a trailing slash somebody typed, and the mistakes that must stop the
 * build instead of shipping a bundle whose every request goes nowhere.
 */

describe('resolveApiBase', () => {
  it('defaults to the same-origin path the dev server proxies', () => {
    expect(resolveApiBase(undefined)).toBe('/api/v1')
    expect(resolveApiBase('')).toBe('/api/v1')
    expect(resolveApiBase('   ')).toBe('/api/v1')
  })

  it('takes an absolute https origin for a deployed build', () => {
    expect(resolveApiBase('https://web3-wallet-api.onrender.com/api/v1')).toBe(
      'https://web3-wallet-api.onrender.com/api/v1',
    )
  })

  it('strips a trailing slash, so appended paths do not double it', () => {
    expect(resolveApiBase('https://api.example.com/api/v1/')).toBe('https://api.example.com/api/v1')
    expect(resolveApiBase('/api/v1//')).toBe('/api/v1')
  })

  it('takes a rooted path, which is what a same-origin deployment uses', () => {
    expect(resolveApiBase('/api/v2')).toBe('/api/v2')
  })

  it('allows a loopback origin, which is how a built bundle is tested locally', () => {
    expect(resolveApiBase('http://127.0.0.1:8080/api/v1')).toBe('http://127.0.0.1:8080/api/v1')
  })

  it('refuses a value that is neither a URL nor a rooted path', () => {
    for (const raw of [
      'web3-wallet-api.onrender.com/api/v1',
      'api/v1',
      '//web3-wallet-api.onrender.com/api/v1',
      'ftp://api.example.com/api/v1',
      'https://api.example.com/api/v1?x=1',
      'https://api.example.com/api/v1#frag',
      'https://',
      'https://api example.com/api/v1',
    ]) {
      expect(() => resolveApiBase(raw), raw).toThrowError(/VITE_API_BASE_URL/)
    }
  })

  // A URL may carry a username and password, and every character of this value is
  // compiled into the bundle every visitor downloads. Accepting it would publish
  // the credential, and the build would look green while doing it.
  it('refuses a value that carries a username or password', () => {
    for (const raw of [
      'https://user:password@api.example.com/api/v1',
      'https://user@api.example.com/api/v1',
      'http://user:password@127.0.0.1:8080/api/v1',
      'https://:password@api.example.com/api/v1',
      // The password is percent-encoded into userinfo by the extra `@`, so the
      // credential is the text between the colons, not the text before the first
      // `@`. Masking up to the first `@` leaves `s3cr3t` in the message.
      'https://zeus:@s3cr3t@api.example.com/api/v1',
      'https://zeus:pa@ss@word@api.example.com/api/v1',
    ]) {
      expect(() => resolveApiBase(raw), raw).toThrowError(/VITE_API_BASE_URL/)
    }
  })

  it('says which credential is wrong without printing it, because the build log is public too', () => {
    const message = (() => {
      try {
        resolveApiBase('https://user:s3cr3t@api.example.com/api/v1')
      } catch (error) {
        return (error as Error).message
      }
      return ''
    })()

    expect(message).toContain('must not carry a username or password')
    expect(message).not.toContain('s3cr3t')
    expect(message).not.toContain('user:')
    expect(message).not.toContain('api.example.com')
  })

  // Redacting up to the first `@` is the obvious fix for the message above, and it
  // is wrong for this shape: the URL parser reads everything before the last `@`
  // as userinfo, so `user:` and `s3cr3t` are one credential and the second half
  // survives the mask. Every one of these must produce a message with no part of
  // the value in it.
  it('redacts a credential whatever `@` the password hides behind', () => {
    for (const raw of [
      'https://zeus:@s3cr3t@api.example.com/api/v1',
      'https://zeus:pa@ss@word@api.example.com/api/v1',
      'https://@s3cr3t@api.example.com/api/v1',
    ]) {
      const message = (() => {
        try {
          resolveApiBase(raw)
        } catch (error) {
          return (error as Error).message
        }
        return ''
      })()

      expect(message, raw).toContain('VITE_API_BASE_URL')
      expect(message, raw).not.toContain('s3cr3t')
      expect(message, raw).not.toContain('ss@word')
      expect(message, raw).not.toContain('zeus')
      expect(message, raw).not.toContain('@')
      expect(message, raw).not.toContain('api.example.com')
    }
  })

  // The shape check runs before the URL is parsed, so a value that carries a
  // credential and is not a URL at all reaches the other message. It must not echo
  // either.
  it('redacts a credential that is not shaped like a URL', () => {
    const message = (() => {
      try {
        resolveApiBase('user:s3cr3t@api.example.com/api/v1')
      } catch (error) {
        return (error as Error).message
      }
      return ''
    })()

    expect(message).toContain('must be an absolute http(s) URL')
    expect(message).not.toContain('s3cr3t')
    expect(message).not.toContain('user:s3cr3t')
    expect(message).toContain('<redacted:')
  })

  it('still takes an ordinary origin, so the check is narrow', () => {
    expect(resolveApiBase('https://api.example.com/api/v1')).toBe('https://api.example.com/api/v1')
  })

  it('names the variable and the value in the failure, so a build log says what to fix', () => {
    expect(() => resolveApiBase('api/v1')).toThrowError(
      'VITE_API_BASE_URL must be an absolute http(s) URL or a path beginning with /, and it was "api/v1".',
    )
  })
})
