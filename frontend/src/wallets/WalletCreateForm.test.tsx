import { screen, waitFor } from '@testing-library/react'
import type { UserEvent } from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Chain, User, Wallet } from '../api/index.ts'
import { createTokenStorage, type TokenStorage } from '../auth/storage.ts'
import { otherTabStores } from '../test/crossTab.ts'
import {
  errorResponse,
  jsonResponse,
  pendingResponse,
  stubFetch,
  type FetchCall,
} from '../test/http.ts'
import { currentPath, renderApp } from '../test/renderApp.tsx'
import { PAGE_SIZE } from './page.ts'

const USER_A: User = { id: 5, email: 'ada@example.com', createdAt: '2026-10-06T12:00:00Z' }
const USER_B: User = { id: 9, email: 'bob@example.com', createdAt: '2026-10-06T12:00:00Z' }

const SEPOLIA: Chain = {
  chainId: 11155111,
  name: 'Sepolia',
  symbol: 'ETH',
  isTestnet: true,
}
const ETHEREUM: Chain = { chainId: 1, name: 'Ethereum', symbol: 'ETH', isTestnet: false }

const EXISTING: Wallet = {
  id: 7,
  address: '0x00000000000000000000000000000000000000a1',
  chainId: 11155111,
  label: 'Existing wallet',
  createdAt: '2026-10-01T10:00:00Z',
}

const CREATED: Wallet = {
  id: 11,
  address: '0x00000000000000000000000000000000000000c3',
  chainId: 11155111,
  label: 'Treasury',
  createdAt: '2026-10-18T09:00:00Z',
}

const ADDRESS = '0x00000000000000000000000000000000000000c3'

function paginationFor(totalItems: number, page = 1) {
  return {
    page,
    pageSize: PAGE_SIZE,
    totalItems,
    totalPages: Math.ceil(totalItems / PAGE_SIZE),
  }
}

function chainsResponse(chains: unknown[] = [ETHEREUM, SEPOLIA]) {
  return jsonResponse({ data: chains })
}

function listResponse(wallets: Wallet[], pagination = paginationFor(wallets.length)) {
  return jsonResponse({ data: wallets, pagination })
}

function createdResponse(wallet: Wallet = CREATED) {
  return jsonResponse({ data: wallet }, { status: 201 })
}

type Handlers = {
  chains?: (call: number) => Response | Promise<Response>
  list?: (call: number) => Response | Promise<Response>
  create?: (body: unknown, call: number) => Response | Promise<Response>
  me?: (token: string) => Response
}

/**
 * Routes every call the slice makes.
 *
 * The responders are counted per endpoint, because the assertions in these
 * tests are mostly about how many requests happened and in what order, not
 * only about what is on screen.
 */
function stubApi(handlers: Handlers = {}) {
  let chainCalls = 0
  let listCalls = 0
  let createCalls = 0
  const createBodies: unknown[] = []

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
      chainCalls += 1
      return handlers.chains?.(chainCalls) ?? chainsResponse()
    }

    if (url.includes('/wallets')) {
      if (init.method === 'POST') {
        createCalls += 1
        createBodies.push(JSON.parse(String(init.body)) as unknown)
        return handlers.create?.(createBodies.at(-1), createCalls) ?? createdResponse()
      }

      listCalls += 1
      return handlers.list?.(listCalls) ?? listResponse([])
    }

    throw new Error(`unexpected request: ${url}`)
  })

  return {
    stub,
    createBodies,
    get chainCalls() {
      return chainCalls
    },
    get listCalls() {
      return listCalls
    },
    get createCalls() {
      return createCalls
    },
  }
}

/** Real localStorage, so another tab's write reaches this document. */
function realStorage(initial: string): TokenStorage {
  window.localStorage.clear()
  const storage = createTokenStorage(() => window.localStorage)
  storage.write(initial)
  return storage
}

function chainSelect(): HTMLSelectElement {
  return screen.getByLabelText('Chain') as HTMLSelectElement
}

function addressInput(): HTMLInputElement {
  return screen.getByLabelText('Address') as HTMLInputElement
}

function labelInput(): HTMLInputElement {
  return screen.getByLabelText('Label') as HTMLInputElement
}

function saveButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Save wallet' }) as HTMLButtonElement
}

/** Waits for the catalog to arrive, so the select is usable. */
async function waitForChains(): Promise<void> {
  await waitFor(() => {
    expect(chainSelect().options.length).toBeGreaterThan(1)
  })
}

async function fillForm(
  user: UserEvent,
  options: { address?: string; chain?: string; label?: string } = {},
): Promise<void> {
  await waitForChains()

  const address = options.address ?? ADDRESS
  const chain = options.chain ?? String(SEPOLIA.chainId)
  const label = options.label ?? CREATED.label

  await user.type(addressInput(), address)
  await user.selectOptions(chainSelect(), chain)
  await user.type(labelInput(), label)
}

function callTo(calls: FetchCall[], fragment: string): FetchCall | undefined {
  return calls.find((call) => call.url.includes(fragment))
}

describe('wallet create form', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    window.localStorage.clear()
  })

  it('offers the chains the catalog returned, and no others', async () => {
    stubApi()

    renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await waitForChains()

    const options = Array.from(chainSelect().options).map((option) => option.text)
    expect(options).toContain('Ethereum (ETH)')
    expect(options).toContain('Sepolia (ETH) testnet')
    // Built from the response, so a fourth chain the server starts offering
    // appears without a code change and a removed one disappears.
    expect(options).toHaveLength(3)
  })

  it('reads the catalog with no bearer', async () => {
    const { stub } = stubApi()

    renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await waitForChains()

    const call = callTo(stub.calls, '/chains')
    expect(call).toBeDefined()
    expect(new Headers(call?.init.headers).get('authorization')).toBeNull()
  })

  it('shows a failed catalog with Retry and recovers on the retry', async () => {
    const api = stubApi({
      chains: (call) => (call === 1 ? errorResponse(503, 'SERVICE_UNAVAILABLE') : chainsResponse()),
    })

    renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('temporarily unavailable')
    })

    await vi.waitFor(() => {
      expect(api.chainCalls).toBeGreaterThan(0)
    })

    await screen.getByRole('button', { name: 'Retry' }).click()

    await waitFor(() => {
      expect(chainSelect().options.length).toBeGreaterThan(1)
    })
    expect(api.chainCalls).toBe(2)
  })

  it('shows a malformed catalog as a failure rather than an empty list', async () => {
    stubApi({ chains: () => jsonResponse({ data: [{ ...SEPOLIA, isTestnet: 'true' }] }) })

    renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('Something went wrong')
    })
    // An unusable row is not "no chains": it is a response this client cannot
    // read, and saying otherwise would hide a real contract problem.
    expect(screen.queryByText(/No chains are available/)).toBeNull()
  })

  it('says so when the catalog is empty and refuses the save', async () => {
    stubApi({ chains: () => chainsResponse([]) })

    renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await waitFor(() => {
      expect(screen.getByText(/No chains are available/)).toBeDefined()
    })
    // There is no valid selection to make, so the form cannot be filled in
    // correctly and the button says so rather than failing on submit.
    expect(saveButton().disabled).toBe(true)
  })

  it('saves the three fields and shows the refreshed list', async () => {
    const api = stubApi({
      list: (call) => (call === 1 ? listResponse([EXISTING]) : listResponse([CREATED, EXISTING])),
    })
    const { user } = renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await fillForm(user)
    await user.click(saveButton())

    await waitFor(() => {
      expect(screen.getByText('Saved Treasury.')).toBeDefined()
    })

    expect(api.createBodies).toEqual([
      { address: ADDRESS, chainId: SEPOLIA.chainId, label: CREATED.label },
    ])
    expect(new Headers(api.stub.calls.at(-1)?.init.headers).get('authorization')).toBe(
      'Bearer token-a',
    )

    // The list was refreshed, so the new row and the new total are both there.
    await waitFor(() => {
      expect(screen.getByText('Showing 2 of 2 saved wallets.')).toBeDefined()
    })
    expect(api.listCalls).toBe(2)

    // Address and label are cleared, the chain is kept.
    expect(addressInput().value).toBe('')
    expect(labelInput().value).toBe('')
    expect(chainSelect().value).toBe(String(SEPOLIA.chainId))
  })

  it('returns to page 1 after a save made from a later page', async () => {
    stubApi({
      list: (call) =>
        call === 1
          ? listResponse([], paginationFor(25, 3))
          : listResponse([CREATED], paginationFor(1)),
    })
    const { user } = renderApp({ path: '/wallets?page=3', storage: realStorage('token-a') })

    await waitFor(() => {
      expect(screen.getByText(/No wallets on page 3/)).toBeDefined()
    })

    await fillForm(user)
    await user.click(saveButton())

    await waitFor(() => {
      expect(screen.getByText('Saved Treasury.')).toBeDefined()
    })
    // A new wallet lands at the top of the list, so the page the user was on
    // no longer describes the data behind it.
    await waitFor(() => {
      expect(currentPath()).toBe('/wallets?page=1')
    })
  })

  it('puts a 422 message under the field the server named and focuses it', async () => {
    stubApi({
      create: () =>
        errorResponse(422, 'VALIDATION_ERROR', {
          message: 'address must be a hexadecimal string',
          details: { address: 'address must be a hexadecimal string' },
        }),
    })
    const { user } = renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await fillForm(user)
    await user.click(saveButton())

    await waitFor(() => {
      expect(screen.getByText('address must be a hexadecimal string')).toBeDefined()
    })
    // The first invalid field receives focus, so the message is next to the
    // box the user is already in.
    expect(document.activeElement).toBe(addressInput())
    expect(addressInput().getAttribute('aria-invalid')).toBe('true')
  })

  it('reports a duplicate in its own words', async () => {
    stubApi({
      create: () =>
        errorResponse(409, 'RESOURCE_CONFLICT', {
          message: 'wallet address already exists on this chain',
        }),
    })
    const { user } = renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await fillForm(user)
    await user.click(saveButton())

    await waitFor(() => {
      expect(screen.getByText('That address is already saved on this chain.')).toBeDefined()
    })
  })

  it('keeps the retry delay a rate limit sent', async () => {
    stubApi({
      create: () =>
        errorResponse(429, 'RATE_LIMITED', {
          message: 'slow down',
          headers: { 'Retry-After': '4' },
        }),
    })
    const { user } = renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await fillForm(user)
    await user.click(saveButton())

    await waitFor(() => {
      expect(screen.getByText(/try again in 4 seconds/)).toBeDefined()
    })
  })

  it('reports a timeout as an unknown outcome and does not replay the save', async () => {
    const held = pendingResponse<Response>()
    const api = stubApi({
      create: () => held.promise,
    })
    const { user } = renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await fillForm(user)
    await user.click(saveButton())

    // A timeout reached no verdict, so the row may or may not exist. Saying it
    // failed would invite the second submit that becomes the duplicate.
    held.reject(new Error('boom'))

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('did not finish')
    })
    expect(api.createCalls).toBe(1)
  })

  it('keeps the save confirmed when the refresh fails', async () => {
    const api = stubApi({
      list: (call) =>
        call === 1 ? listResponse([EXISTING]) : errorResponse(500, 'INTERNAL_SERVER_ERROR'),
    })
    const { user } = renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await fillForm(user)
    await user.click(saveButton())

    await waitFor(() => {
      expect(screen.getByText('Saved Treasury.')).toBeDefined()
    })

    // The save answered 201. The list failed afterwards, which is the list's
    // failure to report, with its own Retry.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined()
    })
    expect(screen.getByText('Saved Treasury.')).toBeDefined()
    expect(api.createCalls).toBe(1)
  })

  it('refuses a second submit while one is in flight', async () => {
    const held = pendingResponse<Response>()
    const api = stubApi({ create: () => held.promise })
    const { user } = renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await fillForm(user)
    await user.click(saveButton())

    await waitFor(() => {
      expect(saveButton().disabled).toBe(true)
    })

    await user.click(saveButton())
    expect(api.createCalls).toBe(1)

    held.resolve(createdResponse())
    await waitFor(() => {
      expect(screen.getByText('Saved Treasury.')).toBeDefined()
    })
    expect(api.createCalls).toBe(1)
  })

  it('stops an over-long label before it reaches the API', async () => {
    const api = stubApi()
    const { user } = renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await waitForChains()
    await user.type(addressInput(), ADDRESS)
    await user.selectOptions(chainSelect(), String(SEPOLIA.chainId))
    await user.type(labelInput(), 'a'.repeat(51))
    await user.click(saveButton())

    await waitFor(() => {
      expect(screen.getByText('Enter a label of 50 characters or fewer.')).toBeDefined()
    })
    expect(document.activeElement).toBe(labelInput())
    expect(api.createCalls).toBe(0)
  })

  it('applies nothing when a held save is answered after a sign out', async () => {
    const held = pendingResponse<Response>()
    const api = stubApi({ create: () => held.promise })
    const { user } = renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await fillForm(user)
    await user.click(saveButton())
    await waitFor(() => {
      expect(api.createCalls).toBe(1)
    })

    const before = api.listCalls
    await user.click(screen.getByRole('button', { name: 'Sign out' }))

    await waitFor(() => {
      expect(currentPath()).toBe('/login')
    })

    // The answer belongs to an identity that no longer exists.
    held.resolve(createdResponse())

    await waitFor(() => {
      expect(api.listCalls).toBe(before)
    })
    expect(screen.queryByText('Saved Treasury.')).toBeNull()
    expect(currentPath()).toBe('/login')
  })

  it('applies nothing when a held save is answered after another account signs in', async () => {
    const held = pendingResponse<Response>()
    const api = stubApi({
      create: () => held.promise,
      me: (token) => jsonResponse({ data: token === 'token-b' ? USER_B : USER_A }),
    })
    const { user } = renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await fillForm(user)
    await user.click(saveButton())
    await waitFor(() => {
      expect(api.createCalls).toBe(1)
    })

    otherTabStores('token-b')

    await waitFor(() => {
      expect(screen.getByText(USER_B.email)).toBeDefined()
    })

    // The draft belonged to the session that typed it, not to the account, so
    // switching accounts retires it including the chain choice.
    await waitFor(() => {
      expect(chainSelect().value).toBe('')
    })
    expect(addressInput().value).toBe('')

    // Bob's list has already loaded by now, so any further list call would be
    // the late save reaching into another identity's cache.
    const before = api.listCalls
    held.resolve(createdResponse())

    await waitFor(() => {
      expect(screen.getByText(USER_B.email)).toBeDefined()
    })
    // No success message for another identity, and no refresh of its list.
    expect(screen.queryByText('Saved Treasury.')).toBeNull()
    expect(chainSelect().value).toBe('')
    expect(api.listCalls).toBe(before)
  })

  it('applies nothing when a held save is answered after the same account gets a new credential', async () => {
    const held = pendingResponse<Response>()
    const api = stubApi({
      create: () => held.promise,
      // The same user, so only the generation can tell the two sessions apart.
      me: () => jsonResponse({ data: USER_A }),
    })
    const { user } = renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await fillForm(user)
    await user.click(saveButton())
    await waitFor(() => {
      expect(api.createCalls).toBe(1)
    })

    otherTabStores('token-a-second')

    await waitFor(() => {
      expect(chainSelect().value).toBe('')
    })
    // Still Ada, so this is a replacement and not a switch: the screen says so.
    expect(screen.getByText(USER_A.email)).toBeDefined()

    held.resolve(createdResponse())

    await waitFor(() => {
      expect(screen.getByText(USER_A.email)).toBeDefined()
    })
    expect(screen.queryByText('Saved Treasury.')).toBeNull()
    expect(chainSelect().value).toBe('')
  })

  it('does not sign the current session out on a late 401 for a replaced credential', async () => {
    const held = pendingResponse<Response>()
    const api = stubApi({
      create: () => held.promise,
      me: (token) => jsonResponse({ data: token === 'token-b' ? USER_B : USER_A }),
    })
    const { user } = renderApp({ path: '/wallets', storage: realStorage('token-a') })

    await fillForm(user)
    await user.click(saveButton())

    await waitFor(() => {
      expect(api.createCalls).toBe(1)
    })

    otherTabStores('token-b')

    await waitFor(() => {
      expect(screen.getByText(USER_B.email)).toBeDefined()
    })

    // A 401 for the credential that was replaced describes a session nobody is
    // holding. Ending this one would sign Bob out for Ada's expired token.
    held.resolve(errorResponse(401, 'UNAUTHENTICATED'))

    await waitFor(() => {
      expect(screen.getByText(USER_B.email)).toBeDefined()
    })
    expect(currentPath()).toBe('/wallets')
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeDefined()
  })
})
