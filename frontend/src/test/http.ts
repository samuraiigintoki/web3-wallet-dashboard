import { vi } from 'vitest'

export type FetchCall = {
  url: string
  init: RequestInit
}

export type FetchStub = {
  mock: ReturnType<typeof vi.fn>
  calls: FetchCall[]
  lastCall: () => FetchCall
  headers: () => Record<string, string>
  body: () => unknown
}

/**
 * Installs a stub on the global fetch and records what was sent. The seam is
 * the global on purpose: it is the one the application actually uses, so a
 * test cannot pass against a seam production code never touches.
 */
export function stubFetch(
  responder: (url: string, init: RequestInit) => Promise<Response> | Response,
): FetchStub {
  const calls: FetchCall[] = []

  const mock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init: init ?? {} })
    return await responder(url, init ?? {})
  })

  vi.stubGlobal('fetch', mock)

  const lastCall = (): FetchCall => {
    const call = calls.at(-1)
    if (call === undefined) {
      throw new Error('fetch was never called')
    }
    return call
  }

  return {
    mock,
    calls,
    lastCall,
    headers: () => normaliseHeaders(lastCall().init.headers),
    body: () => {
      const raw = lastCall().init.body
      return typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw
    },
  }
}

function normaliseHeaders(headers: HeadersInit | undefined): Record<string, string> {
  if (headers === undefined) {
    return {}
  }

  const result: Record<string, string> = {}
  new Headers(headers).forEach((value, key) => {
    result[key] = value
  })

  return result
}

export function jsonResponse(
  payload: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const headers = new Headers({ 'Content-Type': 'application/json' })
  for (const [key, value] of Object.entries(init.headers ?? {})) {
    headers.set(key, value)
  }

  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers,
  })
}

export function errorResponse(
  status: number,
  code: string,
  options: {
    message?: string
    details?: Record<string, string>
    headers?: Record<string, string>
  } = {},
): Response {
  return jsonResponse(
    {
      error: {
        code,
        message: options.message ?? 'failed',
        ...(options.details === undefined ? {} : { details: options.details }),
      },
    },
    { status, headers: options.headers },
  )
}

/** What the Go mux sends for an unmatched path or a method mismatch. */
export function plainTextResponse(status: number, text: string): Response {
  return new Response(text, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}

/** What the Vite dev proxy sends when the API is not running. */
export function emptyProxyFailure(): Response {
  return new Response('', {
    status: 502,
    headers: { 'Content-Type': 'text/plain' },
  })
}

/** A fetch that never settles until the request is aborted. */
export function hangingFetch(_url: string, init: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => {
      reject(new DOMException('The operation was aborted.', 'AbortError'))
    })
  })
}
