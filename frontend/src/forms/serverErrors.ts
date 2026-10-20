import { isApiError } from '../api/index.ts'

export type AuthFormField = 'email' | 'password'

/** The fields the create form renders, in the order they appear. */
export type WalletFormField = 'address' | 'chainId' | 'label'

const AUTH_FIELDS: readonly AuthFormField[] = ['email', 'password']

const WALLET_FIELDS: readonly WalletFormField[] = ['address', 'chainId', 'label']

/**
 * Picks the detail entries a form can actually show.
 *
 * A 422 names the field it rejected, so the message belongs next to that input
 * rather than in a form-level banner the user has to map back to a box
 * themselves. Details for anything the form does not render are dropped: they
 * are real, and they stay available to the caller's generic message, but there
 * is no input to put them under.
 */
function pick<F extends string>(
  error: unknown,
  fields: readonly F[],
): Partial<Record<F, string>> {
  if (!isApiError(error) || error.code !== 'VALIDATION_ERROR') {
    return {}
  }

  const details = error.details
  if (details === undefined) {
    return {}
  }

  const result: Partial<Record<F, string>> = {}
  for (const field of fields) {
    const message = details[field]
    if (typeof message === 'string' && message !== '') {
      result[field] = message
    }
  }

  return result
}

export function fieldErrorsFrom(error: unknown): Partial<Record<AuthFormField, string>> {
  return pick(error, AUTH_FIELDS)
}

/**
 * Wallet create has its own field names, and the existing mapper only knows
 * email and password.
 *
 * The server sends `chainId` as the key, in Go's spelling, so the lookup is
 * case sensitive on purpose. A key in another spelling is not this form's
 * field, and silently folding the case would attach a message to the wrong
 * input.
 */
export function walletFieldErrorsFrom(
  error: unknown,
): Partial<Record<WalletFormField, string>> {
  return pick(error, WALLET_FIELDS)
}
