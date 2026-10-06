import { beforeEach, describe, expect, it, vi } from 'vitest'

import { errorResponse, hangingFetch, jsonResponse, stubFetch } from '../test/http.ts'
import { createApiClient } from './client.ts'
import { API_BASE } from './request.ts'
import type { LoginRequest, RegisterRequest } from './types.ts'

const TOKEN = 'client-session-token'

const USER = { id: 3, email: 'grace@example.com', createdAt: '2026-10-06T09:00:00Z' }

function client(getToken: () => string | null = () => null, onUnauthorized = vi.fn()) {
  return createApiClient({ getToken, onUnauthorized })
}

describe('api client', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('register posts to the register route and returns the created user', async () => {
    const fetchStub = stubFetch(() => jsonResponse({ data: USER }, { status: 201 }))

    const user = await client().register({
      email: 'grace@example.com',
      password: 'correct horse battery staple',
    })

    expect(user).toEqual(USER)
    expect(fetchStub.lastCall().url).toBe(`${API_BASE}/auth/register`)
    expect(fetchStub.lastCall().init.method).toBe('POST')
    expect(fetchStub.body()).toEqual({
      email: 'grace@example.com',
      password: 'correct horse battery staple',
    })
  })

  it('login returns only the token pair, which is why identity needs a second call', async () => {
    stubFetch(() =>
      jsonResponse({ data: { token: 'issued-token', expiresAt: '2026-10-13T09:00:00Z' } }),
    )

    const result = await client().login({ email: 'grace@example.com', password: 'pw' })

    expect(result).toEqual({ token: 'issued-token', expiresAt: '2026-10-13T09:00:00Z' })
    expect(result).not.toHaveProperty('id')
    expect(result).not.toHaveProperty('email')
  })

  it('login rejects a response with no token', async () => {
    stubFetch(() => jsonResponse({ data: { expiresAt: '2026-10-13T09:00:00Z' } }))

    await expect(
      client().login({ email: 'grace@example.com', password: 'pw' }),
    ).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' })
  })

  it('getMe sends the bearer header and returns the user', async () => {
    const fetchStub = stubFetch(() => jsonResponse({ data: USER }))

    const user = await client(() => TOKEN).getMe()

    expect(user).toEqual(USER)
    const headers = fetchStub.lastCall().init.headers as Record<string, string>
    expect(headers['Authorization']).toBe(`Bearer ${TOKEN}`)
  })

  it('logout sends the bearer header and accepts the message body', async () => {
    const fetchStub = stubFetch(() => jsonResponse({ data: { message: 'logged out' } }))

    const result = await client(() => TOKEN).logout()

    expect(result).toEqual({ message: 'logged out' })
    expect(fetchStub.lastCall().url).toBe(`${API_BASE}/auth/logout`)
    const headers = fetchStub.lastCall().init.headers as Record<string, string>
    expect(headers['Authorization']).toBe(`Bearer ${TOKEN}`)
  })

  it('logout accepts an empty body as success', async () => {
    stubFetch(() => new Response(null, { status: 204 }))

    await expect(client(() => TOKEN).logout()).resolves.toBeNull()
  })

  it('logout surfaces the 401 the server sends for a malformed header', async () => {
    stubFetch(() => errorResponse(401, 'UNAUTHENTICATED'))

    await expect(client(() => TOKEN).logout()).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
      status: 401,
    })
  })

  it('register never carries a bearer header even when a token is stored', async () => {
    const fetchStub = stubFetch(() => jsonResponse({ data: USER }, { status: 201 }))

    await client(() => TOKEN).register({ email: 'grace@example.com', password: 'pw' })

    expect(fetchStub.headers()['authorization']).toBeUndefined()
  })

  it('login never carries a bearer header even when a token is stored', async () => {
    const fetchStub = stubFetch(() =>
      jsonResponse({ data: { token: 't', expiresAt: '2026-10-13T09:00:00Z' } }),
    )

    await client(() => TOKEN).login({ email: 'grace@example.com', password: 'pw' })

    expect(fetchStub.headers()['authorization']).toBeUndefined()
  })

  it('register sends only the two contract fields, whatever the caller hands over', async () => {
    const fetchStub = stubFetch(() => jsonResponse({ data: USER }, { status: 201 }))
    // What a form object looks like before anyone thinks about the wire. The
    // server rejects unknown keys, so confirmPassword must not travel.
    const formValues = {
      email: 'grace@example.com',
      password: 'pw',
      confirmPassword: 'pw',
    } as unknown as RegisterRequest

    await client().register(formValues)

    expect(fetchStub.body()).toEqual({ email: 'grace@example.com', password: 'pw' })
  })

  it('login sends only the two contract fields, whatever the caller hands over', async () => {
    const fetchStub = stubFetch(() =>
      jsonResponse({ data: { token: 't', expiresAt: '2026-10-13T09:00:00Z' } }),
    )
    const formValues = {
      email: 'grace@example.com',
      password: 'pw',
      remember: true,
    } as unknown as LoginRequest

    await client().login(formValues)

    expect(fetchStub.body()).toEqual({ email: 'grace@example.com', password: 'pw' })
  })

  it('cancels the call when the caller aborts their signal', async () => {
    stubFetch(hangingFetch)

    const controller = new AbortController()
    const pending = client(() => TOKEN).getMe({ signal: controller.signal })
    const settled = pending.catch((error: unknown) => error)
    controller.abort()

    expect(await settled).toMatchObject({ code: 'ABORTED', status: 0 })
  })
})
