import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  emptyResponse,
  errorResponse,
  jsonResponse,
  plainTextResponse,
  stubFetch,
  type FetchStub,
} from '../test/http.ts'
import { createApiClient } from './client.ts'
import { ApiError, isApiError } from './errors.ts'
import { API_BASE } from './request.ts'

const TOKEN = 'wallet-delete-token'

const WALLET = {
  id: 11,
  address: '0x00000000000000000000000000000000000000c3',
  chainId: 11155111,
  label: 'Treasury ops',
  createdAt: '2026-10-18T09:00:00Z',
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

/** The code anything other than the contract's own answer has to become. */
function expectUnexpectedResponse(
  run: () => Promise<unknown>,
  status?: number,
): Promise<void> {
  return expect(run()).rejects.toSatisfy((error: unknown) => {
    expect(isApiError(error)).toBe(true)
    expect((error as ApiError).code).toBe('UNEXPECTED_RESPONSE')
    if (status !== undefined) {
      expect((error as ApiError).status).toBe(status)
    }
    return true
  })
}

describe('wallet delete call', () => {
  let http: FetchStub

  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends DELETE to the addressed wallet with no body and no user id', async () => {
    http = stubFetch(() => emptyResponse(204))
    const { client } = createClient()

    await client.deleteWallet(11)

    expect(http.calls).toHaveLength(1)
    expect(http.lastCall().url).toBe(`${API_BASE}/wallets/11`)
    expect(http.lastCall().init.method).toBe('DELETE')
    // No body at all: the route takes the id from the path, and a user id in
    // the body would be a claim the API does not accept.
    expect(http.lastCall().init.body).toBeUndefined()
    expect(new Headers(http.lastCall().init.headers).get('authorization')).toBe(
      `Bearer ${TOKEN}`,
    )
  })

  it.each([
    ['an empty 200', 200],
    ['an empty 202', 202],
    ['an empty 201', 201],
  ])('refuses %s as a confirmation and keeps its status', async (_name, status) => {
    stubFetch(() => emptyResponse(status))
    const { client } = createClient()

    // Only 204 is the contract's confirmation. An empty body on any other
    // success status is an answer this client cannot read as a removal, and it
    // keeps the real status so the caller can treat it as unknown.
    await expectUnexpectedResponse(() => client.deleteWallet(11), status)
  })

  it('refuses a success that carries a wallet body', async () => {
    stubFetch(() => jsonResponse({ data: WALLET }))
    const { client } = createClient()

    await expectUnexpectedResponse(() => client.deleteWallet(11), 200)
  })

  it.each([
    ['zero', 0],
    ['negative', -3],
    ['fractional', 1.5],
    ['not a number', Number.NaN],
    ['beyond the safe range', Number.MAX_SAFE_INTEGER + 2],
  ])('refuses to address a wallet id that is %s', async (_name, id) => {
    http = stubFetch(() => emptyResponse(204))
    const { client } = createClient()

    await expectUnexpectedResponse(() => client.deleteWallet(id))
    // Nothing was sent: an unusable id never becomes a URL.
    expect(http.calls).toHaveLength(0)
  })

  it('reports a repeated or unknown id as the typed not-found', async () => {
    stubFetch(() => errorResponse(404, 'RESOURCE_NOT_FOUND', { message: 'wallet not found' }))
    const { client } = createClient()

    await expect(client.deleteWallet(11)).rejects.toSatisfy((error: unknown) => {
      expect((error as ApiError).code).toBe('RESOURCE_NOT_FOUND')
      expect((error as ApiError).status).toBe(404)
      return true
    })
  })

  it('keeps an opaque 404 unreadable rather than calling it not-found', async () => {
    // What a proxy answers when the route is not matched. It is not the API's
    // typed answer, so the caller cannot treat it as "already unavailable".
    stubFetch(() => plainTextResponse(404, '404 page not found'))
    const { client } = createClient()

    await expect(client.deleteWallet(11)).rejects.toSatisfy((error: unknown) => {
      expect((error as ApiError).code).toBe('UNEXPECTED_RESPONSE')
      expect((error as ApiError).status).toBe(404)
      return true
    })
  })

  it('keeps the retry delay a rate limit sent', async () => {
    stubFetch(() => errorResponse(429, 'RATE_LIMITED', { headers: { 'Retry-After': '5' } }))
    const { client } = createClient()

    await expect(client.deleteWallet(11)).rejects.toSatisfy((error: unknown) => {
      expect((error as ApiError).code).toBe('RATE_LIMITED')
      expect((error as ApiError).retryAfterSeconds).toBe(5)
      return true
    })
  })

  it('reports an unreadable gateway answer with the status it came with', async () => {
    stubFetch(() => plainTextResponse(502, 'Bad Gateway'))
    const { client } = createClient()

    await expect(client.deleteWallet(11)).rejects.toSatisfy((error: unknown) => {
      expect((error as ApiError).code).toBe('UNEXPECTED_RESPONSE')
      expect((error as ApiError).status).toBe(502)
      return true
    })
  })

  it('sends no token when there is none to send', async () => {
    http = stubFetch(() => emptyResponse(204))
    const { client } = createClient(() => null)

    await client.deleteWallet(11)

    expect(new Headers(http.lastCall().init.headers).get('authorization')).toBeNull()
  })
})

describe('single wallet read', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads one wallet by id with the stored credential', async () => {
    const http = stubFetch(() => jsonResponse({ data: WALLET }))
    const { client } = createClient()

    const wallet = await client.getWallet(11)

    expect(wallet).toEqual(WALLET)
    expect(http.lastCall().url).toBe(`${API_BASE}/wallets/11`)
    expect(http.lastCall().init.method).toBe('GET')
    expect(http.lastCall().init.body).toBeUndefined()
    expect(new Headers(http.lastCall().init.headers).get('authorization')).toBe(
      `Bearer ${TOKEN}`,
    )
  })

  it.each([
    ['createdAt', { ...WALLET, createdAt: undefined }],
    ['label', { id: WALLET.id, address: WALLET.address, chainId: WALLET.chainId, createdAt: WALLET.createdAt }],
    ['address', { ...WALLET, address: undefined }],
  ])('refuses a row without %s', async (_field, row) => {
    stubFetch(() => jsonResponse({ data: row }))
    const { client } = createClient()

    await expectUnexpectedResponse(() => client.getWallet(11))
  })

  it('refuses a read that describes another record', async () => {
    stubFetch(() =>
      jsonResponse({ data: { ...WALLET, id: 12 } }, { headers: { 'X-Request-ID': 'req-read-1' } }),
    )
    const { client } = createClient()

    await expect(client.getWallet(11)).rejects.toSatisfy((error: unknown) => {
      expect((error as ApiError).code).toBe('UNEXPECTED_RESPONSE')
      // The id is preserved so the response can be reported and found again.
      expect((error as ApiError).requestId).toBe('req-read-1')
      return true
    })
  })

  it('reads a typed 404 as the resource not being found', async () => {
    stubFetch(() => errorResponse(404, 'RESOURCE_NOT_FOUND', { message: 'wallet not found' }))
    const { client } = createClient()

    await expect(client.getWallet(11)).rejects.toSatisfy((error: unknown) => {
      expect((error as ApiError).code).toBe('RESOURCE_NOT_FOUND')
      return true
    })
  })

  it('leaves an opaque 404 unreadable', async () => {
    stubFetch(() => plainTextResponse(404, 'Not Found'))
    const { client } = createClient()

    await expect(client.getWallet(11)).rejects.toSatisfy((error: unknown) => {
      expect((error as ApiError).code).toBe('UNEXPECTED_RESPONSE')
      expect((error as ApiError).status).toBe(404)
      return true
    })
  })

  it('refuses an unusable id without sending anything', async () => {
    const http = stubFetch(() => jsonResponse({ data: WALLET }))
    const { client } = createClient()

    await expectUnexpectedResponse(() => client.getWallet(-1))
    expect(http.calls).toHaveLength(0)
  })

  it('reports a rejected credential to the session that sent it', async () => {
    stubFetch(() => errorResponse(401, 'UNAUTHENTICATED'))
    const { client, onUnauthorized } = createClient()

    await expect(client.getWallet(11)).rejects.toBeInstanceOf(ApiError)
    expect(onUnauthorized).toHaveBeenCalledWith(TOKEN)
  })
})
