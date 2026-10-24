import type { ContractEvent } from '../api/index.ts'
import type { BrowserWalletState } from '../provider/useBrowserWallet.ts'
import { ActionPanel, type ActionWords, type ReviewFact } from './ActionPanel.tsx'
import type { RefreshedPage } from './events.ts'
import { checkExecuteEligibility, type ExecutePreflight } from './execute.ts'
import type { SubmitTarget } from './useSubmitTransaction.ts'
import { useExecuteTransaction } from './useExecuteTransaction.ts'

export type ExecuteTransactionProps = {
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
 * Executing one threshold-satisfied proposal.
 *
 * This is the one action in this app that calls something other than the multisig
 * itself. The review says so in the plainest words available, states that the
 * calldata is not decoded here, and asks for an acknowledgement before the wallet
 * can be opened. The preflight is a snapshot at one block, and the contract is
 * still the authority when the transaction is mined.
 */
export function ExecuteTransaction({
  contract,
  event,
  wallet,
  onRefreshEvents,
}: ExecuteTransactionProps) {
  const eligibility = checkExecuteEligibility(event, contract.address, contract.chainId)

  if (!eligibility.eligible) {
    return <p className="hint">{EXECUTE_WORDS.cannotPrefix}: {eligibility.reason}</p>
  }

  return (
    <ExecuteControl
      contract={contract}
      index={eligibility.index}
      payload={eligibility.payload}
      wallet={wallet}
      onRefreshEvents={onRefreshEvents}
    />
  )
}

function ExecuteControl({
  contract,
  index,
  payload,
  wallet,
  onRefreshEvents,
}: {
  contract: SubmitTarget
  index: bigint
  payload: Parameters<typeof useExecuteTransaction>[0]['payload']
  wallet: BrowserWalletState
  onRefreshEvents: () => Promise<RefreshedPage | null>
}) {
  const execute = useExecuteTransaction({
    contractAddress: contract.address,
    contractChainId: contract.chainId,
    index,
    payload,
    wallet,
  })

  return (
    <ActionPanel<ExecutePreflight>
      contract={contract}
      wallet={wallet}
      phase={execute.phase}
      gate={execute.gate}
      words={EXECUTE_WORDS}
      facts={executionFacts}
      onRefreshEvents={onRefreshEvents}
      onCheck={() => void execute.check()}
      onCancel={execute.cancel}
      onSubmit={() => void execute.submit()}
      onRetry={execute.retry}
    />
  )
}

/**
 * The evidence, in the review.
 *
 * A threshold that has been met is a fact about one block, so the block is shown
 * with it: a user reading "2 of 2" needs to know when that was true, because the
 * next read may say something else.
 */
function executionFacts(preflight: ExecutePreflight): readonly ReviewFact[] {
  return [
    { label: 'Preflight block', value: preflight.block, mono: true },
    {
      label: 'Threshold',
      value: `${preflight.threshold.toString(10)} of ${String(preflight.ownerCount)} owners`,
    },
    {
      label: 'Confirmed at this block',
      value: `${String(preflight.confirmedCount)} of ${String(
        preflight.ownerCount,
      )} owners, as the contract reported`,
    },
  ]
}

/** Every sentence that makes this the executing action. */
const EXECUTE_WORDS: ActionWords = {
  cannotPrefix: 'Cannot execute',
  gateSentence: 'Executing is not available.',
  checkLabel: 'Check execution',
  checkingSentence: 'Reading the proposal and its confirmations from the contract at one block.',
  reviewIntro:
    'The contract was read at the block above and this proposal had reached its threshold. The next button opens your wallet with one execution, for this index and no other, and the call itself sends no value to the multisig. Nothing is retried.',
  openLabel: 'Open wallet and execute',
  cancelLabel: 'Cancel',
  sendingSentence: 'Waiting for the wallet.',
  sentLead: 'Sent.',
  sentNote:
    'The execution has been sent, and that is all this app knows. It does not mean the transaction is in a block, that the proposal was executed, or that the call it makes succeeded.',
  declinedNote:
    'A refusal in the wallet does not prove that nothing was sent. Check the wallet before trying again.',
  unknownNote:
    'This app cannot tell whether the wallet sent this execution. Check the wallet before trying again.',
  warning:
    'Executing runs the destination above with the value and calldata above. It can move funds or run code in another contract, and it cannot be undone once it is mined. This app does not decode calldata: what those bytes do is only known to whoever wrote them, so read them yourself before continuing.',
  acknowledgement: {
    label: 'I have read the destination, the value and the calldata above, and I accept what executing them may do.',
    note: 'The wallet stays closed until this is ticked. This app cannot tell you what the calldata does.',
  },
  receiptPurpose: (index, actor) => ({ kind: 'execute', index, actor }),
}
