import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation } from 'react-router'

import { AppRoutes } from '../App.tsx'
import { AuthProvider } from '../auth/AuthProvider.tsx'
import { createTokenStorage, type TokenStorage } from '../auth/storage.ts'

export function memoryStorage(initial: string | null = null): TokenStorage {
  const storage = createTokenStorage(() => null)
  if (initial !== null) {
    storage.write(initial)
  }
  return storage
}

/** Exposes the router's current path so a redirect can be asserted. */
function LocationProbe() {
  const location = useLocation()

  return (
    <div data-testid="location">{`${location.pathname}${location.search}`}</div>
  )
}

export function renderApp(
  options: { path?: string; storage?: TokenStorage } = {},
) {
  const storage = options.storage ?? memoryStorage()
  const user = userEvent.setup()

  const utils = render(
    <AuthProvider storage={storage}>
      <MemoryRouter initialEntries={[options.path ?? '/']}>
        <LocationProbe />
        <AppRoutes />
      </MemoryRouter>
    </AuthProvider>,
  )

  return { ...utils, storage, user }
}

export function currentPath(): string {
  const node = document.querySelector('[data-testid="location"]')
  return node?.textContent ?? ''
}
