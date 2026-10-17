import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import {
  ApiError,
  createApiClient,
  describeApiError,
  isApiError,
  type ApiClient,
  type LoginRequest,
  type RegisterRequest,
  type User,
} from '../api/index.ts'
import {
  AuthContext,
  type DataSession,
  type AuthContextValue,
  type Session,
} from './session.ts'
import { tokenStorage, type TokenStorage } from './storage.ts'

type AuthProviderProps = {
  children: ReactNode
  /** Seam for tests. The application always uses the real storage. */
  storage?: TokenStorage
}

/** The outcome of a sign-in that another tab's credential superseded. */
function supersededSignIn(): ApiError {
  return new ApiError({
    code: 'ABORTED',
    status: 0,
    message: 'the sign-in was superseded by another tab',
  })
}

export function AuthProvider({ children, storage = tokenStorage }: AuthProviderProps) {
  // The first state is derived, not set from an effect. With no stored token
  // there is nothing to restore, so the application starts anonymous and the
  // guard never flashes a loading state on a cold visit.
  const [session, setSession] = useState<Session>(() =>
    storage.read() === null ? { status: 'anonymous' } : { status: 'restoring' },
  )
  const [logoutProblem, setLogoutProblem] = useState<string | null>(null)

  /**
   * The data capability for the current identity, and the only way a data view
   * can reach the API. It is created when an identity is validated and dropped
   * the moment that identity ends, so there is never a window in which a screen
   * showing one user holds a client for another.
   */
  const [dataSession, setDataSession] = useState<DataSession | null>(null)

  /**
   * Identity generation. Every transition that can change who this tab is bumps
   * it, and asynchronous work only applies its result while its own generation
   * is still the current one. A restore, a login, a 401 or a logout that
   * finishes late therefore cannot resurrect or erase a newer session.
   */
  const generationRef = useRef(0)

  /**
   * The credential this tab's identity is bound to, and so the only one its
   * requests may carry. Requests never read the shared store themselves: if
   * they did, a screen still showing user A could pick up the credential
   * another tab stored a moment ago and act as user B. The store is read only
   * at explicit boundaries: a subscription delivery, a retry, and the guards
   * that decide whether this tab may still clear the key at all.
   */
  const credentialRef = useRef<string | null>(null)

  /**
   * One controller for whatever identity request is currently allowed to
   * matter. Starting a new one aborts the previous, so a slow /users/me from a
   * session the user has already left cannot land later and resurrect it.
   */
  const activeRequest = useRef<AbortController | null>(null)

  /**
   * False once the provider has been unmounted. Teardown retires the generation,
   * so every operation still bound to the old one is obsolete, but a late answer
   * also has to be stopped from starting new work: an unmounted provider must
   * not issue a request or write to the shared store on behalf of an identity it
   * has already given up.
   */
  const mountedRef = useRef(true)

  /** The API client, built on first use rather than during render: it holds the
   * credential source for this tab, and nothing needs it before the first
   * request. */
  const clientRef = useRef<ApiClient | null>(null)

  const isCurrent = useCallback(
    (generation: number): boolean => generationRef.current === generation,
    [],
  )

  /**
   * Ends the current identity. Whatever was in flight belongs to the previous
   * one and is aborted, so it can neither finish nor be answered.
   */
  const endIdentity = useCallback((): void => {
    generationRef.current += 1
    activeRequest.current?.abort()
    activeRequest.current = null
    // The identity that owned the data capability has ended. Any query still
    // holding it belongs to a session nobody is presenting, so it loses its
    // client here as well as its generation; the query layer cancels and drops
    // the cached work when the new identity arrives.
    setDataSession(null)
  }, [])

  /**
   * Starts an identity transition that may issue a request, and returns the
   * generation it runs under together with the controller its request uses.
   */
  const startIdentity = useCallback((): {
    generation: number
    controller: AbortController
  } => {
    endIdentity()
    const controller = new AbortController()
    activeRequest.current = controller
    return { generation: generationRef.current, controller }
  }, [endIdentity])

  /** The bound credential, never a fresh read of the shared store. */
  const getToken = useCallback((): string | null => credentialRef.current, [])

  /**
   * A 401 can only end the credential it was sent with, and only while that
   * credential is still this tab's and still the shared one. A late 401 from a
   * credential another tab has replaced describes a session nobody is holding,
   * and clearing on it would sign out the newer one.
   */
  const onUnauthorized = useCallback(
    (sentToken: string): void => {
      if (sentToken !== credentialRef.current || storage.read() !== sentToken) {
        return
      }

      credentialRef.current = null
      storage.clear()
      setSession({ status: 'anonymous' })
    },
    [storage],
  )

  const client = useCallback((): ApiClient => {
    clientRef.current ??= createApiClient({ getToken, onUnauthorized })
    return clientRef.current
  }, [getToken, onUnauthorized])

  /**
   * Builds the data capability for one validated identity.
   *
   * The credential is captured here, not read from the ref at request time: a
   * client built on `getToken` would send whatever this tab holds when the
   * request happens, which is how a screen showing one user ends up acting as
   * another. `onUnauthorized` stays the shared one, so a 401 still ends only
   * the credential it was sent with.
   */
  const openDataSession = useCallback(
    (token: string, user: User, generation: number): DataSession => ({
      userId: user.id,
      generation,
      client: createApiClient({ getToken: () => token, onUnauthorized }),
    }),
    [onUnauthorized],
  )

  /**
   * Validates a credential against the server and applies the outcome, unless
   * the tab's identity moved on while the answer was in flight.
   */
  const validate = useCallback(
    (token: string, generation: number, controller: AbortController): void => {
      const run = async (): Promise<void> => {
        try {
          const user = await client().getMe({ signal: controller.signal })
          if (!isCurrent(generation)) {
            return
          }

          setLogoutProblem(null)
          setSession({ status: 'authenticated', user })
          setDataSession(openDataSession(token, user, generation))
        } catch (error) {
          if (!isCurrent(generation) || controller.signal.aborted) {
            return
          }

          // A 401 is the only answer that proves the credential is dead. The
          // client's unauthorized callback clears it while it is still the
          // current one; this covers the answer that arrives when the tab has
          // already stopped being that credential's.
          if (isApiError(error) && error.code === 'UNAUTHENTICATED') {
            if (storage.read() === token) {
              storage.clear()
            }
            credentialRef.current = null
            setSession({ status: 'anonymous' })
            return
          }

          // A stopped API, a timeout, a rate limit or a 5xx says nothing about
          // the credential, so it stays and the user is offered Retry.
          setSession({ status: 'unavailable' })
        }
      }

      void run()
    },
    [client, isCurrent, openDataSession, storage],
  )

  /**
   * Adopts the credential the store holds, or reacts to it changing.
   *
   * The storage module reports the value at subscription time as well as later
   * changes, so this one path covers the page load and every change another tab
   * makes afterwards. The value was read synchronously for a subscription and
   * re-read from the store for a change, never taken from an event's payload: a
   * delivery describing a superseded value cannot send this tab off to
   * validate a credential nobody holds.
   *
   * A change this tab made itself never arrives here: browsers do not notify
   * the document that made the change.
   */
  const syncFromStorage = useCallback(
    (shared: string | null): void => {
      if (shared === credentialRef.current) {
        // The same credential. The one case that still needs an answer is a tab
        // waiting to restore something that is not there any more: no request
        // is coming for it, so it must not stay on the loading screen.
        if (shared !== null) {
          return
        }

        setSession((current) =>
          current.status === 'restoring' ? { status: 'anonymous' } : current,
        )
        return
      }

      if (shared === null) {
        // The store holds no credential any more: another tab signed out, or
        // cleared it. There is nothing to ask the server about, so this tab
        // becomes anonymous with no request.
        endIdentity()
        credentialRef.current = null
        setSession({ status: 'anonymous' })
        return
      }

      // The store holds a credential this tab is not bound to: another tab
      // signed in or replaced it. Stop presenting the old identity before
      // validating, so the screen never shows one user while the shared
      // credential belongs to another.
      const { generation, controller } = startIdentity()
      credentialRef.current = shared
      setSession({ status: 'restoring' })
      validate(shared, generation, controller)
    },
    [endIdentity, startIdentity, validate],
  )

  /**
   * Teardown. Unmounting retires the generation, so whatever identity work was
   * in flight is obsolete, aborts the request it is waiting on, and drops the
   * bound credential. Without the last two, a sign-in answered after unmount
   * would still store its token and overwrite a credential another tab has put
   * in the store since, and a late 401 would still clear it.
   *
   * The effect also runs before the subscription is installed, so a mount that
   * follows a teardown reports as mounted before anything can be heard.
   */
  useEffect(() => {
    mountedRef.current = true

    return () => {
      mountedRef.current = false
      endIdentity()
      credentialRef.current = null
    }
  }, [endIdentity])

  useEffect(() => storage.subscribe(syncFromStorage), [storage, syncFromStorage])

  const register = useCallback(
    async (body: RegisterRequest): Promise<User> => await client().register(body),
    [client],
  )

  const login = useCallback(
    async (body: LoginRequest): Promise<void> => {
      const { generation, controller } = startIdentity()

      /**
       * Adopts whatever the shared store holds now, while this provider is still
       * mounted. A superseded sign-in leaves the tab with no identity of its own,
       * so it follows the credential the other tab is holding instead of sitting
       * on a screen whose session the store no longer has.
       */
      const reconcile = (): void => {
        if (mountedRef.current) {
          syncFromStorage(storage.read())
        }
      }

      // The credential boundary this sign-in started from. A sign-in is answered
      // on the wire, not in this tab: another tab can store its credential while
      // this one waits, and the notification announcing it can still be sitting
      // in the queue when the answer arrives. The generation alone would not
      // notice that, because nothing has been delivered yet, so the shared value
      // is compared as well before anything is committed.
      const boundary = storage.read()

      const { token } = await client().login(body, { signal: controller.signal })

      if (!isCurrent(generation) || storage.read() !== boundary) {
        // Another tab replaced the shared credential while this sign-in was in
        // flight. Storing this token would erase that newer session, so it is
        // dropped and this tab follows the credential that is already shared.
        reconcile()
        throw supersededSignIn()
      }

      storage.write(token)
      credentialRef.current = token

      try {
        const user = await client().getMe({ signal: controller.signal })
        if (!isCurrent(generation)) {
          return
        }

        if (storage.read() !== token) {
          // The credential this sign-in issued is no longer the shared one:
          // another tab replaced it while the identity was being checked.
          // Committing this result would present a session the store no longer
          // holds, so the shared credential wins and the answer is dropped.
          reconcile()
          throw supersededSignIn()
        }

        setLogoutProblem(null)
        setSession({ status: 'authenticated', user })
        setDataSession(openDataSession(token, user, generation))
      } catch (error) {
        // The token was issued but the identity never arrived, or the sign-in was
        // superseded on the way. Keeping a token that is no longer the shared one
        // would persist half a session no screen can render, and clearing a newer
        // credential would sign the tab that stored it out, so the clear only
        // happens while this operation is still current and still holds the
        // shared key.
        if (isCurrent(generation) && storage.read() === token) {
          credentialRef.current = null
          storage.clear()
        }
        throw error
      }
    },
    [client, isCurrent, openDataSession, startIdentity, storage, syncFromStorage],
  )

  const logout = useCallback(async (): Promise<void> => {
    // Bound to the credential this tab is signed in with: that is the session
    // this operation is allowed to end.
    const credential = credentialRef.current
    const { generation, controller } = startIdentity()

    try {
      if (credential !== null) {
        await client().logout({ signal: controller.signal })
      }
      if (isCurrent(generation)) {
        setLogoutProblem(null)
      }
    } catch (error) {
      // The server session may still be alive, and the user is told so, but
      // local state is cleared either way. Leaving them signed in because the
      // network failed would be the worse outcome.
      if (isCurrent(generation)) {
        setLogoutProblem(describeApiError(error))
      }
    } finally {
      // An obsolete sign-out does nothing at all: it lost its identity while it
      // was in flight, and every side effect left to it is wrong. A clear here
      // would drop a notification another tab's removal is about to deliver,
      // because the storage module would read the key back as the value it
      // already announced, and dropping the binding would disturb the identity
      // this tab has adopted since. The fence therefore covers the store and the
      // binding, not only the state update.
      if (isCurrent(generation)) {
        const shared = storage.read()

        // A current sign-out may end the session it owns even while the store
        // holds a credential it does not own: that newer credential belongs to
        // the tab that stored it, and this tab ends its own session locally.
        if (shared === credential || shared === null) {
          storage.clear()
        }

        if (credentialRef.current === credential) {
          credentialRef.current = null
        }
        setSession({ status: 'anonymous' })
      }
    }
  }, [client, isCurrent, startIdentity, storage])

  const retryRestore = useCallback(() => {
    // Decide here the way the subscription does, because the token can be gone
    // by now: another tab's sign-out clears the same key. The restore path
    // makes no request without a credential, so entering `restoring` on its own
    // would leave the screen loading with nothing coming.
    const token = storage.read()
    if (token === null) {
      endIdentity()
      credentialRef.current = null
      setSession({ status: 'anonymous' })
      return
    }

    const { generation, controller } = startIdentity()
    credentialRef.current = token
    setSession({ status: 'restoring' })
    validate(token, generation, controller)
  }, [endIdentity, startIdentity, storage, validate])

  const signOutLocally = useCallback(() => {
    // Local only: no server call, so the session stays valid until it expires.
    // It clears the shared key like any other sign-out, and every other tab is
    // told through the storage notification that it is gone.
    endIdentity()
    credentialRef.current = null
    storage.clear()
    setLogoutProblem(null)
    setSession({ status: 'anonymous' })
  }, [endIdentity, storage])

  const value: AuthContextValue = useMemo(
    () => ({
      session,
      dataSession,
      register,
      login,
      logout,
      retryRestore,
      signOutLocally,
      logoutProblem,
    }),
    [
      session,
      dataSession,
      register,
      login,
      logout,
      retryRestore,
      signOutLocally,
      logoutProblem,
    ],
  )

  return <AuthContext value={value}>{children}</AuthContext>
}
