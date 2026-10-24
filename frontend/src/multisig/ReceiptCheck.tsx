import { useCallback, useRef, useState } from 'react'

import type { BrowserWalletState } from '../provider/useBrowserWallet.ts'
import {
  findConfirmation,
  findExecution,
  findRevocation,
  findSubmittedTransaction,
  type RefreshedPage,
} from './events.ts'
import { useTransactionReceipt, type ReceiptState } from './useTransactionReceipt.ts'
import type { SubmitTarget } from './useSubmitTransaction.ts'

/**
 * What the manual event refresh found.
 *
 * Three outcomes, and the middle one is the point: a hash that is not on the
 * refreshed page is not an event that never happened. The message says where it
 * looked and what it cannot tell apart, and stops there.
 */
type EventsCheck =
  | { kind: 'idle' }
  | { kind: 'refreshing' }
  | { kind: 'found'; blockNumber: number }
  | { kind: 'not-shown'; page: number }
  | { kind: 'failed' }

/**
 * What the checked transaction was for, which decides what its receipt means and
 * which stored event would answer for it.
 *
 * A submission's success means the multisig accepted a proposal. A confirmation's
 * success means one owner's confirmation was recorded, which is a smaller fact
 * still: it says nothing about the threshold being reached. The two are worded
 * apart rather than parameterised into one sentence, because merging them would be
 * exactly the confusion this slice is built to avoid.
 */
export type ReceiptPurpose =
  | { kind: 'submit' }
  /** The index confirmed, and the account whose confirmation it was. */
  | { kind: 'confirm'; index: string; actor: string }
  /** The index revoked, and the account whose confirmation was removed. */
  | { kind: 'revoke'; index: string; actor: string }
  /** The index executed, and the account that executed it. */
  | { kind: 'execute'; index: string; actor: string }

export type ReceiptCheckProps = {
  /** The hash the wallet returned, in memory for this screen only. */
  hash: string
  /** The tracked contract the transaction was addressed to. */
  contract: SubmitTarget
  /** Whether this was a submission or a confirmation. */
  purpose: ReceiptPurpose
  /** The browser wallet, for its state as well as its account and chain. */
  wallet: BrowserWalletState
  /**
   * Reads the current page of indexed events again, under the signed-in
   * identity. Returns what came back, or null when the read produced no page.
   */
  onRefreshEvents: () => Promise<RefreshedPage | null>
}

/**
 * The receipt of one submitted transaction, and a separate check of the index.
 *
 * The two are deliberately two actions and two statements. A transaction can be
 * included and not yet indexed, indexed and not yet confirmed by the owners, or
 * confirmed and not yet executed: the chain and the index are different facts
 * about the same proposal, and a screen that merged them would let one stand in
 * for the other.
 *
 * Everything here is user-triggered. There is no timer, no retry and no refresh
 * on render, so nothing is requested while the user is not looking and no answer
 * appears that they did not ask for. Both result sentences live in regions marked
 * `aria-live="polite"`, so a screen reader hears the outcome when it arrives, and
 * the regions are single stable elements, so an unrelated render does not repeat
 * what they already say.
 */
export function ReceiptCheck({
  hash,
  contract,
  purpose,
  wallet,
  onRefreshEvents,
}: ReceiptCheckProps) {
  const receipt = useTransactionReceipt({ hash, contract, wallet })

  const [eventsCheck, setEventsCheck] = useState<EventsCheck>({ kind: 'idle' })
  const refreshingRef = useRef(false)

  /**
   * A new receipt answer retires what the last refresh said.
   *
   * A found event and a successful receipt are statements about a moment, and
   * re-checking the receipt starts a new one. Keeping the old claim next to the
   * new answer would present a stale match as if it belonged to this check.
   */
  const receiptKey =
    receipt.state.kind === 'included'
      ? `${receipt.state.blockHash}:${String(receipt.state.success)}`
      : receipt.state.kind

  const [lastReceiptKey, setLastReceiptKey] = useState(receiptKey)

  if (lastReceiptKey !== receiptKey) {
    setLastReceiptKey(receiptKey)
    setEventsCheck({ kind: 'idle' })
  }

  const refresh = useCallback(async (): Promise<void> => {
    if (refreshingRef.current) {
      return
    }

    refreshingRef.current = true
    setEventsCheck({ kind: 'refreshing' })

    try {
      let page: RefreshedPage | null

      try {
        page = await onRefreshEvents()
      } catch {
        setEventsCheck({ kind: 'failed' })
        return
      }

      if (page === null) {
        setEventsCheck({ kind: 'failed' })
        return
      }

      // The match depends on what was sent: a submission is found by its hash,
      // a confirmation by its hash, its index and the account that made it.
      const match =
        purpose.kind === 'submit'
          ? findSubmittedTransaction(hash, page.events)
          : purpose.kind === 'confirm'
            ? findConfirmation(hash, purpose.index, purpose.actor, page.events)
            : purpose.kind === 'revoke'
              ? findRevocation(hash, purpose.index, purpose.actor, page.events)
              : findExecution(hash, purpose.index, purpose.actor, page.events)

      setEventsCheck(
        match === null
          ? { kind: 'not-shown', page: page.page }
          : { kind: 'found', blockNumber: match.blockNumber },
      )
    } finally {
      refreshingRef.current = false
    }
  }, [hash, onRefreshEvents, purpose])

  const state = receipt.state
  const checking = state.kind === 'checking'

  // Narrowed through a local so the type carries into the JSX below, rather than
  // a boolean that describes a check the compiler cannot follow.
  const included = state.kind === 'included' ? state : null
  const succeeded = included !== null && included.success

  return (
    <section className="status" aria-labelledby="receipt-heading">
      <h3 id="receipt-heading">Receipt</h3>

      <p aria-live="polite" aria-atomic="true">
        <ReceiptSentence state={receipt.state} gateReason={receipt.gate.reason} />
      </p>

      {included !== null && (
        <p className="hint">
          {succeeded
            ? successNote(purpose)
            : revertNote(purpose)}
        </p>
      )}

      <div className="status__actions">
        <button type="button" onClick={() => void receipt.check()} disabled={checking || !receipt.gate.available}>
          {receipt.state.kind === 'idle' ? 'Check receipt' : 'Check receipt again'}
        </button>
      </div>

      {succeeded && (
        <EventCheck
          eventsCheck={eventsCheck}
          purpose={purpose}
          onRefresh={() => void refresh()}
        />
      )}
    </section>
  )
}

/**
 * What a success does not mean, per purpose.
 *
 * Both sentences end in the same admission, that a later check can differ, and
 * both refuse the reading a user is most likely to want: that a receipt is a
 * finished proposal.
 */
function successNote(purpose: ReceiptPurpose): string {
  switch (purpose.kind) {
    case 'submit':
      return 'A successful receipt means the multisig accepted this submission call. It does not mean the owners have confirmed or executed the proposal, that the event has been indexed, or that the block is final. Asking again later can give a different answer.'
    case 'confirm':
      return 'A successful receipt means this account\'s confirmation was recorded by the contract. It does not mean the proposal reached its threshold or was executed, that the confirmation event has been indexed, or that the block is final. Asking again later can give a different answer.'
    case 'revoke':
      return 'A successful receipt means this account\'s confirmation was removed by the contract. It does not mean the proposal was executed or cancelled, that the revocation event has been indexed, or that the block is final. Asking again later can give a different answer.'
    case 'execute':
      return 'A successful receipt means the contract ran this proposal\'s call and the call did not revert. It does not mean the effects you expect happened, that the execution event has been indexed, or that the block is final. Asking again later can give a different answer.'
  }
}

/** What a revert leaves behind, per purpose. */
function revertNote(purpose: ReceiptPurpose): string {
  switch (purpose.kind) {
    case 'submit':
      return 'A reverted call did not submit the proposal, and the wallet may still have charged a fee for it. This app cannot tell you why it reverted, and asking again later can give a different answer.'
    case 'confirm':
      return 'A reverted call did not record this confirmation, and the wallet may still have charged a fee for it. The proposal itself is unchanged by a failed confirmation, and this app cannot tell you why it reverted.'
    case 'revoke':
      return 'A reverted call did not remove this confirmation, and the wallet may still have charged a fee for it. This confirmation is still recorded, and this app cannot tell you why it reverted.'
    case 'execute':
      return 'A reverted call did not execute this proposal, and the wallet may still have charged a fee for it. The contract reports no reason, and what the destination did before reverting is not something this app can see.'
  }
}

function EventCheck({
  eventsCheck,
  purpose,
  onRefresh,
}: {
  eventsCheck: EventsCheck
  purpose: ReceiptPurpose
  onRefresh: () => void
}) {
  return (
    <>
      <h4>Indexed events</h4>

      <p aria-live="polite" aria-atomic="true">
        <EventsSentence check={eventsCheck} purpose={purpose} />
      </p>

      <div className="status__actions">
        <button
          type="button"
          onClick={onRefresh}
          disabled={eventsCheck.kind === 'refreshing'}
        >
          Refresh indexed events
        </button>
      </div>
    </>
  )
}

/**
 * The receipt, in the words that fit what is actually known.
 *
 * `none` is spelled out as a state rather than as a failure, because a pending
 * transaction and a missing one answer the same way and a user who read that as
 * "dropped" would resubmit a proposal that is already in the mempool. The two
 * included cases are kept apart for the same reason: a revert is a definite
 * outcome that still leaves the wallet's fee in place.
 */
function ReceiptSentence({ state, gateReason }: { state: ReceiptState; gateReason: string }) {
  switch (state.kind) {
    case 'idle':
      return (
        <>
          No receipt has been checked.
          {gateReason === '' ? null : <span className="hint"> {gateReason}</span>}
        </>
      )
    case 'checking':
      return <>Checking the receipt.</>
    case 'none':
      return (
        <>
          The wallet has no receipt for this transaction right now. That is not a
          failure, and it is not proof the transaction was dropped: a transaction
          that is still pending gives the same answer.
        </>
      )
    case 'included':
      return state.success ? (
        <>
          {`The transaction is included in block ${state.blockNumber}, and the call did not revert.`}
        </>
      ) : (
        <>
          {`The transaction is included in block ${state.blockNumber}, and the call reverted.`}
        </>
      )
    case 'error':
      return <>{state.message}</>
  }
}

/**
 * The index, in the only three things this app can honestly say about it.
 *
 * A match names the block it sits in and nothing more. No match says which page
 * was read and lists the reasons the event could be absent, because the one thing
 * the screen must never imply is that the contract emitted nothing.
 */
function EventsSentence({ check, purpose }: { check: EventsCheck; purpose: ReceiptPurpose }) {
  switch (check.kind) {
    case 'idle':
      return <>The indexed events have not been refreshed for this transaction.</>
    case 'refreshing':
      return <>Reading the current page of indexed events.</>
    case 'found':
      return (
        <>
          {purpose.kind === 'submit'
            ? `The refreshed page shows the SubmitTransaction event for this transaction, in block ${String(
                check.blockNumber,
              )}.`
            : purpose.kind === 'confirm'
              ? `The refreshed page shows the ConfirmTransaction event for this proposal from this account, in block ${String(
                  check.blockNumber,
                )}.`
              : purpose.kind === 'revoke'
                ? `The refreshed page shows the RevokeConfirmation event for this proposal from this account, in block ${String(
                    check.blockNumber,
                  )}.`
                : `The refreshed page shows the ExecuteTransaction event for this proposal from this account, in block ${String(
                    check.blockNumber,
                  )}.`}{' '}
          The index is a copy of what the indexer has stored, not a live view of the chain.
        </>
      )
    case 'not-shown':
      return (
        <>
          {`This transaction is not on the refreshed page (page ${String(
            check.page,
          )}). It may still be waiting to be indexed, it may be on another page, or it may not be in the stored index at all. This app cannot tell those apart, and it does not mean the contract emitted nothing.`}
        </>
      )
    case 'failed':
      return <>The current page of indexed events could not be read again.</>
  }
}
