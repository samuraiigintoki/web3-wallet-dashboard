import { useEffect, useRef } from 'react'

import { describeApiError, type Wallet } from '../api/index.ts'
import type { DataSession } from '../auth/session.ts'
import type { IdentityRef } from '../data/identityKeys.ts'
import { useDeleteWallet } from './useDeleteWallet.ts'

/**
 * The confirmation for removing one saved record.
 *
 * Inline rather than a modal, for the same reason the label editor is: the row
 * it acts on is already on screen, and a dialog over a table would have to
 * re-create the address and chain it is not editing. One row operation is open
 * at a time, which is the page's decision, and this component assumes it is the
 * only one mounted.
 *
 * It removes an off-chain record. It never touches keys, funds or chain state,
 * and it says so rather than leaving the user to assume otherwise.
 */

const UNCONFIRMED_MESSAGE =
  'The removal did not finish, so the saved record may or may not be gone. Check the saved record before trying again.'

const ALREADY_UNAVAILABLE_MESSAGE =
  'The server says this saved record is already unavailable to your account. Nothing else was removed by this action.'

type ConfirmRemoveWalletProps = {
  dataSession: DataSession
  wallet: Wallet
  /** Closes the confirmation without writing anything. Disabled while pending. */
  onCancel: () => void
  /**
   * The record is gone: confirmed by a `204`, already unavailable to this
   * owner, or reconciled as absent by a typed `404`. The page owns what
   * happens next, because the list and the URL are not this component's.
   */
  onGone: (identity: IdentityRef, wallet: Wallet, how: 'removed' | 'unavailable') => void
  /**
   * True while the delete is on the wire.
   *
   * The page uses it to stop moving the user off the page underneath a request
   * whose answer they are still owed. An abort there would leave the record
   * possibly gone with nobody to report it.
   */
  onPendingChange: (pending: boolean) => void
}

export function ConfirmRemoveWallet({
  dataSession,
  wallet,
  onCancel,
  onGone,
  onPendingChange,
}: ConfirmRemoveWalletProps) {
  const { state, check, remove, verify } = useDeleteWallet({
    dataSession,
    walletId: wallet.id,
  })

  const cancelRef = useRef<HTMLButtonElement>(null)

  /**
   * Focus on entry, on `Cancel`.
   *
   * For a destructive action the safe choice is the one that does nothing, so
   * the panel opens with the caret there rather than on the button that removes
   * the record. A stray Enter then cancels.
   */
  useEffect(() => {
    cancelRef.current?.focus()
  }, [])

  const pending = state.status === 'removing' || check.status === 'checking'

  /**
   * Removes the record, reporting the in-flight window to the page around it.
   *
   * The flag is raised before the request and only dropped by the effect below,
   * once the answer is known. Dropping it in the handler's `finally` would
   * release it the moment the DELETE resolved, which is before this panel has
   * necessarily unmounted: for that interval the row behind it would look idle
   * again while its list entry is still on screen.
   */
  const handleRemove = async (): Promise<void> => {
    onPendingChange(true)
    await remove()
  }

  /**
   * Holds the page's pending flag until the outcome is known.
   *
   * A confirmed or already-unavailable answer keeps it raised: the record is
   * settled, the list has not caught up yet, and the page must not treat that
   * window as idle. Every other outcome releases it, because those rows are
   * still the user's to retry or to check.
   */
  useEffect(() => {
    if (state.status === 'removed' || state.status === 'unavailable') {
      return
    }

    if (state.status !== 'removing') {
      onPendingChange(false)
    }
  }, [state, onPendingChange])

  /**
   * Report the record gone exactly once, whichever path established it.
   *
   * The page then refreshes the list and repairs the page, which is what makes
   * the row disappear. Reporting is guarded because a state change can be
   * followed by the check that caused it settling again before the refresh
   * unmounts this panel.
   */
  const reported = useRef(false)
  const onGoneRef = useRef(onGone)

  useEffect(() => {
    onGoneRef.current = onGone
  }, [onGone])

  useEffect(() => {
    if (reported.current) {
      return
    }

    const identity: IdentityRef = {
      userId: dataSession.userId,
      generation: dataSession.generation,
    }

    if (state.status === 'removed') {
      reported.current = true
      onGoneRef.current(identity, wallet, 'removed')
      return
    }

    if (state.status === 'unavailable') {
      reported.current = true
      onGoneRef.current(identity, wallet, 'unavailable')
      return
    }

    if (check.status === 'absent') {
      // A typed `404` says the record is unavailable to this owner. It does not
      // say who removed it, so it is reported as that and not as a removal.
      reported.current = true
      onGoneRef.current(identity, wallet, 'unavailable')
    }
  }, [state, check, dataSession, wallet])

  const failure = state.status === 'failed' ? state.error : null
  const unconfirmed = state.status === 'unconfirmed' ? state.error : null

  return (
    <div
      className="form"
      role="group"
      // Named for the row it acts on, so a reader hears which record a
      // destructive confirmation belongs to.
      aria-label={`Remove wallet ${wallet.address}`}
      aria-busy={pending}
    >
      <dl className="confirm">
        <dt>Label</dt>
        <dd>{wallet.label === '' ? 'No label' : wallet.label}</dd>
        <dt>Address</dt>
        <dd>{wallet.address}</dd>
        <dt>Chain</dt>
        <dd>{wallet.chainId}</dd>
      </dl>

      {/* Said once, plainly, because "delete" next to a wallet address can be
          read as something that happens on chain. It cannot. */}
      <p className="hint">
        This removes the saved record only. It does not touch keys, funds or
        anything on chain.
      </p>

      <div className="status__actions">
        {/* Constant labels: a button that renames itself mid-click makes a
            double submit harder to reason about, and the panel carries
            aria-busy. */}
        <button type="button" onClick={() => void handleRemove()} disabled={pending}>
          Remove wallet
        </button>
        {/* Disabled while a delete is in flight: closing then would leave a
            destructive request on the wire whose answer nobody is watching. */}
        <button type="button" ref={cancelRef} onClick={onCancel} disabled={pending}>
          Cancel
        </button>
      </div>

      {failure !== null && (
        <div className="notice" role="alert">
          <p>{describeApiError(failure)}</p>
          <p>The saved record was not removed.</p>
        </div>
      )}

      {unconfirmed !== null && (
        <div className="notice" role="alert">
          <p>{UNCONFIRMED_MESSAGE}</p>
          <div className="status__actions">
            <button type="button" onClick={() => void verify()} disabled={pending}>
              Check saved record
            </button>
          </div>
        </div>
      )}

      {check.status === 'checking' && <p role="status">Checking the saved record.</p>}

      {check.status === 'present' && (
        <p className="notice" role="status">
          {`The saved record is still on the server: "${
            check.wallet.label === '' ? 'No label' : check.wallet.label
          }", ${check.wallet.address}, chain ${String(check.wallet.chainId)}. Nothing was removed.`}
        </p>
      )}

      {check.status === 'indeterminate' && (
        <p className="notice" role="status">
          The saved record could not be read, so it cannot be shown to be gone or
          still there. Try the check again.
        </p>
      )}

      {state.status === 'unavailable' && (
        <p className="notice" role="status">
          {ALREADY_UNAVAILABLE_MESSAGE}
        </p>
      )}
    </div>
  )
}
