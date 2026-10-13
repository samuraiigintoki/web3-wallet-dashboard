import { useEffect, useState } from 'react'

import { Page } from '../ui/Page.tsx'
import { Skeleton } from '../ui/Skeleton.tsx'

/**
 * How long the shapes stand on their own before the screen says what it is
 * doing in words. The recorded loading language puts a status line past two
 * seconds, and this is that line: a slow check is stated, not treated as a
 * failure, so there is no error styling and no retry beside it. It is not a
 * duration token, because nothing here moves; the value is the band in
 * docs/design/experience-brief.md section 7.
 */
const STATUS_AFTER_MS = 2000

/**
 * The screen shown while a stored session is being checked.
 *
 * One screen, used by both guards, so the answer to "who is this" looks the
 * same whether it is being asked on an auth route or a protected one. It is
 * the anatomy of the page that will replace it: a title shape and body lines,
 * static, at the same column width. Nothing is claimed while the answer is
 * unknown, and nothing is counted, so the shape is all there is.
 *
 * The screen names itself in neither the navigation nor the tab list: a name
 * for a screen that is about to be replaced is a name that has to be unread.
 */
export function RestoringScreen() {
  const [showStatus, setShowStatus] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => {
      setShowStatus(true)
    }, STATUS_AFTER_MS)

    // The answer landing replaces this screen, and clearing the timer here is
    // what keeps a late tick from touching a screen that is gone.
    return () => {
      clearTimeout(timer)
    }
  }, [])

  return (
    <Page busy>
      <Skeleton status="Restoring your session." lines={3} statusVisible={showStatus} />
    </Page>
  )
}
