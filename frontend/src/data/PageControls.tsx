import type { Pagination } from '../api/index.ts'
import { MAX_PAGE } from './page.ts'

/**
 * Previous and Next, bounded by what the server reported.
 *
 * Shared by the two list screens this slice touches. There is no page-size
 * control anywhere, and the last page is the server's `totalPages`, so a caller
 * cannot walk past the end of its own data or past the ceiling the API enforces.
 * The wallets page keeps its own copy, because its controls are locked while a
 * removal is in flight and these are not.
 */
export function PageControls({
  pagination,
  page,
  onPage,
  label,
}: {
  pagination: Pagination
  /** The page that was asked for, which the URL owns. */
  page: number
  onPage: (page: number) => void
  /** The navigation's accessible name, which says what is being paged. */
  label: string
}) {
  if (pagination.totalPages === 0) {
    return null
  }

  const atLastPage = page >= pagination.totalPages || page >= MAX_PAGE

  return (
    <nav aria-label={label}>
      <div className="status__actions">
        <button type="button" onClick={() => onPage(page - 1)} disabled={page <= 1}>
          Previous
        </button>
        <span>{`Page ${String(page)} of ${String(pagination.totalPages)}`}</span>
        <button type="button" onClick={() => onPage(page + 1)} disabled={atLastPage}>
          Next
        </button>
      </div>
    </nav>
  )
}
