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
 */

export const SESSION_TOKEN_KEY = 'web3-wallet-dashboard.session-token'

export type TokenStorage = {
  read: () => string | null
  write: (token: string) => void
  clear: () => void
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

  return {
    read() {
      const store = backing()
      if (store === null) {
        return memoryToken
      }

      try {
        const value = store.getItem(SESSION_TOKEN_KEY)
        return value === null || value === '' ? null : value
      } catch {
        degrade(memoryToken)
        return memoryToken
      }
    },

    write(token) {
      memoryToken = token
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
  }
}

/** The instance the application uses. */
export const tokenStorage = createTokenStorage()
