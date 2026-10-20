/**
 * The identity part of every protected query key.
 *
 * A key names the user and the session generation that authorized the request,
 * never the credential: two sessions of one account, before and after a
 * credential replacement, are different identities and never share a cache
 * entry. A token is never a key, because it would put the secret in the cache
 * and in every devtools dump of it.
 */

const IDENTITY = 'identity'

export type IdentityRef = {
  userId: number
  generation: number
}

/** Every protected key begins with this triple. */
export function identityKey(identity: IdentityRef): readonly [string, number, number] {
  return [IDENTITY, identity.userId, identity.generation]
}

/** True for any key that can hold data belonging to an identity. */
export function isProtectedKey(key: readonly unknown[]): boolean {
  return key.length >= 3 && key[0] === IDENTITY
}

/**
 * True when this key belongs to `current`.
 *
 * A null identity matches nothing, so signing out, losing the session or
 * starting a revalidation makes every protected entry stale at once.
 */
export function isCurrentIdentityKey(
  key: readonly unknown[],
  current: IdentityRef | null,
): boolean {
  if (!isProtectedKey(key) || current === null) {
    return false
  }

  const userId = key[1]
  const generation = key[2]

  return userId === current.userId && generation === current.generation
}
