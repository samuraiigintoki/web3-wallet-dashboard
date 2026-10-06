import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'

import { AppRoutes } from '../App.tsx'
import { AuthProvider } from '../auth/AuthProvider.tsx'
import { createTokenStorage, type TokenStorage } from '../auth/storage.ts'
import { LocationProbe } from './LocationProbe.tsx'

export function memoryStorage(initial: string | null = null): TokenStorage {
  const storage = createTokenStorage(() => null)
  if (initial !== null) {
    storage.write(initial)
  }
  return storage
}

export function renderApp(
  options: { path?: string; storage?: TokenStorage; state?: unknown } = {},
) {
  const storage = options.storage ?? memoryStorage()
  const user = userEvent.setup()
  const entry = { pathname: options.path ?? '/', state: options.state ?? null }

  const utils = render(
    <AuthProvider storage={storage}>
      <MemoryRouter initialEntries={[entry]}>
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
