import { isApiError } from '../api/index.ts'

export type AuthFormField = 'email' | 'password'

const FIELDS: readonly AuthFormField[] = ['email', 'password']

/**
 * A 422 names the field it rejected, so the message belongs next to that
 * input rather than in a form-level banner the user has to map back to a box
 * themselves. Details for anything the form does not render are left to the
 * caller's generic message.
 */
export function fieldErrorsFrom(error: unknown): Partial<Record<AuthFormField, string>> {
  if (!isApiError(error) || error.code !== 'VALIDATION_ERROR') {
    return {}
  }

  const details = error.details
  if (details === undefined) {
    return {}
  }

  const result: Partial<Record<AuthFormField, string>> = {}
  for (const field of FIELDS) {
    const message = details[field]
    if (typeof message === 'string' && message !== '') {
      result[field] = message
    }
  }

  return result
}
