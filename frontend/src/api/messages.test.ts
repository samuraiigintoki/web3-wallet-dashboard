import { describe, expect, it } from 'vitest'

import { ApiError, CLIENT_ERROR_CODES, SERVER_ERROR_CODES } from './errors.ts'
import { describeApiError } from './messages.ts'

function error(init: Partial<ConstructorParameters<typeof ApiError>[0]>): ApiError {
  return new ApiError({
    code: 'INTERNAL_SERVER_ERROR',
    status: 500,
    message: 'internal error',
    ...init,
  })
}

describe('describeApiError', () => {
  it('gives every documented code a non-empty message', () => {
    for (const code of [...SERVER_ERROR_CODES, ...CLIENT_ERROR_CODES]) {
      const copy = describeApiError(error({ code }))
      expect(copy.length).toBeGreaterThan(0)
      expect(copy).not.toContain(code)
    }
  })

  it('does not say which half of a credential pair was wrong', () => {
    const copy = describeApiError(error({ code: 'INVALID_CREDENTIALS', status: 401 }))

    expect(copy).toBe('That email and password combination is not correct.')
    expect(copy.toLowerCase()).not.toContain('no such user')
    expect(copy.toLowerCase()).not.toContain('wrong password')
  })

  it('includes the retry delay when the server sent one', () => {
    const copy = describeApiError(
      error({ code: 'RATE_LIMITED', status: 429, retryAfterSeconds: 24 }),
    )

    expect(copy).toBe('Too many attempts. Please try again in 24 seconds.')
  })

  it('uses the singular when the delay is one second', () => {
    const copy = describeApiError(
      error({ code: 'RATE_LIMITED', status: 429, retryAfterSeconds: 1 }),
    )

    expect(copy).toBe('Too many attempts. Please try again in 1 second.')
  })

  it('falls back when a 429 carried no usable Retry-After', () => {
    const copy = describeApiError(error({ code: 'RATE_LIMITED', status: 429 }))

    expect(copy).toBe('Too many attempts. Please wait a moment and try again.')
  })

  it('surfaces the server field detail on a validation error', () => {
    const copy = describeApiError(
      error({
        code: 'VALIDATION_ERROR',
        status: 422,
        details: { password: 'password exceeds maximum allowed length of 72 bytes' },
      }),
    )

    expect(copy).toBe('password: password exceeds maximum allowed length of 72 bytes')
  })

  it('falls back to a generic message for anything that is not an ApiError', () => {
    expect(describeApiError(new Error('boom'))).toBe('Something went wrong. Please try again.')
    expect(describeApiError('boom')).toBe('Something went wrong. Please try again.')
    expect(describeApiError(undefined)).toBe('Something went wrong. Please try again.')
  })
})
