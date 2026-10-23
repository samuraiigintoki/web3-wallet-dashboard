import type { ApiError, ApiErrorCode } from '../api/index.ts'

/**
 * Whether a failed write left the fate of the write unknown.
 *
 * Two families share that property. A timeout, a dropped connection or a
 * cancelled attempt never reached a verdict. A success-shaped response this
 * client could not verify, malformed JSON, an empty body, a row missing a
 * field the contract requires, is the other: the server answered 2xx, and the
 * row may already be committed. Neither is "not saved", and neither may be
 * retried blind without looking at the server's own list first.
 *
 * A failure the API itself reported is not in this set. A 409, a 422 or a 503
 * is an answer, not an unknown.
 */
const UNCONFIRMED_CODES: readonly ApiErrorCode[] = [
  'TIMEOUT',
  'ABORTED',
  'NETWORK_ERROR',
  'UNEXPECTED_RESPONSE',
]

/**
 * Statuses a gateway sends when it could not deliver or read an answer.
 *
 * The upstream POST may have committed before the gateway lost the response, so
 * an unreadable 502 or 504 says nothing about the row. It is not a verdict.
 */
const GATEWAY_STATUSES: readonly number[] = [502, 504]

export function isUnconfirmedWrite(error: ApiError): boolean {
  if (!UNCONFIRMED_CODES.includes(error.code)) {
    return false
  }

  // An unreadable response means the write's fate is unknown when the status
  // does not rule out a committed row: 2xx, the statusless failure the client
  // raises for a body it could not use, or a gateway that may have lost the
  // answer after the upstream handler ran.
  //
  // An unreadable status the API itself sent is different. A 503 is the service
  // reporting that it did not serve the request, and that stays a plain failure
  // with ordinary advice.
  if (error.code === 'UNEXPECTED_RESPONSE') {
    return (
      error.status === 0 ||
      (error.status >= 200 && error.status < 300) ||
      GATEWAY_STATUSES.includes(error.status)
    )
  }

  return true
}
