/**
 * Placeholder sections.
 *
 * They render static text and make no API call. No illustrative row, count or
 * balance appears anywhere: a fake figure in a wallet product is worse than an
 * empty screen, because a reviewer cannot tell it from a real one.
 *
 * Wallets left this file in Week 8 and now lives in WalletsPage.tsx. Overview
 * left it in Week 9, when the browser-wallet area gave it a reason to exist as
 * OverviewPage.tsx.
 */

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
