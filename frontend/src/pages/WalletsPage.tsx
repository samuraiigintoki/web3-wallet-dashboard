import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { useSearchParams } from 'react-router'

import { describeApiError, type Pagination, type Wallet } from '../api/index.ts'
import { useAuth } from '../auth/useAuth.ts'
import type { IdentityRef } from '../data/identityKeys.ts'
import { MAX_PAGE, parsePageParam } from '../wallets/page.ts'
import { isWalletListKeyFor, walletListQuery } from '../wallets/walletQueries.ts'
import { WalletCreateForm } from '../wallets/WalletCreateForm.tsx'

/**
 * The saved wallets of the signed-in account.
 *
 * One read and one write: the rows come from the API, the owner comes from the
 * bearer, and every state on screen says what actually happened. There is no
 * edit or delete control here, and no figure that the API did not send.
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
   * After a save that belongs to the identity still presented.
   *
   * The pages of that identity are invalidated, and cancelling on invalidate is
   * what stops a list response that was already on the wire from landing after
   * the fresh one and overwriting it. The URL then returns to page 1, because a
   * new wallet is saved at the top of the list and a page the user was on
   * earlier no longer describes the data behind it.
   *
   * A refresh that fails is the list's failure to report, not the save's: the
   * save already answered 201, and the list shows its own error with its own
   * Retry.
   */
  const handleSaved = useCallback(
    (identity: IdentityRef): void => {
      void queryClient.invalidateQueries({ predicate: isWalletListKeyFor(identity) })

      if (page !== 1) {
        goToPage(1)
      }
    },
    [goToPage, page, queryClient],
  )

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

      <WalletCreateForm dataSession={dataSession} onSaved={handleSaved} />

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

      {data !== undefined && (
        <WalletResults
          wallets={data.wallets}
          pagination={data.pagination}
          page={page}
          onPage={goToPage}
        />
      )}
    </main>
  )
}

type WalletResultsProps = {
  wallets: Wallet[]
  pagination: Pagination
  /** The page that was asked for, which the URL owns. */
  page: number
  onPage: (page: number) => void
}

function WalletResults({ wallets, pagination, page, onPage }: WalletResultsProps) {
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
              <td>{wallet.label === '' ? 'No label' : wallet.label}</td>
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
