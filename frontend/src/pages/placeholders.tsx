/**
 * Placeholder sections.
 *
 * They render static text and make no API call. No illustrative row, count or
 * balance appears anywhere: a fake figure in a wallet product is worse than an
 * empty screen, because a reviewer cannot tell it from a real one.
 */

export function DashboardPage() {
  return (
    <main className="page">
      <h1>Overview</h1>
      <p>
        You are signed in. Wallet, contract and indexed event views are not built
        yet.
      </p>
    </main>
  )
}

export function WalletsPage() {
  return (
    <main className="page">
      <h1>Wallets</h1>
      <p>Wallet management is not built yet.</p>
    </main>
  )
}

export function ContractsPage() {
  return (
    <main className="page">
      <h1>Contracts</h1>
      <p>Tracked contracts and their indexed events are not built yet.</p>
    </main>
  )
}

export function NotFoundPage() {
  return (
    <main className="page">
      <h1>Page not found</h1>
      <p>That address does not match a page in this application.</p>
    </main>
  )
}
