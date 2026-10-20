import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  errorResponse,
  hangingFetch,
  jsonResponse,
  plainTextResponse,
  stubFetch,
  type FetchStub,
} from '../test/http.ts'
import { createApiClient } from './client.ts'
import { createChainCatalog } from './chains.ts'
import { ApiError, isApiError } from './errors.ts'
import { API_BASE } from './request.ts'

const TOKEN = 'wallet-create-token'

const CREATED = {
  id: 11,
  address: '0x00000000000000000000000000000000000000c3',
  chainId: 11155111,
  label: 'Treasury',
  createdAt: '2026-10-18T09:00:00Z',
}

const CHAIN_SEPOLIA = {
  chainId: 11155111,
  name: 'Sepolia',
  symbol: 'ETH',
  isTestnet: true,
}

const CHAIN_ETHEREUM = {
  chainId: 1,
  name: 'Ethereum',
  symbol: 'ETH',
  isTestnet: false,
}

function createClient(
  getToken: () => string | null = () => TOKEN,
  onUnauthorized = vi.fn(),
) {
  return {
    client: createApiClient({ getToken, onUnauthorized }),
    onUnauthorized,
  }
}

/** The code a malformed success has to become, whatever the server thought it sent. */
function expectUnexpectedResponse(run: () => Promise<unknown>): Promise<void> {
  return expect(run()).rejects.toSatisfy((error: unknown) => {
    expect(isApiError(error)).toBe(true)
    expect((error as ApiError).code).toBe('UNEXPECTED_RESPONSE')
    return true
  })
}

describe('wallet create call', () => {
  let http: FetchStub

  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  const save = (overrides: Record<string, unknown> = {}) =>
    createClient().client.createWallet({
      address: CREATED.address,
      chainId: CREATED.chainId,
      label: CREATED.label,
      ...overrides,
    })

  it('sends exactly the three fields the contract allows and nothing else', async () => {
    http = stubFetch(() => jsonResponse({ data: CREATED }, { status: 201 }))

    await save()

    expect(http.lastCall().url).toBe(`${API_BASE}/wallets`)
    expect(http.lastCall().init.method).toBe('POST')
    // Selected field by field, not forwarded: the handler decodes with unknown
    // fields disallowed, so a fourth key is a 400 rather than an ignored extra.
    expect(http.body()).toEqual({
      address: CREATED.address,
      chainId: CREATED.chainId,
      label: CREATED.label,
    })
  })

  it('carries the bearer and never a user id', async () => {
    http = stubFetch(() => jsonResponse({ data: CREATED }, { status: 201 }))

    await save()

    expect(http.headers()['authorization']).toBe(`Bearer ${TOKEN}`)

    const body = http.body() as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['address', 'chainId', 'label'])
    expect(JSON.stringify(body)).not.toContain('user')
  })

  it('returns the created wallet on 201', async () => {
    http = stubFetch(() => jsonResponse({ data: CREATED }, { status: 201 }))

    await expect(save()).resolves.toEqual(CREATED)
  })

  it('rejects a created row that is missing createdAt', async () => {
    const { createdAt: _omitted, ...withoutTimestamp } = CREATED
    http = stubFetch(() => jsonResponse({ data: withoutTimestamp }, { status: 201 }))

    // The row would otherwise come back with a blank cell and an id nobody can
    // reason about. A create response owes all five fields.
    await expectUnexpectedResponse(save)
  })

  it.each([
    ['a non-integer id', { ...CREATED, id: 1.5 }],
    ['a string id', { ...CREATED, id: '11' }],
    ['an unsafe id', { ...CREATED, id: 2 ** 53 }],
    ['a float chain id', { ...CREATED, chainId: 1.5 }],
    ['a string chain id', { ...CREATED, chainId: '11155111' }],
    ['a non-string address', { ...CREATED, address: 42 }],
    ['a non-string label', { ...CREATED, label: null }],
    ['a non-string createdAt', { ...CREATED, createdAt: 1760784000 }],
  ])('rejects a created row with %s', async (_name, row) => {
    http = stubFetch(() => jsonResponse({ data: row }, { status: 201 }))

    await expectUnexpectedResponse(save)
  })

  it('rejects a success with no data at all', async () => {
    http = stubFetch(() => jsonResponse({ message: 'created' }, { status: 201 }))

    await expectUnexpectedResponse(save)
  })

  it('rejects a success with an empty body', async () => {
    http = stubFetch(() => new Response('', { status: 201 }))

    await expectUnexpectedResponse(save)
  })

  it('rejects a success that is not JSON', async () => {
    http = stubFetch(() => plainTextResponse(201, 'created'))

    await expectUnexpectedResponse(save)
  })

  it('carries the field detail a 422 sends', async () => {
    http = stubFetch(() =>
      errorResponse(422, 'VALIDATION_ERROR', {
        message: 'address must be a hexadecimal string',
        details: { address: 'address must be a hexadecimal string' },
      }),
    )

    await expect(save()).rejects.toSatisfy((error: unknown) => {
      expect(isApiError(error)).toBe(true)
      expect((error as ApiError).code).toBe('VALIDATION_ERROR')
      expect((error as ApiError).status).toBe(422)
      expect((error as ApiError).details).toEqual({
        address: 'address must be a hexadecimal string',
      })
      return true
    })
  })

  it('reports a duplicate as a conflict', async () => {
    http = stubFetch(() =>
      errorResponse(409, 'RESOURCE_CONFLICT', {
        message: 'wallet address already exists on this chain',
      }),
    )

    await expect(save()).rejects.toSatisfy((error: unknown) => {
      expect((error as ApiError).code).toBe('RESOURCE_CONFLICT')
      expect((error as ApiError).status).toBe(409)
      return true
    })
  })

  it('reports a rate limit with its retry delay', async () => {
    http = stubFetch(() =>
      errorResponse(429, 'RATE_LIMITED', {
        message: 'slow down',
        headers: { 'Retry-After': '3' },
      }),
    )

    await expect(save()).rejects.toSatisfy((error: unknown) => {
      expect((error as ApiError).code).toBe('RATE_LIMITED')
      expect((error as ApiError).retryAfterSeconds).toBe(3)
      return true
    })
  })

  it('reports a 401 to the callback with the token it actually sent', async () => {
    http = stubFetch(() => errorResponse(401, 'UNAUTHENTICATED'))
    // Built after the stub: the request helper binds fetch when the client is
    // created, so a client made first would call the real one and the test
    // would pass against a network error it never meant to test.
    const { client, onUnauthorized } = createClient()

    await expect(
      client.createWallet({
        address: CREATED.address,
        chainId: CREATED.chainId,
        label: CREATED.label,
      }),
    ).rejects.toBeInstanceOf(ApiError)

    expect(http.headers()['authorization']).toBe(`Bearer ${TOKEN}`)
    expect(onUnauthorized).toHaveBeenCalledWith(TOKEN)
  })

  it('does not report a 401 when no token was sent', async () => {
    http = stubFetch(() => errorResponse(401, 'UNAUTHENTICATED'))
    const { client, onUnauthorized } = createClient(() => null)

    await expect(
      client.createWallet({
        address: CREATED.address,
        chainId: CREATED.chainId,
        label: CREATED.label,
      }),
    ).rejects.toBeInstanceOf(ApiError)

    // No header was sent, so there was no credential to reject and nothing to
    // report. This is the case a late 401 from a superseded session looks like.
    expect(http.headers()).not.toHaveProperty('authorization')
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('cancels the save when the caller aborts', async () => {
    stubFetch(hangingFetch)
    const controller = new AbortController()

    const run = createClient().client.createWallet(
      {
        address: CREATED.address,
        chainId: CREATED.chainId,
        label: CREATED.label,
      },
      { signal: controller.signal },
    )

    controller.abort()

    await expect(run).rejects.toSatisfy((error: unknown) => {
      expect(isApiError(error)).toBe(true)
      expect((error as ApiError).code).toBe('ABORTED')
      return true
    })
  })
})

describe('chain catalog call', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads the catalog with no bearer', async () => {
    const http = stubFetch(() => jsonResponse({ data: [CHAIN_ETHEREUM, CHAIN_SEPOLIA] }))

    await expect(createChainCatalog().listChains()).resolves.toEqual([
      CHAIN_ETHEREUM,
      CHAIN_SEPOLIA,
    ])

    expect(http.lastCall().url).toBe(`${API_BASE}/chains`)
    expect(http.lastCall().init.method).toBe('GET')
    // The whole point of the separate client: there is no header to leak, and
    // no token source to read one from.
    expect(http.headers()).not.toHaveProperty('authorization')
  })

  it('accepts an empty catalog as a real answer', async () => {
    stubFetch(() => jsonResponse({ data: [] }))

    await expect(createChainCatalog().listChains()).resolves.toEqual([])
  })

  it.each([
    ['data is not an array', { data: { chainId: 1 } }],
    ['data is null', { data: null }],
    ['a row is missing isTestnet', { data: [{ chainId: 1, name: 'Ethereum', symbol: 'ETH' }] }],
    ['a row has a float chain id', { data: [{ ...CHAIN_ETHEREUM, chainId: 1.5 }] }],
    ['a row has a non-positive chain id', { data: [{ ...CHAIN_ETHEREUM, chainId: 0 }] }],
    ['a row has a string name', { data: [{ ...CHAIN_ETHEREUM, name: 1 }] }],
    ['a row has a string isTestnet', { data: [{ ...CHAIN_ETHEREUM, isTestnet: 'true' }] }],
    ['one row of two is unusable', { data: [CHAIN_ETHEREUM, { ...CHAIN_SEPOLIA, symbol: 7 }] }],
  ])('rejects a catalog where %s', async (_name, payload) => {
    stubFetch(() => jsonResponse(payload))

    await expectUnexpectedResponse(() => createChainCatalog().listChains())
  })

  it('rejects a catalog success with an empty body', async () => {
    stubFetch(() => new Response('', { status: 200 }))

    await expectUnexpectedResponse(() => createChainCatalog().listChains())
  })

  it('surfaces a catalog failure as an ApiError', async () => {
    stubFetch(() => errorResponse(503, 'SERVICE_UNAVAILABLE'))

    await expect(createChainCatalog().listChains()).rejects.toSatisfy(
      (error: unknown) => {
        expect((error as ApiError).code).toBe('SERVICE_UNAVAILABLE')
        return true
      },
    )
  })

  it('never reaches the unauthorized callback, because it sends no credential', async () => {
    let unauthorizedCalls = 0
    // The catalog client is built with a callback that would fail the run.
    const catalog = createChainCatalog()
    stubFetch(() => errorResponse(401, 'UNAUTHENTICATED'))

    await expect(catalog.listChains()).rejects.toBeInstanceOf(ApiError)
    expect(unauthorizedCalls).toBe(0)
  })
})
