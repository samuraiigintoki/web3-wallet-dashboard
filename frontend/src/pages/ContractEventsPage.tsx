import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { useCallback } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { MULTISIG_ADDRESS, SEPOLIA_CHAIN_ID } from '../provider/multisig.ts'
import { useBrowserWallet, type BrowserWalletState } from '../provider/useBrowserWallet.ts'
import { chainCatalogQuery } from '../wallets/chainQueries.ts'
import { ConfirmTransaction } from '../multisig/ConfirmTransaction.tsx'
import { RevokeTransaction } from '../multisig/RevokeTransaction.tsx'
import type { RefreshedPage } from '../multisig/events.ts'
import type { CatalogFact } from '../multisig/useSubmitTransaction.ts'

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
import { SubmitTransactionForm } from '../multisig/SubmitTransactionForm.tsx'

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
 *
 * Below the events is the one write in the app: submitting a proposal to this
 * contract through the browser wallet. It is on this screen because this is
 * where the contract is identified and restated, and because a submission is not
 * an event: the list above does not change when one is sent, and this screen does
 * not pretend to watch for it.
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

  /**
   * The wallet, read once for the whole page.
   *
   * The submit form and every row that can confirm share this one answer, so the
   * screen cannot hold two opinions about which account and chain this tab is on.
   * It is read here rather than in each control because a confirmation and a
   * submission in the same session must agree about that, and because one
   * subscription per row would be one leak per row.
   */
  const wallet = useBrowserWallet()

  /**
   * The public chain catalog, read only once a wallet is connected.
   *
   * The catalog is what makes a chain supported, and it comes from this app's
   * API rather than from the provider: the provider says where the wallet is, and
   * only the deployment can say which chains it knows how to talk about.
   */
  const catalog = useQuery({
    ...chainCatalogQuery(),
    enabled: wallet.state.status === 'connected',
  })

  /**
   * Whether this tracked contract is the deployment whose confirm function this
   * app knows.
   *
   * One statement for the page rather than one per row: a contract at another
   * address may be a different multisig or no multisig at all, and repeating the
   * same refusal under twenty rows would be noise rather than information.
   */
  const confirmable =
    contract.data !== undefined &&
    contract.data.address.toLowerCase() === MULTISIG_ADDRESS.toLowerCase() &&
    contract.data.chainId === SEPOLIA_CHAIN_ID

  const connectedChain = wallet.state.status === 'connected' ? wallet.state.chainId : null

  const catalogFact: CatalogFact = (() => {
    if (connectedChain === null) {
      return 'loading'
    }

    if (catalog.isPending) {
      return 'loading'
    }

    if (catalog.isError) {
      return 'failed'
    }

    return catalog.data.some((chain) => chain.chainId === connectedChain) ? 'listed' : 'unlisted'
  })()

  // Only after the contract read says this account may see it.
  const events = useQuery(
    contractEventListQuery(dataSession, contractId ?? 0, page, contract.isSuccess),
  )

  /**
   * The current page of events, read again on request.
   *
   * Shared by the receipt check after a submission and after a confirmation, so
   * both ask the same question of the same query: same key, same identity scope,
   * same page. A failed refetch keeps the last successful page in `data`, so
   * `data` alone would be a page from before the failure; nothing is returned then
   * and the caller reports that the refresh failed.
   */
  const refreshEvents = useCallback(async () => {
    const result = await events.refetch()

    if (result.isError || result.error !== null) {
      return null
    }

    return result.data === undefined ? null : { events: result.data.events, page }
  }, [events, page])

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

          {!confirmable && (
            <p className="hint">
              {`Confirming and revoking are only available on the verified Sepolia multisig contract (${MULTISIG_ADDRESS}, chain ${String(
                SEPOLIA_CHAIN_ID,
              )}). This tracked contract is not it, so no action is offered on these events.`}
            </p>
          )}

          <EventResults
            showConfirm={confirmable}
            events={events.data?.events}
            pagination={events.data?.pagination}
            page={page}
            onPage={goToPage}
            isPending={events.isPending}
            isFetching={events.isFetching}
            error={events.error}
            onRetry={() => void events.refetch()}
            contract={contract.data}
            wallet={wallet.state}
            onRefreshEvents={refreshEvents}
          />

          <SubmitTransactionForm
            contract={contract.data}
            wallet={wallet.state}
            catalog={catalogFact}
            onRefreshEvents={refreshEvents}
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
  contract: TrackedContract
  wallet: BrowserWalletState
  onRefreshEvents: () => Promise<RefreshedPage | null>
  /** Whether this contract may be confirmed on at all. */
  showConfirm: boolean
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
  contract,
  wallet,
  onRefreshEvents,
  showConfirm,
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
                {showConfirm && event.eventName === 'SubmitTransaction' && (
                  <>
                    {/*
                      Two actions, one proposal. Each reads the contract before it
                      offers anything, and the verdicts are opposites: an account
                      that has confirmed is offered the revocation, and one that has
                      not is offered the confirmation. Neither is offered for the
                      other's state, so the pair can never both reach a review.
                    */}
                    <ConfirmTransaction
                      contract={contract}
                      event={event}
                      wallet={wallet}
                      onRefreshEvents={onRefreshEvents}
                    />
                    <RevokeTransaction
                      contract={contract}
                      event={event}
                      wallet={wallet}
                      onRefreshEvents={onRefreshEvents}
                    />
                  </>
                )}
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
