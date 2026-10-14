import { SESSION_TOKEN_KEY } from '../auth/storage.ts'

/**
 * Cross-tab test support.
 *
 * The other tab of a unit test is a writer that touches localStorage directly,
 * which is exactly what another tab is from this document's point of view: it
 * changes the shared store, and the browser then tells this document about it.
 * Both sides therefore read the same real window.localStorage instead of the
 * isolated memory helper, and nothing here reimplements the storage module.
 */

/** Another tab signs in, or replaces the credential: the store changes and is announced. */
export function otherTabStores(token: string): void {
  const previous = window.localStorage.getItem(SESSION_TOKEN_KEY)
  window.localStorage.setItem(SESSION_TOKEN_KEY, token)
  announceStorageChange({ key: SESSION_TOKEN_KEY, oldValue: previous, newValue: token })
}

/** Another tab signs out: the key is removed and that is announced. */
export function otherTabRemoves(): void {
  const previous = window.localStorage.getItem(SESSION_TOKEN_KEY)
  window.localStorage.removeItem(SESSION_TOKEN_KEY)
  announceStorageChange({ key: SESSION_TOKEN_KEY, oldValue: previous, newValue: null })
}

/** Another tab calls localStorage.clear(), which arrives as a null key. */
export function otherTabClearsStorage(): void {
  window.localStorage.clear()
  announceStorageChange({ key: null, oldValue: null, newValue: null })
}

/**
 * Writes the store without announcing anything: what another tab has done from
 * the moment it writes up to the moment this document handles the event, which
 * is the window in which this tab's screen and the store disagree.
 */
export function otherTabStoresSilently(token: string): void {
  window.localStorage.setItem(SESSION_TOKEN_KEY, token)
}

/** Announces a change to a value already in the store, without writing it. */
export function announceStoredCredential(token: string): void {
  announceStorageChange({ key: SESSION_TOKEN_KEY, newValue: token })
}

/** The notification a browser sends, with a payload the caller can make stale. */
export function announceStorageChange(init: {
  key: string | null
  oldValue?: string | null
  newValue?: string | null
  storageArea?: Storage
}): void {
  window.dispatchEvent(
    new StorageEvent('storage', {
      key: init.key,
      oldValue: init.oldValue ?? null,
      newValue: init.newValue ?? null,
      storageArea: init.storageArea ?? window.localStorage,
      url: window.location.href,
    }),
  )
}
