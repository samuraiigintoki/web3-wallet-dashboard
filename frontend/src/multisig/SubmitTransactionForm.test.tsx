import { QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'

import { createQueryClient } from '../data/queryClient.ts'
import { installFakeProvider, removeFakeProvider, type FakeProvider } from '../test/fakeProvider.ts'
import { jsonResponse, stubFetch } from '../test/http.ts'
import { SubmitTransactionForm } from './SubmitTransactionForm.tsx'
import type { SubmitTarget } from './useSubmitTransaction.ts'

/**
 * The submit form as a user meets it, with a stubbed wallet and a stubbed chain
 * catalog.
 *
 * What is being checked here is the order and the wording, because both are the
 * security property: the details appear before the button that opens the wallet,
 * the refusal sentence never claims nothing happened, and the confirmation says
 * which of the two values is money paid by this call.
 */

const ACCOUNT = '0x1e1D0e1D0e1D0e1D0e1D0e1D0e1D0e1D0e1D0e1D'
const DESTINATION = '0x14912965632cd9ab70c046e8d23e9b8dfa9f2746'
const SEPOLIA = 11155111
const HASH = `0x${'ab'.repeat(32)}`

const CONTRACT: SubmitTarget = {
  id: 7,
  address: '0x5b324f41e5889cf94cba8e909089683a1a97c318',
  chainId: SEPOLIA,
}

const SEPOLIA_ENTRY = {
  chainId: SEPOLIA,
  name: 'Sepolia',
  symbol: 'ETH',
  isTestnet: true,
}

function catalogFetch(chains: unknown[] = [SEPOLIA_ENTRY]): void {
  stubFetch((url: string) => {
    if (url.includes('/chains')) {
      return jsonResponse({ data: chains })
    }

    return jsonResponse({ data: [] })
  })
}

function wallet(options: { chain?: string; send?: () => unknown } = {}): FakeProvider {
  return installFakeProvider({
    answer: ({ method }) => {
      if (method === 'eth_accounts') {
        return [ACCOUNT]
      }

      if (method === 'eth_chainId') {
        return options.chain ?? `0x${SEPOLIA.toString(16)}`
      }

      if (method === 'eth_sendTransaction') {
        return options.send === undefined ? HASH : options.send()
      }

      throw new Error(`unexpected method ${method}`)
    },
  })
}

function renderForm() {
  const user = userEvent.setup()

  return {
    user,
    ...render(
      <QueryClientProvider client={createQueryClient()}>
        <SubmitTransactionForm contract={CONTRACT} />
      </QueryClientProvider>,
    ),
  }
}

async function fill(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(await screen.findByLabelText('Destination address'), DESTINATION)
  await user.type(screen.getByLabelText('Value in wei'), '1000000000000000000')
  await user.type(screen.getByLabelText('Calldata'), '0xdeadbeef')
}

function reviewButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Review submission' }) as HTMLButtonElement
}

function submitButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Open wallet and submit' }) as HTMLButtonElement
}

function sends(fake: FakeProvider): FakeProvider['calls'] {
  return fake.calls.filter((call) => call.method === 'eth_sendTransaction')
}

afterEach(() => {
  removeFakeProvider()
})

describe('the submit form', () => {
  it('offers the form and names the contract when the wallet is on the contract chain', async () => {
    catalogFetch()
    wallet()

    renderForm()

    expect(await screen.findByRole('heading', { name: 'Submit a transaction' })).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Open wallet and submit' })).toBeNull()

    await waitFor(() => {
      expect(reviewButton().disabled).toBe(false)
    })
  })

  it('refuses to review while the wallet is on another chain, and says which', async () => {
    catalogFetch()
    wallet({ chain: '0x1' })

    renderForm()

    await waitFor(() => {
      expect(screen.getByText(/Sending is not available/).textContent).toContain('chain 1')
    })

    expect(reviewButton().disabled).toBe(true)
  })

  it('refuses to review when the catalog does not list the chain, even with the wallet agreeing', async () => {
    catalogFetch([])
    const fake = wallet()

    renderForm()

    await waitFor(() => {
      expect(screen.getByText(/Sending is not available/).textContent).toContain(
        'does not list chain 11155111',
      )
    })

    expect(reviewButton().disabled).toBe(true)
    expect(sends(fake)).toHaveLength(0)
  })

  it('refuses when the catalog cannot be read', async () => {
    stubFetch((url: string) => {
      if (url.includes('/chains')) {
        return jsonResponse({ data: 'not a list' })
      }

      return jsonResponse({ data: [] })
    })
    wallet()

    renderForm()

    await waitFor(() => {
      expect(screen.getByText(/Sending is not available/).textContent).toContain(
        'catalog could not be read',
      )
    })
  })

  it('shows every detail of the call before any wallet prompt, and nothing is sent yet', async () => {
    catalogFetch()
    const fake = wallet()
    const { user } = renderForm()

    await fill(user)
    await user.click(reviewButton())

    const facts = screen.getByText('Destination').closest('dl')!

    expect(facts.textContent).toContain(CONTRACT.address)
    expect(facts.textContent).toContain(String(SEPOLIA))
    expect(facts.textContent).toContain(ACCOUNT)
    expect(facts.textContent).toContain(DESTINATION)
    expect(facts.textContent).toContain('1000000000000000000 wei')
    expect(facts.textContent).toContain('0xdeadbeef')
    // The call itself pays nothing, and the screen says why that is not the value.
    expect(facts.textContent).toContain('0 wei')
    expect(facts.textContent).toContain('inside the calldata')

    // Nothing has been asked of the wallet beyond its account and chain.
    expect(sends(fake)).toHaveLength(0)
    expect(fake.calls.map((call) => call.method)).not.toContain('eth_requestAccounts')
  })

  it('sends once when the wallet is opened from the confirmation, and shows the hash', async () => {
    catalogFetch()
    const fake = wallet()
    const { user } = renderForm()

    await fill(user)
    await user.click(reviewButton())
    await user.click(submitButton())

    await waitFor(() => {
      expect(screen.getByText(/Submitted\./).textContent).toContain(HASH)
    })

    expect(sends(fake)).toHaveLength(1)
    expect(sends(fake)[0]!.params).toEqual([
      {
        from: ACCOUNT,
        to: CONTRACT.address,
        value: '0x0',
        data: expect.stringContaining('0xc6427474'),
      },
    ])

    // Submitted is not mined, and the copy says so in as many words.
    expect(screen.getByText(/does not mean it was mined/)).toBeDefined()

    const afterSend = fake.calls.length
    await new Promise((resolve) => setTimeout(resolve, 20))
    // No receipt polling, no event refresh: the provider is not asked again.
    expect(fake.calls.length).toBe(afterSend)
  })

  it('cancel returns to the form and sends nothing', async () => {
    catalogFetch()
    const fake = wallet()
    const { user } = renderForm()

    await fill(user)
    await user.click(reviewButton())
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.getByLabelText('Destination address')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Open wallet and submit' })).toBeNull()
    expect(sends(fake)).toHaveLength(0)
  })

  it('reports a rejection without repeating the wallet text, and does not claim nothing happened', async () => {
    catalogFetch()
    wallet({
      send: () => {
        throw Object.assign(new Error('MetaMask Tx Signature: User denied transaction signature.'), {
          code: 4001,
        })
      },
    })
    const { user } = renderForm()

    await fill(user)
    await user.click(reviewButton())
    await user.click(submitButton())

    const alert = await screen.findByRole('alert')

    expect(alert.textContent).toBe('The transaction was declined in the wallet.')
    expect(document.body.textContent).not.toContain('User denied')
    expect(screen.getByText(/does not prove that nothing was sent/)).toBeDefined()
  })

  it('reports each bad field and never reaches the confirmation', async () => {
    catalogFetch()
    const fake = wallet()
    const { user } = renderForm()

    await user.type(await screen.findByLabelText('Destination address'), 'nope')
    await user.type(screen.getByLabelText('Value in wei'), '1.5')
    await user.click(reviewButton())

    expect(screen.getAllByRole('alert')).toHaveLength(2)
    expect(screen.queryByRole('button', { name: 'Open wallet and submit' })).toBeNull()
    expect(sends(fake)).toHaveLength(0)
  })

  it('submits an empty calldata field as no calldata', async () => {
    catalogFetch()
    const fake = wallet()
    const { user } = renderForm()

    await user.type(await screen.findByLabelText('Destination address'), DESTINATION)
    await user.type(screen.getByLabelText('Value in wei'), '0')
    await user.click(reviewButton())

    const facts = screen.getByText('Calldata').closest('dl')!

    expect(facts.textContent).toContain('0x')

    await user.click(submitButton())

    await waitFor(() => {
      expect(sends(fake)).toHaveLength(1)
    })
  })
})
