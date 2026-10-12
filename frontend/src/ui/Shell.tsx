import type { ReactNode } from 'react'

import { PRODUCT_NAME } from './product.ts'
import styles from './Shell.module.css'
import { SkipLink } from './SkipLink.tsx'

type Props = {
  /** The section list. The layout owns the navigation landmark around it. */
  nav: ReactNode
  /** Who is signed in, and the way out. */
  identity: ReactNode
  children: ReactNode
}

/**
 * The signed in frame.
 *
 * The landmarks are here rather than in each screen: a banner, the section
 * navigation with a name of its own, and the main region the screens render
 * inside it.
 */
export function Shell({ nav, identity, children }: Props) {
  return (
    <div className={styles.shell}>
      <SkipLink targetId="main" />

      <header className={styles.header}>
        <div className={styles.bar}>
          <strong className={styles.brand}>{PRODUCT_NAME}</strong>
          <nav className={styles.nav} aria-label="Sections">
            {nav}
          </nav>
          <div className={styles.identity}>{identity}</div>
        </div>
      </header>

      {children}
    </div>
  )
}

/**
 * Who is signed in, beside the way out.
 *
 * The address is supporting text at the label step, where the ink has to be
 * one of the two reading tokens rather than --text-3.
 */
export function ShellIdentity({ email, children }: { email: string; children: ReactNode }) {
  return (
    <>
      <span className={styles.email}>{email}</span>
      {children}
    </>
  )
}
