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
          The dashboard could not reach the API to check your session. The token
          from your last sign in is still stored on this device. Whether the
          server still accepts that token is unknown until a check gets through,
          so this screen does not claim either answer.
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
          Retry checks the session again. Sign out clears this device&apos;s session
          and returns you to sign in.
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
