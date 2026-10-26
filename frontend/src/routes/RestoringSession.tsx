import { useEffect, useState } from 'react'

/**
 * How long a restore may take before the page explains itself.
 *
 * The staging API is stopped after fifteen minutes idle, so the first request
 * of a visit waits for the whole service to boot. That is tens of seconds, far
 * longer than a restore ordinarily takes, and a page that only says
 * "restoring" for that long looks frozen.
 */
export const WAKE_NOTICE_DELAY_MS = 4_000

/**
 * What both route guards show while the stored credential is being checked.
 *
 * The sentence about the session is present from the first frame, because an
 * ordinary restore finishes in milliseconds and does not need an explanation.
 * The second sentence appears only if the wait is long enough to be a wake.
 */
export function RestoringSession() {
  const [showWakeNotice, setShowWakeNotice] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setShowWakeNotice(true), WAKE_NOTICE_DELAY_MS)

    return () => clearTimeout(timer)
  }, [])

  return (
    <main className="page" aria-busy="true">
      <p role="status">Restoring your session.</p>
      <p aria-live="polite">
        {showWakeNotice
          ? 'The API had stopped while nobody was using it and is starting again. This can take up to a minute; the page continues on its own.'
          : ''}
      </p>
    </main>
  )
}
