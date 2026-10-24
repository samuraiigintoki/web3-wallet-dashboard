import type { ContractEvent, SubmitTransactionPayload } from '../api/index.ts'
import type { BrowserWalletState } from '../provider/useBrowserWallet.ts'
import {
  checkStatusEligibility,
  type ProposalStatus as Status,
} from './status.ts'
import { useProposalStatus, type StatusPhase } from './useProposalStatus.ts'
import type { SubmitTarget } from './useSubmitTransaction.ts'

export type ProposalStatusProps = {
  /** The tracked contract, as the server record has it. */
  contract: SubmitTarget
  /** This row, which must be a `SubmitTransaction` whose index this app can read. */
  event: ContractEvent
  /** The browser wallet, read by the page rather than by every row. */
  wallet: BrowserWalletState
}

/**
 * One proposal's live status, read on request.
 *
 * This is the only control on the event view that asks the chain a question
 * without offering to change it. It is a separate component from the three
 * actions on purpose: it has no review, no acknowledgement and no wallet prompt,
 * so sharing the action panel would mean sharing a screen built to send.
 *
 * What it shows is a snapshot at one block, and it says so next to the facts. A
 * threshold that has been met at a block is not a promise that the destination
 * call would succeed, and this screen does not imply otherwise.
 */
export function ProposalStatus({ contract, event, wallet }: ProposalStatusProps) {
  const eligibility = checkStatusEligibility(event, contract.address, contract.chainId)

  if (!eligibility.eligible) {
    return (
      <p className="hint">
        Cannot show live status: {eligibility.reason}
      </p>
    )
  }

  return (
    <StatusControl
      contract={contract}
      index={eligibility.index}
      payload={eligibility.payload}
      wallet={wallet}
    />
  )
}

function StatusControl({
  contract,
  index,
  payload,
  wallet,
}: {
  contract: SubmitTarget
  index: bigint
  payload: SubmitTransactionPayload
  wallet: BrowserWalletState
}) {
  const status = useProposalStatus({
    contractAddress: contract.address,
    contractChainId: contract.chainId,
    index,
    payload,
    wallet,
  })

  return (
    <section className="confirm" aria-label={`Live status of proposal ${index.toString(10)}`}>
      {!status.gate.open && (
        <p aria-live="polite" aria-atomic="true">
          Live status is not available.
          {status.gate.reason === '' ? null : (
            <span className="hint"> {status.gate.reason}</span>
          )}
        </p>
      )}

      <StatusBody
        phase={status.phase}
        gateOpen={status.gate.open}
        onRead={() => void status.read()}
        onClear={status.clear}
      />
    </section>
  )
}

function StatusBody({
  phase,
  gateOpen,
  onRead,
  onClear,
}: {
  phase: StatusPhase
  gateOpen: boolean
  onRead: () => void
  onClear: () => void
}) {
  if (phase.kind === 'idle') {
    return (
      <div className="status__actions">
        <button type="button" onClick={onRead} disabled={!gateOpen}>
          Check live status
        </button>
      </div>
    )
  }

  if (phase.kind === 'reading') {
    return (
      <p aria-live="polite" aria-atomic="true">
        Reading the proposal, the owners and their confirmations from the contract at one block.
      </p>
    )
  }

  if (phase.kind === 'refused') {
    return (
      <>
        <p role="alert">{phase.reason}</p>
        <div className="status__actions">
          <button type="button" onClick={onClear}>
            Back
          </button>
        </div>
      </>
    )
  }

  return (
    <>
      {phase.outcome.kind === 'live' ? (
        <LiveStatus status={phase.outcome.status} />
      ) : (
        <p aria-live="polite" aria-atomic="true">
          {`At block ${phase.outcome.blockText} the contract held ${phase.outcome.transactionCount} proposals, so index ${phase.outcome.indexText} names no live proposal.`}
        </p>
      )}

      <div className="status__actions">
        <button type="button" onClick={onRead}>
          Check again
        </button>
        <button type="button" onClick={onClear}>
          Done
        </button>
      </div>
    </>
  )
}

/** The snapshot itself, as the contract answered it. */
function LiveStatus({ status }: { status: Status }) {
  const confirmed = status.confirmations.filter((entry) => entry.confirmed)
  const unconfirmed = status.confirmations.filter((entry) => !entry.confirmed)

  return (
    <>
      <dl className="browser-wallet__facts">
        <dt>Snapshot block</dt>
        <dd className="mono">{status.blockText}</dd>
        <dt>Proposal index</dt>
        <dd>{status.indexText}</dd>
        <dt>Destination</dt>
        <dd className="mono">{status.proposal.to}</dd>
        <dt>Value</dt>
        <dd>
          <span className="mono">{status.proposal.valueWei.toString(10)}</span> wei
        </dd>
        <dt>Calldata</dt>
        <dd className="mono">{status.proposal.data}</dd>
        <dt>Execution status</dt>
        <dd>{status.executed ? 'Executed at this block' : 'Not executed at this block'}</dd>
        <dt>Owners</dt>
        <dd>{String(status.owners.length)}</dd>
        <dt>Threshold</dt>
        <dd>{status.threshold.toString(10)}</dd>
        <dt>Confirmed owners</dt>
        <dd>
          {`${String(status.confirmedCount)} of ${String(
            status.owners.length,
          )} owners, with ${status.threshold.toString(10)} required`}
        </dd>
      </dl>

      <p>
        {status.executed
          ? `The contract reports this proposal as executed at block ${status.blockText}, so it cannot be executed again.`
          : status.thresholdMet
            ? `This proposal has ${String(status.confirmedCount)} of the ${status.threshold.toString(
                10,
              )} confirmations this contract requires at block ${status.blockText}, so it could be executed from here. That does not mean the call it makes would succeed, and a later block may say something else.`
            : `This proposal has ${String(status.confirmedCount)} of the ${status.threshold.toString(
                10,
              )} confirmations this contract requires at block ${status.blockText}.`}
      </p>

      <p>
        {confirmed.length === 0
          ? `No owner had confirmed this proposal at block ${status.blockText}.`
          : `The contract reported a confirmation from ${confirmed
              .map((entry) => entry.owner)
              .join(', ')} at block ${status.blockText}.`}
      </p>

      {unconfirmed.length === 0 ? null : (
        <p>
          {`The contract reported no confirmation from ${unconfirmed
            .map((entry) => entry.owner)
            .join(', ')} at block ${status.blockText}.`}
        </p>
      )}

      <p>
        {status.viewerIsOwner
          ? status.viewerConfirmed
            ? 'Your account is one of the owners, and the contract reported its confirmation at this block.'
            : 'Your account is one of the owners, and the contract reported no confirmation from it at this block.'
          : 'Your account is not an owner of this contract, so it cannot confirm or execute this proposal.'}
      </p>

      <p className="hint">
        This is what the contract reported at one block, not a live feed. Nothing here refreshes by
        itself, these confirmations are not read from the indexed events above, and the contract
        remains the authority for what happens next.
      </p>
    </>
  )
}
