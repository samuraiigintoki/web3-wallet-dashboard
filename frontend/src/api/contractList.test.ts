import { beforeEach, describe, expect, it, vi } from 'vitest'

import { errorResponse, hangingFetch, jsonResponse, stubFetch, type FetchStub } from '../test/http.ts'
import { createApiClient } from './client.ts'
import { ApiError, isApiError } from './errors.ts'
import { API_BASE } from './request.ts'
import type { Pagination, TrackedContract } from './types.ts'

/**
 * The one call this slice adds: `GET /api/v1/contracts`.
 *
 * The shape mirrors the wallet-list suite because the call does: owner-scoped by
 * the bearer, one page, pagination echoed back and checked against the request.
 * What is new here is the contract row, whose `indexingStatus` is a closed set
 * rather than a free string.
 */

const TOKEN = 'contract-list-token'

const CONTRACT_A: TrackedContract = {
  id: 3,
  address: '0x5b324f41e5889cf94cba8e909089683a1a97c318',
  chainId: 11155111,
  label: 'Project multisig',
  enabled: true,
  startBlock: 5_800_000,
  createdAt: '2026-10-01T10:00:00Z',
  indexingStatus: 'pending',
}

const CONTRACT_B: TrackedContract = {
  id: 4,
  address: '0x00000000000000000000000000000000000000b2',
  chainId: 11155111,
  label: '',
  enabled: false,
  startBlock: 0,
  createdAt: '2026-10-02T11:30:00Z',
  indexingStatus: 'disabled',
}

const PAGINATION: Pagination = { page: 1, pageSize: 20, totalItems: 2, totalPages: 1 }

function contractListClient(getToken: () => string | null = () => null, onUnauthorized = vi.fn()) {
  return {
    client: createApiClient({ getToken, onUnauthorized }),
    onUnauthorized,
  }
}

function listPayload(data: unknown, options: { pagination?: unknown } = { pagination: PAGINATION }) {
  // The key itself matters: no pagination key and a null pagination are
  // different bodies, and both have to be rejected.
  return jsonResponse('pagination' in options ? { data, pagination: options.pagination } : { data })
}

function expectUnexpectedResponse(run: () => Promise<unknown>): Promise<void> {
  return expect(run()).rejects.toSatisfy((error: unknown) => {
    expect(isApiError(error)).toBe(true)
    expect((error as ApiError).code).toBe('UNEXPECTED_RESPONSE')
    return true
  })
}

describe('contract list call', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('asks for the caller own tracked contracts by page and carries the bearer', async () => {
    const fetchStub: FetchStub = stubFetch(() => listPayload([CONTRACT_A, CONTRACT_B]))
    const { client } = contractListClient(() => TOKEN)

    const result = await client.listContracts({ page: 1, pageSize: 20 })

    expect(result).toEqual({ contracts: [CONTRACT_A, CONTRACT_B], pagination: PAGINATION })
    expect(fetchStub.lastCall().url).toBe(`${API_BASE}/contracts?page=1&pageSize=20`)
    expect(fetchStub.lastCall().init.method).toBe('GET')
    expect(fetchStub.headers()['authorization']).toBe(`Bearer ${TOKEN}`)
  })

  it('sends the page and the page size, and nothing else', async () => {
    const fetchStub = stubFetch(() =>
      listPayload([], { pagination: { page: 2, pageSize: 20, totalItems: 0, totalPages: 0 } }),
    )
    const { client } = contractListClient(() => TOKEN)

    await client.listContracts({ page: 2, pageSize: 20 })

    const url = new URL(`https://api.test${fetchStub.lastCall().url}`)
    expect([...url.searchParams.keys()].sort()).toEqual(['page', 'pageSize'])
    // No user id, no search, no filter: the owner is the bearer and this screen
    // offers no way to narrow or widen the list.
    expect(url.searchParams.get('page')).toBe('2')
    expect(fetchStub.lastCall().init.body).toBeUndefined()
  })

  it('sends no bearer when there is no credential, so a 401 cannot end a session', async () => {
    const fetchStub = stubFetch(() => jsonResponse({ data: [] }))
    const { client, onUnauthorized } = contractListClient(() => null)

    await expect(client.listContracts({ page: 1, pageSize: 20 })).rejects.toBeInstanceOf(ApiError)

    expect(fetchStub.headers()['authorization']).toBeUndefined()
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('reports a 401 to the credential that was actually sent', async () => {
    stubFetch(() => errorResponse(401, 'UNAUTHENTICATED'))
    const { client, onUnauthorized } = contractListClient(() => TOKEN)

    await expect(client.listContracts({ page: 1, pageSize: 20 })).rejects.toBeInstanceOf(ApiError)

    expect(onUnauthorized).toHaveBeenCalledWith(TOKEN)
  })

  it('honours the caller abort through the same helper as every other call', async () => {
    stubFetch(hangingFetch)

    const controller = new AbortController()
    const { client } = contractListClient(() => TOKEN)
    const pending = client.listContracts({ page: 1, pageSize: 20 }, { signal: controller.signal })
    const settled = pending.catch((error: unknown) => error)
    controller.abort()

    expect(await settled).toMatchObject({ code: 'ABORTED', status: 0 })
  })

  it('makes no write call of any kind', async () => {
    const fetchStub = stubFetch(() => listPayload([CONTRACT_A]))
    const { client } = contractListClient(() => TOKEN)

    await client.listContracts({ page: 1, pageSize: 20 })

    expect(fetchStub.calls.map((call) => call.init.method)).toEqual(['GET'])
  })
})

describe('contract list response validation', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it.each([
    ['data is not an array', { id: 3 }],
    ['data is an object of rows', { 0: CONTRACT_A }],
    ['one row is missing its label', [{ ...CONTRACT_A, label: undefined }]],
    ['one row has an address that is not a string', [{ ...CONTRACT_A, address: 42 }]],
    ['one row has an id that is a string', [{ ...CONTRACT_A, id: '3' }]],
    ['one row has an id that is a float', [{ ...CONTRACT_A, id: 3.5 }]],
    ['one row has an id beyond safe integers', [{ ...CONTRACT_A, id: 2 ** 53 }]],
    ['one row has a chainId that is null', [{ ...CONTRACT_A, chainId: null }]],
    ['one row has an enabled flag that is a string', [{ ...CONTRACT_A, enabled: 'true' }]],
    ['one row has a startBlock that is a string', [{ ...CONTRACT_A, startBlock: '5800000' }]],
    ['one row has a startBlock that is a float', [{ ...CONTRACT_A, startBlock: 1.5 }]],
    ['one row has no createdAt', [{ ...CONTRACT_A, createdAt: undefined }]],
    [
      'one row has an indexingStatus outside the three known values',
      [{ ...CONTRACT_A, indexingStatus: 'indexing' }],
    ],
    [
      'one row has an indexingStatus that is a number',
      [{ ...CONTRACT_A, indexingStatus: 2 }],
    ],
    [
      'one row has an indexingStatus that is a server internal',
      [{ ...CONTRACT_A, indexingStatus: 'scanning' }],
    ],
    ['the second row is the bad one', [CONTRACT_A, { ...CONTRACT_B, chainId: '11155111' }]],
  ])('rejects a page where %s', (_name, data) => {
    stubFetch(() => listPayload(data))
    const { client } = contractListClient(() => TOKEN)

    return expectUnexpectedResponse(() => client.listContracts({ page: 1, pageSize: 20 }))
  })

  it.each(['pending', 'disabled', 'unsupported'] as const)(
    'accepts the %s availability value',
    async (status) => {
      stubFetch(() => listPayload([{ ...CONTRACT_A, indexingStatus: status }]))
      const { client } = contractListClient(() => TOKEN)

      const result = await client.listContracts({ page: 1, pageSize: 20 })

      expect(result.contracts[0]?.indexingStatus).toBe(status)
    },
  )

  it.each([
    ['pagination is missing', {}],
    ['pagination is null', { pagination: null }],
    ['pagination is not an object', { pagination: '1' }],
    ['page is a string', { pagination: { ...PAGINATION, page: '1' } }],
    ['page is zero', { pagination: { ...PAGINATION, page: 0 } }],
    ['pageSize is negative', { pagination: { ...PAGINATION, pageSize: -1 } }],
    ['totalPages is a float', { pagination: { ...PAGINATION, totalPages: 1.5 } }],
    ['totalItems is missing', { pagination: { page: 1, pageSize: 20, totalPages: 1 } }],
    ['totalItems is beyond safe integers', { pagination: { ...PAGINATION, totalItems: 2 ** 53 } }],
  ])('rejects a page where %s', (_name, options) => {
    stubFetch(() => listPayload([CONTRACT_A], options))
    const { client } = contractListClient(() => TOKEN)

    return expectUnexpectedResponse(() => client.listContracts({ page: 1, pageSize: 20 }))
  })

  it('rejects a reply that describes a page other than the one requested', async () => {
    stubFetch(() => listPayload([CONTRACT_A], { pagination: PAGINATION }))
    const { client } = contractListClient(() => TOKEN)

    return expectUnexpectedResponse(() => client.listContracts({ page: 3, pageSize: 20 }))
  })

  it('rejects a reply that describes a page size other than the one requested', async () => {
    stubFetch(() => listPayload([CONTRACT_A], { pagination: { ...PAGINATION, pageSize: 50 } }))
    const { client } = contractListClient(() => TOKEN)

    return expectUnexpectedResponse(() => client.listContracts({ page: 1, pageSize: 20 }))
  })

  it('accepts a past-end page, which echoes the requested page and keeps real totals', async () => {
    stubFetch(() =>
      listPayload([], { pagination: { page: 7, pageSize: 20, totalItems: 12, totalPages: 1 } }),
    )
    const { client } = contractListClient(() => TOKEN)

    const result = await client.listContracts({ page: 7, pageSize: 20 })

    expect(result.contracts).toEqual([])
    expect(result.pagination).toEqual({
      page: 7,
      pageSize: 20,
      totalItems: 12,
      totalPages: 1,
    })
  })
})
