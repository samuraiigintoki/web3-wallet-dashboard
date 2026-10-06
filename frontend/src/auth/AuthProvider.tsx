import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import {
  createApiClient,
  describeApiError,
  isApiError,
  type ApiClient,
  type LoginRequest,
  type RegisterRequest,
  type User,
} from '../api/index.ts'
import { AuthContext, type AuthContextValue, type Session } from './session.ts'
import { tokenStorage, type TokenStorage } from './storage.ts'

type AuthProviderProps = {
  children: ReactNode
  /** Seam for tests. The application always uses the real storage. */
  storage?: TokenStorage
}

export function AuthProvider({ children, storage = tokenStorage }: AuthProviderProps) {
  // The first state is derived, not set from an effect. With no stored token
  // there is nothing to restore, so the application starts anonymous and the
  // guard never flashes a loading state on a cold visit.
  const [session, setSession] = useState<Session>(() =>
    storage.read() === null ? { status: 'anonymous' } : { status: 'restoring' },
  )
  const [logoutProblem, setLogoutProblem] = useState<string | null>(null)
  const [restoreAttempt, setRestoreAttempt] = useState(0)

  /**
   * One controller for whatever identity request is currently allowed to
   * matter. Starting a login or a logout aborts the previous one, so a slow
   * /users/me from a session the user has already left cannot land later and
   * resurrect it.
   */
  const activeRequest = useRef<AbortController | null>(null)

  const beginExclusiveRequest = useCallback((): AbortController => {
    activeRequest.current?.abort()
    const controller = new AbortController()
    activeRequest.current = controller
    return controller
  }, [])

  const client: ApiClient = useMemo(
    () =>
      createApiClient({
        getToken: () => storage.read(),
        // A 401 on a token-carrying request is the server saying the session
        // is gone. Login's 401 is INVALID_CREDENTIALS and never arrives here.
        onUnauthorized: () => {
          storage.clear()
          setSession({ status: 'anonymous' })
        },
      }),
    [storage],
  )

  // Restore on load, and again whenever Retry bumps the attempt counter. The
  // effect only runs the request: the states it does not need the network for
  // are decided in the initializer and in retryRestore.
  useEffect(() => {
    if (storage.read() === null) {
      // No token means no request. Asking the server about nothing would only
      // spend a rate-limit slot on every cold visit.
      return
    }

    const controller = new AbortController()
    activeRequest.current = controller

    const restore = async (): Promise<void> => {
      try {
        const user = await client.getMe({ signal: controller.signal })
        if (!controller.signal.aborted) {
          setSession({ status: 'authenticated', user })
        }
      } catch (error) {
        if (controller.signal.aborted) {
          return
        }

        // A 401 is the only answer that proves the token is dead. A stopped
        // API, a timeout, a rate limit or a 5xx says nothing about the
        // session, so the token stays and the user is offered Retry.
        if (isApiError(error) && error.code === 'UNAUTHENTICATED') {
          storage.clear()
          setSession({ status: 'anonymous' })
          return
        }

        setSession({ status: 'unavailable' })
      }
    }

    void restore()

    // StrictMode mounts twice in development. Aborting on cleanup means the
    // first pass cannot apply its result after the second has started.
    return () => {
      controller.abort()
    }
  }, [client, storage, restoreAttempt])

  const register = useCallback(
    async (body: RegisterRequest): Promise<User> => await client.register(body),
    [client],
  )

  const login = useCallback(
    async (body: LoginRequest): Promise<void> => {
      const controller = beginExclusiveRequest()

      const { token } = await client.login(body, { signal: controller.signal })
      storage.write(token)

      try {
        const user = await client.getMe({ signal: controller.signal })
        if (controller.signal.aborted) {
          return
        }
        setLogoutProblem(null)
        setSession({ status: 'authenticated', user })
      } catch (error) {
        // The token was issued but the identity never arrived. Keeping it
        // would persist half a session that no screen can render.
        storage.clear()
        throw error
      }
    },
    [beginExclusiveRequest, client, storage],
  )

  const logout = useCallback(async (): Promise<void> => {
    const controller = beginExclusiveRequest()
    const hadToken = storage.read() !== null

    try {
      if (hadToken) {
        await client.logout({ signal: controller.signal })
      }
      setLogoutProblem(null)
    } catch (error) {
      // The server session may still be alive, and the user is told so, but
      // local state is cleared either way. Leaving them signed in because the
      // network failed would be the worse outcome.
      setLogoutProblem(describeApiError(error))
    } finally {
      storage.clear()
      setSession({ status: 'anonymous' })
    }
  }, [beginExclusiveRequest, client, storage])

  const retryRestore = useCallback(() => {
    setSession({ status: 'restoring' })
    setRestoreAttempt((attempt) => attempt + 1)
  }, [])

  const signOutLocally = useCallback(() => {
    activeRequest.current?.abort()
    storage.clear()
    setLogoutProblem(null)
    setSession({ status: 'anonymous' })
  }, [storage])

  const value: AuthContextValue = useMemo(
    () => ({
      session,
      register,
      login,
      logout,
      retryRestore,
      signOutLocally,
      logoutProblem,
    }),
    [session, register, login, logout, retryRestore, signOutLocally, logoutProblem],
  )

  return <AuthContext value={value}>{children}</AuthContext>
}
