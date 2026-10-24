import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ContractEvent } from '../api/index.ts'
import type { BrowserWalletState } from '../provider/useBrowserWallet.ts'
import { deferred, installFakeProvider, removeFakeProvider } from '../test/fakeProvider.ts'
import { ReceiptCheck } from './ReceiptCheck.tsx'
import type { RefreshedPage } from './events.ts'
import type { SubmitTarget } from './useSubmitTransaction.ts'

/**
 * The receipt and index screen as a user meets it.
 *
 * The assertions are mostly about wording, because the wording is the feature: a
 * null receipt must not read as a lost transaction, a success must not read as an
 * executed proposal, and a hash that is not on the refreshed page must not read
 * as an event that never happened. The rest is about what the two buttons do, and
 * that they do nothing until pressed.
 */

const ACCOUNT = '0x1e1D0e1D0e1D0e1D0e1D0e1D0e1D0e1D0e1D0e1D'
const CONTRACT = '0x5b324f41e5889cf94cba8e909089683a1a97c318'
const SEPOLIA = 11155111
const HASH = `0x${'ab'.repeat(32)}`
const BLOCK_HASH = `0x${'11'.repeat(32)}`

const TARGET: SubmitTarget = { id: 7, address: CONTRACT, chainId: SEPOLIA }

const WALLET: BrowserWalletState = { status: 'connected', account: ACCOUNT, chainId: SEPOLIA }

function receipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    transactionHash: HASH,
    to: CONTRACT,
    status: '0x1',
    blockNumber: '0x5d2c40',
    blockHash: BLOCK_HASH,
    ...overrides,
  }
}

function provider(answer: () => unknown = () => receipt()) {
  const fake = installFakeProvider({
    answer: ({ method }) => {
      if (method === 'eth_getTransactionReceipt') {
        return answer()
      }

      throw new Error(`unexpected method ${method}`)
    },
  })

  return {
    ...fake,
    receiptCalls: () => fake.calls.filter((call) => call.method === 'eth_getTransactionReceipt'),
  }
}

function event(overrides: Partial<ContractEvent> = {}): ContractEvent {
  return {
    contractId: 7,
    eventName: 'SubmitTransaction',
    blockNumber: 6_100_000,
    blockHash: `0x${'22'.repeat(32)}`,
    transactionHash: HASH,
    transactionIndex: 1,
    logIndex: 4,
    actorAddress: ACCOUNT,
    multisigTxIndex: '0',
    payload: { to: CONTRACT, valueWei: '1', data: '0x' },
    ...overrides,
  }
}

function renderCheck(
  options: {
    answer?: () => unknown
    onRefreshEvents?: () => Promise<RefreshedPage | null>
    wallet?: BrowserWalletState
  } = {},
) {
  const fake = provider(options.answer)
  const onRefreshEvents = vi.fn(options.onRefreshEvents ?? (async () => ({ events: [event()], page: 1 })))
  const user = userEvent.setup()

  const utils = render(
    <ReceiptCheck
      hash={HASH}
      contract={TARGET}
      wallet={options.wallet ?? WALLET}
      onRefreshEvents={onRefreshEvents}
    />,
  )

  return { ...utils, user, fake, onRefreshEvents }
}

function button(name: string): HTMLButtonElement {
  return screen.getByRole('button', { name }) as HTMLButtonElement
}

function receiptRegion(): HTMLElement {
  return screen.getByText(/No receipt has been checked|Checking the receipt|The wallet has no receipt|The transaction is included|The wallet answered|The wallet could not/).closest('p') as HTMLElement
}

afterEach(() => {
  removeFakeProvider()
})

describe('the receipt', () => {
  it('starts by saying nothing has been checked, and asks for nothing', () => {
    const { fake } = renderCheck()

    expect(receiptRegion().textContent).toContain('No receipt has been checked')
    expect(fake.receiptCalls()).toHaveLength(0)
  })

  it('makes one request and says the transaction is included when the call succeeded', async () => {
    const { user, fake } = renderCheck()

    await user.click(button('Check receipt'))

    await waitFor(() => {
      expect(receiptRegion().textContent).toContain('included in block 6106176')
    })

    expect(receiptRegion().textContent).toContain('did not revert')
    expect(fake.receiptCalls()).toHaveLength(1)
  })

  it('says what a success does not mean, in the same breath', async () => {
    const { user } = renderCheck()

    await user.click(button('Check receipt'))

    await waitFor(() => {
      expect(screen.getByText(/does not mean the owners have confirmed or executed/)).toBeDefined()
    })

    expect(screen.getByText(/that the block is final/)).toBeDefined()
  })

  it('distinguishes a revert from a success', async () => {
    const { user } = renderCheck({ answer: () => receipt({ status: '0x0' }) })

    await user.click(button('Check receipt'))

    await waitFor(() => {
      expect(receiptRegion().textContent).toContain('the call reverted')
    })

    expect(screen.getByText(/did not submit the proposal/)).toBeDefined()
    // A revert is an outcome, not a prompt to check the index.
    expect(screen.queryByRole('button', { name: 'Refresh indexed events' })).toBeNull()
  })

  it('reads a null answer as no receipt available, not as a failure or a loss', async () => {
    const { user } = renderCheck({ answer: () => null })

    await user.click(button('Check receipt'))

    await waitFor(() => {
      expect(receiptRegion().textContent).toContain('no receipt for this transaction right now')
    })

    expect(receiptRegion().textContent).toContain('not proof the transaction was dropped')
    expect(receiptRegion().textContent).toContain('still pending gives the same answer')
    expect(screen.queryByRole('button', { name: 'Refresh indexed events' })).toBeNull()
  })

  it('offers a second check, and finds a receipt the first one did not', async () => {
    let answer: unknown = null
    const { user, fake } = renderCheck({ answer: () => answer })

    await user.click(button('Check receipt'))

    await waitFor(() => {
      expect(receiptRegion().textContent).toContain('no receipt')
    })

    answer = receipt()

    await user.click(button('Check receipt again'))

    await waitFor(() => {
      expect(receiptRegion().textContent).toContain('included in block')
    })

    expect(fake.receiptCalls()).toHaveLength(2)
  })

  it('shows a refused answer as a data error with no provider text', async () => {
    const { user } = renderCheck({ answer: () => receipt({ to: '0x14912965632cd9ab70c046e8d23e9b8dfa9f2746' }) })

    await user.click(button('Check receipt'))

    await waitFor(() => {
      expect(receiptRegion().textContent).toContain('different contract')
    })
  })

  it('does not offer the check at all when the wallet is on another chain', () => {
    renderCheck({ wallet: { status: 'connected', account: ACCOUNT, chainId: 1 } })

    expect(button('Check receipt').disabled).toBe(true)
    expect(receiptRegion().textContent).toContain('submitted on chain')
  })
})

describe('the indexed events', () => {
  it('is not offered until a successful receipt is in hand', async () => {
    const { user, onRefreshEvents } = renderCheck()

    expect(screen.queryByRole('button', { name: 'Refresh indexed events' })).toBeNull()

    await user.click(button('Check receipt'))

    await waitFor(() => {
      expect(button('Refresh indexed events')).toBeDefined()
    })

    // Offering it is not using it: no page was read.
    expect(onRefreshEvents).not.toHaveBeenCalled()
  })

  it('identifies the event as indexed when the refreshed page holds it', async () => {
    const { user, onRefreshEvents } = renderCheck()

    await user.click(button('Check receipt'))
    await waitFor(() => {
      expect(button('Refresh indexed events')).toBeDefined()
    })

    await user.click(button('Refresh indexed events'))

    await waitFor(() => {
      expect(document.body.textContent).toContain('shows the SubmitTransaction event')
    })

    expect(document.body.textContent).toContain('in block 6100000')
    expect(onRefreshEvents).toHaveBeenCalledTimes(1)
  })

  it('says only that it is not on the refreshed page when the page does not hold it', async () => {
    const { user } = renderCheck({
      onRefreshEvents: async () => ({ events: [], page: 2 }),
    })

    await user.click(button('Check receipt'))
    await waitFor(() => {
      expect(button('Refresh indexed events')).toBeDefined()
    })

    await user.click(button('Refresh indexed events'))

    await waitFor(() => {
      expect(document.body.textContent).toContain('not on the refreshed page (page 2)')
    })

    const text = document.body.textContent ?? ''

    expect(text).toContain('waiting to be indexed')
    expect(text).toContain('another page')
    expect(text).toContain('does not mean the contract emitted nothing')
    // The one thing it must not say.
    expect(text).not.toContain('no event was emitted')
  })

  it('reports a refresh that produced no page, without inventing an event', async () => {
    const { user } = renderCheck({ onRefreshEvents: async () => null })

    await user.click(button('Check receipt'))
    await waitFor(() => {
      expect(button('Refresh indexed events')).toBeDefined()
    })

    await user.click(button('Refresh indexed events'))

    await waitFor(() => {
      expect(document.body.textContent).toContain('could not be read again')
    })

    expect(document.body.textContent).not.toContain('SubmitTransaction event for this transaction')
  })

  it('reports a refresh that failed, without inventing an event', async () => {
    const { user } = renderCheck({
      onRefreshEvents: async () => {
        throw new Error('network down')
      },
    })

    await user.click(button('Check receipt'))
    await waitFor(() => {
      expect(button('Refresh indexed events')).toBeDefined()
    })

    await user.click(button('Refresh indexed events'))

    await waitFor(() => {
      expect(document.body.textContent).toContain('could not be read again')
    })

    expect(document.body.textContent).not.toContain('network down')
  })

  it('does nothing until the button is pressed, however long the screen is open', async () => {
    const { fake, onRefreshEvents } = renderCheck()

    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(fake.receiptCalls()).toHaveLength(0)
    expect(onRefreshEvents).not.toHaveBeenCalled()
  })
})

describe('accessible updates', () => {
  it('marks the receipt and the index sentences as live regions', () => {
    renderCheck()

    const regions = [...document.querySelectorAll('[aria-live="polite"]')]

    expect(regions.length).toBeGreaterThanOrEqual(1)
    expect(regions.every((region) => region.getAttribute('aria-atomic') === 'true')).toBe(true)
  })

  it('keeps one live region per statement, so an unrelated render says nothing new', async () => {
    const held = deferred<unknown>()
    const { user, rerender } = renderCheck({ answer: () => held.promise })

    await user.click(button('Check receipt'))

    await waitFor(() => {
      expect(receiptRegion().textContent).toContain('Checking the receipt')
    })

    const before = receiptRegion()

    // A re-render with the same props stands in for any parent update: the
    // region is the same node, its text is unchanged, and a screen reader has
    // nothing to announce a second time.
    rerender(
      <ReceiptCheck
        hash={HASH}
        contract={TARGET}
        wallet={WALLET}
        onRefreshEvents={async () => ({ events: [event()], page: 1 })}
      />,
    )

    const after = receiptRegion()

    expect(after.isSameNode(before)).toBe(true)
    expect(after.textContent).toBe(before.textContent)

    await act(() => {
      held.resolve(receipt())
      return Promise.resolve()
    })

    await waitFor(() => {
      expect(receiptRegion().textContent).toContain('included in block')
    })

    // Still the same node, with new text: the change is what gets announced.
    expect(receiptRegion().isSameNode(before)).toBe(true)
  })
})
