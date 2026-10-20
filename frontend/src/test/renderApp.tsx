import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { QueryClient } from '@tanstack/react-query'
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
  options: {
    path?: string
    storage?: TokenStorage
    state?: unknown
    /** Lets a test inspect and seed the cache the routes share. */
    queryClient?: QueryClient
  } = {},
) {
  const storage = options.storage ?? memoryStorage()
  const user = userEvent.setup()

  // A path may carry a query, and the router wants the two separately: a
  // pathname holding "?page=3" matches no route at all.
  const [pathname, search] = (options.path ?? '/').split('?')
  const entry = {
    pathname,
    search: search === undefined || search === '' ? '' : `?${search}`,
    state: options.state ?? null,
  }

  const utils = render(
    <AuthProvider storage={storage}>
      <MemoryRouter initialEntries={[entry]}>
        <LocationProbe />
        <AppRoutes queryClient={options.queryClient} />
      </MemoryRouter>
    </AuthProvider>,
  )

  return { ...utils, storage, user }
}

export function currentPath(): string {
  const node = document.querySelector('[data-testid="location"]')
  return node?.textContent ?? ''
}
