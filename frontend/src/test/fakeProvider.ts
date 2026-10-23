import { vi } from 'vitest'

/**
 * A stand-in for an injected EIP-1193 provider.
 *
 * It is deliberately a plain object installed on `window.ethereum`, because that
 * is the thing the application reads: a test that handed the hook a tidier
 * interface would be testing an interface production code never sees.
 *
 * Every method call is recorded, every listener is kept, and every listener
 * removal is recorded too, so a test can count what was added against what was
 * taken away instead of assuming the cleanup ran.
 */

export type ProviderRequest = {
  method: string
  params?: readonly unknown[]
}

/** One request, as the fake recorded it, with its position in the sequence. */
export type ProviderCall = ProviderRequest & {
  /** 1 for the first request of the test, 2 for the next, and so on. */
  call: number
}

export type ProviderAnswer = (request: ProviderCall) => unknown

export type FakeProvider = {
  ethereum: Record<string, unknown>
  /** Every request the app made, in order, with its parameters. */
  calls: ProviderCall[]
  /** Methods requested, in order. */
  requested: string[]
  /** Events subscribed to, in order. */
  subscribed: string[]
  /** Events unsubscribed from, in order. */
  unsubscribed: string[]
  /** How many listeners are attached right now. */
  listenerCount: () => number
  /** Delivers an event to whoever is listening. */
  emit: (event: string, payload?: unknown) => void
  /** Removes `window.ethereum`. */
  remove: () => void
}

export type FakeProviderOptions = {
  /** Answers a request. Throw to reject it, return a promise to hold it. */
  answer?: ProviderAnswer
  /** Present by default; set false to model a provider with no events. */
  listeners?: boolean
}

const DEFAULT_ANSWER: ProviderAnswer = ({ method }) => {
  if (method === 'eth_accounts' || method === 'eth_requestAccounts') {
    return []
  }

  if (method === 'eth_chainId') {
    return '0x1'
  }

  throw new Error(`the fake provider does not answer ${method}`)
}

export function installFakeProvider(options: FakeProviderOptions = {}): FakeProvider {
  const answer = options.answer ?? DEFAULT_ANSWER
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const requested: string[] = []
  const calls: ProviderCall[] = []
  const subscribed: string[] = []
  const unsubscribed: string[] = []

  const ethereum: Record<string, unknown> = {
    request: vi.fn((request: ProviderRequest) => {
      requested.push(request.method)
      const call: ProviderCall = {
        method: request.method,
        ...(request.params === undefined ? {} : { params: request.params }),
        call: calls.length + 1,
      }
      calls.push(call)
      return Promise.resolve().then(() => answer(call))
    }),
  }

  if (options.listeners !== false) {
    ethereum.on = (event: string, listener: (payload: unknown) => void): void => {
      subscribed.push(event)
      const set = listeners.get(event) ?? new Set()
      set.add(listener)
      listeners.set(event, set)
    }

    ethereum.removeListener = (event: string, listener: (payload: unknown) => void): void => {
      unsubscribed.push(event)
      listeners.get(event)?.delete(listener)
    }
  }

  ;(window as { ethereum?: unknown }).ethereum = ethereum

  return {
    ethereum,
    calls,
    requested,
    subscribed,
    unsubscribed,
    listenerCount: () => {
      let total = 0
      for (const set of listeners.values()) {
        total += set.size
      }
      return total
    },
    emit: (event, payload) => {
      for (const listener of [...(listeners.get(event) ?? [])]) {
        listener(payload)
      }
    },
    remove: () => {
      delete (window as { ethereum?: unknown }).ethereum
    },
  }
}

/** Removes any provider a test installed, whether it finished or not. */
export function removeFakeProvider(): void {
  delete (window as { ethereum?: unknown }).ethereum
}

/**
 * A promise with its controls, for the answers that must arrive out of order.
 *
 * A provider is not obliged to answer in the order it was asked, and the case
 * this slice has to survive is exactly that: a slow answer from an older request
 * arriving after a newer one.
 */
export function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} {
  let resolve: (value: T) => void = () => undefined
  let reject: (reason: unknown) => void = () => undefined

  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })

  return { promise, resolve, reject }
}
