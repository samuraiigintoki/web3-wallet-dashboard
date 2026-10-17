import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  announceStorageChange,
  otherTabClearsStorage,
  otherTabRemoves,
  otherTabStores,
} from '../test/crossTab.ts'
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

describe('token storage, shared credential notifications', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('reports the credential it holds when a subscriber attaches', () => {
    window.localStorage.setItem(SESSION_TOKEN_KEY, 'tab-token')
    const listener = vi.fn()

    const unsubscribe = createTokenStorage().subscribe(listener)

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith('tab-token')
    unsubscribe()
  })

  it('reports null when there is nothing stored at subscription time', () => {
    const listener = vi.fn()

    const unsubscribe = createTokenStorage().subscribe(listener)

    expect(listener).toHaveBeenCalledWith(null)
    unsubscribe()
  })

  it('reports a credential another tab stored', () => {
    const listener = vi.fn()
    const unsubscribe = createTokenStorage().subscribe(listener)
    listener.mockClear()

    otherTabStores('other-tab-token')

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith('other-tab-token')
    unsubscribe()
  })

  it('reports null when another tab removes the credential', () => {
    window.localStorage.setItem(SESSION_TOKEN_KEY, 'tab-token')
    const listener = vi.fn()
    const unsubscribe = createTokenStorage().subscribe(listener)
    listener.mockClear()

    otherTabRemoves()

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(null)
    unsubscribe()
  })

  it('reports null when another tab clears storage, which arrives without a key', () => {
    window.localStorage.setItem(SESSION_TOKEN_KEY, 'tab-token')
    const listener = vi.fn()
    const unsubscribe = createTokenStorage().subscribe(listener)
    listener.mockClear()

    otherTabClearsStorage()

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(null)
    unsubscribe()
  })

  it('reports the removal of a credential this tab stored itself', () => {
    const listener = vi.fn()
    const storage = createTokenStorage()
    const unsubscribe = storage.subscribe(listener)
    listener.mockClear()

    // Signing in here goes through write, and browsers do not notify the
    // document that made a change, so this removal is the first delivery the
    // listener ever sees for this credential.
    storage.write('own-tab-token')
    otherTabRemoves()

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(null)
    unsubscribe()
  })

  it('reports a replacement after this tab stored its own credential', () => {
    const listener = vi.fn()
    const storage = createTokenStorage()
    const unsubscribe = storage.subscribe(listener)
    listener.mockClear()

    storage.write('own-tab-token')
    otherTabStores('other-tab-token')

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith('other-tab-token')
    unsubscribe()
  })

  it('still ignores a delivery that reads back the credential this tab stored', () => {
    const listener = vi.fn()
    const storage = createTokenStorage()
    const unsubscribe = storage.subscribe(listener)
    listener.mockClear()

    storage.write('own-tab-token')
    otherTabStores('own-tab-token')

    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('reports a credential another tab stores after this tab signed out here', () => {
    window.localStorage.setItem(SESSION_TOKEN_KEY, 'tab-token')
    const listener = vi.fn()
    const storage = createTokenStorage()
    const unsubscribe = storage.subscribe(listener)
    listener.mockClear()

    // This tab signs out locally, which is not announced to itself either. A
    // credential that arrives afterwards is new to this tab whatever its value.
    storage.clear()
    otherTabStores('tab-token')

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith('tab-token')
    unsubscribe()
  })

  it('ignores a change to an unrelated key', () => {
    const listener = vi.fn()
    const unsubscribe = createTokenStorage().subscribe(listener)
    listener.mockClear()

    window.localStorage.setItem('something-else', 'value')
    announceStorageChange({ key: 'something-else', newValue: 'value' })

    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('ignores a change to another storage area', () => {
    const listener = vi.fn()
    const unsubscribe = createTokenStorage().subscribe(listener)
    listener.mockClear()

    window.sessionStorage.setItem(SESSION_TOKEN_KEY, 'session-only')
    announceStorageChange({ key: SESSION_TOKEN_KEY, storageArea: window.sessionStorage })

    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('reads the store rather than trusting the value an event carries', () => {
    window.localStorage.setItem(SESSION_TOKEN_KEY, 'first-token')
    const listener = vi.fn()
    const unsubscribe = createTokenStorage().subscribe(listener)
    listener.mockClear()

    // Two writes landed before this document handled either notification: the
    // value in the store is the later one, and the delivery still describes the
    // earlier one. The store is what this tab may act on.
    window.localStorage.setItem(SESSION_TOKEN_KEY, 'second-token')
    announceStorageChange({
      key: SESSION_TOKEN_KEY,
      oldValue: 'first-token',
      newValue: 'first-token',
    })

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith('second-token')
    unsubscribe()
  })

  it('ignores a delivery that reads back the value it already announced', () => {
    window.localStorage.setItem(SESSION_TOKEN_KEY, 'tab-token')
    const listener = vi.fn()
    const unsubscribe = createTokenStorage().subscribe(listener)
    listener.mockClear()

    otherTabStores('tab-token')

    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('stops reporting once the subscription ends', () => {
    const listener = vi.fn()
    const unsubscribe = createTokenStorage().subscribe(listener)
    listener.mockClear()

    unsubscribe()
    otherTabStores('other-tab-token')

    expect(listener).not.toHaveBeenCalled()
  })

  it('never reports a change from the memory fallback', () => {
    const listener = vi.fn()
    const unsubscribe = createTokenStorage(() => null).subscribe(listener)

    // The value at subscription time comes from memory, and there is no shared
    // store to hear from afterwards.
    expect(listener).toHaveBeenCalledWith(null)
    listener.mockClear()

    otherTabStores('other-tab-token')

    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('stays silent when the store stops being readable', () => {
    let broken = false
    const store = {
      getItem: (key: string) => {
        if (broken) {
          throw new DOMException('SecurityError')
        }
        return window.localStorage.getItem(key)
      },
      setItem: (key: string, value: string) => {
        window.localStorage.setItem(key, value)
      },
      removeItem: (key: string) => {
        window.localStorage.removeItem(key)
      },
    } as unknown as Storage

    const listener = vi.fn()
    const unsubscribe = createTokenStorage(() => store).subscribe(listener)
    listener.mockClear()

    window.localStorage.setItem(SESSION_TOKEN_KEY, 'other-tab-token')
    broken = true
    announceStorageChange({ key: SESSION_TOKEN_KEY, newValue: 'other-tab-token' })

    // The fallback holds this tab's copy, not the shared value, so it reports
    // nothing rather than a credential that is not the shared one.
    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })
})
