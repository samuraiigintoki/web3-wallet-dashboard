import type { ContractEvent, SubmitTransactionPayload } from '../api/index.ts'
import type { BrowserWalletState } from '../provider/useBrowserWallet.ts'
import { checkEligibility } from './confirm.ts'
import type { RefreshedPage } from './events.ts'
import { ReceiptCheck } from './ReceiptCheck.tsx'
import {
  useConfirmTransaction,
  type ConfirmPhase,
} from './useConfirmTransaction.ts'
import type { SubmitTarget } from './useSubmitTransaction.ts'

export type ConfirmTransactionProps = {
  /** The tracked contract, as the server record has it. */
  contract: SubmitTarget
  /** This row, which must be a `SubmitTransaction` whose index this app can read. */
  event: ContractEvent
  /** The browser wallet, read by the page rather than by every row. */
  wallet: BrowserWalletState
  /** Reads the current page of indexed events again, under the signed-in identity. */
  onRefreshEvents: () => Promise<RefreshedPage | null>
}

/**
 * Confirming one indexed proposal, from the row that describes it.
 *
 * The order is the whole of it. The button reads the contract and nothing else:
 * four view calls that decide whether this account may confirm this proposal and
 * whether the proposal is still the one the event describes. Only a preflight
 * that answers all four acceptably produces a review, and only the review has a
 * button that opens the wallet. A user therefore never approves a confirmation
 * whose details this app has not just read from the chain.
 *
 * The index comes from the row, not from anything the form owns, so the proposal
 * confirmed is the proposal shown. Revocation and execution are not offered
 * anywhere: one proposal, one confirmation, one transaction.
 */
export function ConfirmTransaction({
  contract,
  event,
  wallet,
  onRefreshEvents,
}: ConfirmTransactionProps) {
  const eligibility = checkEligibility(event, contract.address, contract.chainId)

  // An event whose index or payload this app cannot read names no proposal. The
  // row still renders, because the event is real; the action does not.
  if (!eligibility.eligible) {
    return (
      <p className="hint">
        Cannot confirm: {eligibility.reason}
      </p>
    )
  }

  return (
    <ConfirmControl
      contract={contract}
      index={eligibility.index}
      payload={eligibility.payload}
      wallet={wallet}
      onRefreshEvents={onRefreshEvents}
    />
  )
}

function ConfirmControl({
  contract,
  index,
  payload,
  wallet,
  onRefreshEvents,
}: {
  contract: SubmitTarget
  index: bigint
  payload: SubmitTransactionPayload
  wallet: BrowserWalletState
  onRefreshEvents: () => Promise<RefreshedPage | null>
}) {
  const confirm = useConfirmTransaction({
    contractAddress: contract.address,
    contractChainId: contract.chainId,
    index,
    payload,
    wallet,
  })

  const phase: ConfirmPhase = confirm.phase

  return (
    <div className="confirm">
      {/*
        The gate, in one stable polite region: a screen reader hears the reason
        when the wallet or the chain moves, and nothing when this row re-renders
        for any other reason.
      */}
      {!confirm.gate.open && (
        <p aria-live="polite" aria-atomic="true">
          Confirming is not available.<span className="hint"> {confirm.gate.reason}</span>
        </p>
      )}

      {phase.kind === 'idle' && (
        <div className="status__actions">
          <button type="button" onClick={() => void confirm.check()} disabled={!confirm.gate.open}>
            Confirm proposal
          </button>
        </div>
      )}

      {phase.kind === 'checking' && (
        <p role="status">Reading the proposal from the contract.</p>
      )}

      {phase.kind === 'refused' && (
        <>
          <p role="alert">{phase.reason}</p>
          <div className="status__actions">
            <button type="button" onClick={confirm.retry}>
              Back
            </button>
          </div>
        </>
      )}

      {(phase.kind === 'ready' || phase.kind === 'sending') && (
        <Review
          phase={phase}
          contract={contract}
          account={wallet.status === 'connected' ? wallet.account : null}
          onCancel={confirm.cancel}
          onSubmit={() => void confirm.submit()}
        />
      )}

      {phase.kind === 'sent' && (
        <>
          <p role="status">
            Submitted. The wallet returned the transaction hash{' '}
            <span className="mono">{phase.hash}</span>
          </p>
          <p className="hint">
            The confirmation has been sent, and that is all this app knows. It does
            not mean the transaction is in a block, that the proposal has reached its
            threshold, or that it has been executed.
          </p>

          <ReceiptCheck
            key={`${phase.hash}:${contract.id}:${String(contract.chainId)}`}
            hash={phase.hash}
            contract={contract}
            purpose={{
              kind: 'confirm',
              index: phase.preflight.indexText,
              actor: wallet.status === 'connected' ? wallet.account : '',
            }}
            wallet={wallet}
            onRefreshEvents={onRefreshEvents}
          />

          <div className="status__actions">
            <button type="button" onClick={confirm.retry}>
              Done
            </button>
          </div>
        </>
      )}

      {phase.kind === 'failed' && (
        <>
          <p role="alert">{phase.message}</p>
          <p className="hint">
            {phase.declined
              ? 'A refusal in the wallet does not prove that nothing was sent. Check the wallet before trying again.'
              : 'This app cannot tell whether the wallet sent this confirmation. Check the wallet before trying again.'}
          </p>
          <div className="status__actions">
            <button type="button" onClick={confirm.retry}>
              Back
            </button>
          </div>
        </>
      )}
    </div>
  )
}

/**
 * What will be sent, before the wallet is asked for anything.
 *
 * One proposal, named five ways: the contract, the chain, the sender, the index,
 * and the destination, value and calldata that index points at on the contract
 * right now. The index is shown in both forms, decimal and the exact calldata,
 * because the index is what the wallet will sign and a wrong one would confirm a
 * different proposal with the same button.
 */
function Review({
  phase,
  contract,
  account,
  onCancel,
  onSubmit,
}: {
  phase: Extract<ConfirmPhase, { kind: 'ready' | 'sending' }>
  contract: SubmitTarget
  account: string | null
  onCancel: () => void
  onSubmit: () => void
}) {
  const sending = phase.kind === 'sending'
  const { preflight } = phase

  return (
    <>
      <dl className="browser-wallet__facts">
        <dt>Contract</dt>
        <dd className="mono">{contract.address}</dd>
        <dt>Chain ID</dt>
        <dd>{String(contract.chainId)}</dd>
        <dt>From</dt>
        <dd className="mono">{account}</dd>
        <dt>Proposal index</dt>
        <dd>{preflight.indexText}</dd>
        <dt>Destination</dt>
        <dd className="mono">{preflight.proposal.to}</dd>
        <dt>Value</dt>
        <dd>
          <span className="mono">{preflight.proposal.valueWei.toString(10)}</span> wei
        </dd>
        <dt>Calldata</dt>
        <dd className="mono">{preflight.proposal.data}</dd>
        <dt>This call</dt>
        <dd className="mono">{preflight.data}</dd>
      </dl>

      <p>
        The contract was read just now and this account may confirm the proposal
        above. The next button opens your wallet with one confirmation, for this
        index and no other, and the call itself sends no value. Nothing is retried.
      </p>

      <div className="status__actions">
        <button type="button" onClick={onSubmit} disabled={sending}>
          Open wallet and confirm
        </button>
        <button type="button" onClick={onCancel} disabled={sending}>
          Cancel
        </button>
      </div>

      {sending && <p role="status">Waiting for the wallet.</p>}
    </>
  )
}
