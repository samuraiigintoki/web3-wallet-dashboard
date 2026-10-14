import { useState } from 'react'
import { Outlet } from 'react-router'

import { useAuth } from '../auth/useAuth.ts'
import { Button } from '../ui/Button.tsx'
import { Shell, ShellIdentity } from '../ui/Shell.tsx'

/**
 * The sections this block ships. Every one of them is a route that exists, so
 * the frame never offers a destination that leads nowhere. Transactions
 * arrives with the indexed register in Week 8, Settings when there is
 * something to configure.
 */
const DESTINATIONS = [
  { to: '/', label: 'Overview', end: true },
  { to: '/contracts', label: 'Contracts' },
  { to: '/wallets', label: 'Wallets' },
] as const

export function ShellLayout() {
  const { session, logout } = useAuth()
  const [signingOut, setSigningOut] = useState(false)

  const email = session.status === 'authenticated' ? session.user.email : ''

  const handleLogout = (): void => {
    if (signingOut) {
      return
    }

    setSigningOut(true)
    void logout().finally(() => {
      setSigningOut(false)
    })
  }

  return (
    <Shell
      destinations={DESTINATIONS}
      identity={
        <ShellIdentity email={email}>
          <Button variant="secondary" pending={signingOut} onClick={handleLogout}>
            Sign out
          </Button>
        </ShellIdentity>
      }
    >
      <Outlet />
    </Shell>
  )
}
