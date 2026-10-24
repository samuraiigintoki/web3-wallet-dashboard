/**
 * Finding one submission in a refreshed page of indexed events.
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
