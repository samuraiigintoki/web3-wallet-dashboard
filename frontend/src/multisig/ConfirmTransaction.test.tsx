import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ContractEvent } from '../api/index.ts'
import { MULTISIG_ADDRESS, SEPOLIA_CHAIN_ID } from '../provider/multisig.ts'
import { useBrowserWallet } from '../provider/useBrowserWallet.ts'
import { deferred, installFakeProvider, removeFakeProvider, type FakeProvider } from '../test/fakeProvider.ts'
import { ConfirmTransaction } from './ConfirmTransaction.tsx'
import { CONFIRM_SELECTOR } from './confirm.ts'
import type { RefreshedPage } from './events.ts'
import type { SubmitTarget } from './useSubmitTransaction.ts'

/**
 * Confirming one proposal, from the row that shows it.
 *
 * The provider here is a stub, and every `eth_call` is answered by selector, so
 * the four preflight readings are the ones the contract would give for that
 * proposal and nothing else. What is checked is what the screen does with those
 * answers: what it offers, what it refuses, what it sends, and how many times.
 */

const OWNER = '0x14912965632cd9ab70c046e8d23e9b8dfa9f2746'
const OTHER = '0x1e1D0e1D0e1D0e1D0e1D0e1D0e1D0e1D0e1D0e1D'
const DESTINATION = '0x14912965632cd9ab70c046e8d23e9b8dfa9f2746'
const SEPOLIA_HEX = `0x${SEPOLIA_CHAIN_ID.toString(16)}`
const HASH = `0x${'ab'.repeat(32)}`
const OTHER_HASH = `0x${'cd'.repeat(32)}`

const IS_OWNER = '0x2f54bf6e'
const TRANSACTION_COUNT = '0x2e7700f0'
const TRANSACTIONS = '0x9ace38c2'
const IS_CONFIRMED = '0x80f59a65'

const CONTRACT: SubmitTarget = {
  id: 7,
  address: MULTISIG_ADDRESS,
  chainId: SEPOLIA_CHAIN_ID,
}

const PAYLOAD = {
  to: DESTINATION,
  valueWei: '1000000000000000000',
  data: '0xdeadbeef',
}

function word(value: bigint): string {
  return value.toString(16).padStart(64, '0')
}

function addressWord(address: string): string {
  return address.toLowerCase().replace(/^0x/, '').padStart(64, '0')
}

/** `transactions(index)` as the contract answers it, built from the parts. */
function proposalWord(
  parts: { to?: string; valueWei?: bigint; data?: string; executed?: boolean } = {},
): string {
  const to = parts.to ?? DESTINATION
  const value = parts.valueWei ?? 1_000_000_000_000_000_000n
  const data = (parts.data ?? '0xdeadbeef').replace(/^0x/, '')
  const bytes = data.length / 2
  const padded = data.padEnd(Math.ceil(bytes / 32) * 64, '0')

  return [
    '0x',
    addressWord(to),
    word(value),
    word(128n),
    word(parts.executed === true ? 1n : 0n),
    word(BigInt(bytes)),
    padded,
  ].join('')
}

const PROPOSAL = proposalWord()

const EVENT: ContractEvent = {
  contractId: 7,
  eventName: 'SubmitTransaction',
  blockNumber: 6_100_000,
  blockHash: `0x${'11'.repeat(32)}`,
  transactionHash: `0x${'22'.repeat(32)}`,
  transactionIndex: 1,
  logIndex: 0,
  actorAddress: OTHER,
  multisigTxIndex: '0',
  payload: PAYLOAD,
} as ContractEvent

/** An answer, or a function that answers when called, so a read can be held. */
type Answer = string | (() => unknown)

type Reads = {
  isOwner?: Answer
  count?: Answer
  proposal?: Answer
  isConfirmed?: Answer
}

function answered(value: Answer | undefined, fallback: string): unknown {
  if (value === undefined) {
    return fallback
  }

  return typeof value === 'function' ? value() : value
}

type Chain = {
  /** What `eth_accounts` answers. */
  accounts: string[]
  /** What `eth_chainId` answers. */
  chain: string
  /** What `eth_sendTransaction` answers, or throws. */
  send: () => unknown
  receipt: unknown
}

function stub(reads: Reads = {}, chain: Partial<Chain> = {}): { fake: FakeProvider; chain: Chain } {
  const live: Chain = {
    accounts: [OTHER],
    chain: SEPOLIA_HEX,
    send: () => HASH,
    receipt: null,
    ...chain,
  }

  const fake = installFakeProvider({
    answer: ({ method, params }) => {
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') {
        return live.accounts
      }

      if (method === 'eth_chainId') {
        return live.chain
      }

      if (method === 'eth_sendTransaction') {
        return live.send()
      }

      if (method === 'eth_getTransactionReceipt') {
        return live.receipt
      }

      if (method === 'eth_call') {
        const call = (params as [{ data: string }, string])[0]
        const data = call.data

        if (data.startsWith(IS_OWNER)) {
          return answered(reads.isOwner, `0x${word(1n)}`)
        }

        if (data.startsWith(TRANSACTION_COUNT)) {
          return answered(reads.count, `0x${word(3n)}`)
        }

        if (data.startsWith(TRANSACTIONS)) {
          return answered(reads.proposal, PROPOSAL)
        }

        if (data.startsWith(IS_CONFIRMED)) {
          return answered(reads.isConfirmed, `0x${word(0n)}`)
        }

        throw new Error(`unexpected call ${data}`)
      }

      throw new Error(`unexpected method ${method}`)
    },
  })

  return { fake, chain: live }
}

/** The row as the page draws it: the wallet read once and handed to the row. */
function Harness({
  contract = CONTRACT,
  event = EVENT,
  onRefreshEvents = async (): Promise<RefreshedPage | null> => ({ events: [], page: 1 }),
}: {
  contract?: SubmitTarget
  event?: ContractEvent
  onRefreshEvents?: () => Promise<RefreshedPage | null>
}) {
  const wallet = useBrowserWallet()

  return (
    <>
      <p data-testid="wallet">
        {wallet.state.status === 'connected'
          ? `${wallet.state.account}:${String(wallet.state.chainId)}`
          : wallet.state.status}
      </p>
      <ConfirmTransaction
        contract={contract}
        event={event}
        wallet={wallet.state}
        onRefreshEvents={onRefreshEvents}
      />
    </>
  )
}

function sends(fake: FakeProvider): { params?: unknown }[] {
  return fake.calls.filter((call) => call.method === 'eth_sendTransaction')
}

async function renderRow(
  reads: Reads = {},
  chain: Partial<Chain> = {},
  props: {
    contract?: SubmitTarget
    event?: ContractEvent
    onRefreshEvents?: () => Promise<RefreshedPage | null>
  } = {},
) {
  const { fake, chain: live } = stub(reads, chain)
  const user = userEvent.setup()

  const view = render(<Harness {...props} />)

  return { fake, live, user, ...view }
}

function confirmButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Confirm proposal' }) as HTMLButtonElement
}

function openButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Open wallet and confirm' }) as HTMLButtonElement
}

async function reachReview(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await waitFor(() => {
    expect(confirmButton().disabled).toBe(false)
  })

  await user.click(confirmButton())

  await screen.findByRole('button', { name: 'Open wallet and confirm' })
}

afterEach(() => {
  removeFakeProvider()
  vi.restoreAllMocks()
})

describe('confirming one indexed proposal', () => {
  it('reads the contract before the wallet is opened, and reads nothing else first', async () => {
    const { fake, user } = await renderRow()

    await reachReview(user)

    expect(sends(fake)).toHaveLength(0)
    expect(fake.requested).not.toContain('eth_requestAccounts')

    const reads = fake.calls.filter((call) => call.method === 'eth_call').map((call) => {
      const data = (call.params as [{ data: string }, string])[0].data

      return data.slice(0, 10)
    })

    expect(reads).toEqual([IS_OWNER, TRANSACTION_COUNT, TRANSACTIONS, IS_CONFIRMED])
  })

  it('encodes the account as lower case, whatever case the wallet reported', async () => {
    // Wallets report addresses in any case, and a mixed case address is not a
    // checksum, so the read has to be built from the address as bytes rather than
    // from the string the wallet happened to send.
    const { fake, user } = await renderRow()

    await reachReview(user)

    const ownerRead = fake.calls.find((call) => {
      const data = (call.params as [{ data: string }] | undefined)?.[0]?.data

      return typeof data === 'string' && data.startsWith(IS_OWNER)
    })

    expect((ownerRead!.params as [{ data: string }])[0].data).toBe(
      `${IS_OWNER}${addressWord(OTHER)}`,
    )
  })

  it('shows the exact proposal before the wallet is asked for anything', async () => {
    const { fake, user } = await renderRow()

    await reachReview(user)

    const review = screen.getByRole('button', { name: 'Open wallet and confirm' })
      .closest('div')!.parentElement!

    expect(review.textContent).toContain(MULTISIG_ADDRESS)
    expect(review.textContent).toContain(String(SEPOLIA_CHAIN_ID))
    expect(review.textContent).toContain(OTHER)
    expect(review.textContent).toContain(DESTINATION)
    expect(review.textContent).toContain('1000000000000000000 wei')
    expect(review.textContent).toContain('0xdeadbeef')
    // The index in the calldata, which is what will be signed.
    expect(review.textContent).toContain(`${CONFIRM_SELECTOR}${word(0n)}`)

    expect(sends(fake)).toHaveLength(0)
  })

  it('sends one confirmation of this index, with no value, only when opened', async () => {
    const { fake, user } = await renderRow()

    await reachReview(user)
    await user.click(openButton())

    await screen.findByText(/The wallet returned the transaction hash/)

    const sent = sends(fake)

    expect(sent).toHaveLength(1)

    const params = (sent[0]!.params as [Record<string, string>])[0]

    expect(params.to).toBe(MULTISIG_ADDRESS)
    expect(params.value).toBe('0x0')
    expect(params.data).toBe(`${CONFIRM_SELECTOR}${word(0n)}`)
    expect(params.from?.toLowerCase()).toBe(OTHER.toLowerCase())
  })

  it('sends nothing when the review is cancelled', async () => {
    const { fake, user } = await renderRow()

    await reachReview(user)
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    await waitFor(() => {
      expect(confirmButton().disabled).toBe(false)
    })

    expect(sends(fake)).toHaveLength(0)
  })

  it('sends once when the button is pressed twice', async () => {
    const sending = deferred<unknown>()
    const { fake, user } = await renderRow({}, { send: () => sending.promise })

    await reachReview(user)

    const button = openButton()

    await user.click(button)
    await user.click(button)

    sending.resolve(HASH)

    await screen.findByText(/The wallet returned the transaction hash/)

    expect(sends(fake)).toHaveLength(1)
  })

  it('refuses an account the contract does not list as an owner', async () => {
    const { fake, user } = await renderRow({ isOwner: `0x${word(0n)}` })

    await waitFor(() => {
      expect(confirmButton().disabled).toBe(false)
    })

    await user.click(confirmButton())

    expect((await screen.findByRole('alert')).textContent).toContain('not an owner')
    expect(screen.queryByRole('button', { name: 'Open wallet and confirm' })).toBeNull()
    expect(sends(fake)).toHaveLength(0)
  })

  it('refuses an index the contract does not hold', async () => {
    const { fake, user } = await renderRow({ count: `0x${word(1n)}` }, {}, {
      event: { ...EVENT, multisigTxIndex: '1' } as ContractEvent,
    })

    await waitFor(() => {
      expect(confirmButton().disabled).toBe(false)
    })

    await user.click(confirmButton())

    expect((await screen.findByRole('alert')).textContent).toContain('no proposal at this index')
    expect(sends(fake)).toHaveLength(0)
  })

  it('refuses a proposal that was already executed', async () => {
    const { fake, user } = await renderRow({ proposal: proposalWord({ executed: true }) })

    await waitFor(() => {
      expect(confirmButton().disabled).toBe(false)
    })

    await user.click(confirmButton())

    expect((await screen.findByRole('alert')).textContent).toContain('already been executed')
    expect(sends(fake)).toHaveLength(0)
  })

  it('refuses a proposal this account already confirmed', async () => {
    const { fake, user } = await renderRow({ isConfirmed: `0x${word(1n)}` })

    await waitFor(() => {
      expect(confirmButton().disabled).toBe(false)
    })

    await user.click(confirmButton())

    expect((await screen.findByRole('alert')).textContent).toContain('already confirmed')
    expect(sends(fake)).toHaveLength(0)
  })

  it('refuses when the contract record is not the indexed event', async () => {
    const { fake, user } = await renderRow({
      proposal: proposalWord({ to: '0x00000000000000000000000000000000000000ff' }),
    })

    await waitFor(() => {
      expect(confirmButton().disabled).toBe(false)
    })

    await user.click(confirmButton())

    expect((await screen.findByRole('alert')).textContent).toContain(
      'does not match the indexed event',
    )
    expect(sends(fake)).toHaveLength(0)
  })

  it('refuses data it cannot read, without repeating anything the provider said', async () => {
    const { fake, user } = await renderRow({ proposal: '0x1234' })

    await waitFor(() => {
      expect(confirmButton().disabled).toBe(false)
    })

    await user.click(confirmButton())

    const alert = await screen.findByRole('alert')

    expect(alert.textContent).toBe(
      'The contract answered with data this app cannot read, so nothing was sent.',
    )
    expect(sends(fake)).toHaveLength(0)
  })

  it('refuses a read that reverts, in this app own words', async () => {
    const { fake, user } = await renderRow({
      proposal: () => {
        throw Object.assign(new Error('execution reverted: MultiSigWallet__TxDoesNotExist'), {
          code: -32603,
        })
      },
    })

    await waitFor(() => {
      expect(confirmButton().disabled).toBe(false)
    })

    await user.click(confirmButton())

    const alert = await screen.findByRole('alert')

    expect(alert.textContent).not.toContain('MultiSigWallet__TxDoesNotExist')
    expect(alert.textContent).not.toContain('execution reverted')
    expect(sends(fake)).toHaveLength(0)
  })

  it('never opens the wallet on another chain, and names both chains', async () => {
    const { fake } = await renderRow({}, { chain: '0x1' })

    await waitFor(() => {
      expect(screen.getByText(/Confirming is not available/).textContent).toContain('chain 1')
    })

    expect(confirmButton().disabled).toBe(true)
    expect(fake.requested).not.toContain('eth_call')
  })

  it('never offers confirmation on a contract that is not the verified deployment', async () => {
    const { fake } = await renderRow({}, {}, {
      contract: { ...CONTRACT, address: '0x00000000000000000000000000000000000000ff' },
    })

    expect(screen.getByText(/Cannot confirm:/).textContent).toContain(
      'verified Sepolia multisig contract',
    )
    // Not a disabled button: no action at all, because there is no proposal this
    // app could name on that contract.
    expect(screen.queryByRole('button', { name: 'Confirm proposal' })).toBeNull()
    expect(fake.requested).not.toContain('eth_call')
  })

  it('names no proposal for an event whose index this app cannot read', async () => {
    const { fake } = await renderRow({}, {}, {
      event: { ...EVENT, multisigTxIndex: 'one' } as ContractEvent,
    })

    expect(screen.getByText(/Cannot confirm:/).textContent).toContain(
      'does not name a proposal this app can read',
    )
    expect(screen.queryByRole('button', { name: 'Confirm proposal' })).toBeNull()
    expect(sends(fake)).toHaveLength(0)
  })

  it('sends nothing when the account changes between the review and the press', async () => {
    const { fake, user, live } = await renderRow()

    await reachReview(user)

    live.accounts = [OWNER]
    fake.emit('accountsChanged', [OWNER])

    await waitFor(() => {
      expect(screen.getByTestId('wallet').textContent).toBe(`${OWNER}:${SEPOLIA_CHAIN_ID}`)
    })

    // The review belonged to the other account, so it is gone with it.
    expect(screen.queryByRole('button', { name: 'Open wallet and confirm' })).toBeNull()
    expect(sends(fake)).toHaveLength(0)
  })

  it('sends nothing when the chain changes between the review and the press', async () => {
    const { fake, user, live } = await renderRow()

    await reachReview(user)

    live.chain = '0x1'
    fake.emit('chainChanged', '0x1')

    await waitFor(() => {
      expect(screen.getByText(/Confirming is not available/).textContent).toContain('chain 1')
    })

    expect(screen.queryByRole('button', { name: 'Open wallet and confirm' })).toBeNull()
    expect(sends(fake)).toHaveLength(0)
  })

  it('drops a preflight answer that lands after the wallet moved', async () => {
    const count = deferred<unknown>()

    const { fake, user } = await renderRow({
      count: () => count.promise,
    })

    await waitFor(() => {
      expect(confirmButton().disabled).toBe(false)
    })

    await user.click(confirmButton())

    await screen.findByText('Reading the proposal from the contract.')

    fake.emit('accountsChanged', [OWNER])

    count.resolve(`0x${word(3n)}`)


    await waitFor(() => {
      expect(screen.getByTestId('wallet').textContent).toBe(`${OWNER}:${SEPOLIA_CHAIN_ID}`)
    })

    expect(screen.queryByRole('button', { name: 'Open wallet and confirm' })).toBeNull()
    expect(screen.queryByText('Reading the proposal from the contract.')).toBeNull()
    expect(sends(fake)).toHaveLength(0)
  })

  it('drops a preflight answer that lands after the wallet moved away and back', async () => {
    const count = deferred<unknown>()

    const { fake, user } = await renderRow({
      count: () => count.promise,
    })

    await waitFor(() => {
      expect(confirmButton().disabled).toBe(false)
    })

    await user.click(confirmButton())

    await screen.findByText('Reading the proposal from the contract.')

    // Away from the account that asked, and back to it: the review this answer
    // would produce was requested for a wallet state the user has since left, and
    // returning to the same account does not make it current again.
    fake.emit('accountsChanged', [OWNER])

    await waitFor(() => {
      expect(screen.getByTestId('wallet').textContent).toBe(`${OWNER}:${SEPOLIA_CHAIN_ID}`)
    })

    fake.emit('accountsChanged', [OTHER])

    await waitFor(() => {
      expect(screen.getByTestId('wallet').textContent).toBe(`${OTHER}:${SEPOLIA_CHAIN_ID}`)
    })

    count.resolve(`0x${word(3n)}`)

    await waitFor(() => {
      expect(screen.queryByText('Reading the proposal from the contract.')).toBeNull()
    })

    expect(screen.queryByRole('button', { name: 'Open wallet and confirm' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Confirm proposal' })).toBeDefined()
    expect(sends(fake)).toHaveLength(0)
  })

  it('reports a declined confirmation without claiming nothing was sent', async () => {
    const { fake, user } = await renderRow({}, {
      send: () => {
        throw Object.assign(new Error('User rejected the request.'), { code: 4001 })
      },
    })

    await reachReview(user)
    await user.click(openButton())

    const alert = await screen.findByRole('alert')

    expect(alert.textContent).toBe('The confirmation was declined in the wallet.')
    expect(screen.getByText(/does not prove that nothing was sent/)).toBeDefined()
    expect(sends(fake)).toHaveLength(1)
  })

  it('checks the receipt by hand, then looks for this confirmation in the refreshed page', async () => {
    const matching = {
      ...EVENT,
      eventName: 'ConfirmTransaction',
      transactionHash: HASH,
      actorAddress: OTHER,
      multisigTxIndex: '0',
      blockNumber: 6_100_042,
    } as ContractEvent

    const onRefreshEvents = vi.fn(async () => ({ events: [matching], page: 2 }))

    const { user } = await renderRow({}, {
      receipt: {
        transactionHash: HASH,
        to: MULTISIG_ADDRESS,
        status: '0x1',
        blockNumber: '0x5d13ca',
        blockHash: `0x${'33'.repeat(32)}`,
      },
    }, { onRefreshEvents })

    await reachReview(user)
    await user.click(openButton())
    await screen.findByText(/The wallet returned the transaction hash/)

    // The receipt is not read on its own.
    expect(screen.queryByText(/included in block/)).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Check receipt' }))

    expect(
      (await screen.findByText(/confirmation was recorded by the contract/)).textContent,
    ).toContain('does not mean the proposal reached its threshold')

    await user.click(screen.getByRole('button', { name: 'Refresh indexed events' }))

    const found = await screen.findByText(/shows the ConfirmTransaction event/)

    expect(found.textContent).toContain('6100042')
    expect(onRefreshEvents).toHaveBeenCalledTimes(1)
  })

  it('says an absent confirmation is not on the page, and never that it did not happen', async () => {
    // The same proposal confirmed by another owner: the index matches, the actor
    // does not, so this confirmation is not on the page.
    const anotherOwner = {
      ...EVENT,
      eventName: 'ConfirmTransaction',
      transactionHash: OTHER_HASH,
      actorAddress: OWNER,
      multisigTxIndex: '0',
      blockNumber: 6_100_042,
    } as ContractEvent

    const { user } = await renderRow({}, {
      receipt: {
        transactionHash: HASH,
        to: MULTISIG_ADDRESS,
        status: '0x1',
        blockNumber: '0x5d13ca',
        blockHash: `0x${'33'.repeat(32)}`,
      },
    }, { onRefreshEvents: async () => ({ events: [anotherOwner], page: 3 }) })

    await reachReview(user)
    await user.click(openButton())
    await screen.findByText(/The wallet returned the transaction hash/)
    await user.click(screen.getByRole('button', { name: 'Check receipt' }))
    await screen.findByText(/confirmation was recorded by the contract/)
    await user.click(screen.getByRole('button', { name: 'Refresh indexed events' }))

    const absent = await screen.findByText(/not on the refreshed page \(page 3\)/)

    expect(absent.textContent).toContain('It may still be waiting to be indexed')
    expect(absent.textContent).toContain('does not mean the contract emitted nothing')
  })

  it('reports a failed refresh as a failed refresh', async () => {
    const { user } = await renderRow({}, {
      receipt: {
        transactionHash: HASH,
        to: MULTISIG_ADDRESS,
        status: '0x1',
        blockNumber: '0x5d13ca',
        blockHash: `0x${'33'.repeat(32)}`,
      },
    }, { onRefreshEvents: async () => null })

    await reachReview(user)
    await user.click(openButton())
    await screen.findByText(/The wallet returned the transaction hash/)
    await user.click(screen.getByRole('button', { name: 'Check receipt' }))
    await screen.findByText(/confirmation was recorded by the contract/)
    await user.click(screen.getByRole('button', { name: 'Refresh indexed events' }))

    expect(
      (await screen.findByText(/could not be read again/)).textContent,
    ).toBe('The current page of indexed events could not be read again.')
    expect(screen.queryByText(/shows the ConfirmTransaction event/)).toBeNull()
    expect(screen.queryByText(/not on the refreshed page/)).toBeNull()
  })

  it('says a reverted confirmation did nothing, without claiming a reason', async () => {
    const { user } = await renderRow({}, {
      receipt: {
        transactionHash: HASH,
        to: MULTISIG_ADDRESS,
        status: '0x0',
        blockNumber: '0x5d13ca',
        blockHash: `0x${'33'.repeat(32)}`,
      },
    })

    await reachReview(user)
    await user.click(openButton())
    await screen.findByText(/The wallet returned the transaction hash/)
    await user.click(screen.getByRole('button', { name: 'Check receipt' }))

    const reverted = await screen.findByText(/did not record this confirmation/)

    expect(reverted.textContent).toContain('the wallet may still have charged a fee')
    // A reverted confirmation is not a submission, and the wording proves it.
    expect(reverted.textContent).not.toContain('did not submit the proposal')
  })

  it('draws no receipt check before a hash exists', async () => {
    const { user } = await renderRow()

    await reachReview(user)

    expect(screen.queryByRole('heading', { name: 'Receipt' })).toBeNull()
  })
})
