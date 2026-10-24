/**
 * Hand-written guards instead of casts.
 *
 * A cast would make a malformed success body look like a valid one and push
 * the failure into a component, where it reads as a rendering bug rather than
 * a contract violation. These narrow once, at the seam.
 */

import type {
  Chain,
  LoginResult,
  MessageResult,
  Pagination,
  TrackedContract,
  User,
  Wallet,
} from './types.ts'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * An identifier or a count is a safe integer or it is not that identifier.
 *
 * A float, a value beyond 2^53 or a string that happens to parse would become a
 * wrong row key or a wrong page number, and both are silent failures.
 */
export function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

export function isPagination(value: unknown): value is Pagination {
  return (
    isRecord(value) &&
    isFiniteNumber(value.page) &&
    isFiniteNumber(value.pageSize) &&
    isFiniteNumber(value.totalItems) &&
    isFiniteNumber(value.totalPages)
  )
}

/**
 * The identity of the signed-in user.
 *
 * `id` is a safe positive integer or it is not an identity. It is copied
 * straight into a cache key, so a float, a value beyond 2^53, a numeric string
 * or a non-positive number would build a key that no real user owns and let a
 * response that is not an identity open a data session. It is rejected here, at
 * the seam, and never rounded or coerced into something that looks valid.
 */
export function isUser(value: unknown): value is User {
  return (
    isRecord(value) &&
    isSafeInteger(value.id) &&
    value.id > 0 &&
    typeof value.email === 'string' &&
    typeof value.createdAt === 'string'
  )
}

export function isLoginResult(value: unknown): value is LoginResult {
  return (
    isRecord(value) &&
    typeof value.token === 'string' &&
    value.token.length > 0 &&
    typeof value.expiresAt === 'string'
  )
}

export function isMessageResult(value: unknown): value is MessageResult {
  return isRecord(value) && typeof value.message === 'string'
}

/**
 * One wallet row.
 *
 * Every consumed field is checked, including the ones this screen does not print
 * yet: `id` is a query key and a React key, so a wrong one is a wrong cache
 * entry rather than a visible typo.
 */
export function isWallet(value: unknown): value is Wallet {
  return (
    isRecord(value) &&
    isSafeInteger(value.id) &&
    typeof value.address === 'string' &&
    isSafeInteger(value.chainId) &&
    typeof value.label === 'string' &&
    typeof value.createdAt === 'string'
  )
}

/**
 * The whole page, or nothing.
 *
 * One bad row fails the response instead of being filtered out. Dropping rows
 * the client cannot understand would show a short page as if it were the whole
 * truth, and `totalItems` would then disagree with what is on screen.
 */
export function isWalletList(value: unknown): value is Wallet[] {
  if (!Array.isArray(value)) {
    return false
  }

  return value.every((entry: unknown) => isWallet(entry))
}

/**
 * The three indexing availability values the API can send, and nothing else.
 *
 * A fixed set rather than a string. `indexingStatus` is rendered as one of three
 * fixed phrases, and a value outside this set is a response this client does not
 * understand: echoing it would put server vocabulary, and eventually indexer
 * vocabulary, straight onto the screen.
 */
const INDEXING_STATUSES: readonly string[] = ['pending', 'disabled', 'unsupported']

/**
 * One tracked contract, all eight fields.
 *
 * `enabled`, `startBlock` and `createdAt` are checked even though this slice
 * shows them in one place: a row missing one is not a record this client can
 * render, and accepting it would mean rendering an empty cell as if the server
 * had said nothing there. `startBlock` is a safe integer, because a block height
 * beyond 2^53 is not one this screen can display or compare honestly.
 */
export function isTrackedContract(value: unknown): value is TrackedContract {
  return (
    isRecord(value) &&
    isSafeInteger(value.id) &&
    typeof value.address === 'string' &&
    isSafeInteger(value.chainId) &&
    typeof value.label === 'string' &&
    typeof value.enabled === 'boolean' &&
    isSafeInteger(value.startBlock) &&
    typeof value.createdAt === 'string' &&
    typeof value.indexingStatus === 'string' &&
    INDEXING_STATUSES.includes(value.indexingStatus)
  )
}

/**
 * The whole page of tracked contracts, or nothing.
 *
 * One unusable row fails the response instead of being filtered out, for the
 * same reason the wallet list does: a dropped row would leave `totalItems`
 * disagreeing with what is on screen, and a short page would read as the truth.
 */
export function isContractList(value: unknown): value is TrackedContract[] {
  if (!Array.isArray(value)) {
    return false
  }

  return value.every((entry: unknown) => isTrackedContract(entry))
}

/**
 * Pagination for a collection, stricter than `isPagination`.
 *
 * The general helper accepts any finite number because a single-resource
 * response may omit the block entirely. A list response must carry it, and the
 * four values have to be safe integers the UI can render and compare: `page` and
 * `pageSize` are positive, and the totals are never negative.
 */
export function isCollectionPagination(value: unknown): value is Pagination {
  return (
    isRecord(value) &&
    isSafeInteger(value.page) &&
    value.page >= 1 &&
    isSafeInteger(value.pageSize) &&
    value.pageSize >= 1 &&
    isSafeInteger(value.totalItems) &&
    value.totalItems >= 0 &&
    isSafeInteger(value.totalPages) &&
    value.totalPages >= 0
  )
}

/**
 * One row of the public chain catalog.
 *
 * Every consumed field is checked. `chainId` becomes the `chainId` this client
 * sends back on create and the value a saved row is matched against, so a
 * float or a numeric string would both build a request the server rejects and
 * an option that can never match a saved row. `isTestnet` is a real boolean
 * because the option label is chosen on it.
 */
export function isChain(value: unknown): value is Chain {
  return (
    isRecord(value) &&
    isSafeInteger(value.chainId) &&
    value.chainId > 0 &&
    typeof value.name === 'string' &&
    typeof value.symbol === 'string' &&
    typeof value.isTestnet === 'boolean'
  )
}

/**
 * The whole catalog, or nothing.
 *
 * An empty catalog is a valid answer and is preserved: it means this
 * deployment has no enabled chains, which is a real state the form has to
 * render. A catalog with one unusable row is not, for the same reason a bad
 * wallet row fails the whole page: showing half a list of chains would let a
 * user pick an option whose fields the client never actually read.
 */
export function isChainList(value: unknown): value is Chain[] {
  if (!Array.isArray(value)) {
    return false
  }

  return value.every((entry: unknown) => isChain(entry))
}

/**
 * Error detail is a flat string map in the API. Anything else is dropped
 * rather than half-read, so a field-level message is either trustworthy or
 * absent.
 */
export function parseErrorDetails(
  value: unknown,
): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined
  }

  const details: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') {
      return undefined
    }
    details[key] = entry
  }

  return Object.keys(details).length > 0 ? details : undefined
}
