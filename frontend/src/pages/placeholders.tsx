import { Link } from 'react-router'

import { Page } from '../ui/Page.tsx'

/**
 * Placeholder sections.
 *
 * They render static text and make no API call. No illustrative row, count or
 * balance appears anywhere: a fake figure in a wallet product is worse than an
 * empty screen, because a reviewer cannot tell it from a real one.
 */

export function DashboardPage() {
  return (
    <Page title="Overview">
      <p>
        You are signed in. This screen will hold the indexed register: what each
        contract you track has done, the block each event was seen in, and how
        much of it is still reversible. Nothing appears here until it is real, so
        there is no summary to read yet.
      </p>
    </Page>
  )
}

export function WalletsPage() {
  return (
    <Page title="Wallets">
      <p>
        The wallets you add will sit here with their address, their chain and the
        balances read from the chain. Nothing is listed until one is added and the
        reads behind it exist.
      </p>
    </Page>
  )
}

export function ContractsPage() {
  return (
    <Page title="Contracts">
      <p>
        Tracked contracts will sit here with their chain, their start block and
        the state of their indexing. Their events will be readable one contract
        at a time, each with the block it was seen in.
      </p>
    </Page>
  )
}

export function NotFoundPage() {
  return (
    <Page title="Page not found">
      <p>
        That address does not match a page in this application. If a link brought
        you here, it may point at a screen this build does not have yet.
      </p>
      <p>
        <Link to="/">Go to the overview</Link>
      </p>
    </Page>
  )
}
