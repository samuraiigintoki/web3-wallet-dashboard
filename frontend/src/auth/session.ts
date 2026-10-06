import { createContext } from 'react'

import type { LoginRequest, RegisterRequest, User } from '../api/index.ts'

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

export type AuthContextValue = {
  session: Session
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
