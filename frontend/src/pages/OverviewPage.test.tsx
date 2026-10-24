import { screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { jsonResponse, stubFetch } from '../test/http.ts'
import { memoryStorage, renderApp } from '../test/renderApp.tsx'

/**
 * The Overview copy.
 *
 * This screen used to say that contract and indexed event views were not built.
 * They are, and it now also holds the entry point to the one write in the app,
 * so the sentence is checked rather than left to drift: a stale line here tells a
 * user the product is less finished than it is, which is the same class of wrong
 * as claiming more than it does.
 */

const USER = { id: 5, email: 'ada@example.com', createdAt: '2026-10-06T12:00:00Z' }

beforeEach(() => {
  vi.unstubAllGlobals()
  stubFetch((url) => {
    if (url.includes('/chains')) {
      return jsonResponse({ data: [] })
    }

    return jsonResponse({ data: USER })
  })
})

describe('the overview', () => {
  it('no longer claims the contract and event views are unbuilt', async () => {
    renderApp({ path: '/', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Overview' })).toBeDefined()
    })

    const text = screen.getByRole('main').textContent ?? ''

    expect(text).not.toContain('not built yet')
    expect(text).toContain('Contracts')
  })

  it('still separates the browser wallet from the signed-in account', async () => {
    renderApp({ path: '/', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Browser wallet' })).toBeDefined()
    })

    const text = screen.getByRole('main').textContent ?? ''

    expect(text).toContain('separate from signing in to this dashboard')
  })
})
