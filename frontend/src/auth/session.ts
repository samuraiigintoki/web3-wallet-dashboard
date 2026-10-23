import { createContext } from 'react'

import type { ApiClient, LoginRequest, RegisterRequest, User } from '../api/index.ts'

/**
 * Four states, and no boolean pair that can express a fifth by accident.
 *
 * `unavailable` is the one that is easy to leave out. A stored token plus an
 * API that cannot be reached is neither signed in nor signed out: guessing
 * either way is wrong, so it is its own state with its own screen.
 */
export type Session =
  | { status: 'restoring' }
  | { status: 'anonymous' }
  | { status: 'authenticated'; user: User }
  | { status: 'unavailable' }

/**
 * The calls a validated identity may make.
 *
 * Not the whole ApiClient on purpose: a data view may read, may save a wallet
 * and may correct its label, and it may not register, sign in or end a session
 * on the side.
 *
 * The catalog is absent by design. `GET /api/v1/chains` is public and belongs
 * to no identity, so it is fetched through its own client rather than handed to
 * every session as if it were session data.
 */
export type DataClient = Pick<
  ApiClient,
  'listWallets' | 'createWallet' | 'updateWalletLabel'
>

/**
 * The capability behind one validated identity.
 *
 * `client` carries the credential that produced `user` and no other, so a
 * request started under this identity cannot later pick up a replacement that
 * another tab, a revalidation or a sign-in put in shared storage. `generation`
 * is the identity it belongs to: the same user signing in again gets a new
 * number, which is what keeps two sessions of one account from sharing a cache.
 *
 * No token appears here, and none is reachable from it.
 */
export type DataSession = {
  userId: number
  generation: number
  client: DataClient
}

export type AuthContextValue = {
  session: Session
  /**
   * Non-null exactly while `session` is authenticated: `restoring`,
   * `anonymous` and `unavailable` have no identity a data view may act as.
   */
  dataSession: DataSession | null
  /** Creates the account. Does not sign in: the API issues no token here. */
  register: (body: RegisterRequest) => Promise<User>
  /** Issues the token, then loads the identity. Throws an ApiError on failure. */
  login: (body: LoginRequest) => Promise<void>
  /** Revokes server side when it can, and always clears local state. */
  logout: () => Promise<void>
  /** Re-runs the restore from an `unavailable` state. */
  retryRestore: () => void
  /** Drops the stored token without calling a server that cannot be reached. */
  signOutLocally: () => void
  /** Set when a logout call failed. The local session is cleared regardless. */
  logoutProblem: string | null
}

export const AuthContext = createContext<AuthContextValue | null>(null)
