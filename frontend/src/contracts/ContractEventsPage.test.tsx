import { act, screen, waitFor, within } from '@testing-library/react'
import type userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  errorResponse,
  jsonResponse,
  pendingResponse,
  stubFetch,
  type FetchCall,
} from '../test/http.ts'
import {
  deferred,
  installFakeProvider,
  removeFakeProvider,
  type FakeProvider,
} from '../test/fakeProvider.ts'
import { currentPath, memoryStorage, renderApp } from '../test/renderApp.tsx'
import { createQueryClient } from '../data/queryClient.ts'
import { PAGE_SIZE } from '../data/page.ts'

/**
 * The event view as the user sees it.
 *
 * The backend is stubbed at the network boundary, because what this screen does
 * with the API is two reads and nothing else. Every assertion about a row, a
 * total or a page is an assertion about what the server said.
 */

const USER = { id: 5, email: 'ada@example.com', createdAt: '2026-10-06T12:00:00Z' }

const CONTRACT = {
  id: 7,
  address: '0x5b324f41e5889cf94cba8e909089683a1a97c318',
  chainId: 11155111,
  label: 'Project multisig',
  enabled: true,
  startBlock: 5_800_000,
  createdAt: '2026-10-01T10:00:00Z',
  indexingStatus: 'pending',
}

const HASH_A = `0x${'a'.repeat(64)}`
const HASH_B = `0x${'b'.repeat(64)}`

const SUBMIT_EVENT = {
  contractId: 7,
  eventName: 'SubmitTransaction',
  blockNumber: 6_100_000,
  blockHash: HASH_A,
  transactionHash: HASH_B,
  transactionIndex: 3,
  logIndex: 12,
  actorAddress: '0x14912965632cd9ab70c046e8d23e9b8dfa9f2746',
  multisigTxIndex: '0',
  payload: {
    to: '0x5b324f41e5889cf94cba8e909089683a1a97c318',
    valueWei: '1000000000000000000',
    data: '0xdeadbeef',
  },
}

const CONFIRM_EVENT = {
  ...SUBMIT_EVENT,
  eventName: 'ConfirmTransaction',
  multisigTxIndex: '1',
  transactionHash: HASH_A,
  logIndex: 13,
  payload: {},
}

function eventsResponse(
  events: unknown[],
  pagination: Record<string, number> = {
    page: 1,
    pageSize: PAGE_SIZE,
    totalItems: events.length,
    totalPages: events.length === 0 ? 0 : 1,
  },
) {
  return jsonResponse({ data: events, pagination })
}

/**
 * One stub for the whole app: identity, the public catalog the shell reads, the
 * contract context and the event list.
 *
 * `contractResponse` is a function so a test can answer 404 for a contract this
 * account does not track, which is the one case where the event request must not
 * happen at all.
 */
function apiFetch(options: {
  contract?: () => Response | Promise<Response>
  events?: (url: string, init: RequestInit, call: number) => Response | Promise<Response>
  chains?: () => Response | Promise<Response>
}) {
  let eventCalls = 0

  const stub = stubFetch((url: string, init: RequestInit) => {
    if (url.includes('/users/me')) {
      return jsonResponse({ data: USER })
    }

    if (url.includes('/chains')) {
      return options.chains?.() ?? jsonResponse({ data: [] })
    }

    if (url.includes('/auth/logout')) {
      return jsonResponse({ data: { message: 'signed out' } })
    }

    if (/\/contracts\/\d+\/events/.test(url)) {
      eventCalls += 1
      return options.events?.(url, init, eventCalls) ?? eventsResponse([SUBMIT_EVENT, CONFIRM_EVENT])
    }

    if (/\/contracts\/\d+$/.test(url)) {
      return options.contract?.() ?? jsonResponse({ data: CONTRACT })
    }

    if (url.includes('/contracts')) {
      return jsonResponse({
        data: [CONTRACT],
        pagination: { page: 1, pageSize: PAGE_SIZE, totalItems: 1, totalPages: 1 },
      })
    }

    return jsonResponse({ data: [] })
  })

  return {
    stub,
    get eventCalls() {
      return eventCalls
    },
  }
}

function eventRequests(calls: FetchCall[]): FetchCall[] {
  return calls.filter((call) => /\/contracts\/\d+\/events/.test(call.url))
}

function button(name: string): HTMLButtonElement {
  return screen.getByRole('button', { name }) as HTMLButtonElement
}

function mainText(): string {
  return screen.getByRole('main').textContent ?? ''
}

beforeEach(() => {
  vi.unstubAllGlobals()
  removeFakeProvider()
})

describe('event view', () => {
  it('shows a loading state, the contract, then the rows the server returned', async () => {
    const held = pendingResponse<Response>()
    const api = apiFetch({ events: () => held.promise })

    renderApp({ path: '/contracts/7/events', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('Loading indexed events')
    })

    held.resolve(eventsResponse([SUBMIT_EVENT, CONFIRM_EVENT]))

    await waitFor(() => {
      expect(screen.getByText('SubmitTransaction')).toBeDefined()
    })

    expect(screen.getByText('Project multisig')).toBeDefined()
    // The address appears in the context block and again in the submitted
    // payload's destination, which is the same contract here.
    expect(screen.getAllByText(CONTRACT.address).length).toBeGreaterThan(0)
    expect(screen.getByText('ConfirmTransaction')).toBeDefined()
    // Two events from one actor in the same block, each with its own
    // transaction hash.
    expect(screen.getAllByText('0x14912965632cd9ab70c046e8d23e9b8dfa9f2746')).toHaveLength(2)
    expect(screen.getByText(HASH_B)).toBeDefined()
    expect(screen.getByText(HASH_A)).toBeDefined()
    expect(screen.getAllByText('6100000')).toHaveLength(2)
    expect(api.eventCalls).toBe(1)
  })

  it('asks for the contract, then page 1 of its events, with the bearer', async () => {
    const api = apiFetch({})

    renderApp({ path: '/contracts/7/events', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(api.eventCalls).toBe(1)
    })

    const urls = api.stub.calls.map((call) => call.url)
    const contractIndex = urls.findIndex((url) => url.endsWith('/contracts/7'))
    const eventsIndex = urls.findIndex((url) => url.includes('/contracts/7/events'))

    // The context read comes first: it is what establishes the right to read.
    expect(contractIndex).toBeGreaterThan(-1)
    expect(eventsIndex).toBeGreaterThan(contractIndex)
    expect(urls[eventsIndex]).toBe(`/api/v1/contracts/7/events?page=1&pageSize=${String(PAGE_SIZE)}`)

    for (const call of api.stub.calls.filter((entry) => entry.url.includes('/contracts'))) {
      expect(new Headers(call.init.headers).get('authorization')).toBe('Bearer stored-token')
      expect(call.init.method ?? 'GET').toBe('GET')
    }
  })

  it('shows a SubmitTransaction payload exactly as it arrived', async () => {
    const hugeValue = (2n ** 200n).toString(10)
    apiFetch({
      events: () =>
        eventsResponse([
          {
            ...SUBMIT_EVENT,
            payload: { to: SUBMIT_EVENT.payload.to, valueWei: hugeValue, data: '0xdeadbeef' },
          },
        ]),
    })

    renderApp({ path: '/contracts/7/events', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(screen.getByText('SubmitTransaction')).toBeDefined()
    })

    const row = screen.getByRole('row', { name: /SubmitTransaction/ })

    // Exact digits, not a rounded number, and the hex calldata untouched.
    expect(within(row).getByText(hugeValue)).toBeDefined()
    expect(within(row).getByText('0xdeadbeef')).toBeDefined()
    expect(within(row).getByText(SUBMIT_EVENT.payload.to)).toBeDefined()

    // And nothing invented around it: no currency, no decoded function.
    expect(row.textContent).not.toMatch(/\$|USD|€|transfer\(|0xdeadbeef is/i)
  })

  it('says an owner event carries no payload rather than inventing one', async () => {
    apiFetch({ events: () => eventsResponse([CONFIRM_EVENT]) })

    renderApp({ path: '/contracts/7/events', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(screen.getByText('ConfirmTransaction')).toBeDefined()
    })

    const row = screen.getByRole('row', { name: /ConfirmTransaction/ })

    expect(row.textContent).toContain('No payload for this event.')
    expect(row.textContent).not.toContain('wei')
  })

  it('states that the list is indexed data, not a live feed', async () => {
    apiFetch({})

    renderApp({ path: '/contracts/7/events', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(screen.getByText('SubmitTransaction')).toBeDefined()
    })

    expect(mainText()).toContain('not a live chain feed')
    expect(mainText()).toContain('newest block first')
  })

  it('shows an empty result as no stored rows, not as an absence of events', async () => {
    apiFetch({
      events: () => eventsResponse([], { page: 1, pageSize: PAGE_SIZE, totalItems: 0, totalPages: 0 }),
    })

    renderApp({ path: '/contracts/7/events', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('no stored events for this contract')
    })

    expect(mainText()).toContain('not a claim that the contract emitted none on chain')
    expect(screen.queryByRole('table')).toBeNull()
    // Nothing to page through, so no controls at all rather than a dead pair.
    expect(screen.queryByRole('button', { name: 'Previous' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull()
  })

  it('offers a retry that reads the events again after a failure', async () => {
    let calls = 0
    const api = apiFetch({
      events: () => {
        calls += 1

        return calls === 1
          ? errorResponse(500, 'INTERNAL_SERVER_ERROR')
          : eventsResponse([SUBMIT_EVENT], {
              page: 1,
              pageSize: PAGE_SIZE,
              totalItems: 1,
              totalPages: 1,
            })
      },
    })

    const { user } = renderApp({ path: '/contracts/7/events', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('went wrong')
    })

    expect(screen.queryByRole('table')).toBeNull()

    await user.click(button('Retry'))

    await waitFor(() => {
      expect(screen.getByText('SubmitTransaction')).toBeDefined()
    })

    expect(api.eventCalls).toBe(2)
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('pagination', () => {
  it('pages through the server results and keeps the page in the URL', async () => {
    const api = apiFetch({
      events: (url) => {
        const page = new URL(`https://api.test${url}`).searchParams.get('page')

        return eventsResponse(page === '2' ? [CONFIRM_EVENT] : [SUBMIT_EVENT], {
          page: Number(page),
          pageSize: PAGE_SIZE,
          totalItems: 21,
          totalPages: 2,
        })
      },
    })

    const { user } = renderApp({ path: '/contracts/7/events', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(screen.getByText('SubmitTransaction')).toBeDefined()
    })

    expect(screen.getByText(/Showing 1 of 21 indexed events/)).toBeDefined()
    expect(screen.getByText('Page 1 of 2')).toBeDefined()
    expect(button('Previous').disabled).toBe(true)

    await user.click(button('Next'))

    await waitFor(() => {
      expect(currentPath()).toBe('/contracts/7/events?page=2')
    })

    await waitFor(() => {
      expect(screen.getByText('ConfirmTransaction')).toBeDefined()
    })

    expect(screen.queryByText('SubmitTransaction')).toBeNull()
    expect(screen.getByText('Page 2 of 2')).toBeDefined()
    expect(button('Next').disabled).toBe(true)
    expect(eventRequests(api.stub.calls).map((call) => call.url)).toEqual([
      `/api/v1/contracts/7/events?page=1&pageSize=${String(PAGE_SIZE)}`,
      `/api/v1/contracts/7/events?page=2&pageSize=${String(PAGE_SIZE)}`,
    ])
  })

  it('reports a page past the end with the server total instead of an empty contract', async () => {
    apiFetch({
      events: () => eventsResponse([], { page: 3, pageSize: PAGE_SIZE, totalItems: 5, totalPages: 1 }),
    })

    const { user } = renderApp({
      path: '/contracts/7/events?page=3',
      storage: memoryStorage('stored-token'),
    })

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('No indexed events on page 3')
    })

    expect(mainText()).toContain('This contract has 5 stored events over 1 pages')

    await user.click(button('Previous'))

    expect(currentPath()).toBe('/contracts/7/events?page=2')
  })

  it('treats a malformed page in the URL as page 1', async () => {
    const api = apiFetch({})

    renderApp({ path: '/contracts/7/events?page=abc', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(api.eventCalls).toBe(1)
    })

    expect(eventRequests(api.stub.calls)[0]?.url).toBe(
      `/api/v1/contracts/7/events?page=1&pageSize=${String(PAGE_SIZE)}`,
    )
  })

  it('refuses a reply that describes a different page than the one asked for', async () => {
    apiFetch({
      events: () => eventsResponse([SUBMIT_EVENT], { page: 1, pageSize: PAGE_SIZE, totalItems: 2, totalPages: 2 }),
    })

    renderApp({ path: '/contracts/7/events?page=2', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('went wrong')
    })

    expect(screen.queryByText('SubmitTransaction')).toBeNull()
  })
})

describe('a contract this account cannot see', () => {
  it('shows the same answer for a foreign id and a missing one, and reads no events', async () => {
    // The server answers 404 for a contract this account does not track and for
    // one that does not exist, with the same body, so there is one case here:
    // the page must not try to tell them apart, and must not ask for events.
    const api = apiFetch({ contract: () => errorResponse(404, 'RESOURCE_NOT_FOUND') })

    renderApp({ path: '/contracts/7/events', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('no longer exists')
    })

    expect(mainText()).toContain('No events were requested.')
    expect(mainText()).toContain('cannot say which it was')
    expect(api.eventCalls).toBe(0)
    expect(eventRequests(api.stub.calls)).toHaveLength(0)
  })

  it('asks nothing at all for an id that is not a contract id', async () => {
    const api = apiFetch({})

    renderApp({ path: '/contracts/not-an-id/events', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('does not name a tracked contract')
    })

    expect(api.stub.calls.filter((call) => /\/contracts\/\d+/.test(call.url))).toHaveLength(0)
  })
})

describe('a mismatched answer', () => {
  it('shows an error, and reads no events, when the contract answered is not the one asked for', async () => {
    const api = apiFetch({
      contract: () => jsonResponse({ data: { ...CONTRACT, id: 8, label: 'Another contract' } }),
    })

    renderApp({ path: '/contracts/7/events', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('went wrong')
    })

    // Nothing of the other contract is drawn, and no events read was enabled by
    // a successful read of the wrong record.
    expect(mainText()).not.toContain('Another contract')
    expect(screen.queryByText('SubmitTransaction')).toBeNull()
    expect(api.eventCalls).toBe(0)
  })

  it('shows an error rather than rows when the page holds another contract events', async () => {
    apiFetch({
      events: () =>
        eventsResponse([SUBMIT_EVENT, { ...CONFIRM_EVENT, contractId: 8 }], {
          page: 1,
          pageSize: PAGE_SIZE,
          totalItems: 2,
          totalPages: 1,
        }),
    })

    renderApp({ path: '/contracts/7/events', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('went wrong')
    })

    // Not one row of the mixed page is drawn, not even the row that belonged
    // here: the answer is not usable, so none of it is presented.
    expect(screen.queryByText('SubmitTransaction')).toBeNull()
    expect(screen.queryByText('ConfirmTransaction')).toBeNull()
    expect(screen.queryByRole('table')).toBeNull()
  })
})

describe('identity and writes', () => {
  it('draws nothing and keeps no entry after a sign-out mid-read', async () => {
    const held = pendingResponse<Response>()
    const api = apiFetch({ events: () => held.promise })
    const queryClient = createQueryClient()

    const { user } = renderApp({
      path: '/contracts/7/events',
      storage: memoryStorage('stored-token'),
      queryClient,
    })

    await waitFor(() => {
      expect(api.eventCalls).toBe(1)
    })

    await user.click(screen.getByRole('button', { name: 'Sign out' }))

    await waitFor(() => {
      expect(currentPath()).toBe('/login')
    })

    held.resolve(eventsResponse([SUBMIT_EVENT], { page: 1, pageSize: PAGE_SIZE, totalItems: 1, totalPages: 1 }))

    await waitFor(() => {
      expect(
        queryClient.getQueryCache().findAll({ queryKey: ['identity', USER.id] }),
      ).toHaveLength(0)
    })

    expect(screen.queryByText('SubmitTransaction')).toBeNull()
  })

  it('shows nothing for a read that lands after the page is gone', async () => {
    const held = pendingResponse<Response>()
    apiFetch({ events: () => held.promise })

    const { unmount } = renderApp({
      path: '/contracts/7/events',
      storage: memoryStorage('stored-token'),
    })

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('Loading indexed events')
    })

    unmount()
    held.resolve(eventsResponse([SUBMIT_EVENT], { page: 1, pageSize: PAGE_SIZE, totalItems: 1, totalPages: 1 }))

    await Promise.resolve()

    expect(document.body.textContent).not.toContain('SubmitTransaction')
  })

  it('makes no write request, and asks the wallet only who and where it is', async () => {
    const api = apiFetch({
      events: (url) => {
        const page = Number(new URL(`https://api.test${url}`).searchParams.get('page'))

        return eventsResponse([SUBMIT_EVENT], {
          page,
          pageSize: PAGE_SIZE,
          totalItems: 40,
          totalPages: 2,
        })
      },
    })
    // A wallet that is present but has not connected this site.
    const provider = installFakeProvider()

    const { user } = renderApp({ path: '/contracts/7/events', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(screen.getByText('SubmitTransaction')).toBeDefined()
    })

    await user.click(button('Next'))

    await waitFor(() => {
      expect(api.eventCalls).toBe(2)
    })

    expect(api.stub.calls.every((call) => (call.init.method ?? 'GET') === 'GET')).toBe(true)

    // The submit form on this screen reads the account and the chain so it can
    // say whether sending is available. It does not prompt, and it dispatches
    // nothing: no `eth_sendTransaction`, and no request for access.
    expect(
      provider.requested.every(
        (method) => method === 'eth_accounts' || method === 'eth_chainId',
      ),
    ).toBe(true)
    expect(provider.requested).not.toContain('eth_sendTransaction')
    expect(provider.requested).not.toContain('eth_requestAccounts')
  })
})

describe('submitting from the contract view', () => {
  const ACCOUNT = '0x1e1D0e1D0e1D0e1D0e1D0e1D0e1D0e1D0e1D0e1D'
  const DESTINATION = '0x14912965632cd9ab70c046e8d23e9b8dfa9f2746'
  const SENT_HASH = `0x${'cd'.repeat(32)}`
  const SEPOLIA_ENTRY = {
    chainId: CONTRACT.chainId,
    name: 'Sepolia',
    symbol: 'ETH',
    isTestnet: true,
  }

  function wallet(receipt: () => unknown = () => successfulReceipt): FakeProvider {
    return installFakeProvider({
      answer: ({ method }) => {
        if (method === 'eth_accounts') {
          return [ACCOUNT]
        }

        if (method === 'eth_chainId') {
          return `0x${CONTRACT.chainId.toString(16)}`
        }

        if (method === 'eth_sendTransaction') {
          return SENT_HASH
        }

        if (method === 'eth_getTransactionReceipt') {
          return receipt()
        }

        throw new Error(`unexpected method ${method}`)
      },
    })
  }

  const successfulReceipt = {
    transactionHash: SENT_HASH,
    to: CONTRACT.address,
    status: '0x1',
    blockNumber: '0x5d2c40',
    blockHash: `0x${'33'.repeat(32)}`,
  }

  const INDEXED_SUBMIT = {
    ...SUBMIT_EVENT,
    contractId: CONTRACT.id,
    transactionHash: SENT_HASH,
  }

  /** Fills the form, confirms, and opens the wallet once. */
  async function submit(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await user.type(screen.getByLabelText('Destination address'), DESTINATION)
    await user.type(screen.getByLabelText('Value in wei'), '1000000000000000000')
    await user.type(screen.getByLabelText('Calldata'), '0xdeadbeef')
    await user.click(button('Review submission'))
    await user.click(button('Open wallet and submit'))

    await waitFor(() => {
      expect(screen.getByText(/Submitted\./).textContent).toContain(SENT_HASH)
    })
  }

  it('offers the form on the contract page, and says why it cannot send without a wallet', async () => {
    apiFetch({})

    renderApp({ path: '/contracts/7/events', storage: memoryStorage('stored-token') })

    expect(
      await screen.findByRole('heading', { name: 'Submit a transaction' }),
    ).toBeDefined()

    // No provider was installed, which is a fact about this browser and not the
    // same thing as a wallet with nothing connected.
    expect(screen.getByText(/Sending is not available/).textContent).toContain(
      'No browser wallet was found in this browser.',
    )
    expect(button('Review submission').disabled).toBe(true)
  })

  it('submits one proposal to the tracked contract and does not touch the event list', async () => {
    const api = apiFetch({ chains: () => jsonResponse({ data: [SEPOLIA_ENTRY] }) })
    const provider = wallet()

    const { user } = renderApp({
      path: '/contracts/7/events',
      storage: memoryStorage('stored-token'),
    })

    await waitFor(() => {
      expect(button('Review submission').disabled).toBe(false)
    })

    await user.type(screen.getByLabelText('Destination address'), DESTINATION)
    await user.type(screen.getByLabelText('Value in wei'), '1000000000000000000')
    await user.type(screen.getByLabelText('Calldata'), '0xdeadbeef')
    await user.click(button('Review submission'))

    // The contract the page is about, restated in the confirmation.
    expect(screen.getByText('Destination').closest('dl')!.textContent).toContain(
      CONTRACT.address,
    )

    await user.click(button('Open wallet and submit'))

    await waitFor(() => {
      expect(screen.getByText(/Submitted\./).textContent).toContain(SENT_HASH)
    })

    const sent = provider.calls.filter((call) => call.method === 'eth_sendTransaction')

    expect(sent).toHaveLength(1)
    expect(sent[0]!.params).toEqual([
      {
        from: ACCOUNT,
        to: CONTRACT.address,
        value: '0x0',
        data: expect.stringContaining('0xc6427474'),
      },
    ])

    // Submitting is not indexing: the stored list is not read again, and nothing
    // is polled for afterwards.
    expect(api.eventCalls).toBe(1)
    expect(api.stub.calls.every((call) => (call.init.method ?? 'GET') === 'GET')).toBe(true)
  })

  it('checks the receipt once per click, and refreshes the indexed page only on request', async () => {
    const api = apiFetch({
      chains: () => jsonResponse({ data: [SEPOLIA_ENTRY] }),
      events: (_url, _init, call) =>
        call === 1
          ? eventsResponse([SUBMIT_EVENT], { page: 1, pageSize: PAGE_SIZE, totalItems: 1, totalPages: 1 })
          : eventsResponse(
              [INDEXED_SUBMIT],
              { page: 1, pageSize: PAGE_SIZE, totalItems: 2, totalPages: 1 },
            ),
    })
    const provider = wallet()

    const { user } = renderApp({
      path: '/contracts/7/events',
      storage: memoryStorage('stored-token'),
    })

    await waitFor(() => {
      expect(button('Review submission').disabled).toBe(false)
    })

    await submit(user)

    // Nothing has been asked of the wallet or the index since the submission.
    expect(provider.calls.filter((call) => call.method === 'eth_getTransactionReceipt')).toHaveLength(0)
    expect(api.eventCalls).toBe(1)

    await user.click(button('Check receipt'))

    await waitFor(() => {
      expect(document.body.textContent).toContain('included in block 6106176')
    })

    expect(provider.calls.filter((call) => call.method === 'eth_getTransactionReceipt')).toHaveLength(1)
    // A receipt is not an index refresh.
    expect(api.eventCalls).toBe(1)

    await user.click(button('Refresh indexed events'))

    await waitFor(() => {
      expect(document.body.textContent).toContain('shows the SubmitTransaction event')
    })

    // One read of the same page, under the same bearer.
    expect(api.eventCalls).toBe(2)

    const last = api.stub.calls.filter((call) => /\/contracts\/7\/events/.test(call.url)).at(-1)!

    expect(last.url).toBe(`/api/v1/contracts/7/events?page=1&pageSize=${String(PAGE_SIZE)}`)
    expect(new Headers(last.init.headers).get('authorization')).toBe('Bearer stored-token')
    expect(document.body.textContent).toContain('in block 6100000')
  })

  it('says only that the event is not on the refreshed page when it is absent', async () => {
    apiFetch({ chains: () => jsonResponse({ data: [SEPOLIA_ENTRY] }) })
    wallet()

    const { user } = renderApp({
      path: '/contracts/7/events',
      storage: memoryStorage('stored-token'),
    })

    await waitFor(() => {
      expect(button('Review submission').disabled).toBe(false)
    })

    await submit(user)

    await user.click(button('Check receipt'))
    await waitFor(() => {
      expect(button('Refresh indexed events')).toBeDefined()
    })

    await user.click(button('Refresh indexed events'))

    await waitFor(() => {
      expect(document.body.textContent).toContain('not on the refreshed page (page 1)')
    })

    expect(document.body.textContent).toContain('does not mean the contract emitted nothing')
  })

  it('reads a receipt with no block yet as no receipt, not as a lost transaction', async () => {
    apiFetch({ chains: () => jsonResponse({ data: [SEPOLIA_ENTRY] }) })
    wallet(() => null)

    const { user } = renderApp({
      path: '/contracts/7/events',
      storage: memoryStorage('stored-token'),
    })

    await waitFor(() => {
      expect(button('Review submission').disabled).toBe(false)
    })

    await submit(user)
    await user.click(button('Check receipt'))

    await waitFor(() => {
      expect(document.body.textContent).toContain('no receipt for this transaction right now')
    })

    expect(document.body.textContent).toContain('not proof the transaction was dropped')
    expect(screen.queryByRole('button', { name: 'Refresh indexed events' })).toBeNull()
  })

  it('clears the receipt when the wallet moves to another account', async () => {
    apiFetch({ chains: () => jsonResponse({ data: [SEPOLIA_ENTRY] }) })
    const provider = wallet()

    const { user } = renderApp({
      path: '/contracts/7/events',
      storage: memoryStorage('stored-token'),
    })

    await waitFor(() => {
      expect(button('Review submission').disabled).toBe(false)
    })

    await submit(user)
    await user.click(button('Check receipt'))

    await waitFor(() => {
      expect(document.body.textContent).toContain('included in block 6106176')
    })

    // The wallet announces a different account. The submission belonged to the
    // one that left, so the hash and its receipt go with it.
    await act(async () => {
      provider.emit('accountsChanged', ['0x2e2E2e2E2e2E2e2E2e2E2e2E2e2E2e2E2e2E2e2E'])
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(screen.queryByText(/included in block/)).toBeNull()
    })

    expect(screen.queryByText(/Submitted\./)).toBeNull()
  })

  it('shows nothing for a receipt that arrives after the page is gone', async () => {
    const held = deferred<unknown>()
    apiFetch({ chains: () => jsonResponse({ data: [SEPOLIA_ENTRY] }) })
    wallet(() => held.promise)

    const { user } = renderApp({
      path: '/contracts/7/events',
      storage: memoryStorage('stored-token'),
    })

    await waitFor(() => {
      expect(button('Review submission').disabled).toBe(false)
    })

    await submit(user)
    await user.click(button('Check receipt'))

    await waitFor(() => {
      expect(document.body.textContent).toContain('Checking the receipt')
    })

    await user.click(screen.getByRole('link', { name: 'Back to tracked contracts' }))

    await waitFor(() => {
      expect(currentPath()).toBe('/contracts')
    })

    await act(async () => {
      held.resolve(successfulReceipt)
      await Promise.resolve()
    })

    expect(document.body.textContent).not.toContain('included in block')
  })

  it('does not treat an indexing status as a permission it needs', async () => {
    // The record says this deployment does not index the contract chain at all.
    // That is a fact about the indexer, not about whether this wallet can submit
    // a transaction to the contract.
    apiFetch({
      contract: () =>
        jsonResponse({ data: { ...CONTRACT, indexingStatus: 'unsupported' } }),
      chains: () => jsonResponse({ data: [SEPOLIA_ENTRY] }),
    })
    wallet()

    renderApp({ path: '/contracts/7/events', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(button('Review submission').disabled).toBe(false)
    })

    expect(screen.queryByText(/Sending is not available/)).toBeNull()
  })

  it('offers no sending when the catalog does not list the contract chain', async () => {
    apiFetch({ chains: () => jsonResponse({ data: [] }) })
    wallet()

    renderApp({ path: '/contracts/7/events', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(screen.getByText(/Sending is not available/).textContent).toContain(
        `does not list chain ${String(CONTRACT.chainId)}`,
      )
    })

    expect(button('Review submission').disabled).toBe(true)
  })
})

describe('reaching the view from the contracts list', () => {
  it('offers a link to each tracked contract events', async () => {
    apiFetch({})

    const { user } = renderApp({
      path: '/contracts',
      storage: memoryStorage('stored-token'),
    })

    await waitFor(() => {
      expect(screen.getByText('Project multisig')).toBeDefined()
    })

    const link = screen.getByRole('link', { name: /View events/ })

    expect(link.getAttribute('href')).toBe('/contracts/7/events')

    await user.click(link)

    await waitFor(() => {
      expect(currentPath()).toBe('/contracts/7/events')
    })

    await waitFor(() => {
      expect(screen.getByText('SubmitTransaction')).toBeDefined()
    })
  })
})
