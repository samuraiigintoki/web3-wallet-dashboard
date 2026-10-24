import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ContractEvent } from '../api/index.ts'
import { MULTISIG_ADDRESS, SEPOLIA_CHAIN_ID } from '../provider/multisig.ts'
import { useBrowserWallet } from '../provider/useBrowserWallet.ts'
import {
  deferred,
  installFakeProvider,
  removeFakeProvider,
  type FakeProvider,
} from '../test/fakeProvider.ts'
import type { RefreshedPage } from './events.ts'
import { REVOKE_SELECTOR } from './revoke.ts'
import { RevokeTransaction } from './RevokeTransaction.tsx'
import type { SubmitTarget } from './useSubmitTransaction.ts'

/**
 * Revoking your own confirmation, from the row that shows the proposal.
 *
 * The provider is a stub and every `eth_call` is answered by selector, so the four
 * preflight readings are the ones the contract would give. What is checked is what
 * the screen does with them, and the case that matters most is the one that makes
 * this slice different from confirming: an account that has *not* confirmed is
 * refused, before the wallet is opened.
 */

const OWNER = '0x14912965632cd9ab70c046e8d23e9b8dfa9f2746'
const ACCOUNT = '0x1e1D0e1D0e1D0e1D0e1D0e1D0e1D0e1D0e1D0e1D'
const DESTINATION = '0x14912965632cd9ab70c046e8d23e9b8dfa9f2746'
const SEPOLIA_HEX = `0x${SEPOLIA_CHAIN_ID.toString(16)}`
const HASH = `0x${'ef'.repeat(32)}`

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

/** `transactions(index)` as the contract answers it. */
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

const EVENT: ContractEvent = {
  contractId: 7,
  eventName: 'SubmitTransaction',
  blockNumber: 6_100_000,
  blockHash: `0x${'11'.repeat(32)}`,
  transactionHash: `0x${'22'.repeat(32)}`,
  transactionIndex: 1,
  logIndex: 0,
  actorAddress: OWNER,
  multisigTxIndex: '0',
  payload: PAYLOAD,
} as ContractEvent

type Answer = string | (() => unknown)

type Reads = {
  isOwner?: Answer
  count?: Answer
  proposal?: Answer
  /** Whether this account has confirmed. Revoking needs this true. */
  isConfirmed?: Answer
}

function answered(value: Answer | undefined, fallback: string): unknown {
  if (value === undefined) {
    return fallback
  }

  return typeof value === 'function' ? value() : value
}

type Chain = {
  accounts: string[]
  chain: string
  send: () => unknown
  receipt: unknown
}

function stub(reads: Reads = {}, chain: Partial<Chain> = {}): { fake: FakeProvider; chain: Chain } {
  const live: Chain = {
    accounts: [ACCOUNT],
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
        const data = (params as [{ data: string }, string])[0].data

        if (data.startsWith(IS_OWNER)) {
          return answered(reads.isOwner, `0x${word(1n)}`)
        }

        if (data.startsWith(TRANSACTION_COUNT)) {
          return answered(reads.count, `0x${word(3n)}`)
        }

        if (data.startsWith(TRANSACTIONS)) {
          return answered(reads.proposal, proposalWord())
        }

        if (data.startsWith(IS_CONFIRMED)) {
          // A confirmed account by default: this action exists for that state.
          return answered(reads.isConfirmed, `0x${word(1n)}`)
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
      <RevokeTransaction
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

const RECEIPT = {
  transactionHash: HASH,
  to: MULTISIG_ADDRESS,
  status: '0x1',
  blockNumber: '0x5d13ca',
  blockHash: `0x${'33'.repeat(32)}`,
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

function revokeButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Revoke my confirmation' }) as HTMLButtonElement
}

function openButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Open wallet and revoke' }) as HTMLButtonElement
}

async function reachReview(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await waitFor(() => {
    expect(revokeButton().disabled).toBe(false)
  })

  await user.click(revokeButton())

  await screen.findByRole('button', { name: 'Open wallet and revoke' })
}

async function confirmOnce(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await reachReview(user)
  await user.click(openButton())
  await screen.findByText(/The wallet returned the transaction hash/)
}

afterEach(() => {
  removeFakeProvider()
  vi.restoreAllMocks()
})

describe('revoking one own confirmation', () => {
  it('reads the contract before the wallet is opened, and reads nothing else first', async () => {
    const { fake, user } = await renderRow()

    await reachReview(user)

    expect(sends(fake)).toHaveLength(0)
    expect(fake.requested).not.toContain('eth_requestAccounts')

    const reads = fake.calls
      .filter((call) => call.method === 'eth_call')
      .map((call) => (call.params as [{ data: string }, string])[0].data.slice(0, 10))

    expect(reads).toEqual([IS_OWNER, TRANSACTION_COUNT, TRANSACTIONS, IS_CONFIRMED])
  })

  it('reads the confirmation state of this account, not of the row actor', async () => {
    const { fake, user } = await renderRow()

    await reachReview(user)

    const confirmedRead = fake.calls.find((call) => {
      const data = (call.params as [{ data: string }] | undefined)?.[0]?.data

      return typeof data === 'string' && data.startsWith(IS_CONFIRMED)
    })

    // isConfirmed(index, account), the connected wallet and the row index.
    expect((confirmedRead!.params as [{ data: string }])[0].data).toBe(
      `${IS_CONFIRMED}${word(0n)}${addressWord(ACCOUNT)}`,
    )
  })

  it('shows the exact proposal and the exact revocation before anything is sent', async () => {
    const { fake, user } = await renderRow()

    await reachReview(user)

    // The review is the facts list that carries the exact call.
    const reviewText = (
      document.querySelector('dl.browser-wallet__facts')?.textContent ?? ''
    ).replace(/\s+/g, ' ')

    expect(reviewText).toContain(MULTISIG_ADDRESS)
    expect(reviewText).toContain(String(SEPOLIA_CHAIN_ID))
    expect(reviewText).toContain(ACCOUNT)
    expect(reviewText).toContain(DESTINATION)
    expect(reviewText).toContain('1000000000000000000 wei')
    expect(reviewText).toContain('0xdeadbeef')
    expect(reviewText).toContain(`${REVOKE_SELECTOR}${word(0n)}`)
    expect(sends(fake)).toHaveLength(0)
  })

  it('sends one revocation of this index, with no value, only when opened', async () => {
    const { fake, user } = await renderRow()

    await confirmOnce(user)

    const sent = sends(fake)

    expect(sent).toHaveLength(1)

    const params = (sent[0]!.params as [Record<string, string>])[0]

    expect(params.to).toBe(MULTISIG_ADDRESS)
    expect(params.value).toBe('0x0')
    expect(params.data).toBe(`${REVOKE_SELECTOR}${word(0n)}`)
    expect(params.from?.toLowerCase()).toBe(ACCOUNT.toLowerCase())
  })

  it('sends the row index and no other', async () => {
    const { fake, user } = await renderRow({}, {}, {
      event: { ...EVENT, multisigTxIndex: '2' } as ContractEvent,
    })

    await confirmOnce(user)

    const params = (sends(fake)[0]!.params as [Record<string, string>])[0]

    expect(params.data).toBe(`${REVOKE_SELECTOR}${word(2n)}`)
  })

  it('says what a revocation does not do, in the review itself', async () => {
    const { user } = await renderRow()

    await reachReview(user)

    const text = screen.getByText(/The contract was read just now and this account has an active confirmation/).textContent

    expect(text).toContain('It removes your own confirmation only')
    expect(text).toContain('nothing is executed')
  })

  it('sends nothing when the review is cancelled', async () => {
    const { fake, user } = await renderRow()

    await reachReview(user)
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    await waitFor(() => {
      expect(revokeButton().disabled).toBe(false)
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

  it('refuses an account that has not confirmed, before the wallet opens', async () => {
    // The inverse of the confirm preflight: there is nothing to revoke, so the
    // wallet is never asked and no review is drawn.
    const { fake, user } = await renderRow({ isConfirmed: `0x${word(0n)}` })

    await waitFor(() => {
      expect(revokeButton().disabled).toBe(false)
    })

    await user.click(revokeButton())

    expect((await screen.findByRole('alert')).textContent).toBe(
      'This account has not confirmed this proposal, so there is no confirmation to revoke.',
    )
    expect(screen.queryByRole('button', { name: 'Open wallet and revoke' })).toBeNull()
    expect(sends(fake)).toHaveLength(0)
  })

  it('refuses an account the contract does not list as an owner', async () => {
    const { fake, user } = await renderRow({ isOwner: `0x${word(0n)}` })

    await waitFor(() => {
      expect(revokeButton().disabled).toBe(false)
    })

    await user.click(revokeButton())

    expect((await screen.findByRole('alert')).textContent).toContain('not an owner')
    expect(sends(fake)).toHaveLength(0)
  })

  it('refuses an index the contract does not hold', async () => {
    const { fake, user } = await renderRow({ count: `0x${word(1n)}` }, {}, {
      event: { ...EVENT, multisigTxIndex: '1' } as ContractEvent,
    })

    await waitFor(() => {
      expect(revokeButton().disabled).toBe(false)
    })

    await user.click(revokeButton())

    expect((await screen.findByRole('alert')).textContent).toContain('no proposal at this index')
    expect(sends(fake)).toHaveLength(0)
  })

  it('refuses a proposal that was already executed', async () => {
    const { fake, user } = await renderRow({ proposal: proposalWord({ executed: true }) })

    await waitFor(() => {
      expect(revokeButton().disabled).toBe(false)
    })

    await user.click(revokeButton())

    expect((await screen.findByRole('alert')).textContent).toContain('already been executed')
    expect(sends(fake)).toHaveLength(0)
  })

  it('refuses when the contract record is not the indexed event', async () => {
    const { fake, user } = await renderRow({
      proposal: proposalWord({ to: '0x00000000000000000000000000000000000000ff' }),
    })

    await waitFor(() => {
      expect(revokeButton().disabled).toBe(false)
    })

    await user.click(revokeButton())

    expect((await screen.findByRole('alert')).textContent).toContain(
      'does not match the indexed event',
    )
    expect(sends(fake)).toHaveLength(0)
  })

  it('refuses data it cannot read, without repeating anything the provider said', async () => {
    const { fake, user } = await renderRow({ proposal: '0x1234' })

    await waitFor(() => {
      expect(revokeButton().disabled).toBe(false)
    })

    await user.click(revokeButton())

    expect((await screen.findByRole('alert')).textContent).toBe(
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
      expect(revokeButton().disabled).toBe(false)
    })

    await user.click(revokeButton())

    const alert = await screen.findByRole('alert')

    expect(alert.textContent).not.toContain('MultiSigWallet__TxDoesNotExist')
    expect(alert.textContent).not.toContain('execution reverted')
    expect(sends(fake)).toHaveLength(0)
  })

  it('never offers revocation on another chain, and reads nothing', async () => {
    const { fake } = await renderRow({}, { chain: '0x1' })

    await waitFor(() => {
      expect(screen.getByText(/Revoking is not available/).textContent).toContain('chain 1')
    })

    expect(revokeButton().disabled).toBe(true)
    expect(fake.requested).not.toContain('eth_call')
  })

  it('never offers revocation on a contract that is not the verified deployment', async () => {
    const { fake } = await renderRow({}, {}, {
      contract: { ...CONTRACT, address: '0x00000000000000000000000000000000000000ff' },
    })

    expect(screen.getByText(/Cannot revoke:/).textContent).toContain(
      'verified Sepolia multisig contract',
    )
    expect(screen.queryByRole('button', { name: 'Revoke my confirmation' })).toBeNull()
    expect(fake.requested).not.toContain('eth_call')
  })

  it('names no proposal for a row whose index this app cannot read', async () => {
    const { fake } = await renderRow({}, {}, {
      event: { ...EVENT, multisigTxIndex: 'one' } as ContractEvent,
    })

    expect(screen.getByText(/Cannot revoke:/).textContent).toContain(
      'does not name a proposal this app can read',
    )
    expect(screen.queryByRole('button', { name: 'Revoke my confirmation' })).toBeNull()
    expect(fake.requested).not.toContain('eth_call')
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

    expect(screen.queryByRole('button', { name: 'Open wallet and revoke' })).toBeNull()
    expect(sends(fake)).toHaveLength(0)
  })

  it('sends nothing when the chain changes between the review and the press', async () => {
    const { fake, user, live } = await renderRow()

    await reachReview(user)

    live.chain = '0x1'
    fake.emit('chainChanged', '0x1')

    await waitFor(() => {
      expect(screen.getByText(/Revoking is not available/).textContent).toContain('chain 1')
    })

    expect(screen.queryByRole('button', { name: 'Open wallet and revoke' })).toBeNull()
    expect(sends(fake)).toHaveLength(0)
  })

  it('drops a preflight answer that lands after the wallet moved', async () => {
    const count = deferred<unknown>()

    const { fake, user } = await renderRow({ count: () => count.promise })

    await waitFor(() => {
      expect(revokeButton().disabled).toBe(false)
    })

    await user.click(revokeButton())

    await screen.findByText('Reading your confirmation from the contract.')

    fake.emit('accountsChanged', [OWNER])

    count.resolve(`0x${word(3n)}`)

    await waitFor(() => {
      expect(screen.getByTestId('wallet').textContent).toBe(`${OWNER}:${SEPOLIA_CHAIN_ID}`)
    })

    expect(screen.queryByRole('button', { name: 'Open wallet and revoke' })).toBeNull()
    expect(screen.queryByText('Reading your confirmation from the contract.')).toBeNull()
    expect(sends(fake)).toHaveLength(0)
  })

  it('reports a declined revocation without claiming nothing was sent', async () => {
    const { fake, user } = await renderRow({}, {
      send: () => {
        throw Object.assign(new Error('User rejected the request.'), { code: 4001 })
      },
    })

    await reachReview(user)
    await user.click(openButton())

    expect((await screen.findByRole('alert')).textContent).toBe(
      'The revocation was declined in the wallet.',
    )
    expect(screen.getByText(/does not prove that nothing was sent/)).toBeDefined()
    expect(sends(fake)).toHaveLength(1)
  })

  it('labels an unreadable send outcome as unknown rather than resending', async () => {
    const { fake, user } = await renderRow({}, { send: () => ({ ok: true }) })

    await reachReview(user)
    await user.click(openButton())

    expect((await screen.findByRole('alert')).textContent).toContain(
      'did not answer with a transaction hash',
    )
    expect(screen.getByText(/cannot tell whether the wallet sent this revocation/)).toBeDefined()
    expect(sends(fake)).toHaveLength(1)
  })

  it('checks the receipt by hand, then looks for this revocation in the refreshed page', async () => {
    const matching = {
      ...EVENT,
      eventName: 'RevokeConfirmation',
      transactionHash: HASH,
      actorAddress: ACCOUNT,
      multisigTxIndex: '0',
      blockNumber: 6_100_077,
    } as ContractEvent

    const onRefreshEvents = vi.fn(async () => ({ events: [matching], page: 2 }))

    const { user } = await renderRow({}, { receipt: RECEIPT }, { onRefreshEvents })

    await confirmOnce(user)

    // The receipt is not read on its own.
    expect(screen.queryByText(/included in block/)).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Check receipt' }))

    const note = await screen.findByText(/confirmation was removed by the contract/)

    expect(note.textContent).toContain('does not mean the proposal was executed')

    await user.click(screen.getByRole('button', { name: 'Refresh indexed events' }))

    const found = await screen.findByText(/shows the RevokeConfirmation event/)

    expect(found.textContent).toContain('6100077')
    expect(onRefreshEvents).toHaveBeenCalledTimes(1)
  })

  it('does not read a confirmation by this account as this revocation', async () => {
    // Same hash, same index, same actor, but a ConfirmTransaction event: a
    // revocation has its own event name and the match has to respect it.
    const confirmation = {
      ...EVENT,
      eventName: 'ConfirmTransaction',
      transactionHash: HASH,
      actorAddress: ACCOUNT,
      multisigTxIndex: '0',
    } as ContractEvent

    const { user } = await renderRow({}, { receipt: RECEIPT }, {
      onRefreshEvents: async () => ({ events: [confirmation], page: 4 }),
    })

    await confirmOnce(user)
    await user.click(screen.getByRole('button', { name: 'Check receipt' }))
    await screen.findByText(/confirmation was removed by the contract/)
    await user.click(screen.getByRole('button', { name: 'Refresh indexed events' }))

    const absent = await screen.findByText(/not on the refreshed page \(page 4\)/)

    expect(absent.textContent).toContain('It may still be waiting to be indexed')
    expect(absent.textContent).toContain('does not mean the contract emitted nothing')
  })

  it('reports a failed refresh as a failed refresh', async () => {
    const { user } = await renderRow({}, { receipt: RECEIPT }, {
      onRefreshEvents: async () => null,
    })

    await confirmOnce(user)
    await user.click(screen.getByRole('button', { name: 'Check receipt' }))
    await screen.findByText(/confirmation was removed by the contract/)
    await user.click(screen.getByRole('button', { name: 'Refresh indexed events' }))

    expect((await screen.findByText(/could not be read again/)).textContent).toBe(
      'The current page of indexed events could not be read again.',
    )
    expect(screen.queryByText(/shows the RevokeConfirmation event/)).toBeNull()
  })

  it('says a reverted revocation left the confirmation in place', async () => {
    const { user } = await renderRow({}, {
      receipt: { ...RECEIPT, status: '0x0' },
    })

    await confirmOnce(user)
    await user.click(screen.getByRole('button', { name: 'Check receipt' }))

    const reverted = await screen.findByText(/did not remove this confirmation/)

    expect(reverted.textContent).toContain('This confirmation is still recorded')
    expect(reverted.textContent).not.toContain('did not record this confirmation')
  })

  it('draws no receipt check before a hash exists', async () => {
    const { user } = await renderRow()

    await reachReview(user)

    expect(screen.queryByRole('heading', { name: 'Receipt' })).toBeNull()
  })
})
