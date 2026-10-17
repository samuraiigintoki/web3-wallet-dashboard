import type { UseQueryOptions } from '@tanstack/react-query'

import { ApiError, type WalletList } from '../api/index.ts'
import type { DataSession } from '../auth/session.ts'
import { identityKey } from '../data/identityKeys.ts'
import { PAGE_SIZE } from './page.ts'

/**
 * One page of the signed-in user's wallets.
 *
 * The identity is captured in the closure when the options are built and is the
 * same object the query runs with. Nothing here looks a credential up later, so
 * a request started under one session cannot quietly send another's token if
 * the shared store changed while it was in flight.
 *
 * The key carries the user, the generation, the page and the page size, and
 * never a token: two sessions of one account therefore read as two identities
 * and share nothing.
 */
export function walletListQuery(
  dataSession: DataSession | null,
  page: number,
): UseQueryOptions<WalletList, Error, WalletList, readonly unknown[]> {
  const identity = dataSession

  return {
    queryKey:
      identity === null
        ? // Not an identity key: there is no session to protect, the query is
          // disabled, and the guard that drops another identity's cache has no
          // business touching it.
          ['wallets', 'no-identity', page]
        : [...identityKey(identity), 'wallets', 'list', page, PAGE_SIZE],
    // No request at all without a validated identity. A disabled query is not a
    // loading state: it is the absence of permission to ask.
    enabled: identity !== null,
    queryFn: async ({ signal }) => {
      if (identity === null) {
        throw new ApiError({
          code: 'ABORTED',
          status: 0,
          message: 'there is no session to load wallets for',
        })
      }

      // Query's signal goes straight through, so navigating away, signing out
      // or replacing the credential cancels the call instead of leaving it to
      // finish and write into a cache nobody is watching.
      return await identity.client.listWallets({ page, pageSize: PAGE_SIZE }, { signal })
    },
  }
}
