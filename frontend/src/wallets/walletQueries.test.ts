import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'

import { identityKey, type IdentityRef } from '../data/identityKeys.ts'
import { PAGE_SIZE } from '../data/page.ts'
import { refreshWalletLists } from './walletQueries.ts'

const MINE: IdentityRef = { userId: 5, generation: 1 }
/** The same account after a credential replacement: a different identity. */
const MINE_REPLACED: IdentityRef = { userId: 5, generation: 2 }

function listKey(identity: IdentityRef, page: number): readonly unknown[] {
  return [...identityKey(identity), 'wallets', 'list', page, PAGE_SIZE]
}

function newClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  })
}

describe('refreshWalletLists', () => {
  it('marks only the given identity stale, and leaves a replacement alone', async () => {
    const client = newClient()
    client.setQueryData(listKey(MINE, 1), { wallets: [], pagination: null })
    client.setQueryData(listKey(MINE_REPLACED, 1), { wallets: [], pagination: null })

    await refreshWalletLists(client, MINE)

    // The account's own page owes a fresh read after the save.
    expect(client.getQueryState(listKey(MINE, 1))?.isInvalidated).toBe(true)
    // A replacement identity shares the account and nothing else. Its cache is
    // not this sequence's to touch, which is the fence that keeps a superseded
    // refresh out of a newer session.
    expect(client.getQueryState(listKey(MINE_REPLACED, 1))?.isInvalidated).toBe(false)
    expect(client.getQueryData(listKey(MINE_REPLACED, 1))).toEqual({
      wallets: [],
      pagination: null,
    })
  })

  it('aborts a first read that has no data yet', async () => {
    const client = newClient()
    let aborted = false

    // A first load that never answers, exactly like the one held open while the
    // save was confirmed. Invalidation alone reuses a request in this state
    // instead of replacing it, so it has to be cancelled.
    const first = client.fetchQuery({
      queryKey: listKey(MINE, 1),
      queryFn: ({ signal }) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true
            reject(new Error('aborted'))
          })
        }),
    })
    first.catch(() => undefined)

    await refreshWalletLists(client, MINE)

    expect(aborted).toBe(true)
    expect(client.getQueryState(listKey(MINE, 1))?.data).toBeUndefined()
  })
})
