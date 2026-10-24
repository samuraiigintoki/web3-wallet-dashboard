import { useState } from 'react'

import type { BrowserWalletState } from '../provider/useBrowserWallet.ts'
import type { RefreshedPage } from './events.ts'
import { ReceiptCheck, type ReceiptPurpose } from './ReceiptCheck.tsx'
import type { MultisigActionPhase } from './useMultisigAction.ts'
import type { MultisigGate } from './gate.ts'
import type { Preflight } from './confirm.ts'
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
  /**
   * What the review must say about the risk of this particular action.
   *
   * Only execution has one, and only execution can have one: the other two
   * actions call this contract, execution calls whatever this contract was told
   * to call.
   */
  warning?: string
  /**
   * A deliberate step before the wallet opens.
   *
   * Present only where the action needs one, and it is not a formality: a box the
   * user has to tick is the difference between reading the destination and
   * pressing through a dialog.
   */
  acknowledgement?: { label: string; note: string }
}

/** One extra fact the review must restate, for actions that read more. */
export type ReviewFact = { label: string; value: string; mono?: boolean }

export type ActionPanelProps<P extends Preflight = Preflight> = {
  /** The tracked contract, as the server record has it. */
  contract: SubmitTarget
  /** The wallet, read by the page rather than by every row. */
  wallet: BrowserWalletState
  /** Where the action is. */
  phase: MultisigActionPhase<P>
  /** Whether it is offered at all. */
  gate: MultisigGate
  /** The sentences that make this action itself. */
  words: ActionWords
  /** Further facts the review has to show, drawn from this action's preflight. */
  facts?: (preflight: P) => readonly ReviewFact[]
  /** Reads the current page of indexed events again, under the signed-in identity. */
  onRefreshEvents: () => Promise<RefreshedPage | null>
  onCheck: () => void
  onCancel: () => void
  onSubmit: () => void
  onRetry: () => void
}

export function ActionPanel<P extends Preflight = Preflight>({
  contract,
  wallet,
  phase,
  gate,
  words,
  facts,
  onRefreshEvents,
  onCheck,
  onCancel,
  onSubmit,
  onRetry,
}: ActionPanelProps<P>) {
  const account = wallet.status === 'connected' ? wallet.account : null

  /**
   * Whether the user has acknowledged what this action will do.
   *
   * Held here rather than in the hook because it is not a fact about the chain: it
   * is a fact about this person having read the review. It is dropped whenever the
   * panel leaves the review, so a second attempt has to be acknowledged again.
   */
  const [acknowledged, setAcknowledged] = useState(false)
  const reviewing = phase.kind === 'ready' || phase.kind === 'sending'

  if (!reviewing && acknowledged) {
    setAcknowledged(false)
  }

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
          facts={facts}
          acknowledged={acknowledged}
          onAcknowledged={setAcknowledged}
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
function Review<P extends Preflight>({
  phase,
  contract,
  account,
  words,
  facts,
  acknowledged,
  onAcknowledged,
  onCancel,
  onSubmit,
}: {
  phase: Extract<MultisigActionPhase<P>, { kind: 'ready' | 'sending' }>
  contract: SubmitTarget
  account: string | null
  words: ActionWords
  facts?: (preflight: P) => readonly ReviewFact[]
  acknowledged: boolean
  onAcknowledged: (value: boolean) => void
  onCancel: () => void
  onSubmit: () => void
}) {
  const sending = phase.kind === 'sending'
  const { preflight } = phase
  const extra = facts === undefined ? [] : facts(preflight)
  const needsAcknowledgement = words.acknowledgement !== undefined

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

        {extra.map((fact) => (
          <Fact key={fact.label} fact={fact} />
        ))}
      </dl>

      <p>{words.reviewIntro}</p>

      {words.warning === undefined ? null : (
        <p role="note" className="status status--warning">
          {words.warning}
        </p>
      )}

      {words.acknowledgement === undefined ? null : (
        <div className="status__actions">
          <label>
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(change) => {
                onAcknowledged(change.target.checked)
              }}
              disabled={sending}
            />{' '}
            {words.acknowledgement.label}
          </label>
          <p className="hint">{words.acknowledgement.note}</p>
        </div>
      )}

      <div className="status__actions">
        <button
          type="button"
          onClick={onSubmit}
          disabled={sending || (needsAcknowledgement && !acknowledged)}
        >
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

function Fact({ fact }: { fact: ReviewFact }) {
  return (
    <>
      <dt>{fact.label}</dt>
      <dd className={fact.mono === true ? 'mono' : undefined}>{fact.value}</dd>
    </>
  )
}
