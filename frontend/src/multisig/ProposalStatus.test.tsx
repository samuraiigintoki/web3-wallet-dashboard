import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'

import type { ContractEvent } from '../api/index.ts'
import { MULTISIG_ADDRESS, SEPOLIA_CHAIN_ID } from '../provider/multisig.ts'
import { useBrowserWallet } from '../provider/useBrowserWallet.ts'
import {
  deferred,
  installFakeProvider,
  removeFakeProvider,
  type FakeProvider,
} from '../test/fakeProvider.ts'
import { ProposalStatus } from './ProposalStatus.tsx'
import type { SubmitTarget } from './useSubmitTransaction.ts'

/**
 * The live status control as the user meets it.
 *
 * The stub answers `eth_blockNumber` and every `eth_call` by selector, and it
 * records the block tag of each call, because the anchor is what makes the
 * snapshot a snapshot. It refuses to answer anything else, so a test that would
 * let this control send a transaction fails on the unknown method rather than
 * passing quietly.
 */

const OWNER_A = '0x14912965632cd9ab70c046e8d23e9b8dfa9f2746'
const OWNER_B = '0x1e1d0e1d0e1d0e1d0e1d0e1d0e1d0e1d0e1d0e1d'
const STRANGER = '0x00c0ffee00000000000000000000000000000009'
const DESTINATION = OWNER_A
const SEPOLIA_HEX = `0x${SEPOLIA_CHAIN_ID.toString(16)}`
const BLOCK = '0x5d13ca'
const BLOCK_DECIMAL = '6099914'

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

  return [
    '0x',
    addressWord(to),
    word(value),
    word(128n),
    word(parts.executed === true ? 1n : 0n),
    word(BigInt(bytes)),
    data.padEnd(Math.ceil(bytes / 32) * 64, '0'),
  ].join('')
}

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
  multisigTxIndex: '3',
  payload: PAYLOAD,
} as ContractEvent

type Answer = string | (() => unknown)

type Reads = {
  block?: Answer
  isOwner?: Answer
  count?: Answer
  proposal?: Answer
  owners?: Answer
  threshold?: Answer
  confirmations?: Record<string, Answer>
}

type Chain = {
  accounts: string[]
  chain: string
}

function answered(value: Answer | undefined, fallback: string): unknown {
  if (value === undefined) {
    return fallback
  }

  return typeof value === 'function' ? value() : value
}

function stub(reads: Reads = {}, chain: Partial<Chain> = {}): {
  fake: FakeProvider
  live: Chain
} {
  const live: Chain = {
    accounts: [OWNER_A],
    chain: SEPOLIA_HEX,
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

      if (method === 'eth_call') {
        const data = (params as [{ data: string }, string])[0].data

        if (data.startsWith(IS_OWNER)) {
          return answered(reads.isOwner, `0x${word(1n)}`)
        }

        if (data.startsWith(TRANSACTION_COUNT)) {
          return answered(reads.count, `0x${word(9n)}`)
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

          return answered(answers[owner], `0x${word(owner === OWNER_A ? 1n : 0n)}`)
        }

        throw new Error(`unexpected call ${data}`)
      }

      // Deliberately loud: this control may only read.
      throw new Error(`the status control must not call ${method}`)
    },
  })

  return { fake, live }
}

function Harness({
  contract = CONTRACT,
  event = EVENT,
}: {
  contract?: SubmitTarget
  event?: ContractEvent
}) {
  const wallet = useBrowserWallet()

  return (
    <>
      <p data-testid="wallet">
        {wallet.state.status === 'connected'
          ? `${wallet.state.account}:${String(wallet.state.chainId)}`
          : wallet.state.status}
      </p>
      <ProposalStatus contract={contract} event={event} wallet={wallet.state} />
    </>
  )
}

async function open(
  reads: Reads = {},
  chain: Partial<Chain> = {},
  expected: string | null = null,
): Promise<{
  fake: FakeProvider
  live: Chain
  user: ReturnType<typeof userEvent.setup>
  unmount: () => void
}> {
  const { fake, live } = stub(reads, chain)
  const user = userEvent.setup()

  const view = render(<Harness />)

  const want = expected ?? 'connected'

  await waitFor(() => {
    const shown = screen.getByTestId('wallet').textContent ?? ''

    expect(want === 'connected' ? shown.toLowerCase() : shown).toContain(
      want === 'connected' ? OWNER_A.toLowerCase() : want,
    )
  })

  return { fake, live, user, unmount: view.unmount }
}

function callsAt(fake: FakeProvider): { selector: string; tag: string }[] {
  return fake.calls
    .filter((call) => call.method === 'eth_call')
    .map((call) => {
      const [request, tag] = call.params as [{ data: string }, string]

      return { selector: request.data.slice(0, 10), tag }
    })
}

afterEach(() => {
  removeFakeProvider()
})

describe('a live status read', () => {
  it('reads nothing until the user asks', async () => {
    const { fake } = await open()

    expect(fake.requested).not.toContain('eth_blockNumber')
    expect(fake.requested).not.toContain('eth_call')
    expect(screen.getByRole('button', { name: 'Check live status' })).toBeDefined()
  })

  it('asks for the block first and anchors every read to it', async () => {
    const { fake, user } = await open()

    await user.click(screen.getByRole('button', { name: 'Check live status' }))

    await screen.findByText(/Snapshot block/)

    // The block read is the first provider request of the read itself, and every
    // contract read after it carries that block as its tag: the count, the tuple,
    // the owners, the threshold, one confirmation per owner, then ownership.
    const reads = fake.requested.filter((method) => method === 'eth_call' || method === 'eth_blockNumber')

    expect(reads[0]).toBe('eth_blockNumber')
    expect(callsAt(fake).map((call) => call.tag)).toEqual(Array(7).fill(BLOCK))
    expect(callsAt(fake).map((call) => call.selector)).toEqual([
      TRANSACTION_COUNT,
      TRANSACTIONS,
      GET_OWNERS,
      THRESHOLD,
      IS_CONFIRMED,
      IS_CONFIRMED,
      IS_OWNER,
    ])
  })

  it('shows the snapshot, the count and the threshold for a proposal that is not yet confirmed', async () => {
    const { user } = await open()

    await user.click(screen.getByRole('button', { name: 'Check live status' }))

    const facts = (await screen.findByText('Snapshot block')).closest('dl')!.textContent ?? ''

    expect(facts).toContain(BLOCK_DECIMAL)
    expect(facts).toContain('3')
    expect(facts).toContain(DESTINATION)
    expect(facts).toContain('1000000000000000000')
    expect(facts).toContain('0xdeadbeef')
    expect(facts).toContain('Not executed at this block')
    expect(facts).toContain('2')
    expect(facts).toContain('1 of 2 owners, with 2 required')

    expect(
      screen.getByText(
        `This proposal has 1 of the 2 confirmations this contract requires at block ${BLOCK_DECIMAL}.`,
      ),
    ).toBeDefined()
    expect(
      screen.getByText(`The contract reported a confirmation from ${OWNER_A} at block ${BLOCK_DECIMAL}.`),
    ).toBeDefined()
    expect(
      screen.getByText(
        `The contract reported no confirmation from ${OWNER_B} at block ${BLOCK_DECIMAL}.`,
      ),
    ).toBeDefined()
  })

  it('says a met threshold could be executed here, and that it promises nothing about the call', async () => {
    const { user } = await open({ confirmations: { [OWNER_A]: `0x${word(1n)}`, [OWNER_B]: `0x${word(1n)}` } })

    await user.click(screen.getByRole('button', { name: 'Check live status' }))

    const sentence = (
      await screen.findByText(/could be executed from here/)
    ).textContent

    expect(sentence).toBe(
      `This proposal has 2 of the 2 confirmations this contract requires at block ${BLOCK_DECIMAL}, so it could be executed from here. That does not mean the call it makes would succeed, and a later block may say something else.`,
    )

    // All owners confirmed, so there is no "no confirmation from" list.
    expect(screen.queryByText(/reported no confirmation from/)).toBeNull()
  })

  it('reports an executed proposal as executed, without hiding the confirmation facts', async () => {
    const { user } = await open({ proposal: proposalWord({ executed: true }) })

    await user.click(screen.getByRole('button', { name: 'Check live status' }))

    const facts = (await screen.findByText('Snapshot block')).closest('dl')!.textContent ?? ''

    expect(facts).toContain('Executed at this block')
    expect(
      screen.getByText(
        `The contract reports this proposal as executed at block ${BLOCK_DECIMAL}, so it cannot be executed again.`,
      ),
    ).toBeDefined()
  })

  it('attributes the viewer as a confirming owner, a non-confirming owner, and a stranger', async () => {
    const confirming = await open()
    await confirming.user.click(screen.getByRole('button', { name: 'Check live status' }))

    expect(
      await screen.findByText(
        'Your account is one of the owners, and the contract reported its confirmation at this block.',
      ),
    ).toBeDefined()

    confirming.unmount()
    removeFakeProvider()

    const absent = await open({
      confirmations: { [OWNER_A]: `0x${word(0n)}`, [OWNER_B]: `0x${word(1n)}` },
    })
    await absent.user.click(screen.getByRole('button', { name: 'Check live status' }))

    expect(
      await screen.findByText(
        'Your account is one of the owners, and the contract reported no confirmation from it at this block.',
      ),
    ).toBeDefined()

    absent.unmount()
    removeFakeProvider()

    const stranger = await open(
      { isOwner: `0x${word(0n)}` },
      { accounts: [STRANGER] },
      STRANGER,
    )
    await stranger.user.click(screen.getByRole('button', { name: 'Check live status' }))

    expect(
      await screen.findByText(
        'Your account is not an owner of this contract, so it cannot confirm or execute this proposal.',
      ),
    ).toBeDefined()

    // A stranger still gets the count: the status is about the proposal, not
    // about who is looking.
    expect(screen.getByText(/1 of the 2 confirmations this contract requires/)).toBeDefined()
  })

  it('says the index names no live proposal, and never asks for that tuple', async () => {
    const { fake, user } = await open({ count: `0x${word(1n)}` })

    await user.click(screen.getByRole('button', { name: 'Check live status' }))

    expect(
      await screen.findByText(
        `At block ${BLOCK_DECIMAL} the contract held 1 proposals, so index 3 names no live proposal.`,
      ),
    ).toBeDefined()

    expect(callsAt(fake).map((call) => call.selector)).toEqual([TRANSACTION_COUNT])
  })

  it('refuses a tuple that is not this row, and reads no confirmation for it', async () => {
    const { fake, user } = await open({ proposal: proposalWord({ data: '0xfeedface', valueWei: 1n }) })

    await user.click(screen.getByRole('button', { name: 'Check live status' }))

    expect((await screen.findByRole('alert')).textContent).toBe(
      "The contract's record of this proposal does not match the indexed event, so this app will not present it as this row's live status.",
    )

    expect(callsAt(fake).map((call) => call.selector)).toEqual([
      TRANSACTION_COUNT,
      TRANSACTIONS,
      GET_OWNERS,
      THRESHOLD,
    ])
    expect(screen.queryByText(/Snapshot block/)).toBeNull()
  })

  it('refuses more than 32 owners before reading a single confirmation', async () => {
    const owners = Array.from({ length: 33 }, (_, index) => `0x${String(index + 1).padStart(40, '0')}`)
    const { fake, user } = await open({ owners: ownersWord(owners), threshold: `0x${word(1n)}` })

    await user.click(screen.getByRole('button', { name: 'Check live status' }))

    expect((await screen.findByRole('alert')).textContent).toBe(
      'The contract reports 33 owners, and this app will only read the status of a contract with at most 32.',
    )
    expect(fake.requested.filter((method) => method === 'eth_call')).toHaveLength(4)
  })

  it('fails closed on an unreadable block number, with no contract read at all', async () => {
    const { fake, user } = await open({ block: '0x00ff' })

    await user.click(screen.getByRole('button', { name: 'Check live status' }))

    expect((await screen.findByRole('alert')).textContent).toBe(
      'The chain did not answer with a block number this app can read, so no live status was read.',
    )
    expect(fake.requested).not.toContain('eth_call')
  })

  it('fails closed on unreadable contract answers, in this read’s words', async () => {
    for (const reads of [{ count: '0x01' }, { proposal: '0x' }, { owners: `0x${'0'.repeat(64)}` }]) {
      const view = await open(reads)

      await view.user.click(screen.getByRole('button', { name: 'Check live status' }))

      expect((await screen.findByRole('alert')).textContent).toBe(
        'The contract answered with data this app cannot read, so no live status is shown.',
      )

      view.unmount()
      removeFakeProvider()
    }
  })

  it('sanitises a provider failure rather than drawing its text', async () => {
    const { user } = await open({
      count: () => {
        throw new Error('429 rate limited by the RPC provider at https://example.invalid')
      },
    })

    await user.click(screen.getByRole('button', { name: 'Check live status' }))

    const alert = (await screen.findByRole('alert')).textContent ?? ''

    expect(alert).not.toContain('example.invalid')
    expect(alert).not.toContain('429')
    expect(alert.length).toBeGreaterThan(0)
  })

  it('reads again only when the user asks again, and clears without reading', async () => {
    const { fake, user } = await open()

    await user.click(screen.getByRole('button', { name: 'Check live status' }))
    await screen.findByText(/Snapshot block/)

    expect(fake.requested.filter((method) => method === 'eth_blockNumber')).toHaveLength(1)

    await user.click(screen.getByRole('button', { name: 'Check again' }))
    await screen.findByText(/Snapshot block/)

    expect(fake.requested.filter((method) => method === 'eth_blockNumber')).toHaveLength(2)

    await user.click(screen.getByRole('button', { name: 'Done' }))

    expect(screen.queryByText(/Snapshot block/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Check live status' })).toBeDefined()
    // Clearing is not a read.
    expect(fake.requested.filter((method) => method === 'eth_blockNumber')).toHaveLength(2)
  })

  it('never prompts the wallet and never sends', async () => {
    const { fake, user } = await open()

    await user.click(screen.getByRole('button', { name: 'Check live status' }))
    await screen.findByText(/Snapshot block/)

    expect(fake.requested).not.toContain('eth_requestAccounts')
    expect(fake.requested).not.toContain('eth_sendTransaction')
    expect(fake.requested).not.toContain('eth_sign')
  })
})

describe('the live status control under a moving wallet', () => {
  it('offers nothing off Sepolia, and reads nothing there', async () => {
    const { fake } = await open({}, { chain: '0x1' })

    const button = screen.getByRole('button', { name: 'Check live status' })

    expect(button).toHaveProperty('disabled', true)
    expect(screen.getByText(/Live status is not available\./)).toBeDefined()
    expect(fake.requested).not.toContain('eth_blockNumber')
  })

  it('offers nothing until a wallet is connected', async () => {
    const { fake } = await open({}, { accounts: [] }, 'disconnected')

    expect(screen.getByRole('button', { name: 'Check live status' })).toHaveProperty(
      'disabled',
      true,
    )
    expect(
      screen.getByText('Connect a wallet on Sepolia to read this proposal from the contract.'),
    ).toBeDefined()
    expect(fake.requested).not.toContain('eth_blockNumber')
  })

  it('drops a result when the account moves', async () => {
    const { fake, live, user } = await open()

    await user.click(screen.getByRole('button', { name: 'Check live status' }))
    await screen.findByText(/Snapshot block/)

    live.accounts = [STRANGER]

    fake.emit('accountsChanged', [STRANGER])

    await waitFor(() => {
      expect(screen.queryByText(/Snapshot block/)).toBeNull()
    })

    expect(screen.getByRole('button', { name: 'Check live status' })).toBeDefined()
  })

  it('drops a result when the chain moves', async () => {
    const { fake, live, user } = await open()

    await user.click(screen.getByRole('button', { name: 'Check live status' }))
    await screen.findByText(/Snapshot block/)

    live.chain = '0x1'

    fake.emit('chainChanged', '0x1')

    await waitFor(() => {
      expect(screen.queryByText(/Snapshot block/)).toBeNull()
    })
  })

  it('retires an answer that lands after the account moved, even if it moves back', async () => {
    const held = deferred()

    const { fake, live, user } = await open({ count: () => held.promise })

    await user.click(screen.getByRole('button', { name: 'Check live status' }))

    // Away from the account that asked, and back again: the stamp matches the one
    // this answer was requested under, so only the attempt itself can retire it.
    live.accounts = [STRANGER]
    fake.emit('accountsChanged', [STRANGER])

    await waitFor(() => {
      expect(screen.getByTestId('wallet').textContent?.toLowerCase()).toContain(
        STRANGER.toLowerCase(),
      )
    })

    live.accounts = [OWNER_A]
    fake.emit('accountsChanged', [OWNER_A])

    await waitFor(() => {
      expect(screen.getByTestId('wallet').textContent?.toLowerCase()).toContain(
        OWNER_A.toLowerCase(),
      )
    })

    held.resolve(`0x${word(9n)}`)

    // An answer read for a wallet that has since moved describes nothing in front
    // of the user now, so it is neither drawn nor kept.
    await waitFor(() => {
      expect(fake.requested.filter((method) => method === 'eth_blockNumber').length).toBe(1)
    })

    expect(screen.queryByText(/Snapshot block/)).toBeNull()
    expect(screen.queryByText(/no live proposal/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Check live status' })).toBeDefined()
  })
})

describe('where the control is offered', () => {
  it('reads nothing for a contract this app cannot vouch for', async () => {
    const { fake } = stub()

    render(
      <Harness
        contract={{ ...CONTRACT, address: '0x00000000000000000000000000000000000000ff' }}
      />,
    )

    expect(
      screen.getByText(
        'Cannot show live status: Live status is only available on the verified Sepolia multisig contract.',
      ),
    ).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Check live status' })).toBeNull()
    expect(fake.requested).not.toContain('eth_blockNumber')
    expect(fake.requested).not.toContain('eth_call')
  })

  it('reads nothing for a row that is not a submission', async () => {
    const { fake } = stub()

    render(<Harness event={{ ...EVENT, eventName: 'ConfirmTransaction' }} />)

    expect(
      screen.getByText(
        'Cannot show live status: Only a submitted proposal has a live status this app can read.',
      ),
    ).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Check live status' })).toBeNull()
    expect(fake.requested).not.toContain('eth_blockNumber')
  })
})
