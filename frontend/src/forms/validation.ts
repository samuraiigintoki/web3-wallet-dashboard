/**
 * Only the rules the API actually documents are mirrored here.
 *
 * Inventing a stricter client rule would reject passwords the server accepts,
 * which looks like a bug to anyone who already has an account.
 */

/** backend/internal/user/service.go: MaxPasswordBytes. */
export const MAX_PASSWORD_BYTES = 72

/**
 * backend/internal/user/service.go: MinPasswordRunes. Registration only: the
 * floor applies where a password is set, and login leaves it out so an account
 * created before the rule still signs in.
 */
export const MIN_PASSWORD_RUNES = 15

const encoder = new TextEncoder()

/**
 * The server measures bytes, not characters. "é" is one character and two
 * bytes, so a string-length check would let an over-long password through and
 * turn into a 422 the form could have caught.
 */
export function utf8ByteLength(value: string): number {
  return encoder.encode(value).length
}

/**
 * The whitespace the server treats as blank, which is not the set `.trim()`
 * strips.
 *
 * The API calls Go's `strings.TrimSpace`, which uses `unicode.IsSpace`. Two
 * points differ from JavaScript's `\\s` and both were reproduced against the
 * running service: fifteen U+0085 NEXT LINE characters are blank to the server
 * and are accepted by `.trim()`, and fifteen U+FEFF characters are accepted by
 * the server and are blank to `.trim()`. The ranges below are Go's set, and
 * the value is never trimmed or normalized, only classified.
 */
const SERVER_SPACE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x09, 0x0d],
  [0x20, 0x20],
  [0x85, 0x85],
  [0xa0, 0xa0],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x2028, 0x2029],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
]

/** True when every code point is whitespace to the server, so it reads as blank. */
export function isBlankToServer(value: string): boolean {
  if (value === '') {
    return true
  }

  for (const character of value) {
    const codePoint = character.codePointAt(0)
    const isSpace = SERVER_SPACE_RANGES.some(
      ([low, high]) => codePoint !== undefined && codePoint >= low && codePoint <= high,
    )

    if (!isSpace) {
      return false
    }
  }

  return true
}

/**
 * Counts Unicode code points, the unit the API counts in.
 *
 * `value.length` counts UTF-16 units, so it would call 14 astral characters a
 * length of 28. Grapheme clusters are deliberately not counted: the server
 * counts code points, and `Intl.Segmenter` would answer a different question.
 */
export function codePointLength(value: string): number {
  return Array.from(value).length
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
 *
 * This is the login rule as well, and login applies no minimum, so a short
 * legacy password still submits.
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

/**
 * The registration rule, mirroring the API: not whitespace only, at least
 * MIN_PASSWORD_RUNES code points, and the byte ceiling.
 *
 * The count is code points, not UTF-16 length. A string of 14 astral
 * characters has a length of 28 and is still too short. The server counts the
 * same way, so a check on `value.length` would let a rejected password
 * through and turn into a 422 the form could have caught.
 */
export function validateNewPassword(value: string): string | null {
  if (isBlankToServer(value)) {
    return 'Enter your password.'
  }

  if (codePointLength(value) < MIN_PASSWORD_RUNES) {
    return `Your password must be at least ${String(MIN_PASSWORD_RUNES)} characters.`
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
