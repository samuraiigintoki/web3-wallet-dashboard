import { useQuery } from '@tanstack/react-query'
import { useCallback } from 'react'
import { useSearchParams } from 'react-router'

import { describeApiError, type Pagination, type TrackedContract } from '../api/index.ts'
import { useAuth } from '../auth/useAuth.ts'
import { contractListQuery } from '../contracts/contractQueries.ts'
import { indexingDescription, indexingLabel } from '../contracts/indexing.ts'
import { MAX_PAGE, parsePageParam } from '../data/page.ts'

/**
 * The tracked contracts of the signed-in account.
 *
 * One read and no writes. The rows come from the API, the owner comes from the
 * bearer, and every state on the screen says what actually happened rather than
 * filling the gap with a figure. Nothing here creates, edits, enables or removes
 * a record, and nothing here reads the chain: this is the saved list, and the
 * page says so in as many words.
 */
export function ContractsPage() {
  const { dataSession } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()

  // The page lives in the URL, so a reload, a back button and a shared link all
  // land on the same page. Anything malformed is page 1, never a crash, and a
  // page beyond the server's ceiling is clamped rather than sent.
  const page = parsePageParam(searchParams.get('page'))
  const { data, error, isPending, isFetching, refetch } = useQuery(
    contractListQuery(dataSession, page),
  )

  const goToPage = useCallback(
    (next: number): void => {
      const params = new URLSearchParams(searchParams)
      params.set('page', String(next))
      setSearchParams(params)
    },
    [searchParams, setSearchParams],
  )

  return (
    <main className="page">
      <h1>Contracts</h1>
      <p>
        The contracts this account tracks. These are saved records: being here
        does not mean a contract is deployed, that this app has read it, or that
        you own it.
      </p>

      {error !== null && (
        // A failed contract read is a data error, not a lost session. It clears
        // the rows and offers Retry; it never signs the user out and never
        // touches the credential. A current-session 401 is the auth layer's
        // business, and the guard that drops the cache is the route's.
        <div className="status" role="alert">
          <p>{describeApiError(error)}</p>
          <div className="status__actions">
            <button type="button" onClick={() => void refetch()} disabled={isFetching}>
              Retry
            </button>
          </div>
        </div>
      )}

      {error === null && isPending && <p role="status">Loading tracked contracts.</p>}

      {data !== undefined && (
        <ContractResults
          contracts={data.contracts}
          pagination={data.pagination}
          page={page}
          onPage={goToPage}
        />
      )}
    </main>
  )
}

type ContractResultsProps = {
  contracts: TrackedContract[]
  pagination: Pagination
  /** The page that was asked for, which the URL owns. */
  page: number
  onPage: (page: number) => void
}

function ContractResults({ contracts, pagination, page, onPage }: ContractResultsProps) {
  if (contracts.length === 0) {
    return <EmptyContracts pagination={pagination} page={page} onPage={onPage} />
  }

  return (
    <>
      <p role="status">
        {`Showing ${String(contracts.length)} of ${String(pagination.totalItems)} tracked contracts.`}
      </p>

      <table className="table">
        <caption>Tracked contracts</caption>
        <thead>
          <tr>
            <th scope="col">Label</th>
            <th scope="col">Address</th>
            <th scope="col">Chain ID</th>
            <th scope="col">Enabled</th>
            <th scope="col">Start block</th>
            <th scope="col">Indexing</th>
          </tr>
        </thead>
        <tbody>
          {contracts.map((contract) => (
            <tr key={contract.id}>
              <td>{contract.label === '' ? <span className="hint">No label</span> : contract.label}</td>
              <td className="mono">{contract.address}</td>
              <td>{String(contract.chainId)}</td>
              <td>{contract.enabled ? 'Yes' : 'No'}</td>
              <td>{String(contract.startBlock)}</td>
              <td>
                {/*
                  Availability, said in words, with the reason beside it. It is
                  never a percentage, a block height or a spinner: the API does
                  not send progress, so the screen does not suggest any.
                */}
                <span className="hint">{indexingLabel(contract.indexingStatus)}. </span>
                {indexingDescription(contract.indexingStatus)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <PageControls pagination={pagination} page={page} onPage={onPage} />
    </>
  )
}

type EmptyContractsProps = {
  pagination: Pagination
  page: number
  onPage: (page: number) => void
}

/**
 * An account with nothing tracked and a page past the end are different facts
 * and get different words.
 *
 * The difference is the real total the server sent: an empty account reports
 * zero records, while a page past the end reports records that exist on earlier
 * pages. The count is never invented, and it is never shown as zero when it is
 * not.
 */
function EmptyContracts({ pagination, page, onPage }: EmptyContractsProps) {
  if (pagination.totalItems === 0) {
    return <p role="status">This account is not tracking any contracts yet.</p>
  }

  const pageWord = pagination.totalPages === 1 ? 'page' : 'pages'

  return (
    <>
      <p role="status">
        {`No tracked contracts on page ${String(page)}. This account tracks ${String(
          pagination.totalItems,
        )} over ${String(pagination.totalPages)} ${pageWord}.`}
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
 * Previous and Next only, bounded by what the server reported.
 *
 * There is no page-size control in this slice, and the last page is the server's
 * `totalPages`, so the caller cannot walk past the end of its own data or past
 * the ceiling the API enforces.
 */
function PageControls({ pagination, page, onPage }: PageControlsProps) {
  if (pagination.totalPages === 0) {
    return null
  }

  const atLastPage = page >= pagination.totalPages || page >= MAX_PAGE

  return (
    <nav aria-label="Contract pages">
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
