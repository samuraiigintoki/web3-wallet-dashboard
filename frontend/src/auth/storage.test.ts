import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createTokenStorage, SESSION_TOKEN_KEY, tokenStorage } from './storage.ts'

describe('token storage', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('round-trips the token under one namespaced key', () => {
    const storage = createTokenStorage()

    storage.write('token-abc')

    expect(storage.read()).toBe('token-abc')
    expect(window.localStorage.getItem(SESSION_TOKEN_KEY)).toBe('token-abc')
  })

  it('stores the token string only, with no expiry copy', () => {
    const storage = createTokenStorage()

    storage.write('token-abc')

    expect(Object.keys(window.localStorage)).toEqual([SESSION_TOKEN_KEY])
    expect(window.localStorage.getItem(SESSION_TOKEN_KEY)).toBe('token-abc')
  })

  it('reads null when nothing is stored', () => {
    expect(createTokenStorage().read()).toBeNull()
  })

  it('treats an empty stored value as no token', () => {
    window.localStorage.setItem(SESSION_TOKEN_KEY, '')

    expect(createTokenStorage().read()).toBeNull()
  })

  it('clears the key', () => {
    const storage = createTokenStorage()
    storage.write('token-abc')

    storage.clear()

    expect(storage.read()).toBeNull()
    expect(window.localStorage.getItem(SESSION_TOKEN_KEY)).toBeNull()
  })

  it('degrades to memory when the backing store is unreachable', () => {
    const storage = createTokenStorage(() => null)

    storage.write('token-abc')

    expect(storage.read()).toBe('token-abc')
    expect(window.localStorage.getItem(SESSION_TOKEN_KEY)).toBeNull()

    storage.clear()
    expect(storage.read()).toBeNull()
  })

  it('degrades to memory when a write throws, instead of crashing', () => {
    const throwing = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(() => {
        throw new DOMException('QuotaExceededError')
      }),
      removeItem: vi.fn(),
    } as unknown as Storage

    const storage = createTokenStorage(() => throwing)

    expect(() => {
      storage.write('token-abc')
    }).not.toThrow()
    expect(storage.read()).toBe('token-abc')
  })

  it('degrades to memory when a read throws', () => {
    const throwing = {
      getItem: vi.fn(() => {
        throw new DOMException('SecurityError')
      }),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    } as unknown as Storage

    const storage = createTokenStorage(() => throwing)

    expect(storage.read()).toBeNull()
    expect(() => storage.read()).not.toThrow()
  })

  it('exposes a shared instance for the application', () => {
    tokenStorage.write('shared-token')

    expect(tokenStorage.read()).toBe('shared-token')

    tokenStorage.clear()
  })
})
