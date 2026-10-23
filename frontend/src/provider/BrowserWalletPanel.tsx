import { useQuery } from '@tanstack/react-query'

import { chainCatalogQuery } from '../wallets/chainQueries.ts'
import { MultisigSummary } from './MultisigSummary.tsx'
import { useAccountBalance, type BalanceState } from './useAccountBalance.ts'
import { useBrowserWallet } from './useBrowserWallet.ts'

/**
 * What this app knows about the chain the wallet is on.
 *
 * `unlisted` is a fact: the catalog arrived and does not contain the chain.
 * `unknown` is the absence of one: the catalog could not be read, so the panel
 * says what the chain id is and declines to judge it. Collapsing the two would
 * turn an unreachable catalog into a claim about the user's wallet.
 */
type ChainFact =
  | { kind: 'named'; name: string }
  | { kind: 'unlisted' }
  | { kind: 'unknown' }

/**
 * The plain browser-wallet area on the Overview screen.
 *
 * It reads the injected provider and shows what it says: whether one exists,
 * whether this site has been granted access, and which account and chain it
 * reports. It is deliberately quiet about everything else.
 *
 * It never claims that the account belongs to a saved wallet, that it signed
 * anything, or that it is the account the user signed in with. Those are three
 * different things and none of them is established by connecting a wallet.
 */
export function BrowserWalletPanel() {
  const { state, connect } = useBrowserWallet()

  /**
   * The public chain catalog, read only once a wallet is connected.
   *
   * Chain facts come from the app's own API, never from the provider: the
   * catalog says which chains this deployment knows about, and it is not proof
   * of where the wallet is. It is also not needed at all until there is a chain
   * id to name, which is why the query waits for one rather than running on
   * every visit to this screen.
   */
  const catalog = useQuery({
    ...chainCatalogQuery(),
    enabled: state.status === 'connected',
  })

  const chainFact: ChainFact = (() => {
    if (state.status !== 'connected') {
      return { kind: 'unknown' }
    }

    if (catalog.isPending || catalog.isError) {
      return { kind: 'unknown' }
    }

    const entry = catalog.data.find((chain) => chain.chainId === state.chainId)

    return entry === undefined ? { kind: 'unlisted' } : { kind: 'named', name: entry.name }
  })()

  /**
   * The balance, read only where this app has established the chain.
   *
   * `chainFact.kind === 'named'` is the gate, and it is the strict one: the
   * catalog must have answered, and it must list this chain. A catalog that is
   * still loading or has failed, and a chain the catalog does not list, all
   * leave the balance unread, because in each of them this app cannot say what
   * the wei it was given are wei of.
   */
  const balanceEnabled = state.status === 'connected' && chainFact.kind === 'named'

  const balance = useAccountBalance({
    account: state.status === 'connected' ? state.account : null,
    chainId: state.status === 'connected' ? state.chainId : null,
    enabled: balanceEnabled,
  })

  /**
   * What the catalog says about listing, for the multisig summary.
   *
   * The summary has its own gate and its own reason text, so it needs the three
   * catalog outcomes kept apart: a chain the catalog answered without, a catalog
   * still loading, and a catalog that failed are three different sentences.
   */
  const listed: 'listed' | 'loading' | 'failed' | 'unlisted' =
    chainFact.kind === 'named'
      ? 'listed'
      : chainFact.kind === 'unlisted'
        ? 'unlisted'
        : catalog.isError
          ? 'failed'
          : 'loading'

  return (
    <>
      <section className="status" aria-labelledby="browser-wallet-heading">
        <h2 id="browser-wallet-heading">Browser wallet</h2>

        <StatusLine state={state} chainFact={chainFact} />

        {state.status === 'connected' && (
          <dl className="browser-wallet__facts">
            <dt>Account</dt>
            <dd>{state.account}</dd>
            <dt>Chain ID</dt>
            <dd>{state.chainId}</dd>
            <dt>Chain name</dt>
            <dd>
              {chainFact.kind === 'named' && chainFact.name}
              {chainFact.kind === 'unlisted' && "Not in this app's chain catalog"}
              {chainFact.kind === 'unknown' && 'Not read'}
            </dd>
            <dt>Balance</dt>
            <dd>
              <BalanceValue
                balance={balance.state}
                reason={balanceReason(state.status, chainFact, catalog.isPending)}
              />
            </dd>
          </dl>
        )}

        {state.status === 'connected' && balance.state.status === 'error' && (
          <div className="status__actions">
            <button type="button" onClick={balance.retry}>
              Read the balance again
            </button>
          </div>
        )}

        {state.status === 'connected' && chainFact.kind === 'unknown' && (
          <p className="hint">
            The chain catalog could not be read, so this app cannot say whether it
            lists the chain the wallet is on.
          </p>
        )}

        {(state.status === 'disconnected' || state.status === 'error') && (
          <div className="status__actions">
            <button type="button" onClick={() => void connect()}>
              Connect wallet
            </button>
          </div>
        )}

        {state.status === 'connecting' && (
          <div className="status__actions">
            <button type="button" disabled>
              Connect wallet
            </button>
          </div>
        )}

          <p className="hint">
            A browser wallet is separate from signing in to this dashboard. Connecting
            one asks your wallet which account and chain it is on. It signs nothing,
            sends no transaction and proves nothing about the wallets saved here.
          </p>
      </section>

      <MultisigSummary
        account={state.status === 'connected' ? state.account : null}
        chainId={state.status === 'connected' ? state.chainId : null}
        listed={listed}
      />
    </>
  )
}

/**
 * Why the balance was not read, in the words that fit the case.
 *
 * Each reason is a different fact, and the difference matters: a chain the app
 * does not list is a limit of this deployment, while a catalog that failed to
 * load is a limit of this moment. Neither is "no balance", and an empty figure
 * would be read as one.
 */
function balanceReason(
  status: string,
  chainFact: ChainFact,
  catalogPending: boolean,
): string {
  if (status !== 'connected') {
    return 'No connected account.'
  }

  if (chainFact.kind === 'named') {
    return ''
  }

  if (chainFact.kind === 'unlisted') {
    return 'This app does not list the chain the wallet is on.'
  }

  return catalogPending
    ? 'The chain catalog is still being read.'
    : 'The chain catalog could not be read.'
}

/**
 * The balance itself: an exact wei figure, a wait, a failure, or a reason.
 *
 * The figure is printed with its unit and nothing else. No symbol, no decimals,
 * no grouping and no rounding, because every one of those would be a claim this
 * slice cannot support: the number is wei, and wei is what it says.
 */
function BalanceValue({ balance, reason }: { balance: BalanceState; reason: string }) {
  switch (balance.status) {
    case 'loaded':
      return <span className="browser-wallet__wei">{balance.wei} wei</span>
    case 'loading':
      return <span role="status">Reading the balance.</span>
    case 'error':
      return (
        <>
          <span>The balance could not be read.</span>
          <span className="hint"> {balance.message}</span>
        </>
      )
    case 'idle':
      return (
        <span>
          Not read.<span className="hint"> {reason}</span>
        </span>
      )
  }
}

/**
 * The one line that carries the state.
 *
 * Every state this slice distinguishes has its own sentence, so a screenshot, a
 * screen reader and a test all read the same thing. An unsupported chain is its
 * own sentence rather than a footnote under "Connected", because it is the case
 * where the account is known and the chain is not one this app can act on.
 */
function StatusLine({
  state,
  chainFact,
}: {
  state: ReturnType<typeof useBrowserWallet>['state']
  chainFact: ChainFact
}) {
  switch (state.status) {
    case 'checking':
      return <p role="status">Checking this browser for a wallet.</p>
    case 'unsupported':
      return (
        <p role="status">
          No browser wallet was found in this browser. Install or enable an
          injected wallet, then reload this page.
        </p>
      )
    case 'disconnected':
      return (
        <>
          <p role="status">Not connected to a browser wallet.</p>
          {state.notice !== null && <p className="hint">{state.notice}</p>}
        </>
      )
    case 'connecting':
      return <p role="status">Waiting for the wallet to answer.</p>
    case 'connected':
      return (
        <>
          <p role="status">
            {chainFact.kind === 'unlisted'
              ? `Connected, but the wallet is on chain ${String(state.chainId)}, which this app does not list.`
              : 'Connected to a browser wallet.'}
          </p>
          {chainFact.kind === 'unlisted' && (
            <p className="hint">
              The account is readable and is shown below, but nothing on this
              dashboard acts on that chain.
            </p>
          )}
        </>
      )
    case 'error':
      return (
        <>
          <p role="status">The browser wallet could not be read.</p>
          <p className="hint">{state.message}</p>
        </>
      )
  }
}
