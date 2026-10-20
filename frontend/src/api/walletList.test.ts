import { beforeEach, describe, expect, it, vi } from 'vitest'

import { errorResponse, hangingFetch, jsonResponse, stubFetch, type FetchStub } from '../test/http.ts'
import { createApiClient } from './client.ts'
import { ApiError, isApiError } from './errors.ts'
import { API_BASE } from './request.ts'
import type { Pagination } from './types.ts'

const TOKEN = 'wallet-list-token'

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
  label: '',
  createdAt: '2026-10-02T11:30:00Z',
}

const PAGINATION: Pagination = { page: 1, pageSize: 20, totalItems: 2, totalPages: 1 }

/** The reply a page 3 request has to carry: the same page it asked for. */
const PAGINATION_PAGE_THREE: Pagination = {
  page: 3,
  pageSize: 20,
  totalItems: 42,
  totalPages: 3,
}

function walletListClient(getToken: () => string | null = () => null, onUnauthorized = vi.fn()) {
  return {
    client: createApiClient({ getToken, onUnauthorized }),
    onUnauthorized,
  }
}

function listPayload(data: unknown, options: { pagination?: unknown } = { pagination: PAGINATION }) {
  // The key itself matters: a response with no pagination key and one carrying
  // null are different bodies, and both have to be rejected.
  return jsonResponse('pagination' in options ? { data, pagination: options.pagination } : { data })
}

/** The code a malformed success has to become, whatever the server thought it sent. */
function expectUnexpectedResponse(run: () => Promise<unknown>): Promise<void> {
  return expect(run()).rejects.toSatisfy((error: unknown) => {
    expect(isApiError(error)).toBe(true)
    expect((error as ApiError).code).toBe('UNEXPECTED_RESPONSE')
    return true
  })
}

describe('wallet list call', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('asks for the caller own wallets by page and carries the bearer', async () => {
    const fetchStub: FetchStub = stubFetch(() =>
      listPayload([WALLET_A, WALLET_B], { pagination: PAGINATION_PAGE_THREE }),
    )
    const { client } = walletListClient(() => TOKEN)

    const result = await client.listWallets({ page: 3, pageSize: 20 })

    expect(result).toEqual({
      wallets: [WALLET_A, WALLET_B],
      pagination: PAGINATION_PAGE_THREE,
    })
    expect(fetchStub.lastCall().url).toBe(`${API_BASE}/wallets?page=3&pageSize=20`)
    expect(fetchStub.lastCall().init.method).toBe('GET')
    expect(fetchStub.headers()['authorization']).toBe(`Bearer ${TOKEN}`)
  })

  it('never sends a user id: the owner comes from the bearer', async () => {
    const fetchStub = stubFetch(() => listPayload([]))
    const { client } = walletListClient(() => TOKEN)

    await client.listWallets({ page: 1, pageSize: 20 })

    const url = fetchStub.lastCall().url.toLowerCase()
    expect(url).not.toContain('user')
    expect(fetchStub.lastCall().init.body).toBeUndefined()
  })

  it('sends no bearer when there is no credential, so a 401 cannot end a session', async () => {
    const fetchStub = stubFetch(() => errorResponse(401, 'UNAUTHENTICATED'))
    const { client, onUnauthorized } = walletListClient(() => null)

    await expect(client.listWallets({ page: 1, pageSize: 20 })).rejects.toBeInstanceOf(ApiError)

    expect(fetchStub.headers()['authorization']).toBeUndefined()
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('reports a 401 to the credential that was actually sent', async () => {
    stubFetch(() => errorResponse(401, 'UNAUTHENTICATED'))
    const { client, onUnauthorized } = walletListClient(() => TOKEN)

    await expect(client.listWallets({ page: 1, pageSize: 20 })).rejects.toBeInstanceOf(ApiError)

    expect(onUnauthorized).toHaveBeenCalledWith(TOKEN)
  })

  it('keeps the rate-limit detail the API sent', async () => {
    stubFetch(() =>
      errorResponse(429, 'RATE_LIMITED', { headers: { 'Retry-After': '45' } }),
    )
    const { client } = walletListClient(() => TOKEN)

    await expect(client.listWallets({ page: 1, pageSize: 20 })).rejects.toSatisfy(
      (error: unknown) => {
        expect((error as ApiError).code).toBe('RATE_LIMITED')
        expect((error as ApiError).retryAfterSeconds).toBe(45)
        return true
      },
    )
  })

  it('honours the caller abort through the same helper as every other call', async () => {
    stubFetch(hangingFetch)

    const controller = new AbortController()
    const { client } = walletListClient(() => TOKEN)
    const pending = client.listWallets({ page: 1, pageSize: 20 }, { signal: controller.signal })
    const settled = pending.catch((error: unknown) => error)
    controller.abort()

    expect(await settled).toMatchObject({ code: 'ABORTED', status: 0 })
  })
})

/**
 * A malformed success is a broken response, not a short page.
 *
 * Dropping rows the client cannot understand would show a page as if it were
 * complete, and the total on screen would then disagree with the rows under it.
 */
describe('wallet list response validation', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it.each([
    ['data is not an array', { id: 1 }],
    ['data is an object', { 0: WALLET_A }],
    ['one row is missing its label', [{ ...WALLET_A, label: undefined }]],
    ['one row has an address that is not a string', [{ ...WALLET_A, address: 42 }]],
    ['one row has an id that is a string', [{ ...WALLET_A, id: '7' }]],
    ['one row has an id that is not an integer', [{ ...WALLET_A, id: 1.5 }]],
    ['one row has an id beyond safe integers', [{ ...WALLET_A, id: 2 ** 53 }]],
    ['one row has a chainId that is null', [{ ...WALLET_A, chainId: null }]],
    ['one row has no createdAt', [{ ...WALLET_A, createdAt: undefined }]],
    ['the second row is the bad one', [WALLET_A, { ...WALLET_B, chainId: '1' }]],
  ])('rejects a page where %s', (_name, data) => {
    stubFetch(() => listPayload(data))
    const { client } = walletListClient(() => TOKEN)

    return expectUnexpectedResponse(() => client.listWallets({ page: 1, pageSize: 20 }))
  })

  it.each([
    ['pagination is missing', {}],
    ['pagination is null', { pagination: null }],
    ['pagination is not an object', { pagination: '1' }],
    ['page is a string', { pagination: { ...PAGINATION, page: '1' } }],
    ['page is zero', { pagination: { ...PAGINATION, page: 0 } }],
    ['pageSize is negative', { pagination: { ...PAGINATION, pageSize: -1 } }],
    ['totalPages is a float', { pagination: { ...PAGINATION, totalPages: 1.5 } }],
    ['totalItems is missing', { pagination: { page: 1, pageSize: 20, totalPages: 1 } }],
    ['totalItems is negative', { pagination: { ...PAGINATION, totalItems: -1 } }],
    ['totalItems is beyond safe integers', { pagination: { ...PAGINATION, totalItems: 2 ** 53 } }],
  ])('rejects a page where %s', (_name, options) => {
    stubFetch(() => listPayload([WALLET_A], options))
    const { client } = walletListClient(() => TOKEN)

    return expectUnexpectedResponse(() => client.listWallets({ page: 1, pageSize: 20 }))
  })

  it('rejects a reply that describes a page other than the one requested', async () => {
    // The rows are real, but they are page 1's rows. Rendering them under
    // "Page 3 of 3" would label one page's data as another.
    stubFetch(() => listPayload([WALLET_A], { pagination: PAGINATION }))
    const { client } = walletListClient(() => TOKEN)

    return expectUnexpectedResponse(() => client.listWallets({ page: 3, pageSize: 20 }))
  })

  it('rejects a reply that describes a page size other than the one requested', async () => {
    stubFetch(() =>
      listPayload([WALLET_A], { pagination: { ...PAGINATION, page: 1, pageSize: 50 } }),
    )
    const { client } = walletListClient(() => TOKEN)

    return expectUnexpectedResponse(() => client.listWallets({ page: 1, pageSize: 20 }))
  })

  it('accepts a past-end page, which echoes the requested page and keeps real totals', async () => {
    // Not a mismatch: a page past the end describes the page that was asked
    // for, with no rows and the totals that are actually there.
    stubFetch(() =>
      listPayload([], { pagination: { page: 7, pageSize: 20, totalItems: 12, totalPages: 1 } }),
    )
    const { client } = walletListClient(() => TOKEN)

    const result = await client.listWallets({ page: 7, pageSize: 20 })

    expect(result.wallets).toEqual([])
    expect(result.pagination).toEqual({
      page: 7,
      pageSize: 20,
      totalItems: 12,
      totalPages: 1,
    })
  })

  it('accepts a row with an empty label, which is a saved wallet with no name', async () => {
    stubFetch(() => listPayload([WALLET_B]))
    const { client } = walletListClient(() => TOKEN)

    const result = await client.listWallets({ page: 1, pageSize: 20 })

    expect(result.wallets).toEqual([WALLET_B])
  })

  it('accepts an empty page that carries real totals', async () => {
    stubFetch(() =>
      listPayload([], { pagination: { page: 4, pageSize: 20, totalItems: 61, totalPages: 4 } }),
    )
    const { client } = walletListClient(() => TOKEN)

    const result = await client.listWallets({ page: 4, pageSize: 20 })

    expect(result.wallets).toEqual([])
    expect(result.pagination).toEqual({ page: 4, pageSize: 20, totalItems: 61, totalPages: 4 })
  })

  it('accepts an empty account, whose totals are genuinely zero', async () => {
    stubFetch(() =>
      listPayload([], { pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 } }),
    )
    const { client } = walletListClient(() => TOKEN)

    const result = await client.listWallets({ page: 1, pageSize: 20 })

    expect(result.pagination.totalItems).toBe(0)
    expect(result.pagination.totalPages).toBe(0)
  })
})
