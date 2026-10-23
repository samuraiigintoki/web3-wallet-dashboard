import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'

import { describeApiError, type Pagination, type Wallet } from '../api/index.ts'
import type { DataSession } from '../auth/session.ts'
import { useAuth } from '../auth/useAuth.ts'
import type { IdentityRef } from '../data/identityKeys.ts'
import { MAX_PAGE, parsePageParam } from '../wallets/page.ts'
import { refreshWalletLists, walletListQuery } from '../wallets/walletQueries.ts'
import { WalletCreateForm } from '../wallets/WalletCreateForm.tsx'
import { WalletLabelEditor } from '../wallets/WalletLabelEditor.tsx'

/**
 * The saved wallets of the signed-in account.
 *
 * One read and two writes: the rows come from the API, the owner comes from the
 * bearer, and every state on screen says what actually happened. A saved row can
 * be created and its label corrected; nothing else about it is editable, and no
 * figure on this screen comes from anywhere but the API.
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

  /** Why the last label save closed, for the line above the table. */
  const [notice, setNotice] = useState<string | null>(null)

  /**
   * The row whose button gets focus back after an editor closes, so a keyboard
   * user lands where they were rather than at the top of the document.
   */
  const [returnFocusTo, setReturnFocusTo] = useState<number | null>(null)

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
      setReturnFocusTo(wallet.id)
      setNotice(`Saved label for ${wallet.address}.`)
    },
    [refreshLists],
  )

  const closeEditor = useCallback((): void => {
    setEditingId(null)
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
        <p className="notice" role="status">
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
          editingId={editingId}
          returnFocusTo={returnFocusTo}
          onEdit={(wallet) => {
            setNotice(null)
            setEditingId(wallet.id)
          }}
          onCancel={closeEditor}
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
  /** The row with an open editor, or null. At most one at a time. */
  editingId: number | null
  /** The row whose `Edit label` should receive focus, once. */
  returnFocusTo: number | null
  onEdit: (wallet: Wallet) => void
  onCancel: () => void
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
  editingId,
  returnFocusTo,
  onEdit,
  onCancel,
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
                ) : (
                  <>
                    {wallet.label === '' ? 'No label' : wallet.label}
                    <EditLabelButton
                      wallet={wallet}
                      disabled={editingId !== null}
                      returnFocus={returnFocusTo === wallet.id}
                      onFocusReturned={onFocusReturned}
                      onEdit={onEdit}
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

      <PageControls pagination={pagination} page={page} onPage={onPage} />
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

type EmptyWalletsProps = {
  pagination: Pagination
  page: number
  onPage: (page: number) => void
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
function EmptyWallets({ pagination, page, onPage }: EmptyWalletsProps) {
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
      <PageControls pagination={pagination} page={page} onPage={onPage} />
    </>
  )
}

type PageControlsProps = {
  pagination: Pagination
  page: number
  onPage: (page: number) => void
}

/**
 * Previous and Next only. There is no page-size control in this slice, and the
 * last page is the server's `totalPages`, so the caller cannot walk past the end
 * of its own data or past the ceiling the API enforces.
 */
function PageControls({ pagination, page, onPage }: PageControlsProps) {
  if (pagination.totalPages === 0) {
    return null
  }

  const atLastPage = page >= pagination.totalPages || page >= MAX_PAGE

  return (
    <nav aria-label="Wallet pages">
      <div className="status__actions">
        <button type="button" onClick={() => onPage(page - 1)} disabled={page <= 1}>
          Previous
        </button>
        <span>{`Page ${String(page)} of ${String(pagination.totalPages)}`}</span>
        <button type="button" onClick={() => onPage(page + 1)} disabled={atLastPage}>
          Next
        </button>
      </div>
    </nav>
  )
}
