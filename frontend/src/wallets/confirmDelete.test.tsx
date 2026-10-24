import { QueryClient } from '@tanstack/react-query'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { User, Wallet } from '../api/index.ts'
import { createTokenStorage, type TokenStorage } from '../auth/storage.ts'
import { otherTabRemoves, otherTabStores } from '../test/crossTab.ts'
import {
  emptyResponse,
  errorResponse,
  jsonResponse,
  pendingResponse,
  plainTextResponse,
  stubFetch,
} from '../test/http.ts'
import { createQueryClient } from '../data/queryClient.ts'
import { currentPath, renderApp } from '../test/renderApp.tsx'
import { PAGE_SIZE } from '../data/page.ts'

const USER_A: User = { id: 5, email: 'ada@example.com', createdAt: '2026-10-06T12:00:00Z' }
const USER_B: User = { id: 9, email: 'bob@example.com', createdAt: '2026-10-06T12:00:00Z' }

const WALLET_1: Wallet = {
  id: 11,
  address: '0x00000000000000000000000000000000000000c3',
  chainId: 11155111,
  label: 'Treasury',
  createdAt: '2026-10-18T09:00:00Z',
}

const WALLET_2: Wallet = {
  id: 12,
  address: '0x00000000000000000000000000000000000000d4',
  chainId: 1,
  label: 'Cold storage',
  createdAt: '2026-10-19T09:00:00Z',
}

function paginationFor(totalItems: number) {
  return {
    page: 1,
    pageSize: PAGE_SIZE,
    totalItems,
    totalPages: Math.ceil(totalItems / PAGE_SIZE),
  }
}

function listResponse(wallets: Wallet[], pagination = paginationFor(wallets.length)) {
  return jsonResponse({ data: wallets, pagination })
}

type Handlers = {
  list?: (call: number, init: RequestInit, page: number) => Response | Promise<Response>
  remove?: (id: number, call: number, init: RequestInit) => Response | Promise<Response>
  fetchOne?: (id: number, call: number, init: RequestInit) => Response | Promise<Response>
  me?: (token: string) => Response
}

/**
 * Routes the calls this slice makes, keeping the DELETE and the single-wallet
 * read apart by path so a test can tell a reconciliation read from a replay.
 */
function stubApi(handlers: Handlers = {}) {
  let listCalls = 0
  let removeCalls = 0
  let readCalls = 0
  const removeUrls: string[] = []
  const readUrls: string[] = []

  const stub = stubFetch((url: string, init: RequestInit) => {
    if (url.includes('/users/me')) {
      const header = new Headers(init.headers).get('authorization') ?? ''
      const token = header.replace('Bearer ', '')
      return handlers.me === undefined ? jsonResponse({ data: USER_A }) : handlers.me(token)
    }

    if (url.includes('/auth/logout')) {
      return jsonResponse({ data: { message: 'signed out' } })
    }

    if (url.includes('/chains')) {
      return jsonResponse({
        data: [{ chainId: 11155111, name: 'Sepolia', symbol: 'ETH', isTestnet: true }],
      })
    }

    // One saved record: DELETE removes it, GET reads it.
    const single = /\/wallets\/(\d+)$/.exec(url)

    if (single !== null) {
      const id = Number(single[1])

      if (init.method === 'DELETE') {
        removeCalls += 1
        removeUrls.push(url)
        return (
          handlers.remove?.(id, removeCalls, init) ?? emptyResponse(204)
        )
      }

      readCalls += 1
      readUrls.push(url)
      return (
        handlers.fetchOne?.(id, readCalls, init) ??
        jsonResponse({ data: WALLET_1.id === id ? WALLET_1 : WALLET_2 })
      )
    }

    if (url.includes('/wallets')) {
      if (init.method === 'POST') {
        return jsonResponse(
          {
            data: {
              id: 13,
              address: '0x00000000000000000000000000000000000000e5',
              chainId: 1,
              label: 'New signer',
              createdAt: '2026-10-20T09:00:00Z',
            },
          },
          { status: 201 },
        )
      }

      listCalls += 1

      // Which page this read is for, so a test can answer page 2 differently
      // from page 1 and tell a read of the row's page from a read of another.
      const pageParam = /[?&]page=(\d+)/.exec(url)

      return (
        handlers.list?.(
          listCalls,
          init,
          pageParam === null ? 1 : Number(pageParam[1]),
        ) ?? listResponse([WALLET_1, WALLET_2])
      )
    }

    throw new Error(`unexpected request: ${url}`)
  })

  return {
    stub,
    removeUrls,
    readUrls,
    get listCalls() {
      return listCalls
    },
    get removeCalls() {
      return removeCalls
    },
    get readCalls() {
      return readCalls
    },
  }
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function realStorage(initial: string): TokenStorage {
  window.localStorage.clear()
  const storage = createTokenStorage(() => window.localStorage)
  storage.write(initial)
  return storage
}

function confirmPanel(): HTMLElement {
  return screen.getByRole('group', { name: /^Remove wallet/ })
}

function removeButtons(): HTMLButtonElement[] {
  return screen.queryAllByRole('button', { name: 'Remove' }) as HTMLButtonElement[]
}

function editButtons(): HTMLButtonElement[] {
  return screen.queryAllByRole('button', { name: 'Edit label' }) as HTMLButtonElement[]
}

function buttonIn(scope: HTMLElement, name: string): HTMLButtonElement {
  return within(scope).getByRole('button', { name }) as HTMLButtonElement
}

async function openConfirm(
  user: ReturnType<typeof userEvent.setup>,
  index = 0,
): Promise<void> {
  await waitFor(() => {
    expect(removeButtons().length).toBeGreaterThan(0)
  })
  await user.click(removeButtons()[index]!)
  await waitFor(() => {
    expect(screen.queryByRole('group', { name: /^Remove wallet/ })).not.toBeNull()
  })
}

/** Confirms removal and waits for the answer the handler sent. */
async function confirmRemoval(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(buttonIn(confirmPanel(), 'Remove wallet'))
}

describe('wallet removal confirmation', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    window.localStorage.clear()
  })

  it('names the row it will remove, and says this is not a chain action', async () => {
    stubApi()
    const { user } = renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await openConfirm(user)

    const panel = confirmPanel()
    expect(within(panel).getByText('Treasury')).toBeDefined()
    expect(within(panel).getByText(WALLET_1.address)).toBeDefined()
    expect(within(panel).getByText(String(WALLET_1.chainId))).toBeDefined()
    expect(within(panel).getByText(/does not touch keys, funds/)).toBeDefined()

    // The safe choice of the two is where the caret lands.
    expect(document.activeElement).toBe(buttonIn(panel, 'Cancel'))
  })

  it('sends nothing on Cancel and puts focus back on the row action', async () => {
    const api = stubApi()
    const { user } = renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await openConfirm(user)
    await user.click(buttonIn(confirmPanel(), 'Cancel'))

    await waitFor(() => {
      expect(screen.queryByRole('group', { name: /^Remove wallet/ })).toBeNull()
    })
    expect(api.removeCalls).toBe(0)
    expect(document.activeElement).toBe(removeButtons()[0])
  })

  it('cannot be opened over an unsaved label draft', async () => {
    const api = stubApi()
    const { user } = renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await waitFor(() => {
      expect(editButtons().length).toBeGreaterThan(0)
    })
    await user.click(editButtons()[0]!)

    const input = within(screen.getByRole('form', { name: /^Edit label for/ })).getByLabelText(
      'Label',
    ) as HTMLInputElement
    await user.clear(input)
    await user.type(input, 'A draft nobody saved')

    // The other row operations are unavailable while the draft exists, which is
    // what stops a destructive confirmation from closing over it. The edited
    // row has no actions at all while its editor is open.
    expect(removeButtons()).toHaveLength(1)
    expect(removeButtons().every((button) => button.disabled)).toBe(true)
    expect(api.removeCalls).toBe(0)

    // And closing the editor leaves the draft untouched until it is closed.
    expect(input.value).toBe('A draft nobody saved')
  })

  it('blocks the editor while a confirmation is open, in both directions', async () => {
    stubApi()
    const { user } = renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await openConfirm(user)

    expect(editButtons().every((button) => button.disabled)).toBe(true)

    await user.click(buttonIn(confirmPanel(), 'Cancel'))

    await waitFor(() => {
      expect(editButtons().some((button) => !button.disabled)).toBe(true)
    })
    expect(removeButtons().some((button) => !button.disabled)).toBe(true)
  })
})

/**
 * Tries to remove a row that is still on screen after its record was settled.
 *
 * A blocked control does nothing, but a reopened confirmation would also be a
 * way back to the same request, so both paths are exercised: press the row's
 * action, and if that opens the panel, confirm again. A test that only pressed
 * the first button would pass against a page that reopened the confirmation.
 */
async function attemptSecondRemoval(
  user: ReturnType<typeof userEvent.setup>,
  index = 0,
): Promise<void> {
  const stale = removeButtons()[index]
  if (stale === undefined) {
    return
  }

  await user.click(stale)
  await settle()

  const panel = screen.queryByRole('group', { name: /^Remove wallet/ })
  if (panel !== null) {
    await user.click(buttonIn(panel, 'Remove wallet'))
    await settle()
  }
}

describe('wallet removal answer', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    window.localStorage.clear()
  })

  it('treats the 204 as the confirmation and shows what happened', async () => {
    const api = stubApi({
      list: (call) => (call === 1 ? listResponse([WALLET_1, WALLET_2]) : listResponse([WALLET_2])),
    })
    const { user } = renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await openConfirm(user)
    await confirmRemoval(user)

    await waitFor(() => {
      expect(screen.getByText(/Removed the saved record for/)).toBeDefined()
    })
    expect(api.removeCalls).toBe(1)
    expect(api.removeUrls[0]).toMatch(/\/wallets\/11$/)

    // The row is gone because the list says so, not because it was dropped
    // ahead of the answer.
    await waitFor(() => {
      expect(screen.queryByText(WALLET_1.address)).toBeNull()
    })
    // Focus lands on the status line, because the row's buttons are gone.
    expect(document.activeElement?.textContent).toContain('Removed the saved record')
  })

  it.each([
    ['an empty 200', 200],
    ['an empty 202', 202],
  ])('refuses %s and offers the read-only check', async (_name, status) => {
    const api = stubApi({ remove: () => new Response(null, { status }) })
    const { user } = renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await openConfirm(user)
    await confirmRemoval(user)

    await waitFor(() => {
      expect(screen.getByText(/may or may not be gone/)).toBeDefined()
    })
    expect(buttonIn(confirmPanel(), 'Check saved record')).toBeDefined()
    // No removal is claimed: nothing about the row was applied.
    expect(api.removeCalls).toBe(1)
    expect(screen.queryByText(/Removed the saved record for/)).toBeNull()
  })

  it('reads a typed 404 as already unavailable, never as a new removal', async () => {
    const api = stubApi({
      remove: () => errorResponse(404, 'RESOURCE_NOT_FOUND', { message: 'wallet not found' }),
      list: (call) => (call === 1 ? listResponse([WALLET_1, WALLET_2]) : listResponse([WALLET_2])),
    })
    const { user } = renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await openConfirm(user)
    await confirmRemoval(user)

    await waitFor(() => {
      expect(
        screen.getByText(/is no longer available to your account/),
      ).toBeDefined()
    })
    // It is not reported as a successful removal, and it proves nothing about
    // who removed the record.
    expect(screen.queryByText(/Removed the saved record for/)).toBeNull()
    expect(api.removeCalls).toBe(1)
  })

  it('leaves an opaque 404 unknown rather than thinking it is unavailable', async () => {
    stubApi({ remove: () => plainTextResponse(404, '404 page not found') })
    const { user } = renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await openConfirm(user)
    await confirmRemoval(user)

    await waitFor(() => {
      expect(screen.getByText(/may or may not be gone/)).toBeDefined()
    })
    expect(screen.queryByText(/is no longer available to your account/)).toBeNull()
  })

  it.each([
    ['a timeout', () => errorResponse(0, 'TIMEOUT')],
    ['an unreadable gateway', () => plainTextResponse(502, 'Bad Gateway')],
  ])('treats %s as unconfirmed and offers the check', async (_name, remove) => {
    stubApi({ remove })
    const { user } = renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await openConfirm(user)
    await confirmRemoval(user)

    await waitFor(() => {
      expect(screen.getByText(/may or may not be gone/)).toBeDefined()
    })
    expect(buttonIn(confirmPanel(), 'Check saved record')).toBeDefined()
  })

  it('reports a real failure as a failure and sends nothing on its own', async () => {
    const api = stubApi({
      remove: () => errorResponse(429, 'RATE_LIMITED', { headers: { 'Retry-After': '9' } }),
    })
    const { user } = renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await openConfirm(user)
    await confirmRemoval(user)

    await waitFor(() => {
      expect(screen.getByText(/in 9 seconds/)).toBeDefined()
    })
    expect(screen.getByText('The saved record was not removed.')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Check saved record' })).toBeNull()
    expect(api.removeCalls).toBe(1)
  })

  it('keeps the block after paging away and back to the stale page', async () => {
    const PAGE_2_WALLET: Wallet = {
      id: 21,
      address: '0x00000000000000000000000000000000000000f6',
      chainId: 1,
      label: 'Signer two',
      createdAt: '2026-10-21T09:00:00Z',
    }

    const pagination = (pageNumber: number) => ({
      page: pageNumber,
      pageSize: PAGE_SIZE,
      totalItems: 12,
      totalPages: 2,
    })

    // Page 1 holds the row that gets removed and answers with the stale page
    // again after the removal. Page 2 never held it and answers normally.
    const api = stubApi({
      list: (_call, _init, pageNumber) => {
        if (pageNumber === 2) {
          return listResponse([PAGE_2_WALLET], pagination(2))
        }

        return listResponse([WALLET_1, WALLET_2], pagination(1))
      },
    })
    const { user } = renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await openConfirm(user)
    await confirmRemoval(user)

    await waitFor(() => {
      expect(api.removeCalls).toBe(1)
    })

    // Page 1 still shows the settled row, and it is blocked there.
    expect(removeButtons()[0]!.disabled).toBe(true)

    // Page 2 does not hold the row at all. That is not proof of anything: it is
    // a page that never had it.
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => {
      expect(screen.getByText(PAGE_2_WALLET.address)).toBeDefined()
    })
    expect(removeButtons().every((button) => !button.disabled)).toBe(true)

    // Back to page 1, whose cache still holds the removed row. The block has to
    // survive the round trip, or the row is removable again while its page has
    // not answered since the delete.
    await user.click(screen.getByRole('button', { name: 'Previous' }))
    await waitFor(() => {
      expect(screen.getByText(WALLET_1.address)).toBeDefined()
    })

    const stale = removeButtons()[0]!
    expect(stale.disabled).toBe(true)
    expect(screen.getByText('Removed. Waiting for the list to catch up.')).toBeDefined()

    // Nothing to press, and nothing that pressing it could send.
    await attemptSecondRemoval(user)
    expect(screen.queryByRole('group', { name: /^Remove wallet/ })).toBeNull()
    expect(api.removeCalls).toBe(1)
    expect(api.readCalls).toBe(0)
  })

  it('blocks the stale row while the refreshed list is still on its way', async () => {
    const heldRefresh = pendingResponse<Response>()
    let lists = 0
    const api = stubApi({
      list: () => {
        lists += 1
        // The first read answers; the refresh after the confirmed delete is
        // held, so the removed row is still on screen.
        return lists === 1 ? listResponse([WALLET_1, WALLET_2]) : heldRefresh.promise
      },
    })
    const { user } = renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await openConfirm(user)
    await confirmRemoval(user)

    await waitFor(() => {
      expect(api.removeCalls).toBe(1)
    })
    // Confirmed, and the row is deliberately still there: the list has not
    // answered yet.
    await waitFor(() => {
      expect(screen.getByText(WALLET_1.address)).toBeDefined()
    })

    const stale = removeButtons()[0]!
    expect(stale.disabled).toBe(true)
    expect(screen.getByText('Removed. Waiting for the list to catch up.')).toBeDefined()

    // Neither the disabled control nor a reopened confirmation can start
    // another DELETE for a record the server has already confirmed gone.
    // eslint-disable-next-line no-console
    console.log('DBG1 disabled=', removeButtons()[0]?.disabled, 'calls=', api.removeCalls)
    await attemptSecondRemoval(user)
    // eslint-disable-next-line no-console
    console.log('DBG2 calls=', api.removeCalls)
    expect(api.removeCalls).toBe(1)
    expect(api.readCalls).toBe(0)

    // Once the fresh page arrives without the row, the row and the block go.
    heldRefresh.resolve(listResponse([WALLET_2]))
    await waitFor(() => {
      expect(screen.queryByText(WALLET_1.address)).toBeNull()
    })
    expect(api.removeCalls).toBe(1)
  })

  it('keeps the stale row blocked when the refresh fails, and never resends', async () => {
    let lists = 0
    const api = stubApi({
      list: () => {
        lists += 1
        return lists === 1
          ? listResponse([WALLET_1, WALLET_2])
          : errorResponse(503, 'SERVICE_UNAVAILABLE')
      },
    })
    const { user } = renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await openConfirm(user)
    await confirmRemoval(user)

    await waitFor(() => {
      expect(screen.getByText(/The list could not be refreshed/)).toBeDefined()
    })

    // The confirmed row survives the failed refresh, and it stays blocked: the
    // answer is final even though the list cannot show it yet.
    expect(screen.getByText(WALLET_1.address)).toBeDefined()

    await attemptSecondRemoval(user)
    expect(api.removeCalls).toBe(1)
    expect(api.readCalls).toBe(0)
    expect(removeButtons()[0]!.disabled).toBe(true)

    // Retrying the list is a read. It never becomes another delete, and the
    // block lifts only when a page without the row arrives.
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => {
      expect(lists).toBeGreaterThan(2)
    })
    expect(api.removeCalls).toBe(1)
  })

  it('blocks a row the server already reports as unavailable', async () => {
    let lists = 0
    const api = stubApi({
      remove: () => errorResponse(404, 'RESOURCE_NOT_FOUND'),
      list: () => {
        lists += 1
        return lists === 1 ? listResponse([WALLET_1, WALLET_2]) : listResponse([WALLET_1, WALLET_2])
      },
    })
    const { user } = renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await openConfirm(user)
    await confirmRemoval(user)

    await waitFor(() => {
      expect(screen.getByText(/is no longer available to your account/)).toBeDefined()
    })

    // A typed not-found is terminal too. If the refreshed page somehow still
    // holds the row, it is not offered again.
    await attemptSecondRemoval(user)
    expect(api.removeCalls).toBe(1)
    expect(removeButtons()[0]!.disabled).toBe(true)
    expect(lists).toBeGreaterThan(1)
  })

  it('stops the page moving while the delete is on the wire', async () => {
    const held = pendingResponse<Response>()
    const api = stubApi({
      remove: () => held.promise,
      list: (call) =>
        call === 1
          ? listResponse([WALLET_1], {
              page: 1,
              pageSize: PAGE_SIZE,
              totalItems: 21,
              totalPages: 2,
            })
          : listResponse([WALLET_2], {
              page: 2,
              pageSize: PAGE_SIZE,
              totalItems: 21,
              totalPages: 2,
            }),
    })
    const { user } = renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await openConfirm(user)
    await confirmRemoval(user)
    await waitFor(() => {
      expect(api.removeCalls).toBe(1)
    })

    // Paging away would unmount the row and abort a decision the user has
    // already made, so the controls are held for the duration of the request.
    expect(screen.getByRole('button', { name: 'Next' }).hasAttribute('disabled')).toBe(true)
    expect(buttonIn(confirmPanel(), 'Cancel').hasAttribute('disabled')).toBe(true)
    expect(buttonIn(confirmPanel(), 'Remove wallet').hasAttribute('disabled')).toBe(true)
    expect(currentPath()).toBe('/wallets')

    held.resolve(emptyResponse(204))
    await waitFor(() => {
      expect(screen.getByText(/Removed the saved record for/)).toBeDefined()
    })
  })

  it('sends no second delete while the user waits', async () => {
    const api = stubApi({ remove: () => plainTextResponse(504, 'Gateway Timeout') })
    const { user } = renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await openConfirm(user)
    await confirmRemoval(user)

    await waitFor(() => {
      expect(screen.getByText(/may or may not be gone/)).toBeDefined()
    })
    await settle()
    await settle()

    expect(api.removeCalls).toBe(1)
  })
})

describe('removal reconciliation', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    window.localStorage.clear()
  })

  async function openUnknownRemoval(
    handlers: Pick<Handlers, 'fetchOne' | 'list'> = {},
    user?: ReturnType<typeof userEvent.setup>,
  ) {
    const api = stubApi({
      remove: () => plainTextResponse(502, 'Bad Gateway'),
      ...handlers,
    })
    const rendered = renderApp({ path: '/wallets', storage: realStorage('token-a') })
    const actor = user ?? rendered.user

    await openConfirm(actor)
    await confirmRemoval(actor)

    await waitFor(() => {
      expect(screen.getByText(/may or may not be gone/)).toBeDefined()
    })

    return { api, ...rendered, user: actor }
  }

  it('shows the record it read, without sending another delete', async () => {
    const { api, user } = await openUnknownRemoval()

    await user.click(buttonIn(confirmPanel(), 'Check saved record'))

    await waitFor(() => {
      expect(screen.getByText(/The saved record is still on the server/)).toBeDefined()
    })
    expect(
      within(confirmPanel()).getByText(/The saved record is still on the server: "Treasury",/),
    ).toBeDefined()
    // A read, not a replay.
    expect(api.removeCalls).toBe(1)
    expect(api.readCalls).toBe(1)
    expect(api.readUrls[0]).toMatch(/\/wallets\/11$/)
  })

  it('reads a typed 404 as unavailable to this owner', async () => {
    const { api, user } = await openUnknownRemoval({
      fetchOne: () => errorResponse(404, 'RESOURCE_NOT_FOUND'),
      list: (call) => (call === 1 ? listResponse([WALLET_1, WALLET_2]) : listResponse([WALLET_2])),
    })

    await user.click(buttonIn(confirmPanel(), 'Check saved record'))

    await waitFor(() => {
      expect(screen.getByText(/is no longer available to your account/)).toBeDefined()
    })
    expect(api.removeCalls).toBe(1)
  })

  it.each([
    ['a failed read', () => errorResponse(500, 'INTERNAL_SERVER_ERROR')],
    ['an opaque 404', () => plainTextResponse(404, 'Not Found')],
    ['a malformed row', () => jsonResponse({ data: { ...WALLET_1, id: 99 } })],
  ])('does not establish absence from %s', async (_name, fetchOne) => {
    const { api, user } = await openUnknownRemoval({ fetchOne })

    await user.click(buttonIn(confirmPanel(), 'Check saved record'))

    await waitFor(() => {
      expect(screen.getByText(/cannot be shown to be gone or still there/)).toBeDefined()
    })
    expect(screen.queryByText(/is no longer available to your account/)).toBeNull()
    expect(api.removeCalls).toBe(1)
  })
})

describe('removal lifetime', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    window.localStorage.clear()
  })

  it('applies nothing when the answer arrives after another account signs in', async () => {
    const held = pendingResponse<Response>()
    const api = stubApi({
      remove: () => held.promise,
      me: (token) => jsonResponse({ data: token === 'token-b' ? USER_B : USER_A }),
    })
    const { user } = renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await openConfirm(user)
    await confirmRemoval(user)
    await waitFor(() => {
      expect(api.removeCalls).toBe(1)
    })

    otherTabStores('token-b')
    await waitFor(() => {
      expect(screen.getByText(USER_B.email)).toBeDefined()
    })

    held.resolve(emptyResponse(204))
    await settle()

    expect(screen.queryByText(/Removed the saved record for/)).toBeNull()
    expect(screen.queryByText(new RegExp(WALLET_1.address))).toBeDefined()
  })

  it('applies nothing after the credential is removed in another tab', async () => {
    const held = pendingResponse<Response>()
    stubApi({ remove: () => held.promise })
    const { user } = renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await openConfirm(user)
    await confirmRemoval(user)

    act(() => {
      otherTabRemoves()
    })

    await waitFor(() => {
      expect(currentPath()).toBe('/login')
    })

    held.resolve(emptyResponse(204))
    await settle()

    expect(screen.queryByText(/Removed the saved record for/)).toBeNull()
    expect(currentPath()).toBe('/login')
  })

  it('drops a held check when the page is unmounted underneath it', async () => {
    const held = pendingResponse<Response>()
    const queryClient: QueryClient = createQueryClient()
    const api = stubApi({
      remove: () => plainTextResponse(502, 'Bad Gateway'),
      fetchOne: () => held.promise,
    })
    const { user, unmount } = renderApp({
      path: '/wallets',
      storage: realStorage('token-a'),
      queryClient,
    })

    await openConfirm(user)
    await confirmRemoval(user)
    await waitFor(() => {
      expect(screen.getByText(/may or may not be gone/)).toBeDefined()
    })

    await user.click(buttonIn(confirmPanel(), 'Check saved record'))
    await waitFor(() => {
      expect(api.readCalls).toBe(1)
    })

    unmount()

    held.resolve(jsonResponse({ data: WALLET_1 }))
    await settle()

    // Nothing was applied to a screen that no longer exists, and the read was
    // not repeated to find out.
    expect(api.readCalls).toBe(1)
    expect(api.removeCalls).toBe(1)
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0)
  })

  it('does not revive a check for a retired session', async () => {
    const held = pendingResponse<Response>()
    let reads = 0
    const api = stubApi({
      remove: () => plainTextResponse(502, 'Bad Gateway'),
      fetchOne: () => {
        reads += 1
        return held.promise
      },
    })
    const { user } = renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await openConfirm(user)
    await confirmRemoval(user)
    await waitFor(() => {
      expect(screen.getByText(/may or may not be gone/)).toBeDefined()
    })

    await user.click(buttonIn(confirmPanel(), 'Check saved record'))
    await waitFor(() => {
      expect(reads).toBe(1)
    })

    act(() => {
      otherTabRemoves()
    })
    await waitFor(() => {
      expect(currentPath()).toBe('/login')
    })

    held.resolve(jsonResponse({ data: WALLET_1 }))
    await settle()

    expect(reads).toBe(1)
    expect(api.removeCalls).toBe(1)
    expect(currentPath()).toBe('/login')
  })

  it('stays open through an ordinary list read of the same rows', async () => {
    let listCalls = 0
    const api = stubApi({
      remove: () => plainTextResponse(502, 'Bad Gateway'),
      list: () => {
        listCalls += 1
        return listResponse([WALLET_1, WALLET_2])
      },
    })
    const { user } = renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await openConfirm(user)
    await confirmRemoval(user)
    await waitFor(() => {
      expect(screen.getByText(/may or may not be gone/)).toBeDefined()
    })

    const listsBefore = api.listCalls

    // Another write on the page refreshes the list. The row this confirmation
    // belongs to is still on the arrived page, so nothing has been decided for
    // it and the panel stays exactly as it was.
    await waitFor(() => {
      expect(screen.getByLabelText('Chain').querySelectorAll('option').length).toBeGreaterThan(1)
    })
    await user.type(
      screen.getByLabelText('Address'),
      '0x00000000000000000000000000000000000000e5',
    )
    await user.selectOptions(screen.getByLabelText('Chain'), '11155111')
    await user.type(screen.getAllByLabelText('Label')[0]!, 'New signer')
    await user.click(screen.getByRole('button', { name: 'Save wallet' }))

    await waitFor(() => {
      expect(api.listCalls).toBeGreaterThan(listsBefore)
    })

    expect(within(confirmPanel()).getByText('Treasury')).toBeDefined()
    expect(screen.getByText(/may or may not be gone/)).toBeDefined()
    expect(api.removeCalls).toBe(1)
    expect(listCalls).toBeGreaterThan(listsBefore)
  })
})
