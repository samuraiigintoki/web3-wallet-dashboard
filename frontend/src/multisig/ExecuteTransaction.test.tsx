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
import { EXECUTE_SELECTOR } from './execute.ts'
import { ExecuteTransaction } from './ExecuteTransaction.tsx'
import type { SubmitTarget } from './useSubmitTransaction.ts'

/**
 * Executing one threshold-satisfied proposal.
 *
 * The stub answers `eth_blockNumber` and then every `eth_call` by selector, and it
 * records the block tag each call was made at, because the anchor is the security
 * property: six facts and one read per owner only describe one state of the
 * contract if they are all answered at one block.
 */

const OWNER_A = '0x14912965632cd9ab70c046e8d23e9b8dfa9f2746'
const OWNER_B = '0x1e1D0e1D0e1D0e1D0e1D0e1D0e1D0e1D0e1D0e1D'
const ACCOUNT = '0x00c0ffee00000000000000000000000000000001'
const DESTINATION = '0x14912965632cd9ab70c046e8d23e9b8dfa9f2746'
const SEPOLIA_HEX = `0x${SEPOLIA_CHAIN_ID.toString(16)}`
const HASH = `0x${'ee'.repeat(32)}`
const BLOCK = '0x5d13ca'

const IS_OWNER = '0x2f54bf6e'
const TRANSACTION_COUNT = '0x2e7700f0'
const TRANSACTIONS = '0x9ace38c2'
const IS_CONFIRMED = '0x80f59a65'
const GET_OWNERS = '0xa0e67e2b'
const THRESHOLD = '0x42cde4e8'

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

function proposalWord(
  parts: { to?: string; valueWei?: bigint; data?: string; executed?: boolean } = {},
): string {
  const to = parts.to ?? DESTINATION
  const value = parts.valueWei ?? 1_000_000_000_000_000_000n
  const data = (parts.data ?? '0xdeadbeef').replace(/^0x/, '')
  const bytes = data.length / 2
  const padded = data.padEnd(Math.ceil(bytes / 32) * 64, '0')

  return ['0x', addressWord(to), word(value), word(128n), word(parts.executed === true ? 1n : 0n), word(BigInt(bytes)), padded].join('')
}

/** `getOwners()` as the contract answers it. */
function ownersWord(list: string[]): string {
  return ['0x', word(32n), word(BigInt(list.length)), ...list.map(addressWord)].join('')
}

const EVENT: ContractEvent = {
  contractId: 7,
  eventName: 'SubmitTransaction',
  blockNumber: 6_100_000,
  blockHash: `0x${'11'.repeat(32)}`,
  transactionHash: `0x${'22'.repeat(32)}`,
  transactionIndex: 1,
  logIndex: 0,
  actorAddress: OWNER_A,
  multisigTxIndex: '0',
  payload: PAYLOAD,
} as ContractEvent

type Answer = string | (() => unknown)

type Reads = {
  /** `eth_blockNumber`. */
  block?: Answer
  isOwner?: Answer
  count?: Answer
  proposal?: Answer
  owners?: Answer
  threshold?: Answer
  /** Confirmations by owner address, lower case. */
  confirmations?: Record<string, Answer>
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

      if (method === 'eth_blockNumber') {
        return answered(reads.block, BLOCK)
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

        if (data.startsWith(GET_OWNERS)) {
          return answered(reads.owners, ownersWord([OWNER_A, OWNER_B]))
        }

        if (data.startsWith(THRESHOLD)) {
          return answered(reads.threshold, `0x${word(2n)}`)
        }

        if (data.startsWith(IS_CONFIRMED)) {
          // isConfirmed(index, owner): the owner is the last word of the calldata.
          const owner = `0x${data.slice(-40)}`.toLowerCase()
          const answers = reads.confirmations ?? {}

          return answered(answers[owner], `0x${word(1n)}`)
        }

        throw new Error(`unexpected call ${data}`)
      }

      throw new Error(`unexpected method ${method}`)
    },
  })

  return { fake, chain: live }
}

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
      <ExecuteTransaction
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

/** Every `eth_call` with the block tag it was made at. */
function callsAt(fake: FakeProvider): { selector: string; tag: string }[] {
  return fake.calls
    .filter((call) => call.method === 'eth_call')
    .map((call) => {
      const [request, tag] = call.params as [{ data: string }, string]

      return { selector: request.data.slice(0, 10), tag }
    })
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

function checkButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Check execution' }) as HTMLButtonElement
}

function openButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Open wallet and execute' }) as HTMLButtonElement
}

function acknowledgement(): HTMLInputElement {
  return screen.getByRole('checkbox') as HTMLInputElement
}

async function reachReview(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await waitFor(() => {
    expect(checkButton().disabled).toBe(false)
  })

  await user.click(checkButton())

  await screen.findByRole('button', { name: 'Open wallet and execute' })
}

async function acknowledged(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await reachReview(user)
  await user.click(acknowledgement())
}

afterEach(() => {
  removeFakeProvider()
  vi.restoreAllMocks()
})

describe('executing one proposal', () => {
  it('anchors the whole preflight to one validated block number', async () => {
    const { fake, user } = await renderRow()

    await reachReview(user)

    const calls = callsAt(fake)

    // The block is read before any contract read, so the reads that follow can be
    // anchored to it.
    const order = fake.requested.filter((method) => method !== 'eth_accounts' && method !== 'eth_chainId')

    expect(order[0]).toBe('eth_blockNumber')

    // Three configuration reads, then one confirmation read per owner, all at the
    // block the first request returned.
    expect(calls.map((call) => call.selector)).toEqual([
      IS_OWNER,
      TRANSACTION_COUNT,
      TRANSACTIONS,
      GET_OWNERS,
      THRESHOLD,
      IS_CONFIRMED,
      IS_CONFIRMED,
    ])

    for (const call of calls) {
      expect(call.tag).toBe(BLOCK)
    }
  })

  it('reads one confirmation per owner, in the order the contract listed them', async () => {
    const { fake, user } = await renderRow()

    await reachReview(user)

    const confirmedAt = fake.calls
      .filter((call) => (call.params as [{ data: string }] | undefined)?.[0]?.data.startsWith(IS_CONFIRMED))
      .map((call) => `0x${(call.params as [{ data: string }])[0].data.slice(-40)}`.toLowerCase())

    expect(confirmedAt).toEqual([OWNER_A.toLowerCase(), OWNER_B.toLowerCase()])
  })

  it('opens no wallet and sends nothing during the preflight', async () => {
    const { fake, user } = await renderRow()

    await reachReview(user)

    expect(sends(fake)).toHaveLength(0)
    expect(fake.requested).not.toContain('eth_requestAccounts')
  })

  it('shows the proposal, the evidence and the exact call, with the risk stated', async () => {
    const { user } = await renderRow()

    await reachReview(user)

    const reviewText = (document.querySelector('dl.browser-wallet__facts')?.textContent ?? '').replace(
      /\s+/g,
      ' ',
    )

    expect(reviewText).toContain(MULTISIG_ADDRESS)
    expect(reviewText).toContain(String(SEPOLIA_CHAIN_ID))
    expect(reviewText).toContain(ACCOUNT)
    expect(reviewText).toContain(DESTINATION)
    expect(reviewText).toContain('1000000000000000000 wei')
    expect(reviewText).toContain('0xdeadbeef')
    expect(reviewText).toContain(`${EXECUTE_SELECTOR}${word(0n)}`)

    // The evidence that a threshold was met, and the block it was met at.
    expect(reviewText).toContain('6099914')
    expect(reviewText).toContain('2 of 2 owners')
    expect(reviewText).toContain('2 of 2 owners, as the contract reported')

    // What this action can do, said plainly.
    const warning = screen.getByRole('note').textContent ?? ''

    expect(warning).toContain('can move funds or run code in another contract')
    expect(warning).toContain('does not decode calldata')
  })

  it('will not open the wallet until the review is acknowledged', async () => {
    const { fake, user } = await renderRow()

    await reachReview(user)

    expect(openButton().disabled).toBe(true)
    expect(acknowledgement().checked).toBe(false)

    const label = screen.getByText(/I have read the destination, the value and the calldata above/)

    expect(label).toBeDefined()

    await user.click(acknowledgement())

    expect(openButton().disabled).toBe(false)

    await user.click(openButton())

    await screen.findByText(/The wallet returned the transaction hash/)

    expect(sends(fake)).toHaveLength(1)
  })

  it('forgets an acknowledgement when the review is left and re-entered', async () => {
    const { fake, user } = await renderRow()

    await reachReview(user)
    await user.click(acknowledgement())

    expect(openButton().disabled).toBe(false)

    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    await waitFor(() => {
      expect(checkButton().disabled).toBe(false)
    })

    await user.click(checkButton())
    await screen.findByRole('button', { name: 'Open wallet and execute' })

    // A second attempt starts unacknowledged: the tick was for the review that
    // was left, not for every review this row will ever show.
    expect(acknowledgement().checked).toBe(false)
    expect(openButton().disabled).toBe(true)
    expect(sends(fake)).toHaveLength(0)
  })

  it('sends one execution of this index, with no value, only after acknowledgement', async () => {
    const { fake, user } = await renderRow()

    await acknowledged(user)
    await user.click(openButton())

    await screen.findByText(/The wallet returned the transaction hash/)

    const sent = sends(fake)

    expect(sent).toHaveLength(1)

    const params = (sent[0]!.params as [Record<string, string>])[0]

    expect(params.to).toBe(MULTISIG_ADDRESS)
    expect(params.value).toBe('0x0')
    expect(params.data).toBe(`${EXECUTE_SELECTOR}${word(0n)}`)
    expect(params.from?.toLowerCase()).toBe(ACCOUNT.toLowerCase())
  })

  it('sends nothing when the review is cancelled', async () => {
    const { fake, user } = await renderRow()

    await acknowledged(user)
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(sends(fake)).toHaveLength(0)
  })

  it('sends once when the button is pressed twice', async () => {
    const sending = deferred<unknown>()
    const { fake, user } = await renderRow({}, { send: () => sending.promise })

    await acknowledged(user)

    const button = openButton()

    await user.click(button)
    await user.click(button)

    sending.resolve(HASH)

    await screen.findByText(/The wallet returned the transaction hash/)

    expect(sends(fake)).toHaveLength(1)
  })

  it('refuses before the review when the confirmations are short of the threshold', async () => {
    const { fake, user } = await renderRow({
      confirmations: { [OWNER_A.toLowerCase()]: `0x${word(1n)}`, [OWNER_B.toLowerCase()]: `0x${word(0n)}` },
    })

    await waitFor(() => {
      expect(checkButton().disabled).toBe(false)
    })

    await user.click(checkButton())

    expect((await screen.findByRole('alert')).textContent).toBe(
      'This proposal has 1 of the 2 confirmations this contract requires, so it cannot be executed yet.',
    )
    expect(screen.queryByRole('button', { name: 'Open wallet and execute' })).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(sends(fake)).toHaveLength(0)
  })

  it('refuses a threshold the owner list cannot support, before counting anything', async () => {
    const { fake, user } = await renderRow({ threshold: `0x${word(3n)}` })

    await waitFor(() => {
      expect(checkButton().disabled).toBe(false)
    })

    await user.click(checkButton())

    expect((await screen.findByRole('alert')).textContent).toContain(
      'not a configuration this app can believe',
    )
    // The implausible configuration is refused without one read per owner.
    expect(callsAt(fake).filter((call) => call.selector === IS_CONFIRMED)).toHaveLength(0)
    expect(sends(fake)).toHaveLength(0)
  })

  it('refuses an owner list past the cap without issuing a read per owner', async () => {
    const many = Array.from({ length: 33 }, (_, position) => `0x${String(position + 1).padStart(40, '0')}`)
    const { fake, user } = await renderRow({ owners: ownersWord(many), threshold: `0x${word(1n)}` })

    await waitFor(() => {
      expect(checkButton().disabled).toBe(false)
    })

    await user.click(checkButton())

    expect((await screen.findByRole('alert')).textContent).toContain('at most 32')
    expect(callsAt(fake).filter((call) => call.selector === IS_CONFIRMED)).toHaveLength(0)
    expect(sends(fake)).toHaveLength(0)
  })

  it('refuses a block number it cannot read, without reading anything else', async () => {
    const { fake, user } = await renderRow({ block: '6100042' })

    await waitFor(() => {
      expect(checkButton().disabled).toBe(false)
    })

    await user.click(checkButton())

    expect((await screen.findByRole('alert')).textContent).toBe(
      'The chain did not answer with a block number this app can read, so nothing was sent.',
    )
    expect(callsAt(fake)).toHaveLength(0)
    expect(sends(fake)).toHaveLength(0)
  })

  it('refuses a malformed answer without repeating anything the provider said', async () => {
    const { fake, user } = await renderRow({ owners: '0x1234' })

    await waitFor(() => {
      expect(checkButton().disabled).toBe(false)
    })

    await user.click(checkButton())

    expect((await screen.findByRole('alert')).textContent).toBe(
      'The contract answered with data this app cannot read, so nothing was sent.',
    )
    expect(sends(fake)).toHaveLength(0)
  })

  it('refuses a confirmation answer that is not a boolean', async () => {
    const { user } = await renderRow({
      confirmations: { [OWNER_A.toLowerCase()]: `0x${word(2n)}` },
    })

    await waitFor(() => {
      expect(checkButton().disabled).toBe(false)
    })

    await user.click(checkButton())

    expect((await screen.findByRole('alert')).textContent).toBe(
      'The contract answered with data this app cannot read, so nothing was sent.',
    )
  })

  it('refuses an account that is not an owner', async () => {
    const { fake, user } = await renderRow({ isOwner: `0x${word(0n)}` })

    await waitFor(() => {
      expect(checkButton().disabled).toBe(false)
    })

    await user.click(checkButton())

    expect((await screen.findByRole('alert')).textContent).toContain('not an owner')
    expect(sends(fake)).toHaveLength(0)
  })

  it('refuses an index the contract does not hold', async () => {
    const { user } = await renderRow({ count: `0x${word(1n)}` }, {}, {
      event: { ...EVENT, multisigTxIndex: '1' } as ContractEvent,
    })

    await waitFor(() => {
      expect(checkButton().disabled).toBe(false)
    })

    await user.click(checkButton())

    expect((await screen.findByRole('alert')).textContent).toContain('no proposal at this index')
  })

  it('refuses a proposal that was already executed', async () => {
    const { user } = await renderRow({ proposal: proposalWord({ executed: true }) })

    await waitFor(() => {
      expect(checkButton().disabled).toBe(false)
    })

    await user.click(checkButton())

    expect((await screen.findByRole('alert')).textContent).toContain('already been executed')
  })

  it('refuses when the contract record is not the indexed event', async () => {
    const { user } = await renderRow({
      proposal: proposalWord({ to: '0x00000000000000000000000000000000000000ff' }),
    })

    await waitFor(() => {
      expect(checkButton().disabled).toBe(false)
    })

    await user.click(checkButton())

    expect((await screen.findByRole('alert')).textContent).toContain(
      'does not match the indexed event',
    )
  })

  it('refuses a read that reverts, in this app own words', async () => {
    const { user } = await renderRow({
      proposal: () => {
        throw Object.assign(new Error('execution reverted: MultiSigWallet__TxDoesNotExist'), {
          code: -32603,
        })
      },
    })

    await waitFor(() => {
      expect(checkButton().disabled).toBe(false)
    })

    await user.click(checkButton())

    const alert = await screen.findByRole('alert')

    expect(alert.textContent).not.toContain('MultiSigWallet__TxDoesNotExist')
    expect(alert.textContent).not.toContain('execution reverted')
  })

  it('never offers execution on another chain, and reads nothing', async () => {
    const { fake } = await renderRow({}, { chain: '0x1' })

    await waitFor(() => {
      expect(screen.getByText(/Executing is not available/).textContent).toContain('chain 1')
    })

    expect(checkButton().disabled).toBe(true)
    expect(fake.requested).not.toContain('eth_blockNumber')
    expect(fake.requested).not.toContain('eth_call')
  })

  it('never offers execution on a contract that is not the verified deployment', async () => {
    const { fake } = await renderRow({}, {}, {
      contract: { ...CONTRACT, address: '0x00000000000000000000000000000000000000ff' },
    })

    expect(screen.getByText(/Cannot execute:/).textContent).toContain(
      'verified Sepolia multisig contract',
    )
    expect(screen.queryByRole('button', { name: 'Check execution' })).toBeNull()
    expect(fake.requested).not.toContain('eth_blockNumber')
  })

  it('names no proposal for a row whose index this app cannot read', async () => {
    const { fake } = await renderRow({}, {}, {
      event: { ...EVENT, multisigTxIndex: 'one' } as ContractEvent,
    })

    expect(screen.getByText(/Cannot execute:/).textContent).toContain(
      'does not name a proposal this app can read',
    )
    expect(fake.requested).not.toContain('eth_call')
  })

  it('sends nothing when the account changes between the review and the press', async () => {
    const { fake, user, live } = await renderRow()

    await acknowledged(user)

    live.accounts = [OWNER_A]
    fake.emit('accountsChanged', [OWNER_A])

    await waitFor(() => {
      expect(screen.getByTestId('wallet').textContent).toBe(`${OWNER_A}:${SEPOLIA_CHAIN_ID}`)
    })

    expect(screen.queryByRole('button', { name: 'Open wallet and execute' })).toBeNull()
    expect(sends(fake)).toHaveLength(0)
  })

  it('sends nothing when the chain changes between the review and the press', async () => {
    const { fake, user, live } = await renderRow()

    await acknowledged(user)

    live.chain = '0x1'
    fake.emit('chainChanged', '0x1')

    await waitFor(() => {
      expect(screen.getByText(/Executing is not available/).textContent).toContain('chain 1')
    })

    expect(screen.queryByRole('button', { name: 'Open wallet and execute' })).toBeNull()
    expect(sends(fake)).toHaveLength(0)
  })

  it('drops a preflight answer that lands after the wallet moved', async () => {
    const threshold = deferred<unknown>()

    const { fake, user } = await renderRow({ threshold: () => threshold.promise })

    await waitFor(() => {
      expect(checkButton().disabled).toBe(false)
    })

    await user.click(checkButton())

    await screen.findByText(/Reading the proposal and its confirmations/)

    fake.emit('accountsChanged', [OWNER_A])

    threshold.resolve(`0x${word(1n)}`)

    await waitFor(() => {
      expect(screen.getByTestId('wallet').textContent).toBe(`${OWNER_A}:${SEPOLIA_CHAIN_ID}`)
    })

    expect(screen.queryByRole('button', { name: 'Open wallet and execute' })).toBeNull()
    expect(screen.queryByText(/Reading the proposal and its confirmations/)).toBeNull()
    expect(sends(fake)).toHaveLength(0)
  })

  it('reports a declined execution without claiming nothing was sent', async () => {
    const { fake, user } = await renderRow({}, {
      send: () => {
        throw Object.assign(new Error('User rejected the request.'), { code: 4001 })
      },
    })

    await acknowledged(user)
    await user.click(openButton())

    expect((await screen.findByRole('alert')).textContent).toBe(
      'The execution was declined in the wallet.',
    )
    expect(screen.getByText(/does not prove that nothing was sent/)).toBeDefined()
    expect(sends(fake)).toHaveLength(1)
  })

  it('labels an unreadable send outcome as unknown rather than resending', async () => {
    const { fake, user } = await renderRow({}, { send: () => ({ ok: true }) })

    await acknowledged(user)
    await user.click(openButton())

    expect((await screen.findByRole('alert')).textContent).toContain(
      'did not answer with a transaction hash',
    )
    expect(screen.getByText(/cannot tell whether the wallet sent this execution/)).toBeDefined()
    expect(sends(fake)).toHaveLength(1)
  })

  it('checks the receipt by hand, then looks for this execution in the refreshed page', async () => {
    const matching = {
      ...EVENT,
      eventName: 'ExecuteTransaction',
      transactionHash: HASH,
      actorAddress: ACCOUNT,
      multisigTxIndex: '0',
      blockNumber: 6_100_100,
    } as ContractEvent

    const onRefreshEvents = vi.fn(async () => ({ events: [matching], page: 2 }))

    const { user } = await renderRow({}, { receipt: RECEIPT }, { onRefreshEvents })

    await acknowledged(user)
    await user.click(openButton())
    await screen.findByText(/The wallet returned the transaction hash/)

    expect(screen.queryByText(/included in block/)).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Check receipt' }))

    const note = await screen.findByText(/the contract ran this proposal/)

    expect(note.textContent).toContain('the call did not revert')

    await user.click(screen.getByRole('button', { name: 'Refresh indexed events' }))

    const found = await screen.findByText(/shows the ExecuteTransaction event/)

    expect(found.textContent).toContain('6100100')
    expect(onRefreshEvents).toHaveBeenCalledTimes(1)
  })

  it('does not read another owner event as this execution', async () => {
    const confirmation = {
      ...EVENT,
      eventName: 'ConfirmTransaction',
      transactionHash: HASH,
      actorAddress: ACCOUNT,
      multisigTxIndex: '0',
    } as ContractEvent

    const { user } = await renderRow({}, { receipt: RECEIPT }, {
      onRefreshEvents: async () => ({ events: [confirmation], page: 5 }),
    })

    await acknowledged(user)
    await user.click(openButton())
    await screen.findByText(/The wallet returned the transaction hash/)
    await user.click(screen.getByRole('button', { name: 'Check receipt' }))
    await screen.findByText(/the contract ran this proposal/)
    await user.click(screen.getByRole('button', { name: 'Refresh indexed events' }))

    const absent = await screen.findByText(/not on the refreshed page \(page 5\)/)

    expect(absent.textContent).toContain('does not mean the contract emitted nothing')
  })

  it('reports a failed refresh as a failed refresh', async () => {
    const { user } = await renderRow({}, { receipt: RECEIPT }, {
      onRefreshEvents: async () => null,
    })

    await acknowledged(user)
    await user.click(openButton())
    await screen.findByText(/The wallet returned the transaction hash/)
    await user.click(screen.getByRole('button', { name: 'Check receipt' }))
    await screen.findByText(/the contract ran this proposal/)
    await user.click(screen.getByRole('button', { name: 'Refresh indexed events' }))

    expect((await screen.findByText(/could not be read again/)).textContent).toBe(
      'The current page of indexed events could not be read again.',
    )
    expect(screen.queryByText(/shows the ExecuteTransaction event/)).toBeNull()
  })

  it('says a reverted execution did not run the proposal', async () => {
    const { user } = await renderRow({}, { receipt: { ...RECEIPT, status: '0x0' } })

    await acknowledged(user)
    await user.click(openButton())
    await screen.findByText(/The wallet returned the transaction hash/)
    await user.click(screen.getByRole('button', { name: 'Check receipt' }))

    const reverted = await screen.findByText(/did not execute this proposal/)

    expect(reverted.textContent).toContain('The contract reports no reason')
    expect(reverted.textContent).not.toContain('did not submit the proposal')
  })

  it('draws no receipt check before a hash exists', async () => {
    const { user } = await renderRow()

    await reachReview(user)

    expect(screen.queryByRole('heading', { name: 'Receipt' })).toBeNull()
  })
})
