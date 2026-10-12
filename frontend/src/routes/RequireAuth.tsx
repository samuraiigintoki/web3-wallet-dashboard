import { Navigate, Outlet, useLocation } from 'react-router'

import { useAuth } from '../auth/useAuth.ts'
import { Button } from '../ui/Button.tsx'
import { Notice } from '../ui/Notice.tsx'
import { Skeleton } from '../ui/Skeleton.tsx'
import { Page } from '../ui/Page.tsx'

export function RequireAuth() {
  const { session, retryRestore, signOutLocally } = useAuth()
  const location = useLocation()

  if (session.status === 'restoring') {
    // Never redirect while the answer is still unknown. Bouncing to /login
    // here would sign out every reload of an open session.
    return (
      <Page busy>
        <Skeleton status="Restoring your session." />
      </Page>
    )
  }

  if (session.status === 'unavailable') {
    return (
      <Page title="The service is unavailable">
        <Notice
          actions={
            <>
              <Button variant="secondary" onClick={retryRestore}>
                Retry
              </Button>
              <Button variant="secondary" onClick={signOutLocally}>
                Sign out
              </Button>
            </>
          }
        >
          Your session could not be checked, so you have not been signed out. The
          API may be stopped or unreachable.
        </Notice>
      </Page>
    )
  }

  if (session.status === 'anonymous') {
    const from = `${location.pathname}${location.search}`

    return <Navigate to="/login" replace state={{ from }} />
  }

  return <Outlet />
}
