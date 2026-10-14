import type { ReactNode } from 'react'

import styles from './Notice.module.css'

type Props = {
  /**
   * `status` for information the reader can take in when they get to it,
   * `alert` for something that interrupts: a failed submission the fields
   * cannot explain on their own.
   */
  urgency?: 'status' | 'alert'
  children: ReactNode
  /** Buttons, when the notice offers a way forward. */
  actions?: ReactNode
}

/**
 * A message about the state of the page.
 *
 * Nothing here dismisses itself. A notice that vanishes on a timer takes away
 * the only account of what happened, and this product never does that.
 */
export function Notice({ urgency = 'status', children, actions }: Props) {
  const classes = urgency === 'alert' ? `${styles.notice} ${styles.alert}` : styles.notice

  return (
    <div className={classes}>
      <p className={styles.message} role={urgency}>
        {children}
      </p>
      {actions !== undefined && <div className={styles.actions}>{actions}</div>}
    </div>
  )
}
