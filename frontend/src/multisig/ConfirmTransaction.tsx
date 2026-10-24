import type { ContractEvent } from '../api/index.ts'
import type { BrowserWalletState } from '../provider/useBrowserWallet.ts'
import { ActionPanel, type ActionWords } from './ActionPanel.tsx'
import { checkEligibility } from './confirm.ts'
import type { RefreshedPage } from './events.ts'
import { useConfirmTransaction } from './useConfirmTransaction.ts'
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
 * The index comes from the row, not from anything the form owns, so the proposal
 * confirmed is the proposal shown. Revocation and execution are not offered here:
 * one proposal, one confirmation, one transaction. The procedure itself lives in
 * `ActionPanel` and `useMultisigAction`, shared with revoking, which is the same
 * procedure with the opposite verdict.
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
    return <p className="hint">{CONFIRM_WORDS.cannotPrefix}: {eligibility.reason}</p>
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
  payload: Parameters<typeof useConfirmTransaction>[0]['payload']
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

  return (
    <ActionPanel
      contract={contract}
      wallet={wallet}
      phase={confirm.phase}
      gate={confirm.gate}
      words={CONFIRM_WORDS}
      onRefreshEvents={onRefreshEvents}
      onCheck={() => void confirm.check()}
      onCancel={confirm.cancel}
      onSubmit={() => void confirm.submit()}
      onRetry={confirm.retry}
    />
  )
}

/**
 * Every sentence that makes this the confirming action rather than the revoking
 * one, held apart from the panel that draws them.
 */
const CONFIRM_WORDS: ActionWords = {
  cannotPrefix: 'Cannot confirm',
  gateSentence: 'Confirming is not available.',
  checkLabel: 'Confirm proposal',
  checkingSentence: 'Reading the proposal from the contract.',
  reviewIntro:
    'The contract was read just now and this account may confirm the proposal above. The next button opens your wallet with one confirmation, for this index and no other, and the call itself sends no value. Nothing is retried.',
  openLabel: 'Open wallet and confirm',
  cancelLabel: 'Cancel',
  sendingSentence: 'Waiting for the wallet.',
  sentLead: 'Submitted.',
  sentNote:
    'The confirmation has been sent, and that is all this app knows. It does not mean the transaction is in a block, that the proposal has reached its threshold, or that it has been executed.',
  declinedNote:
    'A refusal in the wallet does not prove that nothing was sent. Check the wallet before trying again.',
  unknownNote:
    'This app cannot tell whether the wallet sent this confirmation. Check the wallet before trying again.',
  receiptPurpose: (index, actor) => ({ kind: 'confirm', index, actor }),
}
