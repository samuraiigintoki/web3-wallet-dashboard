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

  it('names the variable and the value in the failure, so a build log says what to fix', () => {
    expect(() => resolveApiBase('api/v1')).toThrowError(
      'VITE_API_BASE_URL must be an absolute http(s) URL or a path beginning with /, and it was "api/v1".',
    )
  })
})
