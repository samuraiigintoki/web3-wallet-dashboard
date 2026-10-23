import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  errorResponse,
  jsonResponse,
  plainTextResponse,
  stubFetch,
  type FetchStub,
} from '../test/http.ts'
import { createApiClient } from './client.ts'
import { ApiError, isApiError } from './errors.ts'
import { API_BASE } from './request.ts'

const TOKEN = 'wallet-label-token'

const UPDATED = {
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

/** The code a malformed or wrong-target success has to become. */
function expectUnexpectedResponse(run: () => Promise<unknown>): Promise<void> {
  return expect(run()).rejects.toSatisfy((error: unknown) => {
    expect(isApiError(error)).toBe(true)
    expect((error as ApiError).code).toBe('UNEXPECTED_RESPONSE')
    return true
  })
}

describe('wallet label update call', () => {
  let http: FetchStub

  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends one field with PATCH to the addressed wallet and returns the row', async () => {
    http = stubFetch(() => jsonResponse({ data: UPDATED }))
    const { client } = createClient()

    const wallet = await client.updateWalletLabel(11, { label: 'Treasury ops' })

    expect(wallet).toEqual(UPDATED)
    expect(http.calls).toHaveLength(1)
    expect(http.lastCall().url).toBe(`${API_BASE}/wallets/11`)
    expect(http.lastCall().init.method).toBe('PATCH')
    expect(http.body()).toEqual({ label: 'Treasury ops' })
    // The owner is the bearer, so no user id and no second identity field.
    expect(http.headers()['authorization']).toBe(`Bearer ${TOKEN}`)
    expect(http.headers()['content-type']).toBe('application/json')
  })

  it('sends exactly one key even when the caller hands over more', async () => {
    http = stubFetch(() => jsonResponse({ data: UPDATED }))
    const { client } = createClient()

    // The handler rejects unknown fields, so a caller that forwards its whole
    // row must still produce a one-key body.
    await client.updateWalletLabel(11, {
      label: 'Treasury ops',
      id: 11,
      address: UPDATED.address,
      chainId: UPDATED.chainId,
      createdAt: UPDATED.createdAt,
    } as unknown as { label: string })

    expect(http.body()).toEqual({ label: 'Treasury ops' })
  })

  it('omits the bearer when there is no token, and reports no unauthorized call', async () => {
    http = stubFetch(() => errorResponse(401, 'UNAUTHENTICATED'))
    const { client, onUnauthorized } = createClient(() => null)

    await expect(client.updateWalletLabel(11, { label: 'x' })).rejects.toBeInstanceOf(
      ApiError,
    )

    expect(http.headers()['authorization']).toBeUndefined()
    // A call that carried nothing to reject cannot have had a session ended.
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('reports a current-identity 401 with the token that was actually sent', async () => {
    stubFetch(() => errorResponse(401, 'UNAUTHENTICATED'))
    const { client, onUnauthorized } = createClient()

    await expect(client.updateWalletLabel(11, { label: 'x' })).rejects.toBeInstanceOf(
      ApiError,
    )

    expect(onUnauthorized).toHaveBeenCalledWith(TOKEN)
  })

  it.each([
    [
      'a row without createdAt',
      { id: 11, address: UPDATED.address, chainId: UPDATED.chainId, label: 'x' },
    ],
    [
      'a row with a string chain id',
      { ...UPDATED, chainId: '11155111' },
    ],
    ['a row with a float id', { ...UPDATED, id: 11.5 }],
    ['a row that is not an object', 'ok'],
  ])('rejects %s', async (_name, payload) => {
    http = stubFetch(() => jsonResponse({ data: payload }))
    const { client } = createClient()

    await expectUnexpectedResponse(() =>
      client.updateWalletLabel(11, { label: 'x' }),
    )
  })

  it('rejects a success that describes a different wallet', async () => {
    // The write may have landed on 11, but this response is about 12 and cannot
    // be used to describe row 11.
    http = stubFetch(() => jsonResponse({ data: { ...UPDATED, id: 12 } }))
    const { client } = createClient()

    await expectUnexpectedResponse(() =>
      client.updateWalletLabel(11, { label: 'x' }),
    )
  })

  it('rejects an empty and a malformed success body', async () => {
    http = stubFetch(() => new Response('', { status: 200 }))
    const { client } = createClient()

    await expectUnexpectedResponse(() =>
      client.updateWalletLabel(11, { label: 'x' }),
    )

    vi.unstubAllGlobals()
    stubFetch(
      () =>
        new Response('{"data":', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    )

    await expectUnexpectedResponse(() =>
      client.updateWalletLabel(11, { label: 'x' }),
    )
  })

  it.each([
    ['zero', 0],
    ['negative', -3],
    ['a float', 1.5],
    ['beyond the safe integer range', Number.MAX_SAFE_INTEGER + 2],
    ['not a number', Number.NaN],
  ])('refuses to address a wallet id that is %s', async (_name, id) => {
    http = stubFetch(() => jsonResponse({ data: UPDATED }))
    const { client } = createClient()

    await expectUnexpectedResponse(() => client.updateWalletLabel(id, { label: 'x' }))
    // No request was made with an id the client cannot address.
    expect(http.calls).toHaveLength(0)
  })

  it('surfaces a 404 with its code and request id', async () => {
    stubFetch(() =>
      errorResponse(404, 'RESOURCE_NOT_FOUND', {
        message: 'wallet not found',
        headers: { 'X-Request-ID': 'req-404' },
      }),
    )
    const { client } = createClient()

    await expect(client.updateWalletLabel(11, { label: 'x' })).rejects.toSatisfy(
      (error: unknown) => {
        expect((error as ApiError).code).toBe('RESOURCE_NOT_FOUND')
        expect((error as ApiError).status).toBe(404)
        expect((error as ApiError).requestId).toBe('req-404')
        return true
      },
    )
  })

  it('keeps a 422 detail keyed by label', async () => {
    stubFetch(() =>
      errorResponse(422, 'VALIDATION_ERROR', {
        message: 'label must not be empty',
        details: { label: 'label must not be empty' },
      }),
    )
    const { client } = createClient()

    await expect(client.updateWalletLabel(11, { label: ' ' })).rejects.toSatisfy(
      (error: unknown) => {
        expect((error as ApiError).status).toBe(422)
        expect((error as ApiError).details).toEqual({
          label: 'label must not be empty',
        })
        return true
      },
    )
  })

  it('keeps the retry delay a rate limit sent', async () => {
    stubFetch(() => errorResponse(429, 'RATE_LIMITED', { headers: { 'Retry-After': '7' } }))
    const { client } = createClient()

    await expect(client.updateWalletLabel(11, { label: 'x' })).rejects.toSatisfy(
      (error: unknown) => {
        expect((error as ApiError).code).toBe('RATE_LIMITED')
        expect((error as ApiError).retryAfterSeconds).toBe(7)
        return true
      },
    )
  })

  it('keeps the request id on a success that names another wallet', async () => {
    stubFetch(() => jsonResponse(UPDATED, { headers: { 'X-Request-ID': 'req-wrong-target-1' } }))
    const { client } = createClient()

    await expect(client.updateWalletLabel(999, { label: 'x' })).rejects.toSatisfy(
      (error: unknown) => {
        // The target check is unchanged: another wallet's body is still refused
        // rather than written into the row that was opened.
        expect(isApiError(error)).toBe(true)
        expect((error as ApiError).code).toBe('UNEXPECTED_RESPONSE')
        expect((error as ApiError).status).toBe(200)
        // The id is the only thing that lets this be reported and found again.
        expect((error as ApiError).requestId).toBe('req-wrong-target-1')
        return true
      },
    )
  })

  it('reports an unreadable gateway answer with the status it came with', async () => {
    stubFetch(() => plainTextResponse(502, 'Bad Gateway'))
    const { client } = createClient()

    await expect(client.updateWalletLabel(11, { label: 'x' })).rejects.toSatisfy(
      (error: unknown) => {
        expect((error as ApiError).code).toBe('UNEXPECTED_RESPONSE')
        expect((error as ApiError).status).toBe(502)
        return true
      },
    )
  })
})
