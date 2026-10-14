import { useEffect } from 'react'

import { PRODUCT_NAME } from './product.ts'

/**
 * The document title for the route that is on screen.
 *
 * Read by screen readers on navigation and by anyone looking at their tab
 * list, so every route names itself. A screen with no name of its own, such as
 * the moment a session is being restored, leaves the product name alone.
 */
export function useDocumentTitle(title: string | null): void {
  useEffect(() => {
    document.title = title === null ? PRODUCT_NAME : `${title} · ${PRODUCT_NAME}`
  }, [title])
}
