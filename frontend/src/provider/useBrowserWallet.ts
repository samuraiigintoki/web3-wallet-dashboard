import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  describeProviderFailure,
  parseAccountList,
  parseChainId,
  providerErrorCode,
  readInjectedProvider,
  USER_REJECTED_CODE,
  type InjectedProvider,
} from './injected.ts'

/**
 * What the browser wallet is doing right now.
 *
 * `connected` carries the account and the chain the provider reported. It says
 * nothing about whether this app supports that chain, and nothing about whether
 * any saved wallet in the dashboard has the same address: both are separate
 * questions, asked by the screen that has the facts for them.
 */
export type BrowserWalletState =
  /** The quiet read at load, which never prompts. */
  | { status: 'checking' }
  /** No injected provider on this page. */
  | { status: 'unsupported' }
  | { status: 'disconnected'; notice: string | null }
  | { status: 'connecting' }
  | { status: 'connected'; account: string; chainId: number }
  | { status: 'error'; message: string }

const UNREADABLE_ACCOUNTS =
  'The wallet answered with something that is not a list of addresses.'

const UNREADABLE_CHAIN = 'The wallet answered with something that is not a chain id.'

/**
 * The browser wallet's account and chain, as the provider currently reports
 * them.
 *
 * Three rules hold this together.
 *
 * Nothing here prompts on its own. The read at load is `eth_accounts`, which
 * asks the provider what it has already granted, and only an explicit
 * `connect()` calls `eth_requestAccounts`. A page that prompts on load is a page
 * that trains its user to approve popups.
 *
 * Every answer is checked before it is rendered. Accounts and chain ids arrive
 * from an extension, so they are parsed, and a shape this code does not
 * recognise becomes a stated error rather than a guess.
 *
 * Every answer is also checked against the attempt that asked for it. A newer
 * event, a newer connect or a disconnect retires what is in flight, so a slow
 * `eth_chainId` from before an account change cannot land on top of the newer
 * state. This is the same lifetime rule the wallet screens use, applied to a
 * source that can answer in any order.
 */
export function useBrowserWallet(scope: unknown = globalThis): {
  state: BrowserWalletState
  connect: () => Promise<void>
} {
  const provider = useMemo(() => readInjectedProvider(scope), [scope])

  /**
   * The first state is decided during render, not in an effect.
   *
   * Whether a provider exists is a fact about the page that is true before
   * anything runs, so the screen can say so on its first paint instead of
   * showing a spinner for one frame. `checking` is what is left when there is a
   * provider to ask.
   */
  const [state, setState] = useState<BrowserWalletState>(() =>
    readInjectedProvider(scope) === null ? { status: 'unsupported' } : { status: 'checking' },
  )

  /** Which attempt the visible state belongs to. */
  const attemptRef = useRef(0)
  const mountedRef = useRef(true)
  const connectingRef = useRef(false)
  const providerRef = useRef<InjectedProvider | null>(provider)

  useEffect(() => {
    providerRef.current = provider
  }, [provider])

  /**
   * Applies an answer only if it is still the newest one and the screen exists.
   *
   * Anything else is a late answer to a question that has been superseded, and
   * the only correct thing to do with it is nothing.
   */
  const apply = useCallback(
    (
      attempt: number,
      next: BrowserWalletState | ((current: BrowserWalletState) => BrowserWalletState),
    ): void => {
      if (!mountedRef.current || attemptRef.current !== attempt) {
        return
      }

      setState((current) => (typeof next === 'function' ? next(current) : next))
    },
    [],
  )

  /** Retires whatever is in flight by moving the attempt on. */
  const retire = useCallback((): void => {
    attemptRef.current += 1
  }, [])

  /**
   * The quiet read at load.
   *
   * `eth_accounts` is the permission-preserving half of the pair: it returns an
   * empty list for a site the user has not connected, and it never opens the
   * wallet. The chain is read only when there is an account to describe.
   */
  useEffect(() => {
    mountedRef.current = true

    if (provider === null) {
      // Already presented as unsupported by the initial state above.
      return undefined
    }

    const live = provider
    const attempt = attemptRef.current + 1
    attemptRef.current = attempt

    void (async () => {
      let accounts: string[] | null

      try {
        accounts = parseAccountList(await live.request({ method: 'eth_accounts' }))
      } catch (error) {
        apply(attempt, { status: 'error', message: describeProviderFailure(error) })
        return
      }

      if (accounts === null) {
        apply(attempt, { status: 'error', message: UNREADABLE_ACCOUNTS })
        return
      }

      if (accounts.length === 0) {
        apply(attempt, { status: 'disconnected', notice: null })
        return
      }

      let chainId: number | null

      try {
        chainId = parseChainId(await live.request({ method: 'eth_chainId' }))
      } catch (error) {
        apply(attempt, { status: 'error', message: describeProviderFailure(error) })
        return
      }

      if (chainId === null) {
        apply(attempt, { status: 'error', message: UNREADABLE_CHAIN })
        return
      }

      apply(attempt, { status: 'connected', account: accounts[0]!, chainId })
    })()

    return () => {
      // Teardown retires the read as well as the screen: an answer that arrives
      // after unmount has nobody it is allowed to settle.
      mountedRef.current = false
      retire()
    }
  }, [apply, provider, retire])

  /**
   * An account change, which may also carry a chain change with it.
   *
   * The chain is read again rather than carried over. A wallet can switch both
   * at once, and the chain that belonged to the old account is a stale fact the
   * moment the account moves.
   */
  const handleAccountsChanged = useCallback(
    (payload: unknown): void => {
      const live = providerRef.current

      if (live === null) {
        return
      }

      const attempt = attemptRef.current + 1
      attemptRef.current = attempt

      const accounts = parseAccountList(payload)

      if (accounts === null) {
        apply(attempt, { status: 'error', message: UNREADABLE_ACCOUNTS })
        return
      }

      if (accounts.length === 0) {
        // The connected account is gone. Saying so is the whole answer; there is
        // no chain left to describe.
        apply(attempt, {
          status: 'disconnected',
          notice: 'The wallet reported no connected account.',
        })
        return
      }

      void (async () => {
        let chainId: number | null

        try {
          chainId = parseChainId(await live.request({ method: 'eth_chainId' }))
        } catch (error) {
          apply(attempt, { status: 'error', message: describeProviderFailure(error) })
          return
        }

        if (chainId === null) {
          apply(attempt, { status: 'error', message: UNREADABLE_CHAIN })
          return
        }

        apply(attempt, { status: 'connected', account: accounts[0]!, chainId })
      })()
    },
    [apply],
  )

  /**
   * A chain change.
   *
   * The account is kept, because a chain change is not an account change, and
   * the event carries only the new chain id. When nothing is connected the event
   * is not a connection: the state stays disconnected.
   */
  const handleChainChanged = useCallback(
    (payload: unknown): void => {
      const attempt = attemptRef.current + 1
      attemptRef.current = attempt

      const chainId = parseChainId(payload)

      if (chainId === null) {
        apply(attempt, { status: 'error', message: UNREADABLE_CHAIN })
        return
      }

      apply(attempt, (current) =>
        current.status === 'connected' ? { ...current, chainId } : current,
      )
    },
    [apply],
  )

  /** The provider's own disconnect, which is accurate news and is reported. */
  const handleDisconnect = useCallback((): void => {
    const attempt = attemptRef.current + 1
    attemptRef.current = attempt

    apply(attempt, {
      status: 'disconnected',
      notice: 'The wallet disconnected.',
    })
  }, [apply])

  /**
   * Listens while the screen exists, and only once.
   *
   * The handlers are captured in this effect and removed in its cleanup, which
   * is the same pair: a provider that keeps a listener after the screen is gone
   * would keep answering into an unmounted component. A provider without a
   * removable listener is not subscribed to at all, which `readInjectedProvider`
   * has already decided.
   */
  useEffect(() => {
    if (provider === null || provider.subscribe === null || provider.unsubscribe === null) {
      return undefined
    }

    const subscribe = provider.subscribe
    const unsubscribe = provider.unsubscribe

    const onAccounts = (payload: unknown): void => {
      handleAccountsChanged(payload)
    }

    const onChain = (payload: unknown): void => {
      handleChainChanged(payload)
    }

    const onDisconnect = (): void => {
      handleDisconnect()
    }

    subscribe('accountsChanged', onAccounts)
    subscribe('chainChanged', onChain)
    subscribe('disconnect', onDisconnect)

    return () => {
      unsubscribe('accountsChanged', onAccounts)
      unsubscribe('chainChanged', onChain)
      unsubscribe('disconnect', onDisconnect)
      retire()
    }
  }, [handleAccountsChanged, handleChainChanged, handleDisconnect, provider, retire])

  /**
   * Asks the wallet for access. This is the only call that may prompt, and the
   * only caller is the button.
   *
   * A second click while the first is outstanding is refused here as well as by
   * the disabled button, because two permission prompts stacked on one another
   * is the kind of thing a user approves by accident.
   */
  const connect = useCallback(async (): Promise<void> => {
    const live = providerRef.current

    if (live === null || connectingRef.current) {
      return
    }

    connectingRef.current = true

    const attempt = attemptRef.current + 1
    attemptRef.current = attempt

    apply(attempt, { status: 'connecting' })

    try {
      let accounts: string[] | null

      try {
        accounts = parseAccountList(await live.request({ method: 'eth_requestAccounts' }))
      } catch (error) {
        if (providerErrorCode(error) === USER_REJECTED_CODE) {
          // A refusal, not a failure. The state it returns to is the one it came
          // from: nothing is connected and nothing was granted.
          apply(attempt, {
            status: 'disconnected',
            notice: 'The connection request was declined in the wallet.',
          })
          return
        }

        apply(attempt, { status: 'error', message: describeProviderFailure(error) })
        return
      }

      if (accounts === null) {
        apply(attempt, { status: 'error', message: UNREADABLE_ACCOUNTS })
        return
      }

      if (accounts.length === 0) {
        apply(attempt, {
          status: 'disconnected',
          notice: 'The wallet returned no account, so nothing is connected.',
        })
        return
      }

      let chainId: number | null

      try {
        chainId = parseChainId(await live.request({ method: 'eth_chainId' }))
      } catch (error) {
        apply(attempt, { status: 'error', message: describeProviderFailure(error) })
        return
      }

      if (chainId === null) {
        apply(attempt, { status: 'error', message: UNREADABLE_CHAIN })
        return
      }

      apply(attempt, { status: 'connected', account: accounts[0]!, chainId })
    } finally {
      connectingRef.current = false
    }
  }, [apply])

  return { state, connect }
}
