/**
 * The injected provider, read as untrusted input.
 *
 * A page cannot assume anything about `window.ethereum`. It may be absent, it
 * may be a browser extension that has been disabled mid-session, and it may be
 * an object put there by another script on the page. Everything this slice
 * consumes is therefore shape-checked before it is rendered: the provider is
 * inspected for the one method it must have, and every answer it gives is
 * parsed instead of trusted.
 *
 * Nothing here talks to the app backend, and nothing here holds a key. The
 * provider is a channel to whichever wallet the user installed; it signs
 * nothing in this slice and it is never asked to.
 */

/** The method-and-params shape EIP-1193 defines, narrowed to what is used. */
export type RequestArguments = {
  method: string
  params?: readonly unknown[]
}

/** What a listener receives. Providers are inconsistent, so this is unknown. */
export type ProviderListener = (payload: unknown) => void

/**
 * The parts of a provider this slice uses.
 *
 * `subscribe` and `unsubscribe` are the object's own listener methods, bound and
 * captured together. They are `null` when the object exposes neither, or only
 * one of them: a listener that cannot be removed would outlive the screen that
 * added it, so in that case none is added at all.
 */
export type InjectedProvider = {
  request: (args: RequestArguments) => Promise<unknown>
  subscribe: ((event: string, listener: ProviderListener) => void) | null
  unsubscribe: ((event: string, listener: ProviderListener) => void) | null
}

/** EIP-1193's code for a request the user declined in the wallet. */
export const USER_REJECTED_CODE = 4001

/** The code a wallet uses when it already has a request open for this site. */
export const REQUEST_PENDING_CODE = -32002

/**
 * Reads the injected provider from a scope, which is the window in the app.
 *
 * The scope is a parameter rather than a hard-coded `window` so that a test can
 * present the exact object it wants inspected, including the malformed ones.
 */
export function readInjectedProvider(scope: unknown): InjectedProvider | null {
  if (typeof scope !== 'object' || scope === null) {
    return null
  }

  const candidate = (scope as { ethereum?: unknown }).ethereum

  if (typeof candidate !== 'object' || candidate === null) {
    return null
  }

  const record = candidate as Record<string, unknown>
  const request = record.request

  if (typeof request !== 'function') {
    return null
  }

  const on = record.on
  const removeListener = record.removeListener ?? record.off

  // Both, or neither. A subscription this code could not remove is a leak, so a
  // provider missing the removal half is read as a provider with no events. It
  // still connects and still shows its account and chain; it simply reports
  // those from the moment it was read.
  const canListen = typeof on === 'function' && typeof removeListener === 'function'

  return {
    request: (args) => Promise.resolve(request.call(candidate, args) as Promise<unknown>),
    subscribe: canListen
      ? (event, listener) => {
          on.call(candidate, event, listener)
        }
      : null,
    unsubscribe: canListen
      ? (event, listener) => {
          removeListener.call(candidate, event, listener)
        }
      : null,
  }
}

/** An address as this slice accepts it: 0x and twenty bytes, nothing else. */
const ADDRESS = /^0x[0-9a-fA-F]{40}$/

/** A chain id as a provider sends it: a hex quantity, no padding rules. */
const CHAIN_ID = /^0x[0-9a-fA-F]{1,13}$/

/**
 * Reads an account list, or null when the answer is not one.
 *
 * All of it or none: a list holding one address and one object is a broken
 * answer, not a list with a usable entry, and taking the good one would mean
 * rendering something the provider did not actually say. An empty array is a
 * valid answer and means no account is connected.
 */
export function parseAccountList(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null
  }

  const accounts: string[] = []

  for (const entry of value) {
    if (typeof entry !== 'string' || !ADDRESS.test(entry)) {
      return null
    }

    accounts.push(entry)
  }

  return accounts
}

/**
 * Reads a chain id, or null when the answer is not one.
 *
 * A hex string is the documented form, and it is the only form accepted. Zero is
 * refused because no chain has that id and refusing it keeps a sentinel from
 * being displayed as a chain. The length is capped so the result is a safe
 * integer rather than a rounded float.
 */
export function parseChainId(value: unknown): number | null {
  if (typeof value !== 'string' || !CHAIN_ID.test(value)) {
    return null
  }

  const chainId = Number.parseInt(value.slice(2), 16)

  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    return null
  }

  return chainId
}

/** The error code a provider reported, when it reported one. */
export function providerErrorCode(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) {
    return null
  }

  const code = (error as { code?: unknown }).code

  return typeof code === 'number' && Number.isInteger(code) ? code : null
}

/**
 * A sentence for a provider failure that is safe to render.
 *
 * The provider's own message is not shown. It can carry internals, it is written
 * for a developer, and it is untrusted text from an extension this app does not
 * control. The code is enough to say what happened without repeating any of it.
 */
export function describeProviderFailure(error: unknown): string {
  const code = providerErrorCode(error)

  if (code === USER_REJECTED_CODE) {
    return 'The request was declined in the wallet.'
  }

  if (code === REQUEST_PENDING_CODE) {
    return 'The wallet already has a request open. Finish it there, then try again.'
  }

  if (code === null) {
    return 'The wallet could not complete the request.'
  }

  return `The wallet could not complete the request (code ${String(code)}).`
}
