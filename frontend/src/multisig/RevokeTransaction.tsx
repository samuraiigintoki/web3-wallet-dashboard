import type { ContractEvent } from '../api/index.ts'
import type { BrowserWalletState } from '../provider/useBrowserWallet.ts'
import { ActionPanel, type ActionWords } from './ActionPanel.tsx'
import type { RefreshedPage } from './events.ts'
import { checkRevokeEligibility } from './revoke.ts'
import type { SubmitTarget } from './useSubmitTransaction.ts'
import { useRevokeTransaction } from './useRevokeTransaction.ts'

export type RevokeTransactionProps = {
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
 * Revoking your own confirmation on one indexed proposal.
 *
 * The same procedure as confirming, with the opposite preflight: the contract
 * must say this account has confirmed, not that it has not. Nothing here touches
 * another owner's confirmation, the proposal itself, or execution: the call is
 * `revokeConfirmation(index)` and the contract removes exactly the caller's own
 * confirmation.
 */
export function RevokeTransaction({
  contract,
  event,
  wallet,
  onRefreshEvents,
}: RevokeTransactionProps) {
  const eligibility = checkRevokeEligibility(event, contract.address, contract.chainId)

  if (!eligibility.eligible) {
    return <p className="hint">{REVOKE_WORDS.cannotPrefix}: {eligibility.reason}</p>
  }

  return (
    <RevokeControl
      contract={contract}
      index={eligibility.index}
      payload={eligibility.payload}
      wallet={wallet}
      onRefreshEvents={onRefreshEvents}
    />
  )
}

function RevokeControl({
  contract,
  index,
  payload,
  wallet,
  onRefreshEvents,
}: {
  contract: SubmitTarget
  index: bigint
  payload: Parameters<typeof useRevokeTransaction>[0]['payload']
  wallet: BrowserWalletState
  onRefreshEvents: () => Promise<RefreshedPage | null>
}) {
  const revoke = useRevokeTransaction({
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
      phase={revoke.phase}
      gate={revoke.gate}
      words={REVOKE_WORDS}
      onRefreshEvents={onRefreshEvents}
      onCheck={() => void revoke.check()}
      onCancel={revoke.cancel}
      onSubmit={() => void revoke.submit()}
      onRetry={revoke.retry}
    />
  )
}

/** Every sentence that makes this the revoking action rather than the confirming one. */
const REVOKE_WORDS: ActionWords = {
  cannotPrefix: 'Cannot revoke',
  gateSentence: 'Revoking is not available.',
  checkLabel: 'Revoke my confirmation',
  checkingSentence: 'Reading your confirmation from the contract.',
  reviewIntro:
    'The contract was read just now and this account has an active confirmation on the proposal above. The next button opens your wallet with one revocation, for this index and no other, and the call itself sends no value. It removes your own confirmation only: the proposal stays as it is, and nothing is executed. Nothing is retried.',
  openLabel: 'Open wallet and revoke',
  cancelLabel: 'Cancel',
  sendingSentence: 'Waiting for the wallet.',
  sentLead: 'Sent.',
  sentNote:
    'The revocation has been sent, and that is all this app knows. It does not mean the transaction is in a block, that the confirmation is gone from the contract, or that the block is final.',
  declinedNote:
    'A refusal in the wallet does not prove that nothing was sent. Check the wallet before trying again.',
  unknownNote:
    'This app cannot tell whether the wallet sent this revocation. Check the wallet before trying again.',
  receiptPurpose: (index, actor) => ({ kind: 'revoke', index, actor }),
}
