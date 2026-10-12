import styles from './Skeleton.module.css'

type Props = {
  /** What is being restored, said in words for anyone who cannot see a shape. */
  status: string
  /** How many body lines the shape suggests. */
  lines?: number
}

/**
 * The shape of content that has not arrived.
 *
 * It holds the layout steady, so the answer lands where the person is already
 * looking rather than pushing the page down when it arrives.
 */
export function Skeleton({ status, lines = 3 }: Props) {
  const bars = Array.from({ length: lines }, (_, index) => index)

  return (
    <div>
      <p role="status" className={styles.srOnly}>
        {status}
      </p>
      <div className={styles.skeleton} aria-hidden="true">
        <span className={`${styles.bar} ${styles.title}`} />
        {bars.map((index) => (
          <span
            key={index}
            className={index === bars.length - 1 ? `${styles.bar} ${styles.short}` : styles.bar}
          />
        ))}
      </div>
    </div>
  )
}
