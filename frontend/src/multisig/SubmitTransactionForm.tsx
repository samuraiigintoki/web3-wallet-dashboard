import { useQuery } from '@tanstack/react-query'
import { useId, type FormEvent } from 'react'

import { useBrowserWallet } from '../provider/useBrowserWallet.ts'
import { chainCatalogQuery } from '../wallets/chainQueries.ts'
import { FIELD_MESSAGES } from './encoding.ts'
import type { RefreshedPage } from './events.ts'
import { ReceiptCheck } from './ReceiptCheck.tsx'
import {
  useSubmitTransaction,
  type CatalogFact,
  type SubmitPhase,
  type SubmitTarget,
} from './useSubmitTransaction.ts'

/**
 * Submitting one proposal to the tracked multisig contract.
 *
 * The order on this screen is the point of it. The form collects three values;
 * pressing Review encodes the call and shows back exactly what will be sent, in
 * full, including the contract address and the chain; only then does a button
 * exist that opens the wallet. Nothing here signs on the user's behalf, retries,
 * or interprets the calldata.
 *
 * The wallet is read through the same hook the Overview screen uses, on this
 * screen, for this screen: a wallet connection belongs to this browser tab, and
 * one screen's view of it is not evidence about another's.
 *
 * After a submission the screen stops and waits. The receipt and the index are
 * two separate things a user can ask about, in their own time, and nothing here
 * asks for either of them on the user's behalf.
 */
export function SubmitTransactionForm({
  contract,
  onRefreshEvents,
}: {
  contract: SubmitTarget
  /**
   * Reads the current page of indexed events again for this contract, under the
   * signed-in identity. The page owns that query, so it owns the refresh: this
   * form asks the page rather than reaching for the index itself.
   */
  onRefreshEvents: () => Promise<RefreshedPage | null>
}) {
  const { state } = useBrowserWallet()

  /**
   * The public chain catalog, read only once a wallet is connected.
   *
   * The catalog is what makes a chain supported, and it comes from this app's
   * API rather than from the provider: the provider says where the wallet is,
   * and only the deployment can say which chains it knows how to talk about.
   */
  const catalog = useQuery({
    ...chainCatalogQuery(),
    enabled: state.status === 'connected',
  })

  const account = state.status === 'connected' ? state.account : null
  const chainId = state.status === 'connected' ? state.chainId : null

  const catalogFact: CatalogFact = (() => {
    if (chainId === null) {
      return 'loading'
    }

    if (catalog.isPending) {
      return 'loading'
    }

    if (catalog.isError) {
      return 'failed'
    }

    return catalog.data.some((chain) => chain.chainId === chainId) ? 'listed' : 'unlisted'
  })()

  const submission = useSubmitTransaction({
    contract,
    wallet: state,
    catalog: catalogFact,
  })

  return (
    <section className="status" aria-labelledby="submit-heading">
      <h2 id="submit-heading">Submit a transaction</h2>

      <p className="hint">
        Submitting proposes a transaction to this contract. It sends no ETH from
        your account: the amount you enter is an argument inside the calldata, not
        the value of this call. This screen only submits. It does not confirm,
        revoke or execute, and it cannot tell you what the owners will do next.
      </p>

      {/*
        The gate, announced when it changes and only then.

        It is one element at a fixed place in the tree, marked polite, so a screen
        reader hears the new reason when the wallet or the catalog moves and hears
        nothing at all when this component re-renders for any other reason: React
        does not touch the text of a node whose content has not changed, and an
        unchanged live region is not re-announced.
      */}
      <p aria-live="polite" aria-atomic="true">
        {submission.gate.open ? (
          'Sending is available.'
        ) : (
          <>
            Sending is not available.<span className="hint"> {submission.gate.reason}</span>
          </>
        )}
      </p>

      {submission.phase.kind === 'editing' && (
        <SubmitFields
          draft={submission.draft}
          errors={submission.errors}
          canReview={submission.gate.open}
          onField={submission.setField}
          onReview={submission.review}
        />
      )}

      {(submission.phase.kind === 'confirming' || submission.phase.kind === 'sending') && (
        <Confirmation
          phase={submission.phase}
          contract={contract}
          account={account}
          onCancel={submission.cancel}
          onSubmit={() => void submission.submit()}
        />
      )}

      {submission.phase.kind === 'submitted' && (
        <>
          <p role="status">
            Submitted. The wallet returned the transaction hash{' '}
            <span className="mono">{submission.phase.hash}</span>
          </p>
          <p className="hint">
            A returned hash means the wallet accepted this transaction and gave it
            an identifier. It does not mean it was mined, confirmed by the other
            owners, executed, or indexed, and this app is not watching for any of
            that.
          </p>
          <ReceiptCheck
            // Keyed by the submission, so a different hash or a different
            // context is a different component with no memory of the last one.
            key={`${submission.phase.hash}:${contract.id}:${String(contract.chainId)}`}
            hash={submission.phase.hash}
            contract={contract}
            wallet={state}
            onRefreshEvents={onRefreshEvents}
          />

          <div className="status__actions">
            <button type="button" onClick={submission.startAnother}>
              Submit another
            </button>
          </div>
        </>
      )}

      {submission.phase.kind === 'failed' && (
        <>
          <p role="alert">{submission.phase.message}</p>
          <p className="hint">
            {submission.phase.declined
              ? 'A refusal in the wallet does not prove that nothing was sent. Check the wallet before submitting again.'
              : 'This app cannot tell whether the wallet sent this transaction. Check the wallet before submitting again.'}
          </p>
          <div className="status__actions">
            <button type="button" onClick={submission.back}>
              Back to the form
            </button>
          </div>
        </>
      )}

      <p className="hint">
        The connected account is the one that would send this transaction. That is
        all it is: nothing here shows that it owns the contract, that it is one of
        the contract&apos;s owners, or that it has anything to do with the wallets
        saved in this dashboard.
      </p>
    </section>
  )
}

type SubmitFieldsProps = {
  draft: { destination: string; valueWei: string; data: string }
  errors: Partial<Record<'destination' | 'valueWei' | 'data', string>>
  canReview: boolean
  onField: (field: 'destination' | 'valueWei' | 'data', value: string) => void
  onReview: () => boolean
}

/**
 * The three values, and the button that validates them.
 *
 * The inputs stay writable while sending is unavailable: a user can prepare a
 * submission before connecting a wallet, and nothing they type here can reach
 * the chain on its own. Only Review is gated, and it is gated because it is the
 * step that leads to the wallet.
 */
function SubmitFields({ draft, errors, canReview, onField, onReview }: SubmitFieldsProps) {
  const destinationId = useId()
  const valueId = useId()
  const dataId = useId()

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    onReview()
  }

  return (
    <form className="form" onSubmit={handleSubmit} noValidate>
      <div className="field">
        <label htmlFor={destinationId}>Destination address</label>
        <input
          id={destinationId}
          name="destination"
          value={draft.destination}
          onChange={(event) => {
            onField('destination', event.target.value)
          }}
          autoComplete="off"
          spellCheck={false}
          aria-describedby={`${destinationId}-error`}
        />
        <span className="hint">The address the multisig would call if this proposal is confirmed.</span>
        {errors.destination !== undefined && (
          <span className="field__error" id={`${destinationId}-error`} role="alert">
            {errors.destination}
          </span>
        )}
      </div>

      <div className="field">
        <label htmlFor={valueId}>Value in wei</label>
        <input
          id={valueId}
          name="valueWei"
          value={draft.valueWei}
          onChange={(event) => {
            onField('valueWei', event.target.value)
          }}
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          aria-describedby={`${valueId}-error`}
        />
        <span className="hint">
          Whole decimal digits, exactly as they will be submitted. This app does
          not convert wei to any currency and does not round the value.
        </span>
        {errors.valueWei !== undefined && (
          <span className="field__error" id={`${valueId}-error`} role="alert">
            {errors.valueWei}
          </span>
        )}
      </div>

      <div className="field">
        <label htmlFor={dataId}>Calldata</label>
        <input
          id={dataId}
          name="data"
          value={draft.data}
          onChange={(event) => {
            onField('data', event.target.value)
          }}
          autoComplete="off"
          spellCheck={false}
          aria-describedby={`${dataId}-error`}
        />
        <span className="hint">
          {FIELD_MESSAGES.data} This app does not decode it, so read it against
          your own source before submitting.
        </span>
        {errors.data !== undefined && (
          <span className="field__error" id={`${dataId}-error`} role="alert">
            {errors.data}
          </span>
        )}
      </div>

      <div className="status__actions">
        <button type="submit" disabled={!canReview}>
          Review submission
        </button>
      </div>
    </form>
  )
}

type ConfirmationProps = {
  phase: Extract<SubmitPhase, { kind: 'confirming' | 'sending' }>
  contract: SubmitTarget
  account: string | null
  onCancel: () => void
  onSubmit: () => void
}

/**
 * Everything that will be sent, before the wallet is asked for anything.
 *
 * The contract address, the chain and the sender are restated here rather than
 * left on the page above, because this is the screen a user reads immediately
 * before approving. The value is shown as the exact decimal the wallet will
 * encode, with the unit spelled out, and the call's own value is shown as zero so
 * that "value" cannot be read as a transfer from the connected account.
 */
function Confirmation({ phase, contract, account, onCancel, onSubmit }: ConfirmationProps) {
  const sending = phase.kind === 'sending'
  const request = phase.request

  return (
    <>
      <dl className="browser-wallet__facts">
        <dt>Contract</dt>
        <dd className="mono">{request.to}</dd>
        <dt>Chain ID</dt>
        <dd>{String(contract.chainId)}</dd>
        <dt>From</dt>
        <dd className="mono">{account}</dd>
        <dt>Destination</dt>
        <dd className="mono">{request.destination}</dd>
        <dt>Value</dt>
        <dd>
          <span className="mono">{request.valueWei}</span> wei
        </dd>
        <dt>Calldata</dt>
        <dd className="mono">{request.calldata}</dd>
        <dt>Call value</dt>
        <dd>0 wei. The amount above is inside the calldata, not paid by this call.</dd>
      </dl>

      <p>
        Check each line against what you intended. The next button opens your
        wallet with one transaction to the contract above. Nothing is retried, and
        declining in the wallet sends nothing from this screen.
      </p>

      <div className="status__actions">
        <button type="button" onClick={onSubmit} disabled={sending}>
          Open wallet and submit
        </button>
        <button type="button" onClick={onCancel} disabled={sending}>
          Cancel
        </button>
      </div>

      {sending && <p role="status">Waiting for the wallet.</p>}
    </>
  )
}
