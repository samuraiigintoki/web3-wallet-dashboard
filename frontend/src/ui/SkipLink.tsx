import styles from './SkipLink.module.css'

/**
 * A way past the header, for anyone driving the page from the keyboard.
 *
 * The target is the main region of the screen, which takes focus when it is
 * skipped to, so the next Tab continues inside the page rather than back in
 * the navigation.
 */
export function SkipLink({ targetId }: { targetId: string }) {
  return (
    <a className={styles.skip} href={`#${targetId}`}>
      Skip to content
    </a>
  )
}
