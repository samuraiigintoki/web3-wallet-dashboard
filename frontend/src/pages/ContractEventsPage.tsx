import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { useCallback } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'

import {
  describeApiError,
  type ContractEvent,
  type Pagination,
  type SubmitTransactionPayload,
  type TrackedContract,
} from '../api/index.ts'
import { useAuth } from '../auth/useAuth.ts'
import {
  contractEventListQuery,
  contractQuery,
} from '../contracts/contractEventQueries.ts'
import { PageControls } from '../data/PageControls.tsx'
import { parsePageParam } from '../data/page.ts'

/**
 * A contract id from the URL, or null when it is not one.
 *
 * The same rule the client applies before it puts an id in a path: a positive
 * safe integer. Anything else names no contract, so nothing is asked about it.
 */
function parseContractId(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) {
    return null
  }

  const parsed = Number.parseInt(raw, 10)

  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

/**
 * The indexed events stored for one tracked contract.
 *
 * Two reads: the contract, for context, and then one page of its events. The
 * second waits for the first, because the first is also what establishes that
 * this account may read the contract at all: a missing id and a contract
 * belonging to somebody else are the same answer, and neither sends an event
 * request.
 *
 * Everything on this screen is what the server stored. Nothing polls, nothing
 * reads the chain, and nothing here claims the list is complete or that the
 * connected browser wallet has anything to do with the contract.
 */
export function ContractEventsPage() {
  const params = useParams()
  const contractId = parseContractId(params.id)
  const { dataSession } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  const page = parsePageParam(searchParams.get('page'))

  const contract = useQuery(
    contractQuery(contractId === null ? null : dataSession, contractId ?? 0),
  )

  // Only after the contract read says this account may see it.
  const events = useQuery(
    contractEventListQuery(dataSession, contractId ?? 0, page, contract.isSuccess),
  )

  const goToPage = useCallback(
    (next: number): void => {
      const nextParams = new URLSearchParams(searchParams)
      nextParams.set('page', String(next))
      setSearchParams(nextParams)
    },
    [searchParams, setSearchParams],
  )

  if (contractId === null) {
    return (
      <main className="page">
        <h1>Contract events</h1>
        <p role="status">That address does not name a tracked contract.</p>
        <BackToContracts />
      </main>
    )
  }

  return (
    <main className="page">
      <h1>Contract events</h1>

      <ContractContext contractId={contractId} contract={contract} />

      {contract.isSuccess && (
        <>
          <p className="hint">
            Indexed data as stored, not a live chain feed. Nothing here polls or reads the chain, and this list is not a claim that the contract emitted nothing else.
          </p>

          <EventResults
            events={events.data?.events}
            pagination={events.data?.pagination}
            page={page}
            onPage={goToPage}
            isPending={events.isPending}
            isFetching={events.isFetching}
            error={events.error}
            onRetry={() => void events.refetch()}
          />
        </>
      )}

      <BackToContracts />
    </main>
  )
}

function BackToContracts() {
  return (
    <p>
      <Link to="/contracts">Back to tracked contracts</Link>
    </p>
  )
}

type ContractQuery = UseQueryResult<TrackedContract, Error>

/**
 * The contract the events belong to, or why it cannot be shown.
 *
 * A `404` is described as "That item no longer exists." for a contract this
 * account does not track and for one that does not exist, because the API
 * deliberately does not tell them apart and this screen must not either.
 */
function ContractContext({ contractId, contract }: { contractId: number; contract: ContractQuery }) {
  if (contract.isPending) {
    return <p role="status">Loading the contract.</p>
  }

  if (contract.error !== null) {
    return (
      <div className="status" role="alert">
        <p>{describeApiError(contract.error)}</p>
        <p className="hint">
          {`No events were requested. A contract this account does not track and one that does not exist give the same answer, so this page cannot say which it was. (Contract id ${String(contractId)}.)`}
        </p>
      </div>
    )
  }

  if (contract.data === undefined) {
    return null
  }

  return (
    <dl className="browser-wallet__facts">
      <dt>Contract</dt>
      <dd>{contract.data.label === '' ? <span className="hint">No label</span> : contract.data.label}</dd>
      <dt>Address</dt>
      <dd className="mono">{contract.data.address}</dd>
      <dt>Chain ID</dt>
      <dd>{String(contract.data.chainId)}</dd>
    </dl>
  )
}

type EventResultsProps = {
  events: ContractEvent[] | undefined
  pagination: Pagination | undefined
  page: number
  onPage: (page: number) => void
  isPending: boolean
  isFetching: boolean
  error: Error | null
  onRetry: () => void
}

function EventResults({
  events,
  pagination,
  page,
  onPage,
  isPending,
  isFetching,
  error,
  onRetry,
}: EventResultsProps) {
  if (error !== null) {
    // A failed read is a data error, not a lost session. Retry reads again; the
    // credential is the auth layer's business and never this screen's.
    return (
      <div className="status" role="alert">
        <p>{describeApiError(error)}</p>
        <div className="status__actions">
          <button type="button" onClick={onRetry} disabled={isFetching}>
            Retry
          </button>
        </div>
      </div>
    )
  }

  if (isPending) {
    return <p role="status">Loading indexed events.</p>
  }

  if (events === undefined || pagination === undefined) {
    return null
  }

  if (events.length === 0) {
    return <EmptyEvents pagination={pagination} page={page} onPage={onPage} />
  }

  return (
    <>
      <p role="status">
        {`Showing ${String(events.length)} of ${String(pagination.totalItems)} indexed events, newest block first.`}
      </p>

      <table className="table">
        <caption>Indexed events</caption>
        <thead>
          <tr>
            <th scope="col">Event</th>
            <th scope="col">Actor</th>
            <th scope="col">Multisig tx</th>
            <th scope="col">Block</th>
            <th scope="col">Transaction hash</th>
            <th scope="col">Payload</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <tr key={`${event.transactionHash}:${String(event.logIndex)}`}>
              <td>{event.eventName}</td>
              <td className="mono">{event.actorAddress}</td>
              <td>{event.multisigTxIndex}</td>
              <td>{String(event.blockNumber)}</td>
              <td className="mono">{event.transactionHash}</td>
              <td>
                <EventPayload event={event} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <PageControls pagination={pagination} page={page} onPage={onPage} label="Event pages" />
    </>
  )
}

/**
 * What the event carried.
 *
 * For `SubmitTransaction` these are the three fields the server sends, drawn as
 * they arrived: the destination address, the value in wei as the exact decimal
 * string, and the calldata as hex. The value is never parsed into a number and
 * the data is never decoded: this view shows what was submitted, it does not
 * interpret it, and it does not turn wei into a currency.
 */
function EventPayload({ event }: { event: ContractEvent }) {
  if (event.eventName !== 'SubmitTransaction') {
    return <span className="hint">No payload for this event.</span>
  }

  const payload = event.payload as SubmitTransactionPayload

  return (
    <dl className="event-payload">
      <dt>To</dt>
      <dd className="mono">{payload.to}</dd>
      <dt>Value</dt>
      <dd>
        <span className="mono">{payload.valueWei}</span> wei
      </dd>
      <dt>Data</dt>
      <dd className="mono">{payload.data}</dd>
    </dl>
  )
}

/**
 * No rows, said honestly.
 *
 * An empty page and an account with no stored events are different facts, and
 * neither means the contract emitted nothing: the indexer stores what it has
 * scanned, and this screen cannot see what it has not.
 */
function EmptyEvents({
  pagination,
  page,
  onPage,
}: {
  pagination: Pagination
  page: number
  onPage: (page: number) => void
}) {
  if (pagination.totalItems === 0) {
    return (
      <p role="status">
        The indexer has no stored events for this contract. That is not a claim that the contract emitted none on chain.
      </p>
    )
  }

  return (
    <>
      <p role="status">
        {`No indexed events on page ${String(page)}. This contract has ${String(
          pagination.totalItems,
        )} stored events over ${String(pagination.totalPages)} pages.`}
      </p>
      <PageControls pagination={pagination} page={page} onPage={onPage} label="Event pages" />
    </>
  )
}
