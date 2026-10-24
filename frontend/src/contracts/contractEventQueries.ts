import type { UseQueryOptions } from '@tanstack/react-query'

import { ApiError, type ContractEventList, type TrackedContract } from '../api/index.ts'
import type { DataSession } from '../auth/session.ts'
import { identityKey } from '../data/identityKeys.ts'
import { PAGE_SIZE } from '../data/page.ts'

/**
 * One tracked contract, for the heading above its events.
 *
 * Keyed by identity and id, like every other protected read, so a response for
 * one account has no key to land in under another. The query is the same call
 * the server uses to authorize the event list, which is why the events query
 * waits for it: a contract this account does not track is answered here with a
 * `404`, and no event request is ever sent for it.
 */
export function contractQuery(
  dataSession: DataSession | null,
  contractId: number,
): UseQueryOptions<TrackedContract, Error, TrackedContract, readonly unknown[]> {
  const identity = dataSession

  return {
    queryKey:
      identity === null
        ? ['contract', 'no-identity', contractId]
        : [...identityKey(identity), 'contracts', 'detail', contractId],
    enabled: identity !== null,
    queryFn: async ({ signal }) => {
      if (identity === null) {
        throw new ApiError({
          code: 'ABORTED',
          status: 0,
          message: 'there is no session to load a contract for',
        })
      }

      return await identity.client.getContract(contractId, { signal })
    },
  }
}

/**
 * One page of a tracked contract's indexed events.
 *
 * Disabled until the contract read above succeeds. That is deliberate and it is
 * the security property, not a tidiness choice: if the id is missing or belongs
 * to another account, the context read fails first and this query never runs, so
 * there is no request whose answer could be mistaken for evidence that the
 * contract exists.
 *
 * The key carries the user, the session generation, the contract id, the page
 * and the page size, and never a token. A read started under one session cannot
 * be filled with another's rows, and a retired identity's entries are dropped by
 * the cache guard on the same triple.
 */
export function contractEventListQuery(
  dataSession: DataSession | null,
  contractId: number,
  page: number,
  enabled: boolean,
): UseQueryOptions<ContractEventList, Error, ContractEventList, readonly unknown[]> {
  const identity = dataSession

  return {
    queryKey:
      identity === null
        ? ['contract-events', 'no-identity', contractId, page]
        : [...identityKey(identity), 'contracts', 'events', contractId, page, PAGE_SIZE],
    enabled: identity !== null && enabled,
    queryFn: async ({ signal }) => {
      if (identity === null) {
        throw new ApiError({
          code: 'ABORTED',
          status: 0,
          message: 'there is no session to load events for',
        })
      }

      // Query's own signal, so navigating away, signing out or replacing the
      // credential cancels the call instead of letting it finish into a cache
      // nobody is watching.
      return await identity.client.listContractEvents(
        contractId,
        { page, pageSize: PAGE_SIZE },
        { signal },
      )
    },
  }
}
