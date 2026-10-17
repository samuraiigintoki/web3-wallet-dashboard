/**
 * Hand-written guards instead of casts.
 *
 * A cast would make a malformed success body look like a valid one and push
 * the failure into a component, where it reads as a rendering bug rather than
 * a contract violation. These narrow once, at the seam.
 */

import type {
  LoginResult,
  MessageResult,
  Pagination,
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

export function isUser(value: unknown): value is User {
  return (
    isRecord(value) &&
    isFiniteNumber(value.id) &&
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
