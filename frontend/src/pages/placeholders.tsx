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
        You are signed in. Wallet, contract and indexed event views are not built
        yet.
      </p>
    </Page>
  )
}

export function WalletsPage() {
  return (
    <Page title="Wallets">
      <p>Wallet management is not built yet.</p>
    </Page>
  )
}

export function ContractsPage() {
  return (
    <Page title="Contracts">
      <p>Tracked contracts and their indexed events are not built yet.</p>
    </Page>
  )
}

export function NotFoundPage() {
  return (
    <Page title="Page not found">
      <p>That address does not match a page in this application.</p>
      <p>
        <Link to="/">Go to the overview</Link>
      </p>
    </Page>
  )
}
