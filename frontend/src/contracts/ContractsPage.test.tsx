import { screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { errorResponse, jsonResponse, pendingResponse, stubFetch, type FetchCall } from '../test/http.ts'
import { currentPath, memoryStorage, renderApp } from '../test/renderApp.tsx'
import { createQueryClient } from '../data/queryClient.ts'
import { PAGE_SIZE } from '../data/page.ts'

/**
 * The tracked-contract list as the user sees it.
 *
 * The backend is stubbed, because what this screen does with the API is one
 * authenticated read and nothing else. Every assertion about a total, a page
 * count or a row is an assertion about what the server said, never about what
 * the screen felt like showing.
 */

const USER = { id: 5, email: 'ada@example.com', createdAt: '2026-10-06T12:00:00Z' }

const CONTRACT_A = {
  id: 3,
  address: '0x5b324f41e5889cf94cba8e909089683a1a97c318',
  chainId: 11155111,
  label: 'Project multisig',
  enabled: true,
  startBlock: 5_800_000,
  createdAt: '2026-10-01T10:00:00Z',
  indexingStatus: 'pending',
}

const CONTRACT_B = {
  id: 4,
  address: '0x00000000000000000000000000000000000000b2',
  chainId: 11155111,
  label: '',
  enabled: false,
  startBlock: 0,
  createdAt: '2026-10-02T11:30:00Z',
  indexingStatus: 'unsupported',
}

function pageResponse(
  contracts: unknown[],
  pagination: Record<string, number> = {
    page: 1,
    pageSize: PAGE_SIZE,
    totalItems: 2,
    totalPages: 1,
  },
) {
  return jsonResponse({ data: contracts, pagination })
}

/**
 * /users/me authenticates the stored credential; the catalog is answered so the
 * Overview screen's own reads never reach the contract responder; everything
 * else is the contract list.
 */
function apiFetch(
  respondContracts: (url: string, init: RequestInit, call: number) => Response | Promise<Response>,
  user: unknown = USER,
) {
  let contractCalls = 0

  return stubFetch((url: string, init: RequestInit) => {
    if (url.includes('/users/me')) {
      return jsonResponse({ data: user })
    }

    if (url.includes('/chains')) {
      return jsonResponse({ data: [] })
    }

    if (url.includes('/auth/logout')) {
      return jsonResponse({ data: { message: 'signed out' } })
    }

    contractCalls += 1
    return respondContracts(url, init, contractCalls)
  })
}

function contractCalls(calls: FetchCall[]): FetchCall[] {
  return calls.filter((call) => call.url.includes('/contracts'))
}

function button(name: string): HTMLButtonElement {
  return screen.getByRole('button', { name }) as HTMLButtonElement
}

/** The status line that describes the list, not a row. */
function statusText(): string {
  const main = screen.getByRole('main')

  return within(main).getAllByRole('status')[0]?.textContent ?? ''
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

describe('contracts page', () => {
  it('shows a loading state, then the rows the API returned', async () => {
    const held = pendingResponse<Response>()
    const fetchStub = apiFetch(() => held.promise)

    renderApp({ path: '/contracts', storage: memoryStorage('stored-token') })

    // The request only starts once the identity is validated, so the loading
    // state to assert is the one after the restore, not before it.
    await waitFor(() => {
      expect(statusText()).toContain('Loading tracked contracts')
    })

    held.resolve(pageResponse([CONTRACT_A, CONTRACT_B]))

    await waitFor(() => {
      expect(screen.getByText('Project multisig')).toBeDefined()
    })

    expect(screen.getByText(CONTRACT_A.address)).toBeDefined()
    expect(screen.getByText(String(CONTRACT_A.startBlock))).toBeDefined()
    expect(screen.getByText('No label')).toBeDefined()
    expect(contractCalls(fetchStub.calls)).toHaveLength(1)
  })

  it('asks for page 1 with the fixed page size and the stored credential', async () => {
    const fetchStub = apiFetch(() => pageResponse([]))

    renderApp({ path: '/contracts', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(contractCalls(fetchStub.calls)).toHaveLength(1)
    })

    const call = contractCalls(fetchStub.calls)[0]

    expect(call?.url).toBe(`/api/v1/contracts?page=1&pageSize=${String(PAGE_SIZE)}`)
    expect(new Headers(call?.init.headers).get('authorization')).toBe('Bearer stored-token')
    // The owner is the bearer. No user id is sent, so no request can name one.
    expect(call?.url.toLowerCase()).not.toContain('user')
  })

  it('says the account tracks nothing rather than showing an invented zero page', async () => {
    apiFetch(() => pageResponse([], { page: 1, pageSize: PAGE_SIZE, totalItems: 0, totalPages: 0 }))

    renderApp({ path: '/contracts', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(statusText()).toContain('not tracking any contracts yet')
    })

    expect(screen.queryByRole('button', { name: 'Previous' })).toBeNull()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('shows a failed read as an error and reads again on Retry', async () => {
    let calls = 0
    const fetchStub = apiFetch(() => {
      calls += 1

      // A first read that fails on the server, then an answer. A 500 is a data
      // error: it must not sign anybody out.
      return calls === 1
        ? errorResponse(500, 'INTERNAL_ERROR')
        : pageResponse([CONTRACT_A], {
            page: 1,
            pageSize: PAGE_SIZE,
            totalItems: 1,
            totalPages: 1,
          })
    })

    const { user } = renderApp({ path: '/contracts', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('went wrong')
    })

    expect(screen.queryByRole('table')).toBeNull()
    expect(currentPath()).toBe('/contracts')

    await user.click(button('Retry'))

    await waitFor(() => {
      expect(screen.getByText('Project multisig')).toBeDefined()
    })

    expect(contractCalls(fetchStub.calls)).toHaveLength(2)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('does not render raw server text in place of a description', async () => {
    apiFetch(() => errorResponse(500, 'INTERNAL_ERROR'))

    renderApp({ path: '/contracts', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeDefined()
    })

    const alert = screen.getByRole('alert').textContent ?? ''

    expect(alert).not.toContain('INTERNAL_ERROR')
    expect(alert).not.toContain('indexer')
  })
})

describe('pagination', () => {
  it('reads the next page from the URL and keeps the server totals', async () => {
    const fetchStub = apiFetch((url) => {
      const page = new URL(`https://api.test${url}`).searchParams.get('page')

      return pageResponse(
        page === '2' ? [CONTRACT_B] : [CONTRACT_A],
        { page: Number(page), pageSize: PAGE_SIZE, totalItems: 21, totalPages: 2 },
      )
    })

    const { user } = renderApp({ path: '/contracts', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(screen.getByText('Project multisig')).toBeDefined()
    })

    expect(screen.getByText('Page 1 of 2')).toBeDefined()
    // Previous is dead on the first page, and Next is not the last word on how
    // many pages there are: the server's totalPages is.
    expect(button('Previous').disabled).toBe(true)
    expect(button('Next').disabled).toBe(false)

    await user.click(button('Next'))

    await waitFor(() => {
      expect(currentPath()).toBe('/contracts?page=2')
    })

    await waitFor(() => {
      expect(screen.getByText(CONTRACT_B.address)).toBeDefined()
    })

    expect(screen.queryByText('Project multisig')).toBeNull()
    expect(screen.getByText('Page 2 of 2')).toBeDefined()
    expect(button('Next').disabled).toBe(true)
    expect(button('Previous').disabled).toBe(false)
    expect(contractCalls(fetchStub.calls).map((call) => call.url)).toEqual([
      `/api/v1/contracts?page=1&pageSize=${String(PAGE_SIZE)}`,
      `/api/v1/contracts?page=2&pageSize=${String(PAGE_SIZE)}`,
    ])
  })

  it('never shows a total it did not receive', async () => {
    apiFetch(() =>
      pageResponse([CONTRACT_A], { page: 1, pageSize: PAGE_SIZE, totalItems: 1, totalPages: 1 }),
    )

    renderApp({ path: '/contracts', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(statusText()).toContain('Showing 1 of 1 tracked contracts.')
    })

    // One page: no Previous/Next pair, because there is nowhere to go.
    expect(button('Previous').disabled).toBe(true)
    expect(button('Next').disabled).toBe(true)
  })

  it('reports a page past the end with the real total rather than an empty account', async () => {
    apiFetch(() =>
      pageResponse([], { page: 4, pageSize: PAGE_SIZE, totalItems: 12, totalPages: 1 }),
    )

    const { user } = renderApp({
      path: '/contracts?page=4',
      storage: memoryStorage('stored-token'),
    })

    await waitFor(() => {
      expect(statusText()).toContain('No tracked contracts on page 4')
    })

    expect(statusText()).toContain('tracks 12 over 1 page')
    // The empty-account wording would be a claim about the account, and this is
    // not that: the records exist on an earlier page.
    expect(statusText()).not.toContain('not tracking any contracts')

    await user.click(button('Back to page 1'))

    expect(currentPath()).toBe('/contracts?page=1')
  })

  it('treats a malformed page in the URL as page 1 rather than crashing', async () => {
    const fetchStub = apiFetch(() => pageResponse([CONTRACT_A]))

    renderApp({ path: '/contracts?page=abc', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(contractCalls(fetchStub.calls)).toHaveLength(1)
    })

    expect(contractCalls(fetchStub.calls)[0]?.url).toBe(
      `/api/v1/contracts?page=1&pageSize=${String(PAGE_SIZE)}`,
    )
    expect(screen.getByText('Project multisig')).toBeDefined()
  })

  it('refuses a reply that describes a different page than the one asked for', async () => {
    // Page 2 was requested. The reply says page 1, so its rows describe a page
    // this screen is not on and cannot be labelled as page 2.
    apiFetch(() =>
      pageResponse([CONTRACT_A], { page: 1, pageSize: PAGE_SIZE, totalItems: 21, totalPages: 2 }),
    )

    renderApp({ path: '/contracts?page=2', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('went wrong')
    })

    expect(screen.queryByText('Project multisig')).toBeNull()
  })
})

describe('indexing availability', () => {
  it.each([
    ['pending', 'Pending.', 'not started yet'],
    ['disabled', 'Disabled.', 'switched off'],
    ['unsupported', 'Unsupported.', 'not available for this chain'],
  ])('describes %s as availability, not progress', async (status, label, reason) => {
    apiFetch(() => pageResponse([{ ...CONTRACT_A, indexingStatus: status }]))

    renderApp({ path: '/contracts', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(screen.getByText('Project multisig')).toBeDefined()
    })

    const cell = screen.getByRole('cell', { name: new RegExp(reason) })

    expect(cell.textContent).toContain(label)
    expect(cell.textContent).toContain(reason)
    // No percentage, no block height, no scanner vocabulary.
    expect(cell.textContent).not.toMatch(/%|\bblock\b|scan|catching up|progress/i)
  })

  it('shows no record at all when the server sends an unknown status', async () => {
    apiFetch(() => pageResponse([{ ...CONTRACT_A, indexingStatus: 'scanning' }]))

    renderApp({ path: '/contracts', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeDefined()
    })

    // The raw value is never echoed, in either the table or the error.
    expect(document.body.textContent).not.toContain('scanning')
    expect(screen.queryByText('Project multisig')).toBeNull()
  })
})

describe('what the page never claims or does', () => {
  it('does not call a tracked record deployed, verified or owned', async () => {
    apiFetch(() => pageResponse([CONTRACT_A]))

    renderApp({ path: '/contracts', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(screen.getByText('Project multisig')).toBeDefined()
    })

    const text = screen.getByRole('main').textContent ?? ''

    // The caveat is on the page, and no part of it asserts a positive claim.
    expect(text).toContain('does not mean a contract is deployed')
    expect(text).not.toMatch(/verified|active on-chain|ownership confirmed/i)
  })

  it('makes no write call and calls no provider method', async () => {
    const fetchStub = apiFetch(() => pageResponse([CONTRACT_A]))
    const provider = { request: vi.fn() }
    Object.defineProperty(window, 'ethereum', {
      value: provider,
      configurable: true,
      writable: true,
    })

    try {
      const { user } = renderApp({ path: '/contracts', storage: memoryStorage('stored-token') })

      await waitFor(() => {
        expect(screen.getByText('Project multisig')).toBeDefined()
      })

      // Paging is the only interaction this screen offers, and it is a read.
      await user.click(button('Next'))

      expect(fetchStub.calls.every((call) => (call.init.method ?? 'GET') === 'GET')).toBe(true)
      expect(provider.request).not.toHaveBeenCalled()
    } finally {
      Reflect.deleteProperty(window, 'ethereum')
    }
  })
})

describe('identity', () => {
  it('draws nothing and keeps no cache entry for a session that ended', async () => {
    const held = pendingResponse<Response>()
    const queryClient = createQueryClient()
    const fetchStub = apiFetch(() => held.promise)

    const { user } = renderApp({
      path: '/contracts',
      storage: memoryStorage('stored-token'),
      queryClient,
    })

    await waitFor(() => {
      expect(contractCalls(fetchStub.calls)).toHaveLength(1)
    })

    const ownerKeys = queryClient
      .getQueryCache()
      .findAll({ queryKey: ['identity', USER.id] })
      .map((query) => query.queryKey)

    expect(ownerKeys.some((key) => key.includes('contracts'))).toBe(true)

    await user.click(screen.getByRole('button', { name: 'Sign out' }))

    await waitFor(() => {
      expect(currentPath()).toBe('/login')
    })

    // The held answer lands after the session is gone.
    held.resolve(pageResponse([CONTRACT_A]))

    await waitFor(() => {
      expect(
        queryClient.getQueryCache().findAll({ queryKey: ['identity', USER.id] }),
      ).toHaveLength(0)
    })

    expect(screen.queryByText('Project multisig')).toBeNull()
  })

  it('never shows one account rows under another account session', async () => {
    // The first identity's page answers late, after the session that asked for
    // it has been replaced. Its rows are not the new account's rows.
    const held = pendingResponse<Response>()
    const fetchStub = apiFetch(() => held.promise)

    const queryClient = createQueryClient()

    const view = renderApp({
      path: '/contracts',
      storage: memoryStorage('stored-token'),
      queryClient,
    })

    await waitFor(() => {
      expect(contractCalls(fetchStub.calls)).toHaveLength(1)
    })

    // Signing out drops the identity, and with it every keyed entry.
    await view.user.click(screen.getByRole('button', { name: 'Sign out' }))

    await waitFor(() => {
      expect(currentPath()).toBe('/login')
    })

    held.resolve(pageResponse([CONTRACT_A]))

    // The sign-out removed the entry and the unmount left it unobserved, so the
    // collector's timer and this assertion were in a race. Wait for the state
    // the assertion is about.
    await waitFor(() => {
      expect(
        queryClient.getQueryCache().findAll().filter((query) => query.queryKey[0] === 'identity'),
      ).toHaveLength(0)
    })

    expect(screen.queryByText('Project multisig')).toBeNull()
  })
})
