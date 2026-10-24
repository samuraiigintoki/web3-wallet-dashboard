import { beforeEach, describe, expect, it, vi } from 'vitest'

import { errorResponse, hangingFetch, jsonResponse, stubFetch, type FetchStub } from '../test/http.ts'
import { createApiClient } from './client.ts'
import { ApiError, isApiError } from './errors.ts'
import { API_BASE } from './request.ts'
import type { Pagination } from './types.ts'

/**
 * The two calls this slice adds: one contract, and one page of its events.
 *
 * The event row is the interesting part. Its `eventName` decides which payload
 * shape it must carry, `valueWei` and `multisigTxIndex` are decimal strings that
 * must survive the round trip character for character, and `data` is hex that
 * must not be reinterpreted.
 */

const TOKEN = 'event-list-token'

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
    data: '0x',
  },
}

const CONFIRM_EVENT = {
  ...SUBMIT_EVENT,
  eventName: 'ConfirmTransaction',
  multisigTxIndex: '1',
  payload: {},
}

const PAGINATION: Pagination = { page: 1, pageSize: 20, totalItems: 2, totalPages: 1 }

function client(getToken: () => string | null = () => null, onUnauthorized = vi.fn()) {
  return { client: createApiClient({ getToken, onUnauthorized }), onUnauthorized }
}

function listPayload(data: unknown, options: { pagination?: unknown } = { pagination: PAGINATION }) {
  return jsonResponse('pagination' in options ? { data, pagination: options.pagination } : { data })
}

function expectUnexpectedResponse(run: () => Promise<unknown>): Promise<void> {
  return expect(run()).rejects.toSatisfy((error: unknown) => {
    expect(isApiError(error)).toBe(true)
    expect((error as ApiError).code).toBe('UNEXPECTED_RESPONSE')
    return true
  })
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

describe('contract context call', () => {
  it('reads one contract by id with the bearer', async () => {
    const fetchStub: FetchStub = stubFetch(() =>
      jsonResponse({
        data: {
          id: 7,
          address: '0x5b324f41e5889cf94cba8e909089683a1a97c318',
          chainId: 11155111,
          label: 'Project multisig',
          enabled: true,
          startBlock: 5_800_000,
          createdAt: '2026-10-01T10:00:00Z',
          indexingStatus: 'pending',
        },
      }),
    )
    const { client: api } = client(() => TOKEN)

    const contract = await api.getContract(7)

    expect(contract.id).toBe(7)
    expect(fetchStub.lastCall().url).toBe(`${API_BASE}/contracts/7`)
    expect(fetchStub.headers()['authorization']).toBe(`Bearer ${TOKEN}`)
    expect(fetchStub.lastCall().init.method).toBe('GET')
  })

  it('reports a foreign or missing contract as the same typed 404', async () => {
    stubFetch(() => errorResponse(404, 'RESOURCE_NOT_FOUND'))
    const { client: api } = client(() => TOKEN)

    await expect(api.getContract(7)).rejects.toSatisfy((error: unknown) => {
      expect((error as ApiError).code).toBe('RESOURCE_NOT_FOUND')
      expect((error as ApiError).status).toBe(404)
      return true
    })
  })

  it('refuses a contract response that describes a different contract', async () => {
    // Well formed, but it is contract 8 answering a request for contract 7. The
    // shape checks pass, so without a correlation check this would become the
    // context for the wrong URL, and the events read after it would be enabled
    // by a successful read of somebody else's record.
    stubFetch(() =>
      jsonResponse({
        data: {
          id: 8,
          address: '0x5b324f41e5889cf94cba8e909089683a1a97c318',
          chainId: 11155111,
          label: 'Another contract',
          enabled: true,
          startBlock: 5_800_000,
          createdAt: '2026-10-01T10:00:00Z',
          indexingStatus: 'pending',
        },
      }),
    )
    const { client: api } = client(() => TOKEN)

    await expectUnexpectedResponse(() => api.getContract(7))
  })

  it('accepts the contract it asked for', async () => {
    stubFetch(() =>
      jsonResponse({
        data: {
          id: 7,
          address: '0x5b324f41e5889cf94cba8e909089683a1a97c318',
          chainId: 11155111,
          label: 'Project multisig',
          enabled: true,
          startBlock: 5_800_000,
          createdAt: '2026-10-01T10:00:00Z',
          indexingStatus: 'pending',
        },
      }),
    )
    const { client: api } = client(() => TOKEN)

    expect((await api.getContract(7)).id).toBe(7)
  })

  it('refuses an id it cannot address rather than building a path from it', async () => {
    const fetchStub = stubFetch(() => jsonResponse({ data: {} }))
    const { client: api } = client(() => TOKEN)

    for (const id of [0, -1, 1.5, Number.NaN, 2 ** 53]) {
      await expect(api.getContract(id)).rejects.toBeInstanceOf(ApiError)
    }

    expect(fetchStub.mock).not.toHaveBeenCalled()
  })
})

describe('event list call', () => {
  it('asks for one page of one contract with the bearer', async () => {
    const fetchStub = stubFetch(() =>
      listPayload([SUBMIT_EVENT, CONFIRM_EVENT], {
        pagination: { page: 3, pageSize: 20, totalItems: 42, totalPages: 3 },
      }),
    )
    const { client: api } = client(() => TOKEN)

    const result = await api.listContractEvents(7, { page: 3, pageSize: 20 })

    expect(result.events).toEqual([SUBMIT_EVENT, CONFIRM_EVENT])
    expect(result.pagination).toEqual({ page: 3, pageSize: 20, totalItems: 42, totalPages: 3 })
    expect(fetchStub.lastCall().url).toBe(`${API_BASE}/contracts/7/events?page=3&pageSize=20`)
    expect(fetchStub.headers()['authorization']).toBe(`Bearer ${TOKEN}`)
    expect(fetchStub.lastCall().init.method).toBe('GET')
  })

  it('sends the contract id in the path and nothing about an owner', async () => {
    const fetchStub = stubFetch(() => listPayload([]))
    const { client: api } = client(() => TOKEN)

    await api.listContractEvents(7, { page: 1, pageSize: 20 })

    const url = fetchStub.lastCall().url.toLowerCase()

    expect(url).not.toContain('user')
    expect(new URL(`https://api.test${fetchStub.lastCall().url}`).searchParams.has('userId')).toBe(false)
    expect(fetchStub.lastCall().init.body).toBeUndefined()
  })

  it('keeps a value and a transaction index far beyond 2^53 exact', async () => {
    const hugeValue = (2n ** 200n).toString(10)
    const longData = `0x${'ab'.repeat(200)}`

    stubFetch(() =>
      listPayload([
        {
          ...SUBMIT_EVENT,
          multisigTxIndex: (2n ** 70n).toString(10),
          payload: { to: SUBMIT_EVENT.payload.to, valueWei: hugeValue, data: longData },
        },
      ]),
    )
    const { client: api } = client(() => TOKEN)

    const result = await api.listContractEvents(7, { page: 1, pageSize: 20 })
    const event = result.events[0]!

    expect(event.multisigTxIndex).toBe((2n ** 70n).toString(10))
    expect(event.payload).toEqual({ to: SUBMIT_EVENT.payload.to, valueWei: hugeValue, data: longData })

    // Character for character: a Number round trip would have changed it.
    const payload = event.payload as { valueWei: string; data: string }
    expect(payload.valueWei).toBe(hugeValue)
    expect(payload.data.length).toBe(longData.length)
  })

  it('refuses a page holding rows for a different contract', async () => {
    // The first row belongs here and the second does not: one foreign row is
    // enough, because drawing it would put another contract's event under this
    // URL.
    stubFetch(() =>
      listPayload([SUBMIT_EVENT, { ...CONFIRM_EVENT, contractId: 8 }], {
        pagination: { page: 1, pageSize: 20, totalItems: 2, totalPages: 1 },
      }),
    )
    const { client: api } = client(() => TOKEN)

    await expectUnexpectedResponse(() => api.listContractEvents(7, { page: 1, pageSize: 20 }))
  })

  it('refuses a page where every row belongs to a different contract', async () => {
    stubFetch(() =>
      listPayload([{ ...SUBMIT_EVENT, contractId: 8 }], {
        pagination: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 },
      }),
    )
    const { client: api } = client(() => TOKEN)

    await expectUnexpectedResponse(() => api.listContractEvents(7, { page: 1, pageSize: 20 }))
  })

  it('honours the caller abort through the same helper as every other call', async () => {
    stubFetch(hangingFetch)

    const controller = new AbortController()
    const { client: api } = client(() => TOKEN)
    const pending = api.listContractEvents(7, { page: 1, pageSize: 20 }, { signal: controller.signal })
    const settled = pending.catch((error: unknown) => error)
    controller.abort()

    expect(await settled).toMatchObject({ code: 'ABORTED', status: 0 })
  })

  it('makes no write call of any kind', async () => {
    const fetchStub = stubFetch((url: string) => {
      if (url.includes('/events')) {
        return listPayload([SUBMIT_EVENT])
      }

      return jsonResponse({
        data: {
          id: 7,
          address: '0x5b324f41e5889cf94cba8e909089683a1a97c318',
          chainId: 11155111,
          label: 'Project multisig',
          enabled: true,
          startBlock: 5_800_000,
          createdAt: '2026-10-01T10:00:00Z',
          indexingStatus: 'pending',
        },
      })
    })
    const { client: api } = client(() => TOKEN)

    await api.getContract(7)
    await api.listContractEvents(7, { page: 1, pageSize: 20 })

    expect(fetchStub.calls.map((call) => call.init.method ?? 'GET')).toEqual(['GET', 'GET'])
  })
})

describe('event response validation', () => {
  it.each([
    ['data is not an array', { 0: SUBMIT_EVENT }],
    ['an unknown event name', [{ ...SUBMIT_EVENT, eventName: 'Transfer' }]],
    ['an event name that is not a string', [{ ...SUBMIT_EVENT, eventName: 4 }]],
    ['a missing actor', [{ ...SUBMIT_EVENT, actorAddress: undefined }]],
    ['an actor that is not an address', [{ ...SUBMIT_EVENT, actorAddress: '0x123' }]],
    ['a multisig index sent as a number', [{ ...SUBMIT_EVENT, multisigTxIndex: 0 }]],
    ['a multisig index that is not decimal', [{ ...SUBMIT_EVENT, multisigTxIndex: '0x1' }]],
    ['a block number sent as a string', [{ ...SUBMIT_EVENT, blockNumber: '6100000' }]],
    ['a block hash that is too short', [{ ...SUBMIT_EVENT, blockHash: '0xabc' }]],
    ['a transaction hash that is missing', [{ ...SUBMIT_EVENT, transactionHash: undefined }]],
    ['a log index that is a float', [{ ...SUBMIT_EVENT, logIndex: 1.5 }]],
    ['a contract id of zero', [{ ...SUBMIT_EVENT, contractId: 0 }]],
    ['the second row is the bad one', [SUBMIT_EVENT, { ...CONFIRM_EVENT, eventName: 'Nope' }]],
  ])('rejects a page where %s', (_name, data) => {
    stubFetch(() => listPayload(data))
    const { client: api } = client(() => TOKEN)

    return expectUnexpectedResponse(() => api.listContractEvents(7, { page: 1, pageSize: 20 }))
  })

  it.each([
    ['the payload is missing', [{ ...SUBMIT_EVENT, payload: undefined }]],
    ['the payload has no destination', [{ ...SUBMIT_EVENT, payload: { valueWei: '1', data: '0x' } }]],
    ['the destination is not an address', [{ ...SUBMIT_EVENT, payload: { to: '0xzz', valueWei: '1', data: '0x' } }]],
    ['the value is a number', [{ ...SUBMIT_EVENT, payload: { ...SUBMIT_EVENT.payload, valueWei: 1 } }]],
    ['the value is negative', [{ ...SUBMIT_EVENT, payload: { ...SUBMIT_EVENT.payload, valueWei: '-1' } }]],
    ['the value has a decimal point', [{ ...SUBMIT_EVENT, payload: { ...SUBMIT_EVENT.payload, valueWei: '1.5' } }]],
    ['the data is not hex', [{ ...SUBMIT_EVENT, payload: { ...SUBMIT_EVENT.payload, data: 'deadbeef' } }]],
    ['the data has an odd length', [{ ...SUBMIT_EVENT, payload: { ...SUBMIT_EVENT.payload, data: '0xabc' } }]],
    ['the payload carries an extra key', [{ ...SUBMIT_EVENT, payload: { ...SUBMIT_EVENT.payload, chainId: 1 } }]],
    ['the payload is an array', [{ ...SUBMIT_EVENT, payload: [] }]],
  ])('rejects a SubmitTransaction row where %s', (_name, data) => {
    stubFetch(() => listPayload(data))
    const { client: api } = client(() => TOKEN)

    return expectUnexpectedResponse(() => api.listContractEvents(7, { page: 1, pageSize: 20 }))
  })

  it.each([
    ['an owner event carries a payload', [{ ...CONFIRM_EVENT, payload: SUBMIT_EVENT.payload }]],
    ['an owner event carries an unrelated key', [{ ...CONFIRM_EVENT, payload: { note: 'x' } }]],
    ['an owner event has no payload at all', [{ ...CONFIRM_EVENT, payload: undefined }]],
  ])('rejects a page where %s', (_name, data) => {
    stubFetch(() => listPayload(data))
    const { client: api } = client(() => TOKEN)

    return expectUnexpectedResponse(() => api.listContractEvents(7, { page: 1, pageSize: 20 }))
  })

  it('accepts each of the four event names with the payload its shape requires', async () => {
    const ownerEvents = ['ConfirmTransaction', 'RevokeConfirmation', 'ExecuteTransaction'].map(
      (eventName) => ({ ...CONFIRM_EVENT, eventName }),
    )

    stubFetch(() => listPayload([SUBMIT_EVENT, ...ownerEvents]))
    const { client: api } = client(() => TOKEN)

    const result = await api.listContractEvents(7, { page: 1, pageSize: 20 })

    expect(result.events.map((event) => event.eventName)).toEqual([
      'SubmitTransaction',
      'ConfirmTransaction',
      'RevokeConfirmation',
      'ExecuteTransaction',
    ])
  })

  it.each([
    ['pagination is missing', {}],
    ['pagination is null', { pagination: null }],
    ['page is zero', { pagination: { ...PAGINATION, page: 0 } }],
    ['pageSize is over the ceiling', { pagination: { ...PAGINATION, pageSize: 1000 } }],
    ['totalItems is a float', { pagination: { ...PAGINATION, totalItems: 1.5 } }],
    ['totalPages is negative', { pagination: { ...PAGINATION, totalPages: -1 } }],
    ['totalItems is beyond safe integers', { pagination: { ...PAGINATION, totalItems: 2 ** 53 } }],
  ])('rejects a page where %s', (_name, options) => {
    stubFetch(() => listPayload([SUBMIT_EVENT], options))
    const { client: api } = client(() => TOKEN)

    return expectUnexpectedResponse(() => api.listContractEvents(7, { page: 1, pageSize: 20 }))
  })

  it('rejects a reply describing another page or page size', async () => {
    stubFetch(() => listPayload([SUBMIT_EVENT], { pagination: PAGINATION }))
    const { client: api } = client(() => TOKEN)

    await expectUnexpectedResponse(() => api.listContractEvents(7, { page: 4, pageSize: 20 }))

    stubFetch(() => listPayload([SUBMIT_EVENT], { pagination: { ...PAGINATION, pageSize: 50 } }))
    const second = client(() => TOKEN)

    await expectUnexpectedResponse(() => second.client.listContractEvents(7, { page: 1, pageSize: 20 }))
  })

  it('accepts a past-end page, which echoes the request and keeps the real totals', async () => {
    stubFetch(() =>
      listPayload([], { pagination: { page: 9, pageSize: 20, totalItems: 15, totalPages: 1 } }),
    )
    const { client: api } = client(() => TOKEN)

    const result = await api.listContractEvents(7, { page: 9, pageSize: 20 })

    expect(result.events).toEqual([])
    expect(result.pagination).toEqual({ page: 9, pageSize: 20, totalItems: 15, totalPages: 1 })
  })
})
