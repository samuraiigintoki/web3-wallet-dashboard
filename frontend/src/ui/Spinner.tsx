import styles from './Spinner.module.css'

/**
 * Decorative by design. The state it reports is carried by aria-busy on the
 * control and by the label that stays in place, so it is hidden from the
 * accessibility tree rather than named.
 */
export function Spinner() {
  return <span className={styles.spinner} aria-hidden="true" />
}
