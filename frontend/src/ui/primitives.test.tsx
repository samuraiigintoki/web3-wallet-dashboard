import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { errorResponse, jsonResponse, stubFetch } from '../test/http.ts'
import { currentPath, memoryStorage, renderApp } from '../test/renderApp.tsx'
import { Button } from './Button.tsx'
import { Notice } from './Notice.tsx'
import { PRODUCT_NAME } from './product.ts'
import { TextField } from './TextField.tsx'

const USER = { id: 5, email: 'ada@example.com', createdAt: '2026-10-06T12:00:00Z' }

describe('Button', () => {
  it('renders both variants as buttons with their name', () => {
    render(
      <>
        <Button>Save</Button>
        <Button variant="secondary">Retry</Button>
      </>,
    )

    expect(screen.getByRole('button', { name: 'Save' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Save' }).getAttribute('aria-busy')).toBe('false')
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(false)
  })

  it('keeps the accessible name while pending, and disables only then', () => {
    render(
      <>
        <Button pending>Save</Button>
        <Button variant="secondary" pending>
          Retry
        </Button>
      </>,
    )

    for (const name of ['Save', 'Retry']) {
      const button = screen.getByRole('button', { name })
      expect(button.getAttribute('aria-busy'), name).toBe('true')
      expect(button.hasAttribute('disabled'), name).toBe(true)
      expect(button.querySelector('[aria-hidden="true"]'), name).not.toBeNull()
    }
  })

  it('reports the press while it is usable and nothing while it is pending', async () => {
    const user = userEvent.setup()
    const onPress = vi.fn()
    const view = render(
      <Button pending={false} onClick={onPress}>
        Save
      </Button>,
    )

    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(onPress).toHaveBeenCalledTimes(1)

    view.rerender(
      <Button pending onClick={onPress}>
        Save
      </Button>,
    )

    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(onPress).toHaveBeenCalledTimes(1)
  })
})

describe('TextField', () => {
  it('binds the label, the hint and the error to the control', () => {
    render(
      <TextField
        label="Password"
        hint="At least 15 characters."
        error="That is too short."
        defaultValue=""
        readOnly
      />,
    )

    const field = screen.getByLabelText('Password')
    const describedBy = field.getAttribute('aria-describedby') ?? ''
    const description = describedBy
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ')

    expect(description).toContain('At least 15 characters.')
    expect(description).toContain('That is too short.')
    expect(field.getAttribute('aria-invalid')).toBe('true')
  })

  it('announces the error politely, not as an alert', () => {
    render(<TextField label="Email" error="Enter an email address." readOnly />)

    const message = screen.getByText('Enter an email address.')
    expect(message.getAttribute('role')).toBe('status')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('leaves a valid field undescribed and not invalid', () => {
    render(<TextField label="Email" defaultValue="ada@example.com" readOnly />)

    const field = screen.getByLabelText('Email')
    expect(field.getAttribute('aria-invalid')).toBe('false')
    expect(field.hasAttribute('aria-describedby')).toBe(false)
  })

  it('carries the hint before the error when both are present', () => {
    render(<TextField label="Email" hint="Work address." error="Required." readOnly />)

    const ids = (screen.getByLabelText('Email').getAttribute('aria-describedby') ?? '').split(' ')
    const texts = ids.map((id) => document.getElementById(id)?.textContent)

    expect(texts).toEqual(['Work address.', 'Required.'])
  })

  it('turns spellcheck off for an email and leaves it alone elsewhere', () => {
    render(
      <>
        <TextField label="Email" type="email" readOnly />
        <TextField label="Note" type="text" readOnly />
      </>,
    )

    expect(screen.getByLabelText('Email').getAttribute('spellcheck')).toBe('false')
    expect(screen.getByLabelText('Note').hasAttribute('spellcheck')).toBe(false)
  })
})

describe('Notice', () => {
  it('is polite by default and assertive only when it says so', () => {
    render(
      <>
        <Notice>Your account is ready.</Notice>
        <Notice urgency="alert">That email and password combination is not correct.</Notice>
      </>,
    )

    expect(screen.getByRole('status').textContent).toBe('Your account is ready.')
    expect(screen.getByRole('alert').textContent).toBe(
      'That email and password combination is not correct.',
    )
  })

  it('offers actions beside the message', () => {
    render(
      <Notice actions={<Button>Retry</Button>}>The API may be unreachable.</Notice>,
    )

    const notice = screen.getByText('The API may be unreachable.').closest('div')
    expect(notice).not.toBeNull()
    expect(within(notice ?? document.body).getByRole('button', { name: 'Retry' })).toBeDefined()
  })

  it('never dismisses itself', async () => {
    vi.useFakeTimers()
    try {
      render(<Notice urgency="alert">Something went wrong.</Notice>)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(screen.getByRole('alert').textContent).toBe('Something went wrong.')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('layouts and titles', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    document.title = ''
  })

  it('gives every route a main region and a name in the tab list', async () => {
    stubFetch(() => jsonResponse({ data: USER }))

    // The screen names itself twice, on purpose: the document title is the
    // plain name of the screen, and the heading is the composed headline.
    const routes: [string, string, string][] = [
      ['/login', 'Sign in', 'Sign in to read the record.'],
      ['/register', 'Create an account', 'Create an account to read the record.'],
    ]

    for (const [path, title, headline] of routes) {
      const view = renderApp({ path })
      await waitFor(() => {
        expect(screen.getByRole('heading', { name: headline })).toBeDefined()
      })

      expect(screen.getByRole('main')).toBeDefined()
      expect(document.title).toBe(`${title} · ${PRODUCT_NAME}`)
      view.unmount()
    }
  })

  it('names the signed in routes too', async () => {
    stubFetch(() => jsonResponse({ data: USER }))

    for (const [path, heading] of [
      ['/', 'Overview'],
      ['/wallets', 'Wallets'],
      ['/contracts', 'Contracts'],
    ] as const) {
      const view = renderApp({ path, storage: memoryStorage('stored-token') })
      await waitFor(() => {
        expect(screen.getByRole('heading', { name: heading })).toBeDefined()
      })

      expect(document.title).toBe(`${heading} · ${PRODUCT_NAME}`)
      view.unmount()
    }
  })

  it('names the not found page without redirecting', async () => {
    stubFetch(() => jsonResponse({ data: USER }))
    renderApp({ path: '/nowhere' })

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Page not found' })).toBeDefined()
    })
    expect(document.title).toBe(`Page not found · ${PRODUCT_NAME}`)
    expect(currentPath()).toBe('/nowhere')
  })

  it('gives the signed in frame its landmarks and a skip link to the main region', async () => {
    stubFetch(() => jsonResponse({ data: USER }))
    renderApp({ path: '/', storage: memoryStorage('stored-token') })

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Overview' })).toBeDefined()
    })

    const main = screen.getByRole('main')
    expect(screen.getByRole('banner')).toBeDefined()
    expect(screen.getByRole('navigation', { name: 'Sections' })).toBeDefined()

    const skip = screen.getByRole('link', { name: 'Skip to content' })
    expect(skip.getAttribute('href')).toBe(`#${main.id}`)
    expect(main.id).not.toBe('')
    // The target has to be able to take focus, or the skip goes nowhere.
    expect(main.getAttribute('tabindex')).toBe('-1')
    expect(skip.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('gives the auth pages a main region and no skip link, because they have no navigation', async () => {
    stubFetch(() => jsonResponse({ data: USER }))
    renderApp({ path: '/login' })

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Sign in to read the record.' })).toBeDefined()
    })
    expect(screen.getByRole('main')).toBeDefined()
    expect(screen.queryByRole('link', { name: 'Skip to content' })).toBeNull()
  })
})

describe('focus on a rejected submit', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('moves focus to the first invalid field on the login page', async () => {
    stubFetch(() => jsonResponse({ data: USER }))
    const { user } = renderApp({ path: '/login' })

    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(document.activeElement).toBe(screen.getByLabelText('Email'))
    expect(screen.getByLabelText('Email').getAttribute('aria-invalid')).toBe('true')
  })

  it('moves focus past a valid first field to the one that failed', async () => {
    stubFetch(() => jsonResponse({ data: USER }))
    const { user } = renderApp({ path: '/register' })

    await user.type(screen.getByLabelText('Email'), 'grace@example.com')
    await user.type(screen.getByLabelText('Password'), 'short')
    await user.type(screen.getByLabelText('Confirm password'), 'short')
    await user.click(screen.getByRole('button', { name: 'Create account' }))

    expect(document.activeElement).toBe(screen.getByLabelText('Password'))
    expect(screen.getByLabelText('Email').getAttribute('aria-invalid')).toBe('false')
  })

  it('takes focus back on a second identical rejected submit', async () => {
    // The values did not change, so the messages did not change either. The
    // attempt is what has to bring focus back: someone who tabs away to look
    // something up and presses the button again is still owed the field.
    stubFetch(() => jsonResponse({ data: USER }))
    const { user } = renderApp({ path: '/login' })

    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(document.activeElement).toBe(screen.getByLabelText('Email'))

    await user.tab()
    expect(document.activeElement).toBe(screen.getByLabelText('Password'))

    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(document.activeElement).toBe(screen.getByLabelText('Email'))
    // The same two messages, unchanged by the second attempt.
    expect(screen.getAllByRole('status').map((node) => node.textContent)).toEqual([
      'Enter your email address.',
      'Enter your password.',
    ])
  })

  it('moves focus to the field the server named', async () => {
    stubFetch(() =>
      errorResponse(422, 'VALIDATION_ERROR', { details: { email: 'email is taken' } }),
    )
    const { user } = renderApp({ path: '/register' })

    await user.type(screen.getByLabelText('Email'), 'grace@example.com')
    await user.type(screen.getByLabelText('Password'), 'a good password')
    await user.type(screen.getByLabelText('Confirm password'), 'a good password')
    await user.click(screen.getByRole('button', { name: 'Create account' }))

    await waitFor(() => {
      expect(screen.getByText('email is taken')).toBeDefined()
    })
    expect(document.activeElement).toBe(screen.getByLabelText('Email'))
  })
})
