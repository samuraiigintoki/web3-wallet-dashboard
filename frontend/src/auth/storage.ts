/**
 * The only module in the application that touches localStorage.
 *
 * Nothing else reads or writes localStorage, sessionStorage or
 * document.cookie. Keeping it to one file means the XSS tradeoff is a single
 * reviewable surface, and swapping the mechanism later is one change.
 *
 * Only the token string is stored. expiresAt is deliberately left out: the
 * server is the authority on expiry, and a second copy would only go stale and
 * invite a client-side expiry check that disagrees with the session table.
 *
 * The module also owns the cross-tab half of that key. The browser sends a
 * `storage` notification to every other document on the origin when one of
 * them changes it, so the subscription below is how a tab learns that another
 * tab signed in, signed out or replaced the credential. Nothing else in the
 * application listens for that event.
 */

export const SESSION_TOKEN_KEY = 'web3-wallet-dashboard.session-token'

export type TokenStorage = {
  read: () => string | null
  write: (token: string) => void
  clear: () => void
  /**
   * Calls `listener` with the value read at subscription time, then again
   * whenever another document changes the shared credential. Reading on
   * subscribe is what makes a page load correct: the value is taken
   * synchronously, so a change made while the page was still starting up
   * cannot be missed between a render and an effect.
   *
   * Change deliveries carry the value re-read from the store rather than the
   * one the event carried: a delivery can describe a value that has already
   * been superseded, and acting on it would mean validating a credential
   * nobody holds any more. A removed key or a `localStorage.clear()` arrives
   * as null. Unrelated keys, changes to another storage area, and a delivery
   * that reads back the credential this instance already holds are ignored.
   *
   * Returns the unsubscribe function. In the memory-only fallback the value at
   * subscription time is still reported, but there is no shared store to
   * observe, so nothing is reported after that: a memory-only session cannot
   * synchronize across tabs.
   */
  subscribe: (listener: (token: string | null) => void) => () => void
}

/** Distinguishes "the store could not be read" from "the store holds nothing". */
const UNREADABLE = Symbol('unreadable')

function readStore(store: Storage): string | null | typeof UNREADABLE {
  try {
    const value = store.getItem(SESSION_TOKEN_KEY)
    // An empty value is no credential, the same as a key that is not there.
    return value === null || value === '' ? null : value
  } catch {
    return UNREADABLE
  }
}

function changedKey(event: StorageEvent): boolean {
  // A clear() of the whole area is reported with a null key and can have taken
  // this key with it, so it counts as a change to the credential.
  return event.key === null || event.key === SESSION_TOKEN_KEY
}

function sameArea(event: StorageEvent, store: Storage): boolean {
  // Some engines have been known to omit the area; the key filter above and the
  // re-read below still keep a wrong-area event from being trusted.
  return event.storageArea === null || event.storageArea === store
}

function defaultBacking(): Storage | null {
  try {
    return globalThis.localStorage
  } catch {
    // Reading the property itself throws when storage is blocked by policy.
    return null
  }
}

/**
 * Every access is wrapped. Storage throws in private browsing modes, when a
 * quota is exhausted, and when a browser policy blocks it. None of those is a
 * reason to crash the application, so the instance degrades to memory for the
 * rest of the page load: the user stays signed in until they close the tab.
 */
export function createTokenStorage(
  getBacking: () => Storage | null = defaultBacking,
): TokenStorage {
  let memoryToken: string | null = null
  let memoryOnly = false

  /**
   * The credential this instance currently considers shared: what it last
   * announced to a subscriber, or what it wrote itself. Browsers fire one
   * notification per change, and a change this document did not need to react
   * to can still read back as the credential it already holds, so repeats are
   * dropped here rather than at every subscriber. This instance's own writes
   * are part of that knowledge and are recorded on the way past below: a tab
   * that signed in here holds a credential the store no longer holds when
   * another tab signs out, and without that record the removal would read back
   * as the value this tab was holding before it signed in.
   */
  let announced: string | null | undefined

  const backing = (): Storage | null => {
    if (memoryOnly) {
      return null
    }

    const store = getBacking()
    if (store === null) {
      memoryOnly = true
    }

    return store
  }

  const degrade = (token: string | null): void => {
    memoryOnly = true
    memoryToken = token
  }

  const read = (): string | null => {
    const store = backing()
    if (store === null) {
      return memoryToken
    }

    const value = readStore(store)
    if (value === UNREADABLE) {
      degrade(memoryToken)
      return memoryToken
    }

    return value
  }

  return {
    read,

    write(token) {
      memoryToken = token
      announced = token
      const store = backing()
      if (store === null) {
        return
      }

      try {
        store.setItem(SESSION_TOKEN_KEY, token)
      } catch {
        degrade(token)
      }
    },

    clear() {
      memoryToken = null
      announced = null
      const store = backing()
      if (store === null) {
        return
      }

      try {
        store.removeItem(SESSION_TOKEN_KEY)
      } catch {
        degrade(null)
      }
    },

    subscribe(listener) {
      const store = backing()

      // No shared store, no cross-tab channel. The session still works in this
      // tab for as long as the page lives, and nothing here pretends otherwise.
      if (store === null || typeof globalThis.addEventListener !== 'function') {
        announced = memoryToken
        listener(memoryToken)
        return () => undefined
      }

      const onStorage = (event: StorageEvent): void => {
        if (!changedKey(event) || !sameArea(event, store)) {
          return
        }

        // The store may have started refusing reads after this subscription.
        // The fallback holds one tab's copy, not the shared value, so silence
        // is the honest answer: nothing is announced from memory.
        if (memoryOnly) {
          return
        }

        const current = readStore(store)
        if (current === UNREADABLE || current === announced) {
          return
        }

        announced = current
        listener(current)
      }

      globalThis.addEventListener('storage', onStorage)

      const initial = read()
      announced = initial
      listener(initial)

      return () => {
        globalThis.removeEventListener('storage', onStorage)
      }
    },
  }
}

/** The instance the application uses. */
export const tokenStorage = createTokenStorage()
