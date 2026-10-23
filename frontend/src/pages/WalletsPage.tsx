import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'

import {
  describeApiError,
  type Pagination,
  type Wallet,
  type WalletList,
} from '../api/index.ts'
import type { DataSession } from '../auth/session.ts'
import { useAuth } from '../auth/useAuth.ts'
import type { IdentityRef } from '../data/identityKeys.ts'
import { MAX_PAGE, parsePageParam } from '../wallets/page.ts'
import { refreshWalletLists, walletListQuery } from '../wallets/walletQueries.ts'
import { ConfirmRemoveWallet } from '../wallets/ConfirmRemoveWallet.tsx'
import { WalletCreateForm } from '../wallets/WalletCreateForm.tsx'
import { WalletLabelEditor } from '../wallets/WalletLabelEditor.tsx'

/**
 * The saved wallets of the signed-in account.
 *
 * One read and three writes: the rows come from the API, the owner comes from
 * the bearer, and every state on screen says what actually happened. A saved row
 * can be created, have its label corrected and be removed; nothing else about it
 * is editable, and no figure on this screen comes from anywhere but the API.
 */
export function WalletsPage() {
  const { dataSession } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  const queryClient = useQueryClient()

  // The page lives in the URL, so a reload, a back button and a shared link all
  // land on the same page. Anything malformed is page 1, never a crash.
  const page = parsePageParam(searchParams.get('page'))
  const query = useQuery(walletListQuery(dataSession, page))

  const { data, error, isPending, isFetching, refetch } = query

  const goToPage = useCallback(
    (next: number): void => {
      const params = new URLSearchParams(searchParams)
      params.set('page', String(next))
      setSearchParams(params)
    },
    [searchParams, setSearchParams],
  )

  /**
   * Reads this identity's list pages again, after a save or on request.
   *
   * The retirement comes first and is not optional: a list request that left
   * before the save is superseded work, and it is cancelled rather than reused,
   * so an empty pre-save page cannot land next to a save confirmation.
   */
  const refreshLists = useCallback(
    (identity: IdentityRef): void => {
      void refreshWalletLists(queryClient, identity)
    },
    [queryClient],
  )

  /**
   * After a save that belongs to the identity still presented.
   *
   * The route is read here, at the moment the answer arrives, not when the
   * submit was made. A submission holds the callback it started with, and the
   * user may have paged on while the POST was in flight; deciding from the page
   * captured at submit time would leave that newer page in the URL with no rows
   * behind it. The functional update is what makes the decision against the
   * current search string.
   *
   * A refresh that fails is the list's failure to report, not the save's: the
   * save already answered 201, and the list shows its own error with its own
   * Retry.
   */
  const handleSaved = useCallback(
    (identity: IdentityRef): void => {
      refreshLists(identity)

      setSearchParams((current) => {
        if (parsePageParam(current.get('page')) === 1) {
          return current
        }

        const next = new URLSearchParams(current)
        next.set('page', '1')
        return next
      })
    },
    [refreshLists, setSearchParams],
  )

  /**
   * The row whose label editor is open, or null.
   *
   * One at a time is enforced here rather than inside the editor: while a row
   * is open, the other rows' actions are disabled, so a second draft cannot
   * exist and an answer that is still coming cannot be retargeted out from
   * under itself. The editor is keyed by id, so the one path that does retarget,
   * a close followed by another open, unmounts the first and aborts whatever it
   * still owned.
   */
  const [editingId, setEditingId] = useState<number | null>(null)

  /**
   * The row whose removal confirmation is open, or null.
   *
   * Held beside the editor rather than inside the confirmation so that exactly
   * one row operation can exist: while either is open, the other's actions are
   * disabled. That is what stops a destructive confirmation from being opened
   * over an unsaved label draft, which would discard it without asking.
   */
  const [removingId, setRemovingId] = useState<number | null>(null)

  /** Why the last label save closed, for the line above the table. */
  const [notice, setNotice] = useState<string | null>(null)

  /**
   * The row whose button gets focus back after an editor closes, so a keyboard
   * user lands where they were rather than at the top of the document.
   */
  const [returnFocusTo, setReturnFocusTo] = useState<number | null>(null)

  /**
   * Which of the row's actions gets that focus.
   *
   * A row has two now, and handing focus to both would let the last one mounted
   * win a race the user cannot see. The action the user actually used is the
   * one that gets the caret back.
   */
  const [returnFocusAction, setReturnFocusAction] = useState<'edit' | 'remove'>('edit')

  /**
   * Rows whose removal has been settled but whose list entry may still be on
   * screen.
   *
   * A confirmed `204`, or the API's typed "already unavailable", is final for
   * that record. The row only disappears when fresh server rows arrive, which
   * may be a moment later or not at all if the refresh fails, and until then it
   * must not offer to remove itself again. The entry is dropped once the
   * arrived page no longer holds the row.
   */
  const [settledRemovals, setSettledRemovals] = useState<readonly number[]>([])

  /**
   * True while a confirmation's delete is on the wire.
   *
   * The page's own navigation is disabled for that window: paging away unmounts
   * the row, which would abort a destructive request whose answer the user is
   * still owed.
   */
  const [removalPending, setRemovalPending] = useState(false)

  /** The status line, which takes focus once a removed row is gone. */
  const noticeRef = useRef<HTMLParagraphElement>(null)

  /** The row whose confirmation was last opened, so cancelling can focus it. */
  const openedRemovalFor = useRef<number | null>(null)

  /**
   * A confirmed label change.
   *
   * The pages are retired and read again, exactly as after a save, and the URL
   * is left alone: a rename cannot move a row between pages or change a total,
   * so navigating would be a change the user did not ask for. A refresh that
   * fails is the list's failure to report; the confirmation stands.
   */
  const handleUpdated = useCallback(
    (identity: IdentityRef, wallet: Wallet): void => {
      refreshLists(identity)
      setEditingId(null)
      setReturnFocusAction('edit')
      setReturnFocusTo(wallet.id)
      setNotice(`Saved label for ${wallet.address}.`)
    },
    [refreshLists],
  )

  const closeEditor = useCallback((): void => {
    setEditingId(null)
  }, [])

  const closeRemoval = useCallback((): void => {
    // Cancelling is a pure close, so the caret goes back to the control that
    // opened the confirmation.
    setRemovingId(null)
    setRemovalPending(false)
    setReturnFocusAction('remove')
    setReturnFocusTo(openedRemovalFor.current)
    openedRemovalFor.current = null
  }, [])

  /**
   * What this page is presented for right now: whose data, which credential
   * generation, and which page of it.
   *
   * Written whenever the session or the page changes, so an asynchronous
   * continuation can ask what is true now instead of what was true when it
   * started. A captured `dataSession` is a value, not a fact: sign-out, a
   * credential replacement in this tab or another, or the guard clearing the
   * cache all happen while a read is on the wire, and this page can still be
   * mounted with no session at all while a held logout answer is outstanding.
   * Deciding from the captured value is what revives a retired identity's
   * request.
   *
   * Teardown retires it too, and that is not the same event as a render with no
   * session. A guard redirect removes this page without ever presenting it a
   * null session, so a continuation waiting for "no session" would wait
   * forever and then read for an owner nobody is watching. `null` here means
   * this page is no longer presented for anyone, whatever the session says.
   */
  const liveView = useRef<{ session: DataSession | null; page: number }>({
    session: dataSession,
    page,
  })

  useEffect(() => {
    liveView.current = { session: dataSession, page }

    return () => {
      liveView.current = { session: null, page }
    }
  }, [dataSession, page])

  /**
   * A manual read of this identity's list, for an outcome the client could not
   * confirm.
   *
   * It is the same retirement and refetch as after a save, and deliberately not
   * a second write: nothing here replays the write. The create form only needs
   * the read to happen, so it is called without a wallet id and nothing is
   * returned.
   */
  const handleCheckList = useCallback((): void => {
    if (dataSession !== null) {
      refreshLists({ userId: dataSession.userId, generation: dataSession.generation })
    }
  }, [dataSession, refreshLists])

  /**
   * The same read, for one row, answered from the server.
   *
   * The editor cannot see what a read produced on its own: the draft belongs to
   * the component and the rows belong to the query. Returning the row this read
   * was answered with is what lets the editor show the stored label next to the
   * uncertain draft, which is the whole point of a read-only reconciliation.
   *
   * It is deliberately a fetch and not a look at the cache. A cache read cannot
   * tell a value the server just sent from a value it sent before, and the case
   * that matters is exactly the one where the two differ: a check whose request
   * is cancelled by another refresh leaves the query reverted to success over
   * the old page, and reporting that as the answer would present stale data as
   * fresh. `fetchQuery` follows the same key and the same query function, so the
   * cache still ends up holding the read, but the value returned here is only
   * ever one a completed request produced. A cancelled or failed read rejects,
   * and the editor says so instead of guessing.
   *
   * It resolves to null when the answer does not hold that wallet, which means
   * the refresh is not the caller's to show any more.
   */
  const readBackWallet = useCallback(
    async (walletId: number): Promise<Wallet | null> => {
      const owner = dataSession
      const ownerPage = page

      if (owner === null) {
        return null
      }

      /**
       * True while the owner that asked for this read is still the one on
       * screen.
       *
       * The whole identity, not only the user: a replacement credential is a
       * different session for the same account and its cache is kept apart, so
       * a read started under the old one has no business filling the new one
       * either. The page is part of it because a read is a read of one page, and
       * one the user has paged away from has nobody to show it to.
       */
      const ownerIsCurrent = (): boolean => {
        const live = liveView.current
        return (
          live.session !== null &&
          live.session.userId === owner.userId &&
          live.session.generation === owner.generation &&
          live.page === ownerPage
        )
      }

      await refreshWalletLists(queryClient, {
        userId: owner.userId,
        generation: owner.generation,
      })

      // The wait above ends the moment another refresh cancels this one, which
      // is exactly when the session may also have been retired. Starting the
      // read now would put the retired identity's page back into a cache the
      // sign-out just cleared, with a credential that is no longer anyone's.
      if (!ownerIsCurrent()) {
        throw new Error('the session that asked for this read has ended')
      }

      const refreshed = await queryClient.fetchQuery(walletListQuery(owner, ownerPage))

      // The same question after the second wait: the answer is only this
      // owner's to report.
      if (!ownerIsCurrent()) {
        return null
      }

      return refreshed.wallets.find((wallet) => wallet.id === walletId) ?? null
    },
    [dataSession, page, queryClient],
  )

  /**
   * The refresh after a record is gone, and the page repair it may need.
   *
   * Retirement first, exactly as after a save: a list request that left before
   * the removal is superseded work. The pages are then read again, and only the
   * fresh server rows decide the page, because only the server knows the totals.
   * That is also why nothing is subtracted locally and no row is removed ahead
   * of the answer.
   *
   * A removal can empty the current page. When it does, the URL moves to the
   * last page the fresh metadata reports, with a floor of page 1: removing the
   * only record on page 2 of 2 lands on page 1, and removing the account's only
   * record lands on page 1, where the true empty state is shown. A page that
   * still holds rows is left exactly where the user put it, and an ordinary
   * visit to a past-end page keeps C1's behaviour because this path only runs
   * after a removal.
   *
   * Every wait is followed by the same ownership question the readback asks. A
   * refresh that arrives after the session ended, or after the user navigated,
   * changes nothing: no cache write of its own making, no navigation.
   */
  const settleRemoval = useCallback(
    async (
      identity: IdentityRef,
      ownerPage: number,
      wallet: Wallet,
      how: 'removed' | 'unavailable',
    ): Promise<void> => {
      const address = wallet.address

      setSettledRemovals((previous) =>
        previous.includes(wallet.id) ? previous : [...previous, wallet.id],
      )

      /** True while this identity and this page are still the ones on screen. */
      const viewIsCurrent = (): boolean => {
        const live = liveView.current
        return (
          live.session !== null &&
          live.session.userId === identity.userId &&
          live.session.generation === identity.generation &&
          live.page === ownerPage
        )
      }

      setRemovingId(null)
      setRemovalPending(false)
      setReturnFocusTo(null)

      if (!viewIsCurrent()) {
        // The page this confirmation belonged to is gone. Saying the record was
        // removed is that page's news, and it is nobody else's to receive.
        return
      }

      setNotice(
        how === 'removed'
          ? `Removed the saved record for ${address}.`
          : `The saved record for ${address} is no longer available to your account.`,
      )

      await refreshWalletLists(queryClient, identity)

      if (!viewIsCurrent() || dataSession === null) {
        return
      }

      let fresh: WalletList
      try {
        fresh = await queryClient.fetchQuery(walletListQuery(dataSession, ownerPage))
      } catch {
        // The removal is confirmed and stays confirmed. This is the list's
        // failure to report, with the list's own Retry, and never a reason to
        // send another DELETE.
        if (viewIsCurrent()) {
          setNotice(
            `Removed the saved record for ${address}. The list could not be refreshed, so it may still show it.`,
          )
          noticeRef.current?.focus()
        }
        return
      }

      if (!viewIsCurrent()) {
        return
      }

      if (fresh.wallets.length > 0) {
        noticeRef.current?.focus()
        return
      }

      const lastPage = Math.max(1, fresh.pagination.totalPages)

      if (lastPage === ownerPage) {
        // The page the user is on is still where the rows are, so it stays.
        noticeRef.current?.focus()
        return
      }

      const next = new URLSearchParams(searchParams)
      next.set('page', String(lastPage))
      setSearchParams(next)
      noticeRef.current?.focus()
    },
    [dataSession, liveView, queryClient, searchParams, setSearchParams],
  )

  /**
   * A draft belongs to the session that typed it, not to the account. A
   * credential replacement for the same user is a different session, so the
   * editor closes on the same boundary the create form clears its own fields
   * on. The editor's unmount is what aborts whatever it still owned.
   */
  const identityGeneration = dataSession?.generation ?? null
  const identityUser = dataSession?.userId ?? null
  const focusedOnce = useRef(false)

  useEffect(() => {
    if (!focusedOnce.current) {
      focusedOnce.current = true
      return
    }

    setEditingId(null)
    setRemovingId(null)
    setRemovalPending(false)
    setSettledRemovals([])
    setNotice(null)
  }, [identityUser, identityGeneration])

  /**
   * Retire a selection whose row is no longer in the visible page.
   *
   * Paging away, or a refresh that drops the row, unmounts the editor but leaves
   * the id it was opened for behind. That id then disables every other row's
   * action with nothing open and no Cancel to press, which is a dead screen.
   *
   * The check runs only against a page that has actually arrived: while a new
   * page is loading there is no row set to judge, and clearing on the way to it
   * would close an editor the user is still looking at. A row that survives an
   * ordinary refetch keeps its editor and its draft, because the id is still
   * present. The URL and the create form's draft are untouched either way.
   */
  const visibleWallets = data?.wallets
  if (
    editingId !== null &&
    visibleWallets !== undefined &&
    !visibleWallets.some((wallet) => wallet.id === editingId)
  ) {
    setEditingId(null)
  }

  if (
    removingId !== null &&
    visibleWallets !== undefined &&
    !visibleWallets.some((wallet) => wallet.id === removingId)
  ) {
    setRemovingId(null)
    setRemovalPending(false)
  }

  /**
   * A settled row is forgotten once the arrived page stops holding it.
   *
   * That is the only event that proves the list caught up: a refresh that failed,
   * or has not answered yet, leaves the row on screen, and the row has to stay
   * blocked for exactly as long as it is still there.
   */
  if (
    visibleWallets !== undefined &&
    settledRemovals.some((id) => !visibleWallets.some((wallet) => wallet.id === id))
  ) {
    setSettledRemovals((previous) =>
      previous.filter((id) => visibleWallets.some((wallet) => wallet.id === id)),
    )
  }

  if (dataSession === null) {
    return (
      <main className="page">
        <h1>Wallets</h1>
        <p role="status">Waiting for your session.</p>
      </main>
    )
  }

  return (
    <main className="page" aria-busy={isPending}>
      <h1>Wallets</h1>

      <WalletCreateForm
        dataSession={dataSession}
        onSaved={handleSaved}
        onCheckList={handleCheckList}
      />

      {error !== null && (
        // A failed wallet read is a data error, not a lost session. It clears
        // the rows and offers Retry; it never signs the user out and never
        // touches the credential. A current-session 401 is different, and it is
        // the auth layer that ends the session and the guard that drops the
        // cache, not this screen.
        <div className="status" role="alert">
          <p>{describeApiError(error)}</p>
          <div className="status__actions">
            <button type="button" onClick={() => void refetch()} disabled={isFetching}>
              Retry
            </button>
          </div>
        </div>
      )}

      {error === null && isPending && <p role="status">Loading wallets.</p>}

      {notice !== null && (
        // Focusable so a confirmed removal can hand focus here: the row and its
        // buttons are gone by then, and leaving the caret nowhere would drop a
        // keyboard user at the top of the document.
        <p className="notice" role="status" ref={noticeRef} tabIndex={-1}>
          {notice}
        </p>
      )}

      {data !== undefined && (
        <WalletResults
          dataSession={dataSession}
          wallets={data.wallets}
          pagination={data.pagination}
          page={page}
          onPage={goToPage}
          navigationLocked={removalPending}
          settledRemovals={settledRemovals}
          editingId={editingId}
          removingId={removingId}
          returnFocusTo={returnFocusTo}
          returnFocusAction={returnFocusAction}
          onEdit={(wallet) => {
            setNotice(null)
            setEditingId(wallet.id)
          }}
          onCancel={closeEditor}
          onRemove={(wallet) => {
            setNotice(null)
            openedRemovalFor.current = wallet.id
            setRemovingId(wallet.id)
          }}
          onCancelRemoval={closeRemoval}
          onRemovalPendingChange={setRemovalPending}
          onGone={(identity, wallet, how) => {
            void settleRemoval(
              identity,
              parsePageParam(searchParams.get('page')),
              wallet,
              how,
            )
          }}
          onUpdated={handleUpdated}
          onReadBack={readBackWallet}
          onFocusReturned={() => {
            setReturnFocusTo(null)
          }}
        />
      )}
    </main>
  )
}

type WalletResultsProps = {
  dataSession: DataSession
  wallets: Wallet[]
  pagination: Pagination
  /** The page that was asked for, which the URL owns. */
  page: number
  onPage: (page: number) => void
  /** True while a delete is pending, which stops the page moving under it. */
  navigationLocked: boolean
  /** Rows whose removal is settled, so their action is blocked until the list
   * itself drops them. */
  settledRemovals: readonly number[]
  /** The row with an open editor, or null. At most one at a time. */
  editingId: number | null
  /** The row with an open removal confirmation, or null. */
  removingId: number | null
  /** The row whose action should receive focus, once. */
  returnFocusTo: number | null
  /** Which action that is. */
  returnFocusAction: 'edit' | 'remove'
  onEdit: (wallet: Wallet) => void
  onCancel: () => void
  onRemove: (wallet: Wallet) => void
  onCancelRemoval: () => void
  onRemovalPendingChange: (pending: boolean) => void
  onGone: (
    identity: IdentityRef,
    wallet: Wallet,
    how: 'removed' | 'unavailable',
  ) => void
  onUpdated: (identity: IdentityRef, wallet: Wallet) => void
  /** Reads the list again and returns the refreshed row, for the editor. */
  onReadBack: (walletId: number) => Promise<Wallet | null>
  onFocusReturned: () => void
}

function WalletResults({
  dataSession,
  wallets,
  pagination,
  page,
  onPage,
  navigationLocked,
  settledRemovals,
  editingId,
  removingId,
  returnFocusTo,
  returnFocusAction,
  onEdit,
  onCancel,
  onRemove,
  onCancelRemoval,
  onGone,
  onRemovalPendingChange,
  onUpdated,
  onReadBack,
  onFocusReturned,
}: WalletResultsProps) {
  if (wallets.length === 0) {
    return (
      <EmptyWallets
        pagination={pagination}
        page={page}
        onPage={onPage}
        navigationLocked={navigationLocked}
      />
    )
  }

  return (
    <>
      <p role="status">
        {`Showing ${String(wallets.length)} of ${String(pagination.totalItems)} saved wallets.`}
      </p>

      <table className="table">
        <caption>Saved wallets</caption>
        <thead>
          <tr>
            <th scope="col">Label</th>
            <th scope="col">Address</th>
            <th scope="col">Chain ID</th>
            <th scope="col">Created</th>
          </tr>
        </thead>
        <tbody>
          {wallets.map((wallet) => (
            <tr key={wallet.id}>
              <td>
                {editingId === wallet.id ? (
                  <WalletLabelEditor
                    // Keyed by id so a retarget is a remount: the old draft is
                    // dropped and the old request is aborted, rather than two
                    // editors sharing one form's state.
                    key={wallet.id}
                    dataSession={dataSession}
                    wallet={wallet}
                    onUpdated={onUpdated}
                    onCancel={onCancel}
                    onReadBack={onReadBack}
                  />
                ) : removingId === wallet.id ? (
                  <ConfirmRemoveWallet
                    // Keyed by id for the same reason: a retarget remounts, so
                    // a held answer cannot land in another row's confirmation.
                    key={wallet.id}
                    dataSession={dataSession}
                    wallet={wallet}
                    onCancel={onCancelRemoval}
                    onGone={onGone}
                    onPendingChange={onRemovalPendingChange}
                  />
                ) : (
                  <>
                    {wallet.label === '' ? 'No label' : wallet.label}
                    <EditLabelButton
                      wallet={wallet}
                      disabled={editingId !== null || removingId !== null}
                      returnFocus={
                        returnFocusTo === wallet.id && returnFocusAction === 'edit'
                      }
                      onFocusReturned={onFocusReturned}
                      onEdit={onEdit}
                    />
                    <RemoveWalletButton
                      wallet={wallet}
                      // Settled by a confirmed answer, so the list entry is the
                      // only thing left to wait for.
                      settled={settledRemovals.includes(wallet.id)}
                      disabled={
                        editingId !== null ||
                        removingId !== null ||
                        settledRemovals.includes(wallet.id)
                      }
                      returnFocus={
                        returnFocusTo === wallet.id && returnFocusAction === 'remove'
                      }
                      onFocusReturned={onFocusReturned}
                      onRemove={onRemove}
                    />
                  </>
                )}
              </td>
              <td>{wallet.address}</td>
              <td>{wallet.chainId}</td>
              <td>{wallet.createdAt}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <PageControls
        pagination={pagination}
        page={page}
        onPage={onPage}
        navigationLocked={navigationLocked}
      />
    </>
  )
}

type EditLabelButtonProps = {
  wallet: Wallet
  /** Another row is being edited, so this one cannot start an editor. */
  disabled: boolean
  returnFocus: boolean
  onFocusReturned: () => void
  onEdit: (wallet: Wallet) => void
}

/**
 * `Edit label` for one row.
 *
 * Disabled while any editor is open, which is what stops a second draft from
 * existing and, while a save is in flight, stops the open editor being
 * retargeted out from under an answer that is still coming.
 */
function EditLabelButton({
  wallet,
  disabled,
  returnFocus,
  onFocusReturned,
  onEdit,
}: EditLabelButtonProps) {
  const buttonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (returnFocus) {
      buttonRef.current?.focus()
      onFocusReturned()
    }
  }, [returnFocus, onFocusReturned])

  return (
    <button
      type="button"
      className="row-action"
      ref={buttonRef}
      disabled={disabled}
      onClick={() => {
        onEdit(wallet)
      }}
    >
      Edit label
    </button>
  )
}

type RemoveWalletButtonProps = {
  wallet: Wallet
  /** The record is already gone; only the list has yet to catch up. */
  settled: boolean
  /**
   * Another row operation is open or in flight, so this one cannot start a
   * destructive confirmation over it.
   */
  disabled: boolean
  returnFocus: boolean
  onFocusReturned: () => void
  onRemove: (wallet: Wallet) => void
}

/**
 * `Remove` for one row.
 *
 * Disabled while any row operation is open, which is what keeps a confirmation
 * from closing over an unsaved label draft, and while a delete is in flight, so
 * the confirmation cannot be retargeted out from under its own answer.
 */
function RemoveWalletButton({
  wallet,
  settled,
  disabled,
  returnFocus,
  onFocusReturned,
  onRemove,
}: RemoveWalletButtonProps) {
  const buttonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (returnFocus) {
      buttonRef.current?.focus()
      onFocusReturned()
    }
  }, [returnFocus, onFocusReturned])

  return (
    <>
      <button
        type="button"
        className="row-action"
        ref={buttonRef}
        disabled={disabled || settled}
        // Said in words as well as by the disabled state: the button still reads
        // `Remove`, so without this a keyboard or screen reader user would only
        // know the action is unavailable, not why.
        aria-describedby={settled ? `removed-${String(wallet.id)}` : undefined}
        onClick={() => {
          onRemove(wallet)
        }}
      >
        Remove
      </button>
      {settled && (
        <span className="hint" id={`removed-${String(wallet.id)}`}>
          Removed. Waiting for the list to catch up.
        </span>
      )}
    </>
  )
}

type EmptyWalletsProps = {
  pagination: Pagination
  page: number
  onPage: (page: number) => void
  navigationLocked: boolean
}

/**
 * An account with nothing saved and a page past the end are different facts and
 * get different words.
 *
 * The difference is the real total the server sent: an empty account reports
 * zero wallets, while a page past the end reports wallets that exist on earlier
 * pages. The count is never invented, and it is never shown as zero when it is
 * not.
 */
function EmptyWallets({
  pagination,
  page,
  onPage,
  navigationLocked,
}: EmptyWalletsProps) {
  if (pagination.totalItems === 0) {
    return (
      <p role="status">
        You have no saved wallets yet. Add one with the form above.
      </p>
    )
  }

  const pageWord = pagination.totalPages === 1 ? 'page' : 'pages'

  return (
    <>
      <p role="status">
        {`No wallets on page ${String(page)}. This account has ${String(
          pagination.totalItems,
        )} saved wallets over ${String(pagination.totalPages)} ${pageWord}.`}
      </p>
      <div className="status__actions">
        <button type="button" onClick={() => onPage(1)} disabled={page <= 1}>
          Back to page 1
        </button>
      </div>
      <PageControls
        pagination={pagination}
        page={page}
        onPage={onPage}
        navigationLocked={navigationLocked}
      />
    </>
  )
}

type PageControlsProps = {
  pagination: Pagination
  page: number
  onPage: (page: number) => void
  /** True while a delete is pending: the page must not move under it. */
  navigationLocked: boolean
}

/**
 * Previous and Next only. There is no page-size control in this slice, and the
 * last page is the server's `totalPages`, so the caller cannot walk past the end
 * of its own data or past the ceiling the API enforces.
 */
function PageControls({
  pagination,
  page,
  onPage,
  navigationLocked,
}: PageControlsProps) {
  if (pagination.totalPages === 0) {
    return null
  }

  const atLastPage = page >= pagination.totalPages || page >= MAX_PAGE

  return (
    <nav aria-label="Wallet pages">
      <div className="status__actions">
        <button
          type="button"
          onClick={() => onPage(page - 1)}
          disabled={page <= 1 || navigationLocked}
        >
          Previous
        </button>
        <span>{`Page ${String(page)} of ${String(pagination.totalPages)}`}</span>
        <button
          type="button"
          onClick={() => onPage(page + 1)}
          disabled={atLastPage || navigationLocked}
        >
          Next
        </button>
      </div>
    </nav>
  )
}
