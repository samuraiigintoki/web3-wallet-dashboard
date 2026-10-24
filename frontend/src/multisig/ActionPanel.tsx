import type { BrowserWalletState } from '../provider/useBrowserWallet.ts'
import type { RefreshedPage } from './events.ts'
import { ReceiptCheck, type ReceiptPurpose } from './ReceiptCheck.tsx'
import type { MultisigActionPhase } from './useMultisigAction.ts'
import type { MultisigGate } from './gate.ts'
import type { SubmitTarget } from './useSubmitTransaction.ts'

/**
 * One multisig action as the user meets it.
 *
 * Confirming and revoking produce the same seven states in the same order, and
 * the difference between them is a handful of sentences plus which receipt
 * purpose to embed. Keeping one panel means a change to that order, or to the
 * safeguards around it, cannot apply to one action and miss the other.
 *
 * The order is the security property. The button reads the contract and nothing
 * else; only a preflight that passed produces a review; only the review has a
 * button that opens the wallet. A user therefore never approves a call whose
 * details this app has not just read from the chain.
 */
export type ActionWords = {
  /** How a row that names no action begins its refusal, e.g. "Cannot confirm". */
  cannotPrefix: string
  /** The stable sentence the gate region carries when the action is unavailable. */
  gateSentence: string
  /** The first button, which only reads. */
  checkLabel: string
  /** What is announced while the four reads are in flight. */
  checkingSentence: string
  /** What the review says the contract was just read for. */
  reviewIntro: string
  /** The second button, the one that opens the wallet. */
  openLabel: string
  /** The label of the control that leaves the review without sending. */
  cancelLabel: string
  /** What is announced while the wallet has the request. */
  sendingSentence: string
  /** The lead of the sentence that reports a hash. */
  sentLead: string
  /** What a hash does not mean, for this action. */
  sentNote: string
  /** What a refusal in the wallet leaves uncertain. */
  declinedNote: string
  /** What an unreadable send leaves uncertain. */
  unknownNote: string
  /** The receipt purpose this action checks after a hash exists. */
  receiptPurpose: (indexText: string, actor: string) => ReceiptPurpose
}

export type ActionPanelProps = {
  /** The tracked contract, as the server record has it. */
  contract: SubmitTarget
  /** The wallet, read by the page rather than by every row. */
  wallet: BrowserWalletState
  /** Where the action is. */
  phase: MultisigActionPhase
  /** Whether it is offered at all. */
  gate: MultisigGate
  /** The sentences that make this action itself. */
  words: ActionWords
  /** Reads the current page of indexed events again, under the signed-in identity. */
  onRefreshEvents: () => Promise<RefreshedPage | null>
  onCheck: () => void
  onCancel: () => void
  onSubmit: () => void
  onRetry: () => void
}

export function ActionPanel({
  contract,
  wallet,
  phase,
  gate,
  words,
  onRefreshEvents,
  onCheck,
  onCancel,
  onSubmit,
  onRetry,
}: ActionPanelProps) {
  const account = wallet.status === 'connected' ? wallet.account : null

  return (
    <div className="confirm">
      {/*
        The gate, in one stable polite region: a screen reader hears the reason
        when the wallet or the chain moves, and nothing when this row re-renders
        for any other reason.
      */}
      {!gate.open && (
        <p aria-live="polite" aria-atomic="true">
          {words.gateSentence}
          {gate.reason === '' ? null : <span className="hint"> {gate.reason}</span>}
        </p>
      )}

      {phase.kind === 'idle' && (
        <div className="status__actions">
          <button type="button" onClick={onCheck} disabled={!gate.open}>
            {words.checkLabel}
          </button>
        </div>
      )}

      {phase.kind === 'checking' && <p role="status">{words.checkingSentence}</p>}

      {phase.kind === 'refused' && (
        <>
          <p role="alert">{phase.reason}</p>
          <div className="status__actions">
            <button type="button" onClick={onRetry}>
              Back
            </button>
          </div>
        </>
      )}

      {(phase.kind === 'ready' || phase.kind === 'sending') && (
        <Review
          phase={phase}
          contract={contract}
          account={account}
          words={words}
          onCancel={onCancel}
          onSubmit={onSubmit}
        />
      )}

      {phase.kind === 'sent' && (
        <>
          <p role="status">
            {words.sentLead} The wallet returned the transaction hash{' '}
            <span className="mono">{phase.hash}</span>
          </p>
          <p className="hint">{words.sentNote}</p>

          <ReceiptCheck
            key={`${phase.hash}:${contract.id}:${String(contract.chainId)}`}
            hash={phase.hash}
            contract={contract}
            purpose={words.receiptPurpose(phase.preflight.indexText, account ?? '')}
            wallet={wallet}
            onRefreshEvents={onRefreshEvents}
          />

          <div className="status__actions">
            <button type="button" onClick={onRetry}>
              Done
            </button>
          </div>
        </>
      )}

      {phase.kind === 'failed' && (
        <>
          <p role="alert">{phase.message}</p>
          <p className="hint">{phase.declined ? words.declinedNote : words.unknownNote}</p>
          <div className="status__actions">
            <button type="button" onClick={onRetry}>
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
 * because the index is what the wallet will sign and a wrong one would act on a
 * different proposal with the same button.
 */
function Review({
  phase,
  contract,
  account,
  words,
  onCancel,
  onSubmit,
}: {
  phase: Extract<MultisigActionPhase, { kind: 'ready' | 'sending' }>
  contract: SubmitTarget
  account: string | null
  words: ActionWords
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

      <p>{words.reviewIntro}</p>

      <div className="status__actions">
        <button type="button" onClick={onSubmit} disabled={sending}>
          {words.openLabel}
        </button>
        <button type="button" onClick={onCancel} disabled={sending}>
          {words.cancelLabel}
        </button>
      </div>

      {sending && <p role="status">{words.sendingSentence}</p>}
    </>
  )
}
