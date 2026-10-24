/**
 * The page a screen asks for, and the limits it asks within.
 *
 * Shared by every paginated screen: the wallets list and the tracked-contract
 * list ask the same server the same questions, and the server owns both caps and
 * answers an over-cap page with 400. These numbers are not decoration: they are
 * what keeps a hand-typed URL from producing a request the API rejects.
 */

/** The server's page ceiling. Anything above it is a 400. */
export const MAX_PAGE = 10_000

/** Fixed for this slice, matching the server default. There is no size control. */
export const PAGE_SIZE = 20

/**
 * A page number from the URL, for any paginated screen.
 *
 * Anything that is not a positive plain integer is page 1 rather than an error:
 * a malformed address bar is not a wallet failure, and crashing on `?page=abc`
 * would leave the user with a blank screen and no way back. Values above the
 * server's ceiling are clamped, never sent.
 */
export function parsePageParam(raw: string | null): number {
  if (raw === null) {
    return 1
  }

  const trimmed = raw.trim()

  // Digits only: no sign, no decimal point, no exponent, no separators.
  if (!/^\d+$/.test(trimmed)) {
    return 1
  }

  const parsed = Number.parseInt(trimmed, 10)

  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return 1
  }

  return Math.min(parsed, MAX_PAGE)
}
