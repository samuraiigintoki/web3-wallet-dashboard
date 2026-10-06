import { Navigate, Outlet, useLocation } from 'react-router'

import { useAuth } from '../auth/useAuth.ts'

export function RequireAuth() {
  const { session, retryRestore, signOutLocally } = useAuth()
  const location = useLocation()

  if (session.status === 'restoring') {
    // Never redirect while the answer is still unknown. Bouncing to /login
    // here would sign out every reload of an open session.
    return (
      <main className="page" aria-busy="true">
        <p role="status">Restoring your session.</p>
      </main>
    )
  }

  if (session.status === 'unavailable') {
    return (
      <main className="page">
        <div className="status">
          <h1>The service is unavailable</h1>
          <p role="status">
            Your session could not be checked, so you have not been signed out. The
            API may be stopped or unreachable.
          </p>
          <div className="status__actions">
            <button type="button" onClick={retryRestore}>
              Retry
            </button>
            <button type="button" onClick={signOutLocally}>
              Sign out
            </button>
          </div>
        </div>
      </main>
    )
  }

  if (session.status === 'anonymous') {
    const from = `${location.pathname}${location.search}`

    return <Navigate to="/login" replace state={{ from }} />
  }

  return <Outlet />
}
