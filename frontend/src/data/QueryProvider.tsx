import { QueryClientProvider, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useEffect, useState, type ReactNode } from 'react'

import { useAuth } from '../auth/useAuth.ts'
import { isCurrentIdentityKey, isProtectedKey } from './identityKeys.ts'
import { createQueryClient } from './queryClient.ts'

/**
 * Drops every cached entry and in-flight request belonging to an identity that
 * is not the current one.
 *
 * Cancel comes first and removal second, and the order is the point: cancelling
 * aborts the request, so a response that is already on the wire cannot land in
 * the new session's cache, and removing takes the entry away so a late answer
 * has nothing to write to. A success that arrives after the identity changed is
 * therefore discarded even if the abort lost the race, and a late 401 from a
 * superseded credential has no query left to sign anyone out of.
 *
 * An identity is (user, generation), so this covers a switch between accounts
 * and the same user receiving a new credential.
 */
function IdentityCacheGuard(): null {
  const queryClient = useQueryClient()
  const { dataSession } = useAuth()

  const userId = dataSession?.userId ?? null
  const generation = dataSession?.generation ?? null

  useEffect(() => {
    const current = userId === null || generation === null ? null : { userId, generation }

    const belongsToAnotherIdentity = (query: {
      queryKey: readonly unknown[]
    }): boolean =>
      isProtectedKey(query.queryKey) && !isCurrentIdentityKey(query.queryKey, current)

    void queryClient.cancelQueries({ predicate: belongsToAnotherIdentity })
    queryClient.removeQueries({ predicate: belongsToAnotherIdentity })
  }, [userId, generation, queryClient])

  return null
}

/**
 * The query client, and the guard that keeps its contents tied to one identity.
 *
 * It sits inside the auth provider because the guard reads the session, and it
 * wraps the routes so no data view can mount outside it.
 */
export function QueryProvider({
  children,
  client,
}: {
  children: ReactNode
  /** Seam for tests. The application always builds its own client. */
  client?: QueryClient
}): ReactNode {
  const [queryClient] = useState(() => client ?? createQueryClient())

  return (
    <QueryClientProvider client={queryClient}>
      <IdentityCacheGuard />
      {children}
    </QueryClientProvider>
  )
}
