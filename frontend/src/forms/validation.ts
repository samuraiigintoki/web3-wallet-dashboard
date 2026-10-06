/**
 * Only the rules the API actually documents are mirrored here.
 *
 * Inventing a stricter client rule would reject passwords the server accepts,
 * which looks like a bug to anyone who already has an account.
 */

/** backend/internal/user/service.go: MaxPasswordBytes. */
export const MAX_PASSWORD_BYTES = 72

const encoder = new TextEncoder()

/**
 * The server measures bytes, not characters. "é" is one character and two
 * bytes, so a string-length check would let an over-long password through and
 * turn into a 422 the form could have caught.
 */
export function utf8ByteLength(value: string): number {
  return encoder.encode(value).length
}

export function validateEmail(value: string): string | null {
  const trimmed = value.trim()

  if (trimmed === '') {
    return 'Enter your email address.'
  }

  if (!trimmed.includes('@')) {
    return 'Enter an email address that contains @.'
  }

  return null
}

/**
 * The password is checked but never trimmed: leading and trailing spaces are
 * part of it, and the server compares what was registered.
 */
export function validatePassword(value: string): string | null {
  if (value === '') {
    return 'Enter your password.'
  }

  if (utf8ByteLength(value) > MAX_PASSWORD_BYTES) {
    return `Your password must be ${String(MAX_PASSWORD_BYTES)} bytes or fewer.`
  }

  return null
}

export function validatePasswordConfirmation(
  password: string,
  confirmation: string,
): string | null {
  return password === confirmation ? null : 'The two passwords do not match.'
}
