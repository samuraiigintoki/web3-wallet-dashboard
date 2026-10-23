import { useMultisigSummary, type MultisigState } from './useMultisigSummary.ts'
import { MULTISIG_ADDRESS, SEPOLIA_CHAIN_ID } from './multisig.ts'

/**
 * Why the summary was not read, in the words that fit the case.
 *
 * The four reasons are different facts. A wallet on another chain is a chain
 * this screen does not read; a catalog still loading is a moment, not a fault;
 * a catalog that failed is a fault with a retry elsewhere on the page; and a
 * catalog that answered without Sepolia is a limit of this deployment. None of
 * them is "no owners", and an empty table would be read as exactly that.
 */
function gateReason(
  connected: boolean,
  chainId: number | null,
  listed: 'listed' | 'loading' | 'failed' | 'unlisted',
): string {
  if (!connected || chainId === null) {
    return 'No connected account.'
  }

  if (chainId !== SEPOLIA_CHAIN_ID) {
    return `This app reads the multisig on Sepolia (${String(SEPOLIA_CHAIN_ID)}), and the wallet is on chain ${String(chainId)}.`
  }

  switch (listed) {
    case 'listed':
      return ''
    case 'loading':
      return 'The chain catalog is still being read.'
    case 'failed':
      return 'The chain catalog could not be read.'
    case 'unlisted':
      return "This app's chain catalog does not list Sepolia."
  }
}

/**
 * The multisig's owners, threshold and transaction count.
 *
 * It reads, and says so. It never claims that the connected account is one of
 * the owners, that it signed anything, or that a saved wallet has anything to do
 * with the list below: a contract read is a contract read, and the note at the
 * end says as much in the interface rather than only in a comment.
 */
export function MultisigSummary(props: {
  account: string | null
  chainId: number | null
  listed: 'listed' | 'loading' | 'failed' | 'unlisted'
}) {
  const enabled = props.account !== null && props.chainId === SEPOLIA_CHAIN_ID && props.listed === 'listed'

  const { state, retry } = useMultisigSummary({
    account: props.account,
    chainId: props.chainId,
    enabled,
  })

  const reason = gateReason(props.account !== null, props.chainId, props.listed)

  return (
    <section className="status" aria-labelledby="multisig-heading">
      <h2 id="multisig-heading">Multisig contract</h2>

      <dl className="browser-wallet__facts">
        <dt>Contract</dt>
        <dd>{MULTISIG_ADDRESS}</dd>
        <dt>Chain</dt>
        <dd>Sepolia ({SEPOLIA_CHAIN_ID})</dd>
      </dl>

      <SummaryBody state={state} reason={reason} />

      {state.status === 'error' && (
        <div className="status__actions">
          <button type="button" onClick={retry}>
            Read the contract again
          </button>
        </div>
      )}

      <p className="hint">
        This is a read of the contract&apos;s public state at the latest block.
        It does not show that the connected account is an owner, it signs
        nothing, and it says nothing about the wallets saved in this dashboard.
      </p>
    </section>
  )
}

function SummaryBody({ state, reason }: { state: MultisigState; reason: string }) {
  switch (state.status) {
    case 'idle':
      return (
        <p role="status">
          Not read.<span className="hint"> {reason}</span>
        </p>
      )
    case 'loading':
      return <p role="status">Reading the contract.</p>
    case 'error':
      return (
        <p role="status">
          The contract could not be read.
          <span className="hint"> {state.message}</span>
        </p>
      )
    case 'loaded':
      return (
        <>
          <dl className="browser-wallet__facts">
            <dt>Threshold</dt>
            <dd>{state.threshold}</dd>
            <dt>Transactions</dt>
            <dd>{state.transactionCount}</dd>
            <dt>Owners ({String(state.owners.length)})</dt>
            <dd>
              <ul className="multisig__owners">
                {state.owners.map((owner) => (
                  <li key={owner}>{owner}</li>
                ))}
              </ul>
            </dd>
          </dl>
          <p className="hint">
            Threshold and transaction count are read as exact integers, not
            converted to a floating-point number.
          </p>
        </>
      )
  }
}
