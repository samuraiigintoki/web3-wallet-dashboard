import type { ReactNode } from 'react'

import { AUTH_FACTS } from './authFacts.ts'
import styles from './AuthComposition.module.css'
import { PRODUCT_NAME } from './product.ts'
import { useDocumentTitle } from './title.ts'

type Props = {
  /** The name of the screen in the tab list and the document title. */
  title: string
  /** The headline. Short, in the product's own words, and true. */
  headline: string
  children: ReactNode
}

/**
 * The auth surface.
 *
 * One column on the ground: the product's name, the headline, then the form.
 * The form comes first and nothing precedes it that has to be read or
 * dismissed, and the form is usable without scrolling on a 360px viewport.
 *
 * The four facts follow the form. They are a list, not decoration: this is
 * also what a browser without scroll timelines and a reader with reduced
 * motion get, in the same order, complete. The bounded sequence that lands
 * later draws on this list rather than replacing it.
 *
 * The heading is the headline itself, so the screen names itself once. The
 * document title stays the plain name of the screen.
 */
export function AuthComposition({ title, headline, children }: Props) {
  useDocumentTitle(title)

  return (
    <main id="main" tabIndex={-1} className={styles.auth}>
      <div className={styles.column}>
        <strong className={styles.brand}>{PRODUCT_NAME}</strong>
        <h1 className={styles.headline}>{headline}</h1>
        {children}
      </div>

      <section className={styles.facts} aria-labelledby="facts-heading">
        <h2 id="facts-heading" className={styles.factsHeading}>
          How this works
        </h2>
        <ul className={styles.factList}>
          {AUTH_FACTS.map((fact) => (
            <li key={fact} className={styles.fact}>
              {fact}
            </li>
          ))}
        </ul>
      </section>
    </main>
  )
}
