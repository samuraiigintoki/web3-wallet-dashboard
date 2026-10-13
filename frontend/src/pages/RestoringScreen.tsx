import { Page } from '../ui/Page.tsx'
import { Skeleton } from '../ui/Skeleton.tsx'

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
  return (
    <Page busy>
      <Skeleton status="Restoring your session." lines={3} />
    </Page>
  )
}
