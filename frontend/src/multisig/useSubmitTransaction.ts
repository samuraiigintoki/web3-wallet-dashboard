import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  describeProviderFailure,
  parseAccountList,
  parseChainId,
  providerErrorCode,
  readInjectedProvider,
  USER_REJECTED_CODE,
} from '../provider/injected.ts'
import {
  buildSubmission,
  parseTransactionHash,
  type SubmitDraft,
  type SubmitField,
  type SubmitFieldErrors,
  type SubmitRequest,
} from './encoding.ts'

/** What the catalog says about the chain the contract is on. */
export type CatalogFact = 'listed' | 'loading' | 'failed' | 'unlisted'

/** The tracked record the transaction is addressed to, as far as this needs it. */
export type SubmitTarget = {
  id: number
  address: string
  chainId: number
}

/**
 * Where the submission is.
 *
 * `submitted` carries the hash the wallet returned and nothing else: it is not a
 * receipt, and every phase name here is about this app's own bookkeeping, never
 * about the chain.
 */
export type SubmitPhase =
  | { kind: 'editing' }
  | { kind: 'confirming'; request: SubmitRequest }
  | { kind: 'sending'; request: SubmitRequest }
  | { kind: 'submitted'; request: SubmitRequest; hash: string }
  | { kind: 'failed'; request: SubmitRequest; message: string; declined: boolean }

/** Whether this screen may send, and why not when it may not. */
export type SubmitGate = { open: boolean; reason: string }

export type UseSubmitTransactionOptions = {
  /** The tracked contract the page is showing, or null before it has loaded. */
  contract: SubmitTarget | null
  /** The account the browser wallet reports, or null when none is connected. */
  account: string | null
  /** The chain the browser wallet reports, or null when none is connected. */
  chainId: number | null
  /** What the catalog says about the contract's chain. */
  catalog: CatalogFact
  /** The scope the injected provider is read from. The window, in the app. */
  scope?: unknown
}

const UNREADABLE_ACCOUNTS =
  'The wallet answered with something that is not a list of addresses, so nothing was sent.'

const UNREADABLE_CHAIN =
  'The wallet answered with something that is not a chain id, so nothing was sent.'

const CHANGED_ACCOUNT = 'The wallet is now on a different account, so nothing was sent.'

const MISSING_HASH =
  'The wallet did not answer with a transaction hash, so this app cannot say whether the transaction was submitted.'

const DECLINED = 'The transaction was declined in the wallet.'

/**
 * The gate: the one condition under which this screen offers to send.
 *
 * Three separate facts have to hold, and each failure has its own sentence
 * because they are not the same thing: no account is a wallet question, a chain
 * that is not the contract's chain is a mismatch, and a chain the catalog does
 * not list is a limit of this deployment. `indexingStatus` appears nowhere: it
 * describes whether the indexer has caught up with a contract, which says
 * nothing about whether a transaction can be submitted to it.
 */
export function submitGate(
  contract: SubmitTarget | null,
  account: string | null,
  chainId: number | null,
  catalog: CatalogFact,
): SubmitGate {
  if (contract === null) {
    return { open: false, reason: 'No tracked contract is loaded.' }
  }

  if (account === null || chainId === null) {
    return { open: false, reason: 'No connected account.' }
  }

  if (chainId !== contract.chainId) {
    return {
      open: false,
      reason: `The wallet is on chain ${String(chainId)}, and this contract is on chain ${String(
        contract.chainId,
      )}.`,
    }
  }

  switch (catalog) {
    case 'listed':
      return { open: true, reason: '' }
    case 'loading':
      return { open: false, reason: 'The chain catalog is still being read.' }
    case 'failed':
      return { open: false, reason: 'The chain catalog could not be read.' }
    case 'unlisted':
      return {
        open: false,
        reason: `This app's chain catalog does not list chain ${String(contract.chainId)}.`,
      }
  }
}

/**
 * One submission: a form, a confirmation, one call to the wallet.
 *
 * The rules this holds to, and what would break without each of them:
 *
 * - The wallet is prompted only after the user has read back the contract, the
 *   chain, the destination, the exact value and the calldata. `review()` builds
 *   the encoded call first; `submit()` is only reachable from the confirmation.
 * - The account and the chain are read again from the provider immediately
 *   before dispatch, and a change between the confirmation and the send aborts
 *   with a sentence rather than signing for a context the user did not see.
 *   `eth_sendTransaction` is not called on that path at all.
 * - Every phase is stamped with the account, the chain and the contract, and a
 *   phase whose stamp is not current is not drawn. An answer that lands after an
 *   account change, a chain change, a navigation away or a newer submission
 *   therefore describes a situation this screen has lost sight of, and the only
 *   thing done with it is nothing.
 * - A send in flight cannot be dispatched twice: the controls are disabled, and
 *   a ref makes a second call impossible even if a way to make one appeared.
 * - Nothing is retried. A failure is reported and waits for the user.
 *
 * The connected account is the sender, and that is all it is. It is never
 * compared with saved wallet records, and submitting does not prove that this
 * account owns the multisig or is one of its owners.
 */
export function useSubmitTransaction({
  contract,
  account,
  chainId,
  catalog,
  scope = globalThis,
}: UseSubmitTransactionOptions): {
  draft: SubmitDraft
  errors: SubmitFieldErrors
  phase: SubmitPhase
  gate: SubmitGate
  setField: (field: SubmitField, value: string) => void
  review: () => boolean
  cancel: () => void
  submit: () => Promise<void>
  back: () => void
  startAnother: () => void
} {
  const provider = useMemo(() => readInjectedProvider(scope), [scope])

  const [draft, setDraft] = useState<SubmitDraft>({
    destination: '',
    valueWei: '',
    data: '',
  })

  const [errors, setErrors] = useState<SubmitFieldErrors>({})

  /**
   * The phase and the identity it belongs to, together.
   *
   * Keeping the stamp beside the phase rather than inside each branch means a
   * branch cannot be added later without one: the type makes the stamp part of
   * every stored value.
   */
  const [stored, setStored] = useState<{ stamp: string; phase: SubmitPhase } | null>(null)

  const mountedRef = useRef(true)
  const attemptRef = useRef(0)
  const sendingRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true

    return () => {
      mountedRef.current = false
      attemptRef.current += 1
    }
  }, [])

  const gate = useMemo(
    () => submitGate(contract, account, chainId, catalog),
    [account, catalog, chainId, contract],
  )

  /**
   * The context every phase belongs to.
   *
   * The account is compared case-insensitively because a wallet may report the
   * same account in either case, and a case difference is not an account change.
   * Null when there is nothing to send from, which no stored phase can match.
   */
  const stamp =
    contract === null || account === null || chainId === null
      ? null
      : `${account.toLowerCase()}:${String(chainId)}:${String(contract.id)}:${contract.address.toLowerCase()}`

  /**
   * A context change clears what the old context produced.
   *
   * Not showing a phase is not the same as forgetting it. Without this, a wallet
   * that moves to another account and back again would bring an earlier
   * submission's hash back on screen with nothing having been pressed, which is a
   * result attached to an action nobody just took. The reset is done during
   * render, like the gate counter, so no frame shows the old phase under the new
   * identity.
   */
  const [lastStamp, setLastStamp] = useState<string | null>(stamp)

  if (lastStamp !== stamp) {
    setLastStamp(stamp)
    setStored(null)
  }

  // A phase whose context is gone is not shown either, and not returned to: the
  // context it belonged to may never come back, and if it does the user should
  // confirm again rather than find an old outcome waiting.
  const phase: SubmitPhase =
    stored !== null && stamp !== null && stored.stamp === stamp
      ? stored.phase
      : { kind: 'editing' }

  const setField = useCallback((field: SubmitField, value: string): void => {
    setDraft((current) => ({ ...current, [field]: value }))
  }, [])

  /** Validates the form and moves to the confirmation. Prompts nothing. */
  const review = useCallback((): boolean => {
    if (contract === null || stamp === null || !gate.open) {
      return false
    }

    const built = buildSubmission(contract.address, draft)

    if (!built.ok) {
      setErrors(built.errors)
      return false
    }

    setErrors({})
    setStored({ stamp, phase: { kind: 'confirming', request: built.request } })
    return true
  }, [contract, draft, gate.open, stamp])

  /** Leaves the confirmation. Sends nothing, and retires anything in flight. */
  const cancel = useCallback((): void => {
    if (sendingRef.current) {
      return
    }

    attemptRef.current += 1
    setStored(null)
  }, [])

  /** Goes back to the form after a failure, keeping what was typed. */
  const back = useCallback((): void => {
    if (sendingRef.current) {
      return
    }

    setStored(null)
  }, [])

  /** Clears everything after a successful submission. */
  const startAnother = useCallback((): void => {
    if (sendingRef.current) {
      return
    }

    setStored(null)
    setErrors({})
    setDraft({ destination: '', valueWei: '', data: '' })
  }, [])

  /**
   * Opens the wallet for the submission the user confirmed.
   *
   * Everything before the `eth_sendTransaction` call is a re-check of facts that
   * were true when the confirmation was drawn: the same account, the same chain,
   * a chain this deployment lists. A re-check that fails returns without
   * dispatching, because the user agreed to a transaction in a context that no
   * longer exists.
   */
  const submit = useCallback(async (): Promise<void> => {
    const live = provider

    if (
      live === null ||
      contract === null ||
      account === null ||
      chainId === null ||
      stamp === null ||
      !gate.open
    ) {
      return
    }

    if (sendingRef.current) {
      return
    }

    if (stored === null || stored.phase.kind !== 'confirming' || stored.stamp !== stamp) {
      return
    }

    const request = stored.phase.request
    const expectedAccount = account.toLowerCase()
    const expectedChain = contract.chainId
    const sendStamp = stamp

    const attempt = attemptRef.current + 1
    attemptRef.current = attempt
    sendingRef.current = true

    /** False once this attempt has been superseded or the screen has gone. */
    const current = (): boolean => attemptRef.current === attempt && mountedRef.current

    const settle = (next: SubmitPhase): void => {
      if (current()) {
        setStored({ stamp: sendStamp, phase: next })
      }
    }

    const fail = (message: string, declined = false): void => {
      settle({ kind: 'failed', request, message, declined })
    }

    setStored({ stamp: sendStamp, phase: { kind: 'sending', request } })

    try {
      let accounts: string[] | null
      let liveChain: number | null

      try {
        accounts = parseAccountList(await live.request({ method: 'eth_accounts' }))
        if (!current()) {
          return
        }

        liveChain = parseChainId(await live.request({ method: 'eth_chainId' }))
      } catch (error) {
        fail(describeProviderFailure(error))
        return
      }

      if (!current()) {
        return
      }

      if (accounts === null) {
        fail(UNREADABLE_ACCOUNTS)
        return
      }

      if (accounts.length === 0) {
        fail('The wallet reported no connected account, so nothing was sent.')
        return
      }

      const sender = accounts[0]!

      if (sender.toLowerCase() !== expectedAccount) {
        fail(CHANGED_ACCOUNT)
        return
      }

      if (liveChain === null) {
        fail(UNREADABLE_CHAIN)
        return
      }

      if (liveChain !== expectedChain) {
        fail(
          `The wallet is now on chain ${String(liveChain)}, and this contract is on chain ${String(
            expectedChain,
          )}, so nothing was sent.`,
        )
        return
      }

      let answer: unknown

      try {
        // The one write in this slice, and the only request in the app that can
        // move value. `to` is the tracked contract, `value` is zero, and the
        // proposal travels inside `data`.
        answer = await live.request({
          method: 'eth_sendTransaction',
          params: [
            {
              from: sender,
              to: request.to,
              value: request.value,
              data: request.data,
            },
          ],
        })
      } catch (error) {
        const declined = providerErrorCode(error) === USER_REJECTED_CODE

        // A refusal is reported as a refusal, in the app's own words, and never
        // as proof that the wallet did nothing: the extension decides that.
        fail(declined ? DECLINED : describeProviderFailure(error), declined)
        return
      }

      if (!current()) {
        return
      }

      const hash = parseTransactionHash(answer)

      if (hash === null) {
        fail(MISSING_HASH)
        return
      }

      settle({ kind: 'submitted', request, hash })
    } finally {
      sendingRef.current = false
    }
  }, [account, chainId, contract, gate.open, provider, stamp, stored])

  return {
    draft,
    errors,
    phase,
    gate,
    setField,
    review,
    cancel,
    submit,
    back,
    startAnother,
  }
}
