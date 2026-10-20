import type { UseQueryOptions } from '@tanstack/react-query'

import { chainCatalog, type Chain } from '../api/index.ts'

/**
 * The chain catalog.
 *
 * This key deliberately does not begin with the identity marker, so C1's guard
 * leaves it alone on every identity change. That is the correct behaviour and
 * not an oversight: the catalog is public, it is the same for every account,
 * and it carries nothing that belongs to a session. Dropping it on a sign-out
 * would only make the next sign-in wait for a list it already has.
 *
 * It is also not an identity-gated query. There is no `enabled` tied to the
 * session, because no credential is needed to read it.
 */
export const CHAIN_CATALOG_KEY = ['chains', 'catalog'] as const

export function chainCatalogQuery(): UseQueryOptions<
  Chain[],
  Error,
  Chain[],
  readonly unknown[]
> {
  return {
    queryKey: CHAIN_CATALOG_KEY,
    queryFn: async ({ signal }) => await chainCatalog.listChains({ signal }),
  }
}
