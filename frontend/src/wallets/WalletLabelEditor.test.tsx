import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ApiClient, User, Wallet } from '../api/index.ts'
import { createTokenStorage, type TokenStorage } from '../auth/storage.ts'
import type { DataSession } from '../auth/session.ts'
import { otherTabRemoves, otherTabStores } from '../test/crossTab.ts'
import {
  errorResponse,
  hangingFetch,
  jsonResponse,
  pendingResponse,
  plainTextResponse,
  stubFetch,
} from '../test/http.ts'
import { isProtectedKey } from '../data/identityKeys.ts'
import { createQueryClient } from '../data/queryClient.ts'
import { currentPath, renderApp } from '../test/renderApp.tsx'
import { PAGE_SIZE } from '../data/page.ts'
import { WalletLabelEditor } from './WalletLabelEditor.tsx'

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

function paginationFor(totalItems: number, page = 1) {
  return {
    page,
    pageSize: PAGE_SIZE,
    totalItems,
    totalPages: Math.ceil(totalItems / PAGE_SIZE),
  }
}

function listResponse(wallets: Wallet[], pagination = paginationFor(wallets.length)) {
  return jsonResponse({ data: wallets, pagination })
}

function updatedResponse(wallet: Wallet = { ...WALLET_1, label: 'Treasury ops' }) {
  return jsonResponse({ data: wallet })
}

type Handlers = {
  list?: (call: number, init: RequestInit) => Response | Promise<Response>
  patch?: (body: unknown, call: number, init: RequestInit) => Response | Promise<Response>
  me?: (token: string) => Response
}

/**
 * Routes every call this slice makes, with the PATCH counter kept separate so a
 * test can assert that reconciliation never turns into a second write.
 */
function stubApi(handlers: Handlers = {}) {
  let listCalls = 0
  let patchCalls = 0
  const patchBodies: unknown[] = []
  const patchUrls: string[] = []

  const stub = stubFetch((url: string, init: RequestInit) => {
    if (url.includes('/users/me')) {
      const header = new Headers(init.headers).get('authorization') ?? ''
      const token = header.replace('Bearer ', '')
      return handlers.me === undefined
        ? jsonResponse({ data: USER_A })
        : handlers.me(token)
    }

    if (url.includes('/auth/logout')) {
      return jsonResponse({ data: { message: 'signed out' } })
    }

    if (url.includes('/chains')) {
      return jsonResponse({
        data: [{ chainId: 11155111, name: 'Sepolia', symbol: 'ETH', isTestnet: true }],
      })
    }

    if (url.includes('/wallets')) {
      if (init.method === 'PATCH') {
        patchCalls += 1
        patchUrls.push(url)
        const rawBody = init.body
        patchBodies.push(
          typeof rawBody === 'string' ? (JSON.parse(rawBody) as unknown) : rawBody,
        )
        return handlers.patch?.(patchBodies.at(-1), patchCalls, init) ?? updatedResponse()
      }

      listCalls += 1
      return handlers.list?.(listCalls, init) ?? listResponse([WALLET_1])
    }

    throw new Error(`unexpected request: ${url}`)
  })

  return {
    stub,
    patchBodies,
    patchUrls,
    get listCalls() {
      return listCalls
    },
    get patchCalls() {
      return patchCalls
    },
  }
}

/**
 * Lets a released promise settle and React render, so a later "this is not on
 * screen" means the answer was discarded and not merely not processed yet.
 */
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

/** The editor's own form, scoped so the create form above it never matches. */
function editorForm(): HTMLElement {
  return screen.getByRole('form', { name: /^Edit label for/ })
}

function labelInput(): HTMLInputElement {
  return within(editorForm()).getByLabelText('Label') as HTMLInputElement
}

function saveButton(): HTMLButtonElement {
  return within(editorForm()).getByRole('button', {
    name: 'Save label',
  }) as HTMLButtonElement
}

function cancelButton(): HTMLButtonElement {
  return within(editorForm()).getByRole('button', {
    name: 'Cancel',
  }) as HTMLButtonElement
}

function editButtons(): HTMLButtonElement[] {
  return screen.queryAllByRole('button', { name: 'Edit label' }) as HTMLButtonElement[]
}

async function openEditor(
  user: ReturnType<typeof userEvent.setup>,
  index = 0,
): Promise<void> {
  await waitFor(() => {
    expect(editButtons().length).toBeGreaterThan(0)
  })
  const button = editButtons()[index]
  if (button === undefined) {
    throw new Error('there is no row action to open')
  }
  await user.click(button)
  await waitFor(() => {
    expect(screen.queryByRole('button', { name: 'Save label' })).not.toBeNull()
  })
}

/** True while the editor's own form is on screen. */
function editorIsOpen(): boolean {
  return screen.queryByRole('form', { name: /^Edit label for/ }) !== null
}

describe('wallet label editor', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    window.localStorage.clear()
  })

  it('opens prefilled, focused, with the address and chain still read-only', async () => {
    stubApi()
    const { user } = renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await openEditor(user)

    expect(labelInput().value).toBe('Treasury')
    expect(document.activeElement).toBe(labelInput())
    // Address and chain are on screen as text, and the editor itself offers no
    // input for either of them.
    expect(screen.getByText(WALLET_1.address)).toBeDefined()
    expect(within(editorForm()).queryByLabelText('Address')).toBeNull()
    expect(within(editorForm()).queryByLabelText('Chain')).toBeNull()
  })

  it('closes on Cancel without sending a request', async () => {
    const api = stubApi()
    const { user } = renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await openEditor(user)
    await user.clear(labelInput())
    await user.type(labelInput(), 'Abandoned draft')
    await user.click(cancelButton())

    await waitFor(() => {
      expect(editorIsOpen()).toBe(false)
    })
    expect(api.patchCalls).toBe(0)
    expect(screen.getByText('Treasury')).toBeDefined()
  })

  it('keeps the action buttons unchanged while a save is in flight', async () => {
    const held = pendingResponse<Response>()
    const api = stubApi({ patch: () => held.promise })
    const { user } = renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await openEditor(user)
    await user.click(saveButton())

    await waitFor(() => {
      expect(saveButton().disabled).toBe(true)
    })
    // The labels do not rename themselves, and the editor cannot be closed or
    // retargeted while the answer is outstanding.
    expect(saveButton().textContent).toBe('Save label')
    expect(cancelButton().textContent).toBe('Cancel')
    expect(cancelButton().disabled).toBe(true)
    expect(api.patchCalls).toBe(1)

    await user.click(saveButton())
    expect(api.patchCalls).toBe(1)

    held.resolve(updatedResponse())
    await waitFor(() => {
      expect(screen.getByText(/Saved label for/)).toBeDefined()
    })
    expect(api.patchCalls).toBe(1)
  })

  it('refuses an empty label and focuses the input without calling the API', async () => {
    const api = stubApi()
    const { user } = renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await openEditor(user)
    await user.clear(labelInput())
    await user.click(saveButton())

    await waitFor(() => {
      expect(screen.getByText('Enter a label.')).toBeDefined()
    })
    expect(document.activeElement).toBe(labelInput())
    expect(labelInput().getAttribute('aria-invalid')).toBe('true')
    expect(api.patchCalls).toBe(0)
  })

  it('counts 50 code points, not UTF-16 units, and stops at 51', async () => {
    const api = stubApi()
    const { user } = renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await openEditor(user)
    await user.clear(labelInput())

    // 50 astral characters are 100 UTF-16 units but exactly 50 code points, so
    // they sit on the server's limit. Counting with `length` would reject them.
    const longest = '🚀'.repeat(50)
    await user.click(labelInput())
    await user.paste(longest)
    await user.click(saveButton())

    await waitFor(() => {
      expect(api.patchCalls).toBe(1)
    })
    expect(api.patchBodies[0]).toEqual({ label: longest })

    // One more code point is past the limit, and the client says so instead of
    // letting the API answer 422 for something it could have counted.
    await waitFor(() => {
      expect(editorIsOpen()).toBe(false)
    })
    await openEditor(user)
    await user.clear(labelInput())
    await user.click(labelInput())
    await user.paste('🚀'.repeat(51))
    await user.click(saveButton())

    await waitFor(() => {
      expect(screen.getByText(/50 characters or fewer/)).toBeDefined()
    })
    expect(document.activeElement).toBe(labelInput())
    expect(api.patchCalls).toBe(1)
  })

  it('trims the label the way the server trims it before sending', async () => {
    const api = stubApi()
    const { user } = renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await openEditor(user)
    await user.clear(labelInput())
    await user.click(labelInput())
    // U+0085 is whitespace to Go and is trimmed; a label of only that is empty.
    await user.paste('\u0085Ops\u0085')
    await user.click(saveButton())

    await waitFor(() => {
      expect(api.patchCalls).toBe(1)
    })
    expect(api.patchBodies[0]).toEqual({ label: 'Ops' })
  })

  it('puts a 422 message under the input and focuses it', async () => {
    stubApi({
      patch: () =>
        errorResponse(422, 'VALIDATION_ERROR', {
          message: 'label must not be empty',
          details: { label: 'label must not be empty' },
        }),
    })
    const { user } = renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await openEditor(user)
    await user.click(saveButton())

    await waitFor(() => {
      expect(screen.getByText('label must not be empty')).toBeDefined()
    })
    expect(document.activeElement).toBe(labelInput())
    expect(labelInput().getAttribute('aria-invalid')).toBe('true')
  })

  it('reads a 404 as an unavailable row rather than a sign-out', async () => {
    const storage = realStorage('token-a')
    stubApi({ patch: () => errorResponse(404, 'RESOURCE_NOT_FOUND') })
    const { user } = renderApp({ path: '/wallets', storage })

    await openEditor(user)
    await user.click(saveButton())

    await waitFor(() => {
      expect(screen.getByText(/no longer in your list/)).toBeDefined()
    })
    expect(currentPath()).toBe('/wallets')
    expect(storage.read()).toBe('token-a')
    expect(screen.getByText(USER_A.email)).toBeDefined()
  })

  it('refreshes the list after a confirmed save and keeps the current page', async () => {
    const api = stubApi({
      list: (call) =>
        call === 1
          ? listResponse([WALLET_1], paginationFor(21, 2))
          : listResponse([{ ...WALLET_1, label: 'Treasury ops' }], paginationFor(21, 2)),
      patch: () => updatedResponse(),
    })
    const { user } = renderApp({
      path: '/wallets?page=2',
      storage: realStorage('token-a'),
    })

    await waitFor(() => {
      expect(screen.getByText('Treasury')).toBeDefined()
    })
    await openEditor(user)
    await user.click(saveButton())

    await waitFor(() => {
      expect(screen.getByText(/Saved label for/)).toBeDefined()
    })

    // The new label comes from the server, and the page the user was on is
    // still the page in the URL: a rename moves nothing.
    await waitFor(() => {
      expect(screen.getByText('Treasury ops')).toBeDefined()
    })
    expect(currentPath()).toBe('/wallets?page=2')
    expect(api.listCalls).toBeGreaterThan(1)
    expect(api.patchUrls).toEqual([`/api/v1/wallets/${String(WALLET_1.id)}`])
  })

  it('keeps the save confirmed when the refresh fails', async () => {
    stubApi({
      list: (call) =>
        call === 1 ? listResponse([WALLET_1]) : errorResponse(500, 'INTERNAL_SERVER_ERROR'),
      patch: () => updatedResponse(),
    })
    const { user } = renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await openEditor(user)
    await user.click(saveButton())

    await waitFor(() => {
      expect(screen.getByText(/Saved label for/)).toBeDefined()
    })
    // The list reports its own failure with its own control; the save's
    // confirmation is not withdrawn for it.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined()
    })
    expect(screen.getByText(/Saved label for/)).toBeDefined()
  })

  it.each([
    ['a malformed body', () => new Response('{"data":', { status: 200 })],
    ['an empty body', () => new Response('', { status: 200 })],
    [
      'a row without createdAt',
      () =>
        jsonResponse({
          data: {
            id: WALLET_1.id,
            address: WALLET_1.address,
            chainId: WALLET_1.chainId,
            label: 'Treasury ops',
          },
        }),
    ],
    ['a row for another wallet', () => jsonResponse({ data: { ...WALLET_1, id: 99 } })],
    ['an unreadable 502', () => plainTextResponse(502, 'Bad Gateway')],
    ['an unreadable 504', () => plainTextResponse(504, 'Gateway Timeout')],
  ])('treats %s as an unconfirmed change and reconciles by reading', async (_name, respond) => {
    const api = stubApi({
      patch: respond,
      list: (call) =>
        call === 1 ? listResponse([WALLET_1]) : listResponse([{ ...WALLET_1, label: 'Treasury ops' }]),
    })
    const { user } = renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await openEditor(user)
    await user.click(saveButton())

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('may or may not have been saved')
    })
    expect(screen.queryByText(/Please try again/)).toBeNull()
    expect(api.patchCalls).toBe(1)

    const before = api.listCalls
    await user.click(screen.getByRole('button', { name: 'Check the list' }))

    await waitFor(() => {
      expect(api.listCalls).toBeGreaterThan(before)
    })
    // Reconciliation is a read. Nothing resends the PATCH.
    expect(api.patchCalls).toBe(1)
  })

  it('keeps a 503 a plain failure with the API wording', async () => {
    stubApi({ patch: () => errorResponse(503, 'SERVICE_UNAVAILABLE') })
    const { user } = renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await openEditor(user)
    await user.click(saveButton())

    await waitFor(() => {
      expect(screen.getByText(/temporarily unavailable/)).toBeDefined()
    })
    expect(screen.queryByRole('button', { name: 'Check the list' })).toBeNull()
  })

  it('applies nothing when a held PATCH answers after a sign out', async () => {
    const held = pendingResponse<Response>()
    const api = stubApi({ patch: () => held.promise })
    const { user } = renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await openEditor(user)
    await user.click(saveButton())
    await waitFor(() => {
      expect(api.patchCalls).toBe(1)
    })

    const before = api.listCalls
    await user.click(screen.getByRole('button', { name: 'Sign out' }))

    await waitFor(() => {
      expect(currentPath()).toBe('/login')
    })

    held.resolve(updatedResponse())

    await waitFor(() => {
      expect(api.listCalls).toBe(before)
    })
    expect(screen.queryByText(/Saved label for/)).toBeNull()
    expect(currentPath()).toBe('/login')
  })

  it('applies nothing when a held PATCH answers after another account signs in', async () => {
    const held = pendingResponse<Response>()
    const api = stubApi({
      patch: () => held.promise,
      me: (token) => jsonResponse({ data: token === 'token-b' ? USER_B : USER_A }),
    })
    const { user } = renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await openEditor(user)
    await user.click(saveButton())
    await waitFor(() => {
      expect(api.patchCalls).toBe(1)
    })

    otherTabStores('token-b')

    await waitFor(() => {
      expect(screen.getByText(USER_B.email)).toBeDefined()
    })
    const before = api.listCalls
    held.resolve(updatedResponse())

    await waitFor(() => {
      expect(screen.getByText(USER_B.email)).toBeDefined()
    })
    expect(screen.queryByText(/Saved label for/)).toBeNull()
    expect(api.listCalls).toBe(before)
  })

  it('closes the draft when the same account gets a new credential', async () => {
    const held = pendingResponse<Response>()
    stubApi({
      patch: () => held.promise,
      me: () => jsonResponse({ data: USER_A }),
    })
    const { user } = renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await openEditor(user)
    await user.type(labelInput(), ' draft')
    otherTabStores('token-a-second')

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Save label' })).toBeNull()
    })
    expect(screen.queryByText(/Saved label for/)).toBeNull()
  })

  it('shows what the read-only check found, without resending or replacing the draft', async () => {
    const api = stubApi({
      patch: () => plainTextResponse(502, 'Bad Gateway'),
      list: (call) =>
        call === 1
          ? listResponse([WALLET_1])
          : listResponse([{ ...WALLET_1, label: 'Saved before the gateway fell over' }]),
    })
    const { user } = renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await openEditor(user)
    await user.clear(labelInput())
    await user.type(labelInput(), 'Draft I typed')
    await user.click(saveButton())

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('may or may not have been saved')
    })

    await user.click(within(editorForm()).getByRole('button', { name: 'Check the list' }))

    // The read has to answer the user's actual question. Showing that a GET
    // happened is not the same as showing what it returned.
    await waitFor(() => {
      expect(screen.getByText(/The list now shows this wallet labelled/)).toBeDefined()
    })
    expect(
      screen.getByText(/The list now shows this wallet labelled "Saved before the gateway fell over"\./),
    ).toBeDefined()

    // Read-only: no second write, and the draft is still the user's typing.
    expect(api.patchCalls).toBe(1)
    expect(labelInput().value).toBe('Draft I typed')
  })

  it('retires the editor when the read finds the wallet gone', async () => {
    stubApi({
      patch: () => plainTextResponse(504, 'Gateway Timeout'),
      list: (call) => (call === 1 ? listResponse([WALLET_1]) : listResponse([])),
    })
    const { user } = renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await openEditor(user)
    await user.click(saveButton())

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('may or may not have been saved')
    })

    await user.click(within(editorForm()).getByRole('button', { name: 'Check the list' }))

    // The refreshed page does not hold the row, so the editor stops claiming a
    // wallet that is not there and the page shows what the server sent.
    await waitFor(() => {
      expect(screen.getByText(/no saved wallets yet/)).toBeDefined()
    })
    expect(editorIsOpen()).toBe(false)
  })

  it('drops a read that arrives after a newer save attempt', async () => {
    const held = pendingResponse<Response>()
    let listCalls = 0
    stubApi({
      patch: (_body, call) =>
        call === 1 ? plainTextResponse(502, 'Bad Gateway') : plainTextResponse(504, 'Gateway Timeout'),
      list: () => {
        listCalls += 1
        if (listCalls === 1) {
          return listResponse([WALLET_1])
        }
        // The check holds; any read after it is answered normally.
        return listCalls === 2 ? held.promise : listResponse([WALLET_1])
      },
    })
    const { user } = renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await openEditor(user)
    await user.clear(labelInput())
    await user.type(labelInput(), 'First rename')
    await user.click(saveButton())

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('may or may not have been saved')
    })

    // The check is on the wire and stays there.
    await user.click(within(editorForm()).getByRole('button', { name: 'Check the list' }))
    expect(screen.getByText('Reading the list.')).toBeDefined()

    // A second, deliberate save while the first read is still open. This is the
    // user's new answer and the only one the editor should report on.
    await user.clear(labelInput())
    await user.type(labelInput(), 'Second rename')
    await user.click(saveButton())

    await waitFor(() => {
      expect(labelInput().value).toBe('Second rename')
    })

    // The old read now answers, with the server value the first attempt was
    // about. Reporting it here would describe a value the user already replaced.
    held.resolve(listResponse([{ ...WALLET_1, label: 'First rename applied' }]))
    await settle()

    expect(screen.getByText(/may or may not have been saved/)).toBeDefined()
    expect(screen.queryByText(/The list now shows this wallet labelled/)).toBeNull()
    expect(screen.queryByText(/First rename applied/)).toBeNull()
    expect(labelInput().value).toBe('Second rename')
  })

  it('drops a failed read that arrives after a newer save attempt', async () => {
    const refreshHold = pendingResponse<Response>()
    const readHold = pendingResponse<Response>()
    let listCalls = 0
    stubApi({
      patch: (_body, call) =>
        call === 1 ? plainTextResponse(502, 'Bad Gateway') : plainTextResponse(504, 'Gateway Timeout'),
      list: () => {
        listCalls += 1
        if (listCalls === 1) {
          return listResponse([WALLET_1])
        }
        return listCalls === 2 ? refreshHold.promise : readHold.promise
      },
    })
    const { user } = renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await openEditor(user)
    await user.click(saveButton())

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('may or may not have been saved')
    })

    await user.click(within(editorForm()).getByRole('button', { name: 'Check the list' }))

    // Let the check reach its own read, which is held too.
    refreshHold.resolve(listResponse([WALLET_1]))
    await waitFor(() => {
      expect(listCalls).toBe(3)
    })

    await user.clear(labelInput())
    await user.type(labelInput(), 'Second rename')
    await user.click(saveButton())

    await waitFor(() => {
      expect(labelInput().value).toBe('Second rename')
    })

    // The retired read fails. Its failure belongs to the attempt that started
    // it, so it is not reported under the newer one.
    readHold.resolve(errorResponse(500, 'INTERNAL_ERROR', { message: 'boom' }))
    await settle()

    expect(screen.queryByText('The list could not be read. Try again.')).toBeNull()
    expect(labelInput().value).toBe('Second rename')
    expect(screen.getByText(/may or may not have been saved/)).toBeDefined()
  })

  /**
   * A check whose owner goes away while its read is on the wire.
   *
   * The editor's own fence silences the UI, but the page behind it still owns
   * the read, so what these assert is the work that must not be revived: a
   * request under a credential nobody holds, and a protected query back in a
   * cache its retirement already cleared.
   */
  async function startHeldCheck(
    list: (call: number, init: RequestInit) => Response | Promise<Response>,
    options: { user?: (token: string) => Response } = {},
  ) {
    const queryClient = createQueryClient()
    const api = stubApi({
      patch: () => plainTextResponse(502, 'Bad Gateway'),
      list,
      ...(options.user === undefined ? {} : { me: options.user }),
    })
    const rendered = renderApp({
      path: '/wallets',
      storage: realStorage('token-a'),
      queryClient,
    })

    await openEditor(rendered.user)
    await rendered.user.click(saveButton())
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('may or may not have been saved')
    })
    await rendered.user.click(within(editorForm()).getByRole('button', { name: 'Check the list' }))

    return { api, queryClient, ...rendered }
  }

  /**
   * Protected cache entries, for one account or for everyone.
   *
   * An entry here is a protected query the guard should have dropped: it holds
   * another session's rows, and a request that puts one back is what this whole
   * fence exists to stop.
   */
  function protectedQueries(queryClient: QueryClient, userId?: number): number {
    return queryClient.getQueryCache().findAll({
      predicate: (query) =>
        isProtectedKey(query.queryKey) &&
        (userId === undefined || query.queryKey[1] === userId),
    }).length
  }

  it('starts nothing for a check whose credential another tab removed', async () => {
    const requests: string[] = []
    const { api, queryClient } = await startHeldCheck((call, init) => {
      requests.push(new Headers(init.headers).get('authorization') ?? '')
      return call === 1 ? listResponse([WALLET_1]) : hangingFetch('', init)
    })

    await waitFor(() => {
      expect(api.listCalls).toBe(2)
    })

    // Both counts are taken before the retirement. Taken afterwards they would
    // absorb the very request this test exists to catch and call it stable.
    const callsBefore = api.listCalls
    const oldRequestsBefore = requests.filter((header) => header === 'Bearer token-a').length

    act(() => {
      otherTabRemoves()
    })

    await waitFor(() => {
      expect(currentPath()).toBe('/login')
    })
    await settle()

    // No further request carries the retired credential, and none carries any
    // other: there is nobody for the page to read for.
    expect(api.listCalls).toBe(callsBefore)
    expect(requests.filter((header) => header === 'Bearer token-a')).toHaveLength(
      oldRequestsBefore,
    )

    // Anonymous means no protected entry at all, for this account or any other.
    expect(protectedQueries(queryClient)).toBe(0)
    expect(currentPath()).toBe('/login')
  })

  it('starts nothing under a credential another account replaced', async () => {
    const requests: string[] = []
    const { api, queryClient } = await startHeldCheck(
      (call, init) => {
        requests.push(new Headers(init.headers).get('authorization') ?? '')
        return call === 1 ? listResponse([WALLET_1]) : hangingFetch('', init)
      },
      { user: (token) => jsonResponse({ data: token === 'token-b' ? USER_B : USER_A }) },
    )

    await waitFor(() => {
      expect(api.listCalls).toBe(2)
    })

    const oldRequestsBefore = requests.filter((header) => header === 'Bearer token-a').length

    act(() => {
      otherTabStores('token-b')
    })

    await waitFor(() => {
      expect(screen.getByText(USER_B.email)).toBeDefined()
    })
    await settle()

    // The retired credential is not used again, and nothing of its owner stays
    // in the cache.
    expect(requests.filter((header) => header === 'Bearer token-a')).toHaveLength(
      oldRequestsBefore,
    )
    expect(protectedQueries(queryClient, USER_A.id)).toBe(0)

    // The identity that replaced it is allowed to read, and does.
    await waitFor(() => {
      expect(protectedQueries(queryClient, USER_B.id)).toBeGreaterThan(0)
    })
  })

  it('does not present a failed read as the stored value', async () => {
    let listCalls = 0
    stubApi({
      patch: () => plainTextResponse(502, 'Bad Gateway'),
      list: () => {
        listCalls += 1
        return listCalls === 1
          ? listResponse([WALLET_1])
          : errorResponse(500, 'INTERNAL_ERROR', { message: 'boom' })
      },
    })
    const { user } = renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await openEditor(user)
    await user.click(saveButton())

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('may or may not have been saved')
    })

    await user.click(within(editorForm()).getByRole('button', { name: 'Check the list' }))

    await waitFor(() => {
      expect(screen.getByText('The list could not be read. Try again.')).toBeDefined()
    })
    // The cached page is not the server's answer, so it is not shown as one.
    expect(screen.queryByText(/The list now shows this wallet labelled/)).toBeNull()
  })

  it('replaces a previous server error with this attempt\'s own', async () => {
    const api = stubApi({
      patch: () =>
        errorResponse(422, 'VALIDATION_ERROR', {
          message: 'label must not be empty',
          details: { label: 'label must not be empty' },
        }),
    })
    const { user } = renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await openEditor(user)
    await user.click(saveButton())

    await waitFor(() => {
      expect(screen.getByText('label must not be empty')).toBeDefined()
    })

    // Empty again, and rejected here before any request. The old server message
    // must not survive to describe a value the server never saw.
    await user.clear(labelInput())
    await user.click(saveButton())

    await waitFor(() => {
      expect(screen.getByText('Enter a label.')).toBeDefined()
    })
    expect(screen.queryByText('label must not be empty')).toBeNull()
    expect(document.activeElement).toBe(labelInput())
    expect(labelInput().getAttribute('aria-invalid')).toBe('true')
    expect(api.patchCalls).toBe(1)
  })

  it('keeps focus on every repeated rejection', async () => {
    stubApi()
    const { user } = renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await openEditor(user)
    await user.clear(labelInput())

    await user.click(saveButton())
    await waitFor(() => {
      expect(document.activeElement).toBe(labelInput())
    })

    // Blur, then reject again by the same rule.
    await user.click(screen.getByRole('heading', { name: 'Wallets' }))
    await user.click(saveButton())
    await waitFor(() => {
      expect(document.activeElement).toBe(labelInput())
    })
  })

  it('keeps one editor at a time and cannot retarget one that is saving', async () => {
    const held = pendingResponse<Response>()
    const api = stubApi({
      patch: () => held.promise,
      list: () => listResponse([WALLET_1, WALLET_2]),
    })
    const { user } = renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await waitFor(() => {
      expect(screen.getByText('Cold storage')).toBeDefined()
    })

    // Two rows, two buttons, one editor.
    const buttons = screen.getAllByRole('button', { name: 'Edit label' })
    expect(buttons).toHaveLength(2)
    await user.click(buttons[0] as HTMLButtonElement)

    await waitFor(() => {
      expect(editorIsOpen()).toBe(true)
    })
    // While an editor is open, no other row can start one.
    expect(editButtons()).toHaveLength(1)
    expect(editButtons()[0]?.disabled).toBe(true)

    await user.click(saveButton())
    await waitFor(() => {
      expect(api.patchCalls).toBe(1)
    })

    held.resolve(updatedResponse())
    await waitFor(() => {
      expect(screen.getByText(/Saved label for/)).toBeDefined()
    })

    // Once the answer lands, the other row can be edited again, and it opens
    // with its own label rather than the first row's draft.
    await waitFor(() => {
      expect(editButtons().length).toBe(2)
    })
    editButtons()[1]?.click()
    await waitFor(() => {
      expect(labelInput().value).toBe('Cold storage')
    })
  })

  it('moves focus back to the row action after a confirmed save', async () => {
    stubApi()
    const { user } = renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await openEditor(user)
    await user.click(saveButton())

    await waitFor(() => {
      expect(screen.getByText(/Saved label for/)).toBeDefined()
    })
    await waitFor(() => {
      expect(document.activeElement).toBe(editButtons()[0])
    })
  })
})

/**
 * The draft is component state, not query data.
 *
 * This is rendered directly so a parent re-render can hand the editor a freshly
 * refetched row, which is exactly what a list read does while the user is
 * typing. The draft must survive it.
 */
describe('wallet label editor draft', () => {
  /** The narrow capability an editor is actually given. */
  function dataSession(): DataSession {
    return {
      userId: 5,
      generation: 1,
      client: {
        listWallets: vi.fn(),
        createWallet: vi.fn(),
        updateWalletLabel: vi.fn() as unknown as ApiClient['updateWalletLabel'],
        deleteWallet: vi.fn() as unknown as ApiClient['deleteWallet'],
        getWallet: vi.fn() as unknown as ApiClient['getWallet'],
        listContracts: vi.fn() as unknown as ApiClient['listContracts'],
      },
    }
  }

  it('survives a row that arrives again from a list read', async () => {
    const user = userEvent.setup()

    const view = (wallet: Wallet) => (
      <QueryClientProvider client={new QueryClient()}>
        <WalletLabelEditor
          dataSession={dataSession()}
          wallet={wallet}
          onUpdated={() => undefined}
          onCancel={() => undefined}
          onReadBack={() => Promise.resolve(null)}
        />
      </QueryClientProvider>
    )

    const { rerender } = render(view(WALLET_1))

    await user.clear(labelInput())
    await user.type(labelInput(), 'Half typed')

    // The same row, re-read from the server with its stored label.
    rerender(view({ ...WALLET_1, label: 'Treasury' }))

    expect(labelInput().value).toBe('Half typed')
    expect(within(editorForm()).queryByText('Treasury')).toBeNull()
  })
})
