import { Navigate, Outlet, useLocation } from 'react-router'

import { useAuth } from '../auth/useAuth.ts'
import { readLocationState } from './locationState.ts'

/**
 * Keeps a signed-in visitor off the auth pages. Submitting login again from
 * an open session would issue a second token and strand the first.
 *
 * The return path is applied here rather than in the login page, so there is
 * exactly one place that decides where an authenticated visitor lands. Having
 * the page navigate as well would race this redirect.
 */
export function GuestOnly() {
  const { session } = useAuth()
  const location = useLocation()

  if (session.status === 'restoring') {
    return (
      <main className="page" aria-busy="true">
        <p role="status">Restoring your session.</p>
      </main>
    )
  }

  if (session.status === 'authenticated') {
    const { from } = readLocationState(location.state)

    return <Navigate to={from ?? '/'} replace />
  }

  // `unavailable` still renders the form: signing in is a reasonable thing to
  // try when the stored token could not be checked.
  return <Outlet />
}
