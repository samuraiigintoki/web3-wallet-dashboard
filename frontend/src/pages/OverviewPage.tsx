import { BrowserWalletPanel } from '../provider/BrowserWalletPanel.tsx'

/**
 * The Overview screen.
 *
 * It holds the browser-wallet area and nothing else yet. The rest of the
 * overview, which is contract and event facts, is later work, and inventing a
 * placeholder figure for it here would be worse than the plain heading.
 *
 * The browser wallet is presented here rather than in the shell header because
 * it belongs to this browser and this tab, not to the signed-in account, and the
 * header is where the account's own identity lives.
 */
export function OverviewPage() {
  return (
    <main className="page">
      <h1>Overview</h1>
      <p>
        You are signed in. Contract and indexed event views are not built yet.
      </p>
      <BrowserWalletPanel />
    </main>
  )
}
