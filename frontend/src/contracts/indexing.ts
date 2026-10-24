import type { IndexingStatus } from '../api/index.ts'

/**
 * What each indexing availability value means, in the interface's words.
 *
 * These are availability, not progress. The API computes this at read time from
 * the deployment: the chain it is on and whether the record is enabled. It never
 * sends how far a scan has got, so nothing here may say "indexing 40%", a block
 * height, or "catching up". Saying that would invent a fact the server did not
 * send and would turn a scanner's internal state into a promise to the user.
 *
 * The type is the closed set from the API, so a new server value cannot reach
 * this table: the response guard refuses a record carrying one, and the read
 * fails as a contract violation instead of rendering a raw string.
 */
const STATUS_DESCRIPTIONS: Record<IndexingStatus, string> = {
  pending: 'Indexing is available for this record and has not started yet.',
  disabled: 'Indexing is switched off for this record.',
  unsupported: 'Indexing is not available for this chain.',
}

/** The short label in the table cell. */
const STATUS_LABELS: Record<IndexingStatus, string> = {
  pending: 'Pending',
  disabled: 'Disabled',
  unsupported: 'Unsupported',
}

export function indexingLabel(status: IndexingStatus): string {
  return STATUS_LABELS[status]
}

export function indexingDescription(status: IndexingStatus): string {
  return STATUS_DESCRIPTIONS[status]
}
