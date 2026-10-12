import { useState } from 'react'
import { NavLink, Outlet } from 'react-router'

import { useAuth } from '../auth/useAuth.ts'
import { Button } from '../ui/Button.tsx'
import { Shell } from '../ui/Shell.tsx'

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
      nav={
        <ul>
          <li>
            <NavLink to="/" end>
              Overview
            </NavLink>
          </li>
          <li>
            <NavLink to="/wallets">Wallets</NavLink>
          </li>
          <li>
            <NavLink to="/contracts">Contracts</NavLink>
          </li>
        </ul>
      }
      identity={
        <>
          <span>{email}</span>
          <Button variant="secondary" pending={signingOut} onClick={handleLogout}>
            Sign out
          </Button>
        </>
      }
    >
      <Outlet />
    </Shell>
  )
}
