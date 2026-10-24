import type { UseQueryOptions } from '@tanstack/react-query'

import { ApiError, type ContractList } from '../api/index.ts'
import type { DataSession } from '../auth/session.ts'
import { identityKey } from '../data/identityKeys.ts'
import { PAGE_SIZE } from '../data/page.ts'

/**
 * One page of the signed-in user's tracked contracts.
 *
 * The shape is the wallet list's, deliberately: the identity is captured when
 * the options are built and is the same object the query runs with, so nothing
 * looks a credential up later and a request started under one session cannot
 * send another's token if the shared store changed while it was in flight.
 *
 * The key carries the user, the session generation, the page and the page size,
 * and never a token. Two sessions of one account are two identities and share
 * nothing, and the cache guard that drops a retired identity's entries is keyed
 * on the same triple, so a foreign response has no key here to land in.
 *
 * There is no refresh helper beside this one: nothing on this screen writes, so
 * there is nothing to read again after a write. A retry is the query's own
 * refetch, which is a fresh read of the same key.
 */
export function contractListQuery(
  dataSession: DataSession | null,
  page: number,
): UseQueryOptions<ContractList, Error, ContractList, readonly unknown[]> {
  const identity = dataSession

  return {
    queryKey:
      identity === null
        ? // Not an identity key: there is no session to protect, the query is
          // disabled, and the guard that drops another identity's cache has no
          // business touching it.
          ['contracts', 'no-identity', page]
        : [...identityKey(identity), 'contracts', 'list', page, PAGE_SIZE],
    // No request at all without a validated identity. A disabled query is not a
    // loading state: it is the absence of permission to ask.
    enabled: identity !== null,
    queryFn: async ({ signal }) => {
      if (identity === null) {
        throw new ApiError({
          code: 'ABORTED',
          status: 0,
          message: 'there is no session to load contracts for',
        })
      }

      // Query's signal goes straight through, so signing out or replacing the
      // credential cancels the call rather than leaving it to finish and write
      // into a cache nobody is watching.
      return await identity.client.listContracts({ page, pageSize: PAGE_SIZE }, { signal })
    },
  }
}
