import { useState } from 'react'
import { NavLink, Outlet } from 'react-router'

import { useAuth } from '../auth/useAuth.ts'

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
    <div className="shell">
      <header className="shell__header">
        <strong>Web3 Wallet Dashboard</strong>

        <nav className="shell__nav" aria-label="Sections">
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
        </nav>

        <div className="shell__identity">
          <span>{email}</span>
          <button type="button" onClick={handleLogout} disabled={signingOut}>
            {signingOut ? 'Signing out' : 'Sign out'}
          </button>
        </div>
      </header>

      <Outlet />
    </div>
  )
}
