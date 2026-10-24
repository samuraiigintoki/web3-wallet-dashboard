/**
 * Finding one submission, or one confirmation, in a refreshed page of indexed
 * events.
 *
 * The indexer stores what it has scanned, and a page of it is what the server
 * last wrote. Matching a submitted hash against those rows is the only way this
 * app can say an event has been indexed, and the only honest thing it can say
 * when there is no match is that the event is not on this page.
 *
 * No match is not an absence. The event may be later than the scan, on a
 * different page, or missing from the stored index for reasons this screen cannot
 * see, and none of those is "no event was emitted". The wording in the component
 * comes from that, and this module deliberately returns a plain result rather
 * than anything that could be read as a verdict.
 */

import type { ContractEvent } from '../api/index.ts'

/** What a manual refresh of the current page returned. */
export type RefreshedPage = {
  events: ContractEvent[]
  /** The page those events belong to, so a statement about them can name it. */
  page: number
}

/**
 * The `SubmitTransaction` row for a hash, or null.
 *
 * The event name is checked as well as the hash: the same transaction can store
 * several events, and the one this screen wants is the submission itself. Hashes
 * are compared in lower case, because case carries no meaning in a hex value and
 * a provider or server that changed it would otherwise defeat the match.
 */
export function findSubmittedTransaction(
  hash: string,
  events: readonly ContractEvent[],
): ContractEvent | null {
  const wanted = hash.toLowerCase()

  for (const event of events) {
    if (event.eventName === 'SubmitTransaction' && event.transactionHash.toLowerCase() === wanted) {
      return event
    }
  }

  return null
}

/**
 * The `ConfirmTransaction` row for one confirmation, or null.
 *
 * All three parts of the match are needed and none of them alone is enough. The
 * index says which proposal was confirmed, the actor says who confirmed it, and
 * the hash says which transaction the receipt this screen just read belongs to.
 * Two owners confirming the same proposal within one block produce two rows that
 * agree on the index and on the event name, so an index-only match could show the
 * wrong one as this confirmation.
 *
 * No match carries no verdict, exactly as with a submission: the event may be
 * later than the scan, on another page, or absent from the stored index.
 */
export function findConfirmation(
  hash: string,
  index: string,
  actor: string,
  events: readonly ContractEvent[],
): ContractEvent | null {
  return findOwnEvent('ConfirmTransaction', hash, index, actor, events)
}

/**
 * The `RevokeConfirmation` row for one revocation, or null.
 *
 * Same three-part match as a confirmation, for the same reason: two owners can
 * revoke on the same proposal within one block, and an index-only match could
 * show another owner's revocation as this one. The event name is part of the
 * match, so a confirmation by this account on this index is never read as its
 * revocation.
 */
export function findRevocation(
  hash: string,
  index: string,
  actor: string,
  events: readonly ContractEvent[],
): ContractEvent | null {
  return findOwnEvent('RevokeConfirmation', hash, index, actor, events)
}

/**
 * One owner event by hash, index and actor.
 *
 * Shared by confirmation and revocation because the matching rule is identical
 * and only the event name differs; writing it twice would be a chance for the two
 * to disagree about which of the three parts is required.
 */
function findOwnEvent(
  name: 'ConfirmTransaction' | 'RevokeConfirmation',
  hash: string,
  index: string,
  actor: string,
  events: readonly ContractEvent[],
): ContractEvent | null {
  const wantedHash = hash.toLowerCase()
  const wantedActor = actor.toLowerCase()

  for (const event of events) {
    if (
      event.eventName === name &&
      event.transactionHash.toLowerCase() === wantedHash &&
      event.multisigTxIndex === index &&
      event.actorAddress.toLowerCase() === wantedActor
    ) {
      return event
    }
  }

  return null
}
