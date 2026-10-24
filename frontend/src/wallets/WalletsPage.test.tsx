import { screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  errorResponse,
  hangingFetch,
  jsonResponse,
  pendingResponse,
  plainTextResponse,
  stubFetch,
  type FetchCall,
} from '../test/http.ts'
import { currentPath, memoryStorage, renderApp } from '../test/renderApp.tsx'
import { createQueryClient } from '../data/queryClient.ts'
import { PAGE_SIZE } from '../data/page.ts'

const USER = { id: 5, email: 'ada@example.com', createdAt: '2026-10-06T12:00:00Z' }

const WALLET_A = {
  id: 7,
  address: '0x00000000000000000000000000000000000000a1',
  chainId: 11155111,
  label: 'Primary signer',
  createdAt: '2026-10-01T10:00:00Z',
}

const WALLET_B = {
  id: 8,
  address: '0x00000000000000000000000000000000000000b2',
  chainId: 1,
  label: 'Cold storage',
  createdAt: '2026-10-02T11:30:00Z',
}

function pageResponse(
  wallets: unknown[],
  pagination: Record<string, number> = {
    page: 1,
    pageSize: PAGE_SIZE,
    totalItems: 2,
    totalPages: 1,
  },
) {
  return jsonResponse({ data: wallets, pagination })
}

/**
 * /users/me authenticates the stored credential; everything else is the wallet
 * list, which is what these tests are about.
 */
function apiFetch(
  respondWallets: (
    url: string,
    init: RequestInit,
    call: number,
  ) => Response | Promise<Response>,
) {
  let walletCalls = 0

  return stubFetch((url: string, init: RequestInit) => {
    if (url.includes('/users/me')) {
      return jsonResponse({ data: USER })
    }

    // The catalog is public and answered here so it never reaches the wallet
    // responder, which counts and answers wallet calls only.
    if (url.includes('/chains')) {
      return jsonResponse({
        data: [{ chainId: 11155111, name: 'Sepolia', symbol: 'ETH', isTestnet: true }],
      })
    }

    walletCalls += 1
    return respondWallets(url, init, walletCalls)
  })
}

function walletCalls(calls: FetchCall[]): FetchCall[] {
  return calls.filter((call) => call.url.includes('/wallets'))
}

function button(name: string): HTMLButtonElement {
  return screen.getByRole('button', { name }) as HTMLButtonElement
}

describe('wallets page', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows a loading state, then the rows the API returned', async () => {
    const held = pendingResponse<Response>()
    const fetchStub = apiFetch(() => held.promise)

    renderApp({ path: '/wallets', storage: memoryStorage('stored-token') })

    // The wallet request only starts once the identity is validated, so the
    // loading state to assert is the one after the restore, not before it.
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('Loading wallets')
    })

    held.resolve(pageResponse([WALLET_A, WALLET_B]))

    await waitFor(() => {
      expect(screen.getByText('Primary signer')).toBeDefined()
    })
    expect(screen.getByText(WALLET_A.address)).toBeDefined()
    expect(screen.getByText('Cold storage')).toBeDefined()
    expect(walletCalls(fetchStub.calls)).toHaveLength(1)
  })

  it('asks for page 1 with the fixed page size and the stored credential', async () => {
    const fetchStub = apiFetch(() => pageResponse([]))

    renderApp({ path: '/wallets', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(walletCalls(fetchStub.calls)).toHaveLength(1)
    })
    expect(walletCalls(fetchStub.calls)[0]?.url).toBe(`/api/v1/wallets?page=1&pageSize=${String(PAGE_SIZE)}`)
    expect(
      new Headers(walletCalls(fetchStub.calls)[0]?.init.headers).get('authorization'),
    ).toBe('Bearer stored-token')
  })

  it('says the account has no wallets rather than showing an invented zero page', async () => {
    apiFetch(() =>
      pageResponse([], { page: 1, pageSize: PAGE_SIZE, totalItems: 0, totalPages: 0 }),
    )

    renderApp({ path: '/wallets', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('no saved wallets yet')
    })
    expect(screen.queryByRole('button', { name: 'Previous' })).toBeNull()
  })

  it('tells a page past the end apart from an empty account and keeps the real totals', async () => {
    apiFetch(() =>
      pageResponse([], { page: 3, pageSize: PAGE_SIZE, totalItems: 2, totalPages: 1 }),
    )

    renderApp({ path: '/wallets?page=3', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(screen.getByText(/No wallets on page 3/)).toBeDefined()
    })
    expect(screen.getByText(/2 saved wallets over 1 page\./)).toBeDefined()
    expect(screen.getByText(/Page 3 of 1/)).toBeDefined()
    expect(button('Previous').disabled).toBe(false)
    expect(button('Next').disabled).toBe(true)
  })

  it('disables Previous on the first page and Next on the last', async () => {
    apiFetch(() =>
      pageResponse([WALLET_A], { page: 1, pageSize: PAGE_SIZE, totalItems: 21, totalPages: 2 }),
    )

    renderApp({ path: '/wallets', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(button('Previous')).toBeDefined()
    })
    expect(button('Previous').disabled).toBe(true)
    expect(button('Next').disabled).toBe(false)
  })

  it('moves the page through the URL, so a reload lands on the same page', async () => {
    const fetchStub = apiFetch((url) =>
      url.includes('page=2')
        ? pageResponse([WALLET_B], {
            page: 2,
            pageSize: PAGE_SIZE,
            totalItems: 21,
            totalPages: 2,
          })
        : pageResponse([WALLET_A], {
            page: 1,
            pageSize: PAGE_SIZE,
            totalItems: 21,
            totalPages: 2,
          }),
    )
    const { user } = renderApp({ path: '/wallets', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(screen.getByText('Primary signer')).toBeDefined()
    })

    await user.click(button('Next'))

    await waitFor(() => {
      expect(currentPath()).toBe('/wallets?page=2')
    })
    await waitFor(() => {
      expect(screen.getByText('Cold storage')).toBeDefined()
    })
    expect(screen.queryByText('Primary signer')).toBeNull()
    expect(walletCalls(fetchStub.calls).map((call) => call.url)).toContain(
      `/api/v1/wallets?page=2&pageSize=${String(PAGE_SIZE)}`,
    )

    await user.click(button('Previous'))

    await waitFor(() => {
      expect(currentPath()).toBe('/wallets?page=1')
    })
    await waitFor(() => {
      expect(screen.getByText('Primary signer')).toBeDefined()
    })
  })

  it.each([
    ['?page=abc', 1],
    ['?page=-4', 1],
    ['?page=0', 1],
    ['?page=1.5', 1],
    ['?page=', 1],
    ['?page=99999', 10000],
  ])('turns a malformed or over-cap URL page %s into a request for page %i', async (query, expected) => {
    const fetchStub = apiFetch(() => pageResponse([]))

    renderApp({ path: `/wallets${query}`, storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(walletCalls(fetchStub.calls)).toHaveLength(1)
    })
    expect(walletCalls(fetchStub.calls)[0]?.url).toContain(`page=${String(expected)}`)
  })

  it('offers Retry and recovers when the API was only failing', async () => {
    const fetchStub = apiFetch((_url, _init, call) =>
      call === 1 ? errorResponse(500, 'INTERNAL_SERVER_ERROR') : pageResponse([WALLET_A]),
    )
    const { user } = renderApp({ path: '/wallets', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeDefined()
    })
    expect(screen.getByRole('alert').textContent).toContain('Something went wrong')

    await user.click(button('Retry'))

    await waitFor(() => {
      expect(screen.getByText('Primary signer')).toBeDefined()
    })
    expect(walletCalls(fetchStub.calls)).toHaveLength(2)
  })

  it('keeps the rate-limit wording and the retry-after the API sent', async () => {
    apiFetch(() =>
      errorResponse(429, 'RATE_LIMITED', { headers: { 'Retry-After': '30' } }),
    )

    renderApp({ path: '/wallets', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('Please try again in 30 seconds')
    })
  })

  it('reports a response it cannot understand instead of rendering a guessed row', async () => {
    apiFetch(() => pageResponse([{ id: 9, address: '0xdead', chainId: 1 }]))

    renderApp({ path: '/wallets', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('Something went wrong')
    })
    expect(screen.queryByText('0xdead')).toBeNull()
  })

  it('treats a failed wallet read as a data error and leaves the session alone', async () => {
    const storage = memoryStorage('stored-token')
    apiFetch(() => errorResponse(503, 'SERVICE_UNAVAILABLE'))

    renderApp({ path: '/wallets', storage })

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeDefined()
    })
    expect(currentPath()).toBe('/wallets')
    expect(storage.read()).toBe('stored-token')
    expect(screen.getByText('ada@example.com')).toBeDefined()
  })

  /**
   * A two-page account where one row is removed, with the pages the server
   * reports before and after.
   *
   * The route answers the list by the page it was asked for and the DELETE with
   * a 204, so the repair is decided from server metadata and never from
   * arithmetic on what the client had.
   */
  function removalRoute(options: {
    pageTwoRowsAfter: unknown[]
    totalItemsAfter: number
    totalPagesAfter: number
    removeResponse?: () => Response | Promise<Response>
  }) {
    const requests: { method: string; url: string }[] = []
    let removed = false

    const fetchStub = apiFetch((url, init) => {
      requests.push({ method: init.method ?? 'GET', url })

      if (init.method === 'DELETE') {
        removed = true
        return options.removeResponse?.() ?? new Response(null, { status: 204 })
      }

      const wantsPageTwo = url.includes('page=2')
      const totalItems = removed ? options.totalItemsAfter : 21
      const totalPages = removed ? options.totalPagesAfter : 2

      const rows = wantsPageTwo
        ? removed
          ? options.pageTwoRowsAfter
          : [WALLET_B]
        : [WALLET_A]

      return pageResponse(rows, {
        page: wantsPageTwo ? 2 : 1,
        pageSize: PAGE_SIZE,
        totalItems,
        totalPages,
      })
    })

    return {
      fetchStub,
      requests,
      deleteCalls: () => requests.filter((request) => request.method === 'DELETE'),
    }
  }

  it('keeps the page after an ordinary removal', async () => {
    const route = removalRoute({
      // Page 2 still holds rows after the removal, so the page the user is on
      // remains valid and must not be moved out from under them.
      pageTwoRowsAfter: [WALLET_B],
      totalItemsAfter: 21,
      totalPagesAfter: 2,
    })
    const { user } = renderApp({ path: '/wallets?page=2', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(screen.getByText('Cold storage')).toBeDefined()
    })

    await user.click(screen.getByRole('button', { name: 'Remove' }))
    await user.click(screen.getByRole('button', { name: 'Remove wallet' }))

    await waitFor(() => {
      expect(screen.getByText(/Removed the saved record for/)).toBeDefined()
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    // The page in the URL is the one the user was on, and the row is gone only
    // because the server's own page no longer holds it.
    expect(currentPath()).toBe('/wallets?page=2')
    expect(route.deleteCalls()).toHaveLength(1)
  })

  it('moves to the last valid page when the removal empties the current one', async () => {
    const route = removalRoute({
      // The removed row was the only one on page 2, and page 1 is all that is
      // left, so the current page is past the end after the removal.
      pageTwoRowsAfter: [],
      totalItemsAfter: 20,
      totalPagesAfter: 1,
    })
    const { user } = renderApp({ path: '/wallets?page=2', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(screen.getByText('Cold storage')).toBeDefined()
    })

    await user.click(screen.getByRole('button', { name: 'Remove' }))
    await user.click(screen.getByRole('button', { name: 'Remove wallet' }))

    // The URL moves, from the fresh metadata, to the last page the server says
    // exists.
    await waitFor(() => {
      expect(currentPath()).toBe('/wallets?page=1')
    })
    await waitFor(() => {
      expect(screen.getByText('Primary signer')).toBeDefined()
    })
    expect(route.deleteCalls()).toHaveLength(1)
  })

  it('shows the true empty state after removing the only record', async () => {
    const fetchStub = apiFetch((_url, init) => {
      if (init.method === 'DELETE') {
        return new Response(null, { status: 204 })
      }

      const removed = fetchStub.calls.some((call) => call.init.method === 'DELETE')

      return pageResponse(removed ? [] : [WALLET_A], {
        page: 1,
        pageSize: PAGE_SIZE,
        totalItems: removed ? 0 : 1,
        totalPages: removed ? 0 : 1,
      })
    })
    const { user } = renderApp({ path: '/wallets', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(screen.getByText('Primary signer')).toBeDefined()
    })

    await user.click(screen.getByRole('button', { name: 'Remove' }))
    await user.click(screen.getByRole('button', { name: 'Remove wallet' }))

    await waitFor(() => {
      expect(screen.getByText(/no saved wallets yet/)).toBeDefined()
    })
    expect(currentPath()).toBe('/wallets')
    expect(screen.getByText(/Removed the saved record for/)).toBeDefined()
  })

  it('keeps a confirmed removal when the refresh fails, and sends no second delete', async () => {
    let listsAfterRemoval = 0
    const fetchStub = apiFetch((_url, init) => {
      if (init.method === 'DELETE') {
        return new Response(null, { status: 204 })
      }

      const removed = fetchStub.calls.some((call) => call.init.method === 'DELETE')

      if (!removed) {
        return pageResponse([WALLET_A, WALLET_B])
      }

      listsAfterRemoval += 1
      return errorResponse(503, 'SERVICE_UNAVAILABLE')
    })
    const { user } = renderApp({ path: '/wallets', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(screen.getByText('Primary signer')).toBeDefined()
    })

    await user.click(screen.getAllByRole('button', { name: 'Remove' })[0]!)
    await user.click(screen.getByRole('button', { name: 'Remove wallet' }))

    // The confirmation stands. The refresh is the list's failure to report,
    // with the list's own Retry.
    await waitFor(() => {
      expect(screen.getByText(/The list could not be refreshed/)).toBeDefined()
    })
    expect(screen.getByText(/Removed the saved record for/)).toBeDefined()

    const deletesBefore = fetchStub.calls.filter((call) => call.init.method === 'DELETE').length
    expect(deletesBefore).toBe(1)

    // Retrying the list is a read. It is never another delete.
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => {
      expect(listsAfterRemoval).toBeGreaterThan(1)
    })
    expect(
      fetchStub.calls.filter((call) => call.init.method === 'DELETE'),
    ).toHaveLength(1)
  })

  it('retires a confirmation whose row the next page does not hold', async () => {
    const pageTwo = pendingResponse<Response>()
    const fetchStub = apiFetch((url) => {
      if (url.includes('page=2')) {
        return pageTwo.promise
      }

      return pageResponse([WALLET_A], {
        page: 1,
        pageSize: PAGE_SIZE,
        totalItems: 2,
        totalPages: 2,
      })
    })
    const { user } = renderApp({ path: '/wallets', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(screen.getByText('Primary signer')).toBeDefined()
    })

    await user.click(screen.getByRole('button', { name: 'Remove' }))
    expect(screen.getByRole('group', { name: /^Remove wallet/ })).toBeDefined()

    await user.click(button('Next'))
    pageTwo.resolve(
      pageResponse([WALLET_B], { page: 2, pageSize: PAGE_SIZE, totalItems: 2, totalPages: 2 }),
    )

    await waitFor(() => {
      expect(screen.getByText('Cold storage')).toBeDefined()
    })

    // The row's confirmation belonged to a page that is gone. It is dropped, so
    // the new page's actions are usable rather than disabled by a selection
    // nobody can see or cancel.
    expect(screen.queryByRole('group', { name: /^Remove wallet/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Remove' }).hasAttribute('disabled')).toBe(false)
    expect(screen.getByRole('button', { name: 'Edit label' }).hasAttribute('disabled')).toBe(false)
    expect(currentPath()).toBe('/wallets?page=2')
    expect(walletCalls(fetchStub.calls).length).toBeGreaterThanOrEqual(2)
  })

  it('ends the session when the API rejects the credential this tab sent', async () => {
    const storage = memoryStorage('stored-token')
    apiFetch(() => errorResponse(401, 'UNAUTHENTICATED'))

    renderApp({ path: '/wallets', storage })

    await waitFor(() => {
      expect(currentPath()).toBe('/login')
    })
    expect(storage.read()).toBeNull()
  })

  it('retires an editor whose row the next page no longer holds', async () => {
    const pageTwo = pendingResponse<Response>()
    const fetchStub = apiFetch((url) => {
      if (url.includes('page=2')) {
        return pageTwo.promise
      }

      return pageResponse([WALLET_A], {
        page: 1,
        pageSize: PAGE_SIZE,
        totalItems: 2,
        totalPages: 2,
      })
    })
    const { user } = renderApp({ path: '/wallets', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(screen.getByText('Primary signer')).toBeDefined()
    })

    await user.click(screen.getByRole('button', { name: 'Edit label' }))
    expect(screen.getByRole('form', { name: /^Edit label for/ })).toBeDefined()

    await user.click(button('Next'))

    await waitFor(() => {
      expect(currentPath()).toBe('/wallets?page=2')
    })

    pageTwo.resolve(
      pageResponse([WALLET_B], { page: 2, pageSize: PAGE_SIZE, totalItems: 2, totalPages: 2 }),
    )

    await waitFor(() => {
      expect(screen.getByText('Cold storage')).toBeDefined()
    })

    // The row the editor belonged to is gone with the old page. Its id used to
    // stay behind and disable the only action on the new page, with no editor
    // open and no Cancel to press.
    expect(screen.queryByRole('form', { name: /^Edit label for/ })).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Edit label' })).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Edit label' }).hasAttribute('disabled')).toBe(
      false,
    )
    // Retiring a selection is not a navigation and not a draft reset.
    expect(currentPath()).toBe('/wallets?page=2')
    expect(walletCalls(fetchStub.calls).length).toBeGreaterThanOrEqual(2)
  })

  it('keeps an unsaved draft through an ordinary list refresh', async () => {
    let listCall = 0
    apiFetch((_url, init) => {
      if (init.method === 'POST') {
        return jsonResponse(
          {
            data: {
              id: 9,
              address: '0x00000000000000000000000000000000000000c3',
              chainId: 11155111,
              label: 'New signer',
              createdAt: '2026-10-03T09:00:00Z',
            },
          },
          { status: 201 },
        )
      }

      listCall += 1
      return pageResponse([WALLET_A, WALLET_B], {
        page: 1,
        pageSize: PAGE_SIZE,
        totalItems: 2,
        totalPages: 1,
      })
    })
    const { user } = renderApp({ path: '/wallets', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(screen.getByText('Primary signer')).toBeDefined()
    })

    await user.click(screen.getAllByRole('button', { name: 'Edit label' })[0]!)
    const editor = screen.getByRole('form', { name: /^Edit label for/ })
    // The create form renders its own Label field first; the editor's is second.
    const input = screen.getAllByLabelText('Label')[1] as HTMLInputElement
    await user.clear(input)
    await user.type(input, 'Draft nobody saved')

    // A create elsewhere on the page refreshes the list. The editor's row is
    // still on it, so the draft the user is typing stays exactly as typed.
    await waitFor(() => {
      expect(screen.getByLabelText('Chain').querySelectorAll('option').length).toBeGreaterThan(1)
    })
    await user.type(
      screen.getByLabelText('Address'),
      '0x00000000000000000000000000000000000000c3',
    )
    await user.selectOptions(screen.getByLabelText('Chain'), '11155111')
    await user.type(screen.getAllByLabelText('Label')[0]!, 'New signer')
    await user.click(screen.getByRole('button', { name: 'Save wallet' }))

    await waitFor(() => {
      expect(listCall).toBe(2)
    })

    expect(screen.getByRole('form', { name: /^Edit label for/ })).toBe(editor)
    expect((screen.getAllByLabelText('Label')[1] as HTMLInputElement).value).toBe(
      'Draft nobody saved',
    )
  })

  it('never reports a cancelled check as the stored label', async () => {
    const held = pendingResponse<Response>()
    let listCalls = 0

    apiFetch((_url, init) => {
      if (init.method === 'PATCH') {
        return plainTextResponse(502, 'Bad Gateway')
      }

      if (init.method === 'POST') {
        return jsonResponse(
          {
            data: {
              id: 9,
              address: '0x00000000000000000000000000000000000000c3',
              chainId: 11155111,
              label: 'New signer',
              createdAt: '2026-10-03T09:00:00Z',
            },
          },
          { status: 201 },
        )
      }

      listCalls += 1

      if (listCalls === 1) {
        return pageResponse([WALLET_A])
      }

      // The check is held, and the read that replaces it after the create
      // carries the renamed value.
      if (listCalls === 2) {
        return held.promise
      }

      return pageResponse([{ ...WALLET_A, label: 'Renamed on the server' }])
    })

    const { user } = renderApp({ path: '/wallets', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(screen.getByText('Primary signer')).toBeDefined()
    })

    await user.click(screen.getByRole('button', { name: 'Edit label' }))
    await user.click(screen.getByRole('button', { name: 'Save label' }))

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('may or may not have been saved')
    })

    await user.click(screen.getByRole('button', { name: 'Check the list' }))
    expect(screen.getByText('Reading the list.')).toBeDefined()

    // Another write on the page refreshes the list, which cancels the check's
    // request. The query then falls back to the page it held before.
    await waitFor(() => {
      expect(screen.getByLabelText('Chain').querySelectorAll('option').length).toBeGreaterThan(1)
    })
    await user.type(
      screen.getByLabelText('Address'),
      '0x00000000000000000000000000000000000000c3',
    )
    await user.selectOptions(screen.getByLabelText('Chain'), '11155111')
    await user.type(screen.getAllByLabelText('Label')[0]!, 'New signer')
    await user.click(screen.getByRole('button', { name: 'Save wallet' }))

    await waitFor(() => {
      expect(listCalls).toBeGreaterThanOrEqual(3)
    })

    // The cancelled request now answers with the page it was going to send.
    held.resolve(pageResponse([WALLET_A]))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    // The check reaches a terminal state rather than staying on "Reading".
    await waitFor(() => {
      expect(screen.queryByText('Reading the list.')).toBeNull()
    })

    // Cached success is not a read. Whatever the check reports, it is never the
    // label the cancelled request was carrying; it either finished on a later
    // read and reports that value, or says it did not finish.
    expect(screen.queryByText(/"Primary signer"/)).toBeNull()
    expect(screen.queryByText(/The list now shows this wallet labelled "Primary signer"/)).toBeNull()

    const readback = screen.queryByText(/The list now shows this wallet labelled/)
    if (readback !== null) {
      expect(readback.textContent).toContain('Renamed on the server')
    }
  })

  /** Wallet GETs, which is what a revived read would add to. */
  function walletGets(calls: FetchCall[]): FetchCall[] {
    return walletCalls(calls).filter((call) => (call.init.method ?? 'GET') === 'GET')
  }

  it('starts nothing for a check whose page was unmounted', async () => {
    const queryClient = createQueryClient()
    let listCalls = 0

    const fetchStub = apiFetch((url, init) => {
      if (init.method === 'PATCH') {
        return plainTextResponse(502, 'Bad Gateway')
      }

      listCalls += 1

      // The check's read only settles when it is aborted, which is what a real
      // cancelled fetch does.
      return listCalls === 1 ? pageResponse([WALLET_A]) : hangingFetch(url, init)
    })

    const { user, unmount } = renderApp({
      path: '/wallets',
      storage: memoryStorage('stored-token'),
      queryClient,
    })

    await waitFor(() => {
      expect(screen.getByText('Primary signer')).toBeDefined()
    })

    await user.click(screen.getByRole('button', { name: 'Edit label' }))
    await user.click(screen.getByRole('button', { name: 'Save label' }))

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('may or may not have been saved')
    })

    await user.click(screen.getByRole('button', { name: 'Check the list' }))

    await waitFor(() => {
      expect(listCalls).toBe(2)
    })

    // Counted before the teardown, so a request made by the continuation shows
    // up as an addition instead of being folded into the baseline.
    const getsBefore = walletGets(fetchStub.calls).length

    // The route can go away without this page ever rendering a null session:
    // a guard redirect is an unmount, not a state this page sees.
    unmount()

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(walletGets(fetchStub.calls)).toHaveLength(getsBefore)

    // The client collects an unobserved query on its own zero-delay timer
    // (`gcTime: 0`), so the entry can outlive the tick above by one macrotask:
    // which timer fires first is not something to bet a green build on. The
    // assertion waits for the collection instead of racing it, and an entry
    // that actually survived still fails it.
    await waitFor(() => {
      expect(
        queryClient
          .getQueryCache()
          .getAll()
          .filter((query) => query.queryKey[0] === 'identity'),
      ).toHaveLength(0)
    })
  })

  it('revives no cached work for a check whose session ended while it waited', async () => {
    const heldLogout = pendingResponse<Response>()
    const queryClient = createQueryClient()
    let listCalls = 0

    const fetchStub = apiFetch((url, init) => {
      // The sign-out answer is held, so the identity is retired while this
      // screen is still mounted and still holding the check.
      if (url.includes('/auth/logout')) {
        return heldLogout.promise
      }

      if (init.method === 'PATCH') {
        return plainTextResponse(502, 'Bad Gateway')
      }

      listCalls += 1

      // The first load answers. The check's read is a request that only settles
      // when it is aborted, which is what a real cancelled fetch does.
      return listCalls === 1 ? pageResponse([WALLET_A]) : hangingFetch(url, init)
    })

    const { user } = renderApp({
      path: '/wallets',
      storage: memoryStorage('stored-token'),
      queryClient,
    })

    await waitFor(() => {
      expect(screen.getByText('Primary signer')).toBeDefined()
    })

    const ownerKeys = queryClient
      .getQueryCache()
      .findAll({ queryKey: ['identity', USER.id] })
      .map((query) => query.queryKey)

    expect(ownerKeys.length).toBeGreaterThan(0)

    await user.click(screen.getByRole('button', { name: 'Edit label' }))
    await user.click(screen.getByRole('button', { name: 'Save label' }))

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('may or may not have been saved')
    })

    await user.click(screen.getByRole('button', { name: 'Check the list' }))

    await waitFor(() => {
      expect(listCalls).toBe(2)
    })

    await user.click(screen.getByRole('button', { name: 'Sign out' }))

    // No session, and this page is still mounted: a check keyed on "is the
    // editor still open" would think it is free to carry on.
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('Waiting for your session')
    })

    const getsBefore = walletGets(fetchStub.calls).length

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    // The aborted check settles here, and its continuation must not read again.
    // A read would both issue a request with a credential this tab has given up
    // and put the retired identity's page back into a cache the sign-out
    // dropped.
    expect(walletGets(fetchStub.calls)).toHaveLength(getsBefore)
    expect(
      queryClient.getQueryCache().findAll({ queryKey: ['identity', USER.id] }),
    ).toHaveLength(0)

    heldLogout.resolve(jsonResponse({ data: { message: 'signed out' } }))
    await waitFor(() => {
      expect(currentPath()).toBe('/login')
    })
    expect(walletGets(fetchStub.calls)).toHaveLength(getsBefore)
    expect(
      queryClient.getQueryCache().findAll({ queryKey: ['identity', USER.id] }),
    ).toHaveLength(0)
  })

  it('retires a selection whose row a refresh dropped', async () => {
    let listCall = 0
    apiFetch((_url, init) => {
      if (init.method === 'POST') {
        return jsonResponse(
          {
            data: {
              id: 9,
              address: '0x00000000000000000000000000000000000000c3',
              chainId: 11155111,
              label: 'New signer',
              createdAt: '2026-10-03T09:00:00Z',
            },
          },
          { status: 201 },
        )
      }

      listCall += 1
      return pageResponse(listCall === 1 ? [WALLET_A, WALLET_B] : [WALLET_A], {
        page: 1,
        pageSize: PAGE_SIZE,
        totalItems: listCall === 1 ? 2 : 1,
        totalPages: 1,
      })
    })
    const { user } = renderApp({ path: '/wallets', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(screen.getByText('Cold storage')).toBeDefined()
    })

    // Open the editor on the row the refresh will not return.
    await user.click(screen.getAllByRole('button', { name: 'Edit label' })[1]!)

    await waitFor(() => {
      expect(screen.getByLabelText('Chain').querySelectorAll('option').length).toBeGreaterThan(1)
    })
    await user.type(
      screen.getByLabelText('Address'),
      '0x00000000000000000000000000000000000000c3',
    )
    await user.selectOptions(screen.getByLabelText('Chain'), '11155111')
    await user.type(screen.getAllByLabelText('Label')[0]!, 'New signer')
    await user.click(screen.getByRole('button', { name: 'Save wallet' }))

    await waitFor(() => {
      expect(screen.queryByText('Cold storage')).toBeNull()
    })

    // The editor's row is gone, so the editor is gone and nothing else is
    // locked. The remaining row can still be edited.
    expect(screen.queryByRole('form', { name: /^Edit label for/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Edit label' }).hasAttribute('disabled')).toBe(
      false,
    )
    expect(currentPath()).toBe('/wallets')
  })

  it('abandons a wallet request that is still running when the user signs out', async () => {
    const held = pendingResponse<Response>()
    let aborted = false
    apiFetch((url, init) => {
      // The sign-out call has to be answered; only the wallet read is held.
      if (url.includes('/auth/logout')) {
        return jsonResponse({ data: { message: 'signed out' } })
      }

      init.signal?.addEventListener('abort', () => {
        aborted = true
      })
      return held.promise
    })

    const { user } = renderApp({ path: '/wallets', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('Loading wallets')
    })

    await user.click(screen.getByRole('button', { name: 'Sign out' }))

    await waitFor(() => {
      expect(currentPath()).toBe('/login')
    })
    expect(aborted).toBe(true)
  })
})
