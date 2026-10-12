import type { FormHTMLAttributes, ReactNode, Ref } from 'react'

import styles from './Page.module.css'
import { useDocumentTitle } from './title.ts'

type Props = {
  /** The page heading. It is also the document title for this route. */
  title?: string
  /** Narrower column, for the auth forms. */
  narrow?: boolean
  /** True while the page is waiting on the answer that decides what it shows. */
  busy?: boolean
  children: ReactNode
}

/**
 * The main region of a screen.
 *
 * It is the landmark the skip link targets, so it carries the id every skip
 * link looks for and takes focus when it is skipped to. The heading and the
 * document title are set together here: a route that shows a screen without
 * naming it is a route a person cannot find in their tab list.
 */
export function Page({ title, narrow = false, busy = false, children }: Props) {
  useDocumentTitle(title ?? null)

  return (
    <main
      id="main"
      tabIndex={-1}
      aria-busy={busy}
      className={narrow ? `${styles.page} ${styles.narrow}` : styles.page}
    >
      {title !== undefined && <h1>{title}</h1>}
      {children}
    </main>
  )
}

type FormProps = { ref?: Ref<HTMLFormElement>; children: ReactNode } & Omit<
  FormHTMLAttributes<HTMLFormElement>,
  'children' | 'className'
>

/**
 * The form element for a page.
 *
 * Validation and messages are ours, so the browser's own bubbles are turned
 * off rather than layered on top of them.
 */
export function PageForm({ ref, children, ...rest }: FormProps) {
  return (
    <form {...rest} ref={ref} className={styles.form} noValidate>
      {children}
    </form>
  )
}
