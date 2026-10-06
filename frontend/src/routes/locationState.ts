import { isRecord } from '../api/guards.ts'

/**
 * Router state the application sets for itself.
 *
 * The post-login return path travels here rather than in a query parameter,
 * so a link cannot be crafted that sends someone somewhere after they sign in.
 */
export type AppLocationState = {
  /** Path the guard turned away, to return to after signing in. */
  from?: string
  /** One-time message, for example after registering. */
  notice?: string
  /** Email to prefill. Never a password. */
  email?: string
}

export function readLocationState(state: unknown): AppLocationState {
  if (!isRecord(state)) {
    return {}
  }

  const result: AppLocationState = {}

  // Only a same-origin path is ever honoured, so state that somehow carried an
  // absolute URL cannot become a redirect off this origin.
  if (
    typeof state.from === 'string' &&
    state.from.startsWith('/') &&
    !state.from.startsWith('//')
  ) {
    result.from = state.from
  }

  if (typeof state.notice === 'string') {
    result.notice = state.notice
  }

  if (typeof state.email === 'string') {
    result.email = state.email
  }

  return result
}
