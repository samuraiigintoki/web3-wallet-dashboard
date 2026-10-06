/**
 * Hand-written guards instead of casts.
 *
 * A cast would make a malformed success body look like a valid one and push
 * the failure into a component, where it reads as a rendering bug rather than
 * a contract violation. These narrow once, at the seam.
 */

import type { LoginResult, MessageResult, Pagination, User } from './types.ts'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
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
