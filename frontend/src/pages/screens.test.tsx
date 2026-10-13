import { screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { jsonResponse, stubFetch } from '../test/http.ts'
import { memoryStorage, renderApp } from '../test/renderApp.tsx'
import { AUTH_FACTS } from '../ui/authFacts.ts'

const USER = { id: 5, email: 'ada@example.com', createdAt: '2026-10-06T12:00:00Z' }

describe('the frame', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows three labelled destinations and marks the one that is open', async () => {
    stubFetch(() => jsonResponse({ data: USER }))
    renderApp({ path: '/contracts', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Contracts' })).toBeDefined()
    })

    const nav = screen.getByRole('navigation', { name: 'Sections' })
    const links = Array.from(nav.querySelectorAll('a'))
    expect(links.map((link) => link.textContent)).toEqual(['Overview', 'Contracts', 'Wallets'])

    // The open destination is marked on the element that is actually open, and
    // the label is never carried by a shape alone.
    expect(links.map((link) => link.getAttribute('aria-current'))).toEqual([
      null,
      'page',
      null,
    ])
  })

  it('keeps the destination labels readable as text, with no icon-only control', async () => {
    stubFetch(() => jsonResponse({ data: USER }))
    renderApp({ path: '/', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Overview' })).toBeDefined()
    })

    const nav = screen.getByRole('navigation', { name: 'Sections' })
    expect(nav.querySelectorAll('svg, img')).toHaveLength(0)
    for (const label of ['Overview', 'Contracts', 'Wallets']) {
      expect(screen.getByRole('link', { name: label })).toBeDefined()
    }
  })
})

describe('the composed auth page', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('puts the form before the facts, and the facts in order', async () => {
    stubFetch(() => jsonResponse({ data: USER }))
    renderApp({ path: '/login' })

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Sign in to read the record.' })).toBeDefined()
    })

    const form = document.querySelector('form')
    const facts = screen.getByRole('list', { name: '' })
    expect(form).not.toBeNull()
    expect(facts).not.toBeNull()

    // The order is the composition: the form is reachable before anything has
    // to be read.
    const position = form!.compareDocumentPosition(facts!)
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    const items = Array.from(facts!.querySelectorAll('li')).map((item) => item.textContent)
    expect(items).toEqual([...AUTH_FACTS])
    expect(screen.getByRole('heading', { name: 'How this works' })).toBeDefined()
  })

  it('names the screen twice, on purpose, and offers the way to register', async () => {
    stubFetch(() => jsonResponse({ data: USER }))
    renderApp({ path: '/register' })

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'Create an account to read the record.' }),
      ).toBeDefined()
    })

    expect(document.title.startsWith('Create an account · ')).toBe(true)
    expect(screen.getByRole('link', { name: 'Sign in' })).toBeDefined()

    // The password warning belongs here, where a password is chosen.
    expect(screen.getByText(/There is no password reset/)).toBeDefined()
  })
})
