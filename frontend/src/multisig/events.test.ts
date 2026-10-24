import { describe, expect, it } from 'vitest'

import type { ContractEvent } from '../api/index.ts'
import { findConfirmation, findSubmittedTransaction } from './events.ts'

/**
 * Matching a submitted hash against a page of stored events.
 *
 * The distinction this guards is between "this page holds the event" and
 * "this page does not", and nothing else. A wrong match would present someone
 * else's transaction as this submission; a match that missed would tell a user
 * their proposal had not been indexed when it had.
 */

const HASH = `0x${'ab'.repeat(32)}`
const OTHER_HASH = `0x${'cd'.repeat(32)}`
const CONTRACT = '0x5b324f41e5889cf94cba8e909089683a1a97c318'
const ACTOR = '0x14912965632cd9ab70c046e8d23e9b8dfa9f2746'

type EventOverrides = Omit<Partial<ContractEvent>, 'eventName'> & {
  eventName?: 'SubmitTransaction' | 'ConfirmTransaction' | 'RevokeConfirmation' | 'ExecuteTransaction'
}

function event(overrides: EventOverrides = {}): ContractEvent {
  return {
    contractId: 7,
    eventName: 'SubmitTransaction',
    blockNumber: 6_100_000,
    blockHash: `0x${'11'.repeat(32)}`,
    transactionHash: HASH,
    transactionIndex: 1,
    logIndex: 0,
    actorAddress: ACTOR,
    multisigTxIndex: '0',
    payload: { to: CONTRACT, valueWei: '1', data: '0x' },
    ...overrides,
  }
}

describe('finding the submission in a page', () => {
  it('finds the SubmitTransaction event for the hash', () => {
    const found = findSubmittedTransaction(HASH, [event()])

    expect(found?.transactionHash).toBe(HASH)
  })

  it('finds it among other events, including events from the same transaction', () => {
    const page = [
      event({ eventName: 'ConfirmTransaction', transactionHash: OTHER_HASH, logIndex: 1 }),
      event({ eventName: 'ConfirmTransaction', logIndex: 2 }),
      event(),
    ]

    const found = findSubmittedTransaction(HASH, page)

    // Index 2 and the submission share a transaction hash, and the confirmation
    // is not the submission: the event name is part of the match.
    expect(found?.eventName).toBe('SubmitTransaction')
    expect(found?.logIndex).toBe(0)
  })

  it('compares the hash without caring about case', () => {
    expect(
      findSubmittedTransaction(HASH.toUpperCase().replace('0X', '0x'), [event()]),
    ).not.toBeNull()
  })

  it('returns null when the page holds no event for this hash', () => {
    expect(
      findSubmittedTransaction(HASH, [
        event({ transactionHash: OTHER_HASH }),
        event({ eventName: 'ConfirmTransaction', transactionHash: OTHER_HASH }),
      ]),
    ).toBeNull()
  })

  it('returns null for an empty page', () => {
    expect(findSubmittedTransaction(HASH, [])).toBeNull()
  })
})

describe('finding one confirmation in a page', () => {
  const OTHER_ACTOR = '0x1e1D0e1D0e1D0e1D0e1D0e1D0e1D0e1D0e1D0e1D'

  function confirmation(overrides: EventOverrides = {}): ContractEvent {
    return event({ eventName: 'ConfirmTransaction', ...overrides })
  }

  it('needs the hash, the index and the actor to agree', () => {
    const found = findConfirmation(HASH, '0', ACTOR, [confirmation()])

    expect(found?.eventName).toBe('ConfirmTransaction')
    expect(found?.multisigTxIndex).toBe('0')
  })

  it('finds it among the submission and another owner confirming the same index', () => {
    const page = [
      event(),
      confirmation({ transactionHash: OTHER_HASH, actorAddress: OTHER_ACTOR, logIndex: 1 }),
      confirmation({ logIndex: 2 }),
    ]

    const found = findConfirmation(HASH, '0', ACTOR, page)

    // The row with the same index from another owner comes first and is not it.
    expect(found?.transactionHash).toBe(HASH)
    expect(found?.actorAddress).toBe(ACTOR)
    expect(found?.logIndex).toBe(2)
  })

  it('returns null when only the index agrees, which is another owner confirming', () => {
    const page = [confirmation({ transactionHash: OTHER_HASH })]

    expect(findConfirmation(HASH, '0', ACTOR, page)).toBeNull()
    expect(findConfirmation(HASH, '0', OTHER_ACTOR, page)).toBeNull()
  })

  it('returns null when the transaction confirmed a different index', () => {
    expect(findConfirmation(HASH, '1', ACTOR, [confirmation({ multisigTxIndex: '1' })])).not.toBeNull()

    // The page row says index 0, so an index of 1 is not on this page.
    expect(findConfirmation(HASH, '1', ACTOR, [confirmation({ multisigTxIndex: '0' })])).toBeNull()
  })

  it('returns null for the submission of this hash, which is not a confirmation', () => {
    expect(findConfirmation(HASH, '0', ACTOR, [event()])).toBeNull()
  })

  it('compares hashes and actors without caring about case', () => {
    const page = [confirmation({ transactionHash: HASH.toUpperCase().replace('0X', '0x'), actorAddress: ACTOR.toUpperCase().replace('0X', '0x') })]

    expect(findConfirmation(HASH, '0', ACTOR, page)).not.toBeNull()
  })

  it('returns null for an empty page', () => {
    expect(findConfirmation(HASH, '0', ACTOR, [])).toBeNull()
  })
})
