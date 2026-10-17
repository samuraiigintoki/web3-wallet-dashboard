import { render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AuthContextValue } from '../auth/session.ts'
import { AuthContext } from '../auth/session.ts'
import { QueryProvider } from './QueryProvider.tsx'
import { createQueryClient } from './queryClient.ts'
import { identityKey } from './identityKeys.ts'

const IDENTITY_A = { userId: 5, generation: 1 }
const IDENTITY_B = { userId: 9, generation: 2 }

const PAGE_A = {
  wallets: [
    {
      id: 7,
      address: '0x00000000000000000000000000000000000000a1',
      chainId: 11155111,
      label: 'Ada primary',
      createdAt: '2026-10-01T10:00:00Z',
    },
  ],
  pagination: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 },
}

/** A context value whose only interesting field is the identity it presents. */
function authValue(dataSession: AuthContextValue['dataSession']): AuthContextValue {
  return {
    session: { status: 'restoring' },
    dataSession,
    register: vi.fn(async () => {
      throw new Error('not used')
    }),
    login: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    retryRestore: vi.fn(),
    signOutLocally: vi.fn(),
    logoutProblem: null,
  }
}

function dataSessionFor(identity: { userId: number; generation: number }) {
  return {
    userId: identity.userId,
    generation: identity.generation,
    client: { listWallets: vi.fn() },
  }
}

function renderGuard(queryClient: QueryClient, identity: AuthContextValue['dataSession']) {
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthContext value={authValue(identity)}>
        <QueryProvider client={queryClient}>
          <p>child</p>
        </QueryProvider>
      </AuthContext>
    </QueryClientProvider>,
  )
}

/**
 * What the guard exists to guarantee.
 *
 * These tests look at the cache rather than at the screen on purpose: an entry
 * belonging to another identity is invisible on screen whether it was removed
 * or merely orphaned, and only the cache says which happened.
 */
describe('identity cache guard', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('drops a cached page belonging to another identity', () => {
    const queryClient = createQueryClient()
    queryClient.setQueryData([...identityKey(IDENTITY_A), 'wallets', 'list', 1, 20], PAGE_A)

    renderGuard(queryClient, dataSessionFor(IDENTITY_B))

    expect(queryClient.getQueryCache().getAll()).toHaveLength(0)
  })

  it('drops even the same user cached page when the credential was replaced', () => {
    const queryClient = createQueryClient()
    queryClient.setQueryData([...identityKey(IDENTITY_A), 'wallets', 'list', 1, 20], PAGE_A)

    // Same user, later generation: another session of the same account.
    renderGuard(queryClient, dataSessionFor({ userId: 5, generation: 2 }))

    expect(queryClient.getQueryCache().getAll()).toHaveLength(0)
  })

  it('drops every protected entry once there is no identity at all', () => {
    const queryClient = createQueryClient()
    queryClient.setQueryData([...identityKey(IDENTITY_A), 'wallets', 'list', 1, 20], PAGE_A)
    queryClient.setQueryData([...identityKey(IDENTITY_B), 'wallets', 'list', 2, 20], PAGE_A)

    renderGuard(queryClient, null)

    expect(queryClient.getQueryCache().getAll()).toHaveLength(0)
  })

  it('keeps the page belonging to the identity that is current', () => {
    const queryClient = createQueryClient()
    const key = [...identityKey(IDENTITY_B), 'wallets', 'list', 1, 20]
    queryClient.setQueryData(key, PAGE_A)

    renderGuard(queryClient, dataSessionFor(IDENTITY_B))

    expect(queryClient.getQueryCache().getAll().map((query) => query.queryKey)).toEqual([key])
    expect(queryClient.getQueryData(key)).toEqual(PAGE_A)
  })
})
