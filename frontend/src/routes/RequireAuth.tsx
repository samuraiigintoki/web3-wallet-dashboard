import { Navigate, Outlet, useLocation } from 'react-router'

import { useAuth } from '../auth/useAuth.ts'
import { RestoringScreen } from '../pages/RestoringScreen.tsx'
import { Button } from '../ui/Button.tsx'
import { Notice } from '../ui/Notice.tsx'
import { Page } from '../ui/Page.tsx'

export function RequireAuth() {
  const { session, retryRestore, signOutLocally } = useAuth()
  const location = useLocation()

  if (session.status === 'restoring') {
    // Never redirect while the answer is still unknown. Bouncing to /login
    // here would sign out every reload of an open session.
    return <RestoringScreen />
  }

  if (session.status === 'unavailable') {
    return (
      <Page title="The service is unavailable">
        <p>
          The dashboard could not reach the API to check your session, so you have
          not been signed out and nothing has been lost. Your session is still
          stored on this device.
        </p>

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
          Retrying reads your session again and changes nothing. Signing out ends
          it on this device.
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
