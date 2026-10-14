import { NavLink } from 'react-router'
import type { ReactNode } from 'react'

import { PRODUCT_NAME } from './product.ts'
import styles from './Shell.module.css'
import { SkipLink } from './SkipLink.tsx'

type Destination = {
  /** The route this destination opens. */
  to: string
  /** The visible label. Never carried by an icon alone. */
  label: string
  /** True for the index route, which only matches on its own path. */
  end?: boolean
}

type Props = {
  /** The sections of the application, in the order they are shown. */
  destinations: readonly Destination[]
  /** Who is signed in, and the way out. */
  identity: ReactNode
  children: ReactNode
}

/**
 * The signed in frame.
 *
 * The landmarks are here rather than in each screen: a banner, the section
 * navigation with a name of its own, and the main region the screens render
 * inside it. The navigation is one element in two shapes, a rail at 48rem and
 * above and a strip fixed to the bottom of the viewport below it, so a screen
 * never needs to know which shape it is on.
 *
 * Every destination is reachable by pointer, by touch and by keyboard, and its
 * label is always visible: there is no icon-only control here and no drawer to
 * open first.
 */
export function Shell({ destinations, identity, children }: Props) {
  return (
    <div className={styles.shell}>
      <SkipLink targetId="main" />

      <div className={styles.rail}>
        <header className={styles.account}>
          <strong className={styles.brand}>{PRODUCT_NAME}</strong>
          <div className={styles.identity}>{identity}</div>
        </header>

        <nav className={styles.nav} aria-label="Sections">
          <ul className={styles.list}>
            {destinations.map((destination) => (
              <li key={destination.to} className={styles.item}>
                <NavLink to={destination.to} end={destination.end} className={styles.link}>
                  {destination.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </div>

      {children}
    </div>
  )
}

/**
 * Who is signed in, beside the way out.
 *
 * The address is supporting text at the label step, where the ink has to be
 * one of the two reading tokens rather than --text-3. It wraps rather than
 * pushing the button off the row: on a 360px viewport the address and the
 * button take a line each, which is the reviewed shape.
 */
export function ShellIdentity({ email, children }: { email: string; children: ReactNode }) {
  return (
    <>
      <span className={styles.email}>{email}</span>
      {children}
    </>
  )
}
