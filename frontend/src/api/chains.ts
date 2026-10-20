/**
 * The chain catalog, the one call this client makes without a credential.
 *
 * `GET /api/v1/chains` is public, so it is deliberately not part of the
 * identity-bound data capability: it needs no session, it returns nothing that
 * belongs to an account, and putting it behind one would make a screen wait for
 * a validated identity before it could show a dropdown.
 *
 * The token source returns null rather than reading shared storage. That is the
 * whole point: with no token there is no Authorization header to send and none
 * to leak, and a 401 cannot happen on a call that carried no credential, so the
 * unauthorized callback is never reached. The guarantee is structural, not a
 * flag that a later caller could flip.
 */

import { createRequest, type CallInit } from './request.ts'
import { isChainList } from './guards.ts'
import { ApiError } from './errors.ts'
import type { Chain } from './types.ts'

export type ChainCatalog = {
  /**
   * The enabled chains, ordered as the server sends them. An empty array is a
   * real answer and is returned as an empty array, never as null and never as
   * an error.
   */
  listChains: (init?: CallInit) => Promise<Chain[]>
}

/**
 * `onUnauthorized` is unreachable in production: the helper only reports a 401
 * for a request that actually carried a token, and this client never has one to
 * send. The parameter exists so that the guarantee can be observed rather than
 * assumed, with a callback the test can count, instead of a counter wired to
 * nothing.
 */
export function createChainCatalog(
  onUnauthorized: () => void = () => undefined,
): ChainCatalog {
  const request = createRequest({
    getToken: () => null,
    onUnauthorized,
  })

  return {
    async listChains(init) {
      // No `auth` flag, so the helper never looks for a token at all.
      const result = await request({
        method: 'GET',
        path: '/chains',
        guard: isChainList,
        signal: init?.signal,
      })

      // The catalog is unpaginated and always carries a `data` array. An empty
      // one is a deployment with no enabled chains; a missing one is a broken
      // response, because the route answers `{"data": []}` and never `null`.
      if (result.data === null) {
        throw new ApiError({
          code: 'UNEXPECTED_RESPONSE',
          status: 0,
          message: 'the server returned an empty body where one was required',
          requestId: result.requestId,
        })
      }

      return result.data
    },
  }
}

/**
 * The catalog the application uses.
 *
 * It holds no credential and no identity, so one instance is safe to share:
 * there is no per-session state in it for two sessions to confuse.
 */
export const chainCatalog: ChainCatalog = createChainCatalog()
