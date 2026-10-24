import { describe, expect, it } from 'vitest'

import type { SubmitTransactionPayload } from '../api/index.ts'
import { MULTISIG_ADDRESS, SEPOLIA_CHAIN_ID } from '../provider/multisig.ts'
import type { ActionReadContext } from './useMultisigAction.ts'
import {
  checkStatusEligibility,
  evaluateStatus,
  runStatus,
  STATUS_MALFORMED,
  statusGate,
  type StatusReads,
} from './status.ts'

/**
 * The status read, judged on its own.
 *
 * Everything here is about the contract's answers, so the reads are handed to
 * `evaluateStatus` directly and `runStatus` is exercised against a context that
 * records what it was asked. No provider, no React: what is being pinned is the
 * order of the reads, the anchor they carry, and which answer means which
 * sentence.
 */

const OWNER_A = '0x14912965632cd9ab70c046e8d23e9b8dfa9f2746'
const OWNER_B = '0x1e1d0e1d0e1d0e1d0e1d0e1d0e1d0e1d0e1d0e1d'
const VIEWER = '0x00c0ffee00000000000000000000000000000001'
const DESTINATION = '0x14912965632cd9ab70c046e8d23e9b8dfa9f2746'

const PAYLOAD: SubmitTransactionPayload = {
  to: DESTINATION,
  valueWei: '1000000000000000000',
  data: '0xdeadbeef',
}

const PROPOSAL = {
  to: DESTINATION,
  valueWei: 1_000_000_000_000_000_000n,
  data: '0xdeadbeef',
  executed: false,
}

function reads(overrides: Partial<StatusReads> = {}): StatusReads {
  return {
    block: 6_099_914n,
    transactionCount: 9n,
    proposal: PROPOSAL,
    owners: [OWNER_A, OWNER_B],
    threshold: 2n,
    confirmations: [true, false],
    viewerIsOwner: true,
    account: OWNER_A,
    ...overrides,
  }
}

describe('evaluateStatus', () => {
  it('reports one proposal as the contract held it, with the count and the threshold', () => {
    const outcome = evaluateStatus(reads(), 3n, PAYLOAD)

    expect(outcome.kind).toBe('live')

    if (outcome.kind !== 'live') {
      throw new Error('unreachable')
    }

    expect(outcome.status.blockText).toBe('6099914')
    expect(outcome.status.indexText).toBe('3')
    expect(outcome.status.executed).toBe(false)
    expect(outcome.status.confirmedCount).toBe(1)
    expect(outcome.status.threshold).toBe(2n)
    expect(outcome.status.thresholdMet).toBe(false)
    expect(outcome.status.owners).toEqual([OWNER_A, OWNER_B])
    expect(outcome.status.confirmations).toEqual([
      { owner: OWNER_A, confirmed: true },
      { owner: OWNER_B, confirmed: false },
    ])
  })

  it('reports a threshold that is met at the block, and says only that', () => {
    const outcome = evaluateStatus(
      reads({ confirmations: [true, true], threshold: 2n }),
      3n,
      PAYLOAD,
    )

    expect(outcome.kind).toBe('live')

    if (outcome.kind !== 'live') {
      throw new Error('unreachable')
    }

    expect(outcome.status.confirmedCount).toBe(2)
    expect(outcome.status.thresholdMet).toBe(true)
  })

  it('counts a threshold of one met by one owner, and above by none', () => {
    const met = evaluateStatus(
      reads({ owners: [OWNER_A], threshold: 1n, confirmations: [true] }),
      3n,
      PAYLOAD,
    )

    expect(met.kind === 'live' && met.status.thresholdMet).toBe(true)

    const above = evaluateStatus(
      reads({ owners: [OWNER_A], threshold: 1n, confirmations: [false] }),
      3n,
      PAYLOAD,
    )

    expect(above.kind === 'live' && above.status.thresholdMet).toBe(false)
    expect(above.kind === 'live' && above.status.confirmedCount).toBe(0)
  })

  it('reports the executed flag rather than refusing it', () => {
    const outcome = evaluateStatus(
      reads({ proposal: { ...PROPOSAL, executed: true } }),
      3n,
      PAYLOAD,
    )

    expect(outcome.kind).toBe('live')

    if (outcome.kind !== 'live') {
      throw new Error('unreachable')
    }

    expect(outcome.status.executed).toBe(true)
  })

  it('names the viewer as an owner who confirmed, and as one who did not', () => {
    const confirmed = evaluateStatus(reads(), 3n, PAYLOAD)
    const notConfirmed = evaluateStatus(
      reads({ confirmations: [false, true], account: OWNER_A }),
      3n,
      PAYLOAD,
    )

    expect(confirmed.kind === 'live' && confirmed.status.viewerIsOwner).toBe(true)
    expect(confirmed.kind === 'live' && confirmed.status.viewerConfirmed).toBe(true)
    expect(notConfirmed.kind === 'live' && notConfirmed.status.viewerIsOwner).toBe(true)
    expect(notConfirmed.kind === 'live' && notConfirmed.status.viewerConfirmed).toBe(false)
  })

  it('compares the viewer by address, not by the case the contract wrote it in', () => {
    const upper = OWNER_A.toUpperCase().replace('0X', '0x')

    const outcome = evaluateStatus(reads({ account: upper }), 3n, PAYLOAD)

    expect(outcome.kind === 'live' && outcome.status.viewerConfirmed).toBe(true)
  })

  it('reports the viewer as not an owner without claiming a confirmation', () => {
    const outcome = evaluateStatus(
      reads({ viewerIsOwner: false, account: '0x00000000000000000000000000000000000000aa' }),
      3n,
      PAYLOAD,
    )

    expect(outcome.kind).toBe('live')

    if (outcome.kind !== 'live') {
      throw new Error('unreachable')
    }

    expect(outcome.status.viewerIsOwner).toBe(false)
    expect(outcome.status.viewerConfirmed).toBe(false)
    expect(outcome.status.confirmedCount).toBe(1)
  })

  it('refuses a tuple that is not the one the indexed row describes', () => {
    const outcome = evaluateStatus(
      reads({ proposal: { ...PROPOSAL, data: '0xfeedface' } }),
      3n,
      PAYLOAD,
    )

    expect(outcome).toEqual({
      kind: 'refused',
      reason:
        "The contract's record of this proposal does not match the indexed event, so this app will not present it as this row's live status.",
    })
  })

  it('refuses a value that differs by one wei, and a destination that differs by one nibble', () => {
    const value = evaluateStatus(
      reads({ proposal: { ...PROPOSAL, valueWei: 999_999_999_999_999_999n } }),
      3n,
      PAYLOAD,
    )
    const destination = evaluateStatus(
      reads({ proposal: { ...PROPOSAL, to: '0x14912965632cd9ab70c046e8d23e9b8dfa9f2747' } }),
      3n,
      PAYLOAD,
    )

    expect(value.kind).toBe('refused')
    expect(destination.kind).toBe('refused')
  })

  it('refuses more than the anchored owner cap, in a sentence that names it', () => {
    const owners = Array.from({ length: 33 }, (_, index) => `0x${String(index).padStart(40, '0')}`)

    const outcome = evaluateStatus(
      reads({ owners, confirmations: [], threshold: 1n }),
      3n,
      PAYLOAD,
    )

    expect(outcome).toEqual({
      kind: 'refused',
      reason:
        'The contract reports 33 owners, and this app will only read the status of a contract with at most 32.',
    })
  })

  it('accepts exactly the cap', () => {
    const owners = Array.from({ length: 32 }, (_, index) => `0x${String(index + 1).padStart(40, '0')}`)

    const outcome = evaluateStatus(
      reads({ owners, confirmations: owners.map(() => true), threshold: 32n }),
      3n,
      PAYLOAD,
    )

    expect(outcome.kind).toBe('live')
    expect(outcome.kind === 'live' && outcome.status.confirmedCount).toBe(32)
  })

  it('refuses an owner and threshold configuration the contract cannot be in', () => {
    const tooHigh = evaluateStatus(reads({ threshold: 3n }), 3n, PAYLOAD)
    const zeroThreshold = evaluateStatus(reads({ threshold: 0n }), 3n, PAYLOAD)
    const duplicate = evaluateStatus(
      reads({ owners: [OWNER_A, OWNER_A], confirmations: [true, true] }),
      3n,
      PAYLOAD,
    )
    const empty = evaluateStatus(reads({ owners: [], confirmations: [], threshold: 1n }), 3n, PAYLOAD)

    for (const outcome of [tooHigh, zeroThreshold, duplicate, empty]) {
      expect(outcome).toEqual({
        kind: 'refused',
        reason:
          "The contract's owner list and threshold are not a configuration this app can believe, so it will not report a live status.",
      })
    }
  })

  it('refuses a confirmation list that does not line up with the owner list', () => {
    const outcome = evaluateStatus(reads({ confirmations: [true] }), 3n, PAYLOAD)

    expect(outcome).toEqual({ kind: 'refused', reason: STATUS_MALFORMED })
  })
})

/** A read context that answers by selector and records every request. */
function context(answers: {
  block?: unknown
  count?: unknown
  proposal?: unknown
  owners?: unknown
  threshold?: unknown
  confirmations?: Record<string, unknown>
  isOwner?: unknown
  index?: bigint
}): { context: ActionReadContext; calls: { data: string; tag?: string }[]; methods: string[] } {
  const calls: { data: string; tag?: string }[] = []
  const methods: string[] = []
  const index = answers.index ?? 3n

  const encode = (name: string, args: readonly unknown[]): string => {
    const head: Record<string, string> = {
      isOwner: '0x2f54bf6e',
      getTransactionCount: '0x2e7700f0',
      transactions: '0x9ace38c2',
      isConfirmed: '0x80f59a65',
    }

    return `${head[name] ?? ''}${args.map((arg) => String(arg)).join(',')}`
  }

  const selectorOf = (data: string): string => data.slice(0, 10)

  const word = (value: bigint): string => `0x${value.toString(16).padStart(64, '0')}`

  const addressWord = (address: string): string =>
    address.replace(/^0x/, '').padStart(64, '0')

  const proposalWord = (executed: boolean): string =>
    [
      '0x',
      addressWord(DESTINATION),
      (1_000_000_000_000_000_000n).toString(16).padStart(64, '0'),
      (128n).toString(16).padStart(64, '0'),
      (executed ? 1n : 0n).toString(16).padStart(64, '0'),
      (4n).toString(16).padStart(64, '0'),
      'deadbeef'.padEnd(64, '0'),
    ].join('')

  const ownersWord = (owners: string[]): string =>
    ['0x', (32n).toString(16).padStart(64, '0'), owners.length.toString(16).padStart(64, '0'), ...owners.map(addressWord)].join('')

  return {
    calls,
    methods,
    context: {
      account: VIEWER,
      index,
      payload: PAYLOAD,
      encode,
      call: async (data: string, tag?: string): Promise<unknown> => {
        calls.push(tag === undefined ? { data } : { data, tag })

        const selector = selectorOf(data)

        if (selector === '0x2e7700f0') {
          return answers.count ?? word(9n)
        }

        if (selector === '0x9ace38c2') {
          return answers.proposal ?? proposalWord(false)
        }

        if (selector === '0xa0e67e2b' || data.startsWith('0xa0e67e2b')) {
          return answers.owners ?? ownersWord([OWNER_A, OWNER_B])
        }

        if (selector === '0x42cde4e8') {
          return answers.threshold ?? word(2n)
        }

        if (selector === '0x80f59a65') {
          const owner = data.split(',')[1] ?? ''
          const map = answers.confirmations ?? {}

          return map[owner] ?? word(owner === OWNER_A ? 1n : 0n)
        }

        if (selector === '0x2f54bf6e') {
          return answers.isOwner ?? word(1n)
        }

        throw new Error(`unexpected call ${data}`)
      },
      request: async (method: string): Promise<unknown> => {
        methods.push(method)

        if (method === 'eth_blockNumber') {
          // Not `??`: a null answer is one of the shapes being refused, so the
          // presence of the key has to be what decides.
          return 'block' in answers ? answers.block : '0x5d13ca'
        }

        throw new Error(`unexpected method ${method}`)
      },
      live: () => true,
    },
  }
}

describe('runStatus', () => {
  it('reads the block first and anchors every contract read to it', async () => {
    const stub = context({})

    const outcome = await runStatus(stub.context)

    expect(stub.methods).toEqual(['eth_blockNumber'])

    // The count, the tuple, the owners, the threshold, one confirmation per
    // owner, and the viewer's ownership: all at the block the node named.
    expect(stub.calls.map((call) => call.tag)).toEqual([
      '0x5d13ca',
      '0x5d13ca',
      '0x5d13ca',
      '0x5d13ca',
      '0x5d13ca',
      '0x5d13ca',
      '0x5d13ca',
    ])
    expect(outcome?.kind).toBe('live')
  })

  it('reads the count before the tuple, so an index past the end is never fetched', async () => {
    const stub = context({ count: `0x${(1n).toString(16).padStart(64, '0')}` })

    const outcome = await runStatus(stub.context)

    expect(outcome).toEqual({
      kind: 'absent',
      blockText: '6099914',
      indexText: '3',
      transactionCount: '1',
    })
    expect(stub.calls.map((call) => call.data.slice(0, 10))).toEqual(['0x2e7700f0'])
  })

  it('treats an empty contract as no live proposal, not as a failure', async () => {
    const stub = context({ count: `0x${'0'.repeat(64)}` })

    const outcome = await runStatus(stub.context)

    expect(outcome?.kind).toBe('absent')
  })

  it('refuses a block number it cannot read, before any contract read', async () => {
    for (const block of ['latest', '6099914', '0x', '0x00ff', 42, null]) {
      const stub = context({ block })
      const outcome = await runStatus(stub.context)

      expect(outcome).toEqual({
        kind: 'refused',
        reason:
          'The chain did not answer with a block number this app can read, so no live status was read.',
      })
      expect(stub.calls).toHaveLength(0)
    }
  })

  it('refuses a malformed count before asking for anything else', async () => {
    const stub = context({ count: '0x01' })

    const outcome = await runStatus(stub.context)

    expect(outcome).toEqual({ kind: 'refused', reason: STATUS_MALFORMED })
    expect(stub.calls).toHaveLength(1)
  })

  it('refuses malformed tuple, owner and threshold answers', async () => {
    for (const answers of [
      { proposal: '0x' },
      { owners: `0x${'0'.repeat(64)}` },
      { threshold: '0x00' },
    ]) {
      const stub = context(answers)

      const outcome = await runStatus(stub.context)

      expect(outcome).toEqual({ kind: 'refused', reason: STATUS_MALFORMED })
    }
  })

  it('refuses a malformed confirmation answer and stops reading the rest', async () => {
    const stub = context({ confirmations: { [OWNER_A]: '0x02' } })

    const outcome = await runStatus(stub.context)

    expect(outcome).toEqual({ kind: 'refused', reason: STATUS_MALFORMED })
    // One confirmation was read and refused; the second owner was not asked.
    expect(stub.calls.filter((call) => call.data.startsWith('0x80f59a65'))).toHaveLength(1)
  })

  it('refuses a malformed ownership answer', async () => {
    const stub = context({ isOwner: '0xff'.padEnd(66, '0') })

    const outcome = await runStatus(stub.context)

    expect(outcome).toEqual({ kind: 'refused', reason: STATUS_MALFORMED })
  })

  it('issues no per-owner read past the owner cap', async () => {
    const owners = Array.from({ length: 33 }, (_, index) => `0x${String(index).padStart(40, '0')}`)
    const stub = context({
      owners: [
        '0x',
        (32n).toString(16).padStart(64, '0'),
        (33n).toString(16).padStart(64, '0'),
        ...owners.map((owner) => owner.replace(/^0x/, '').padStart(64, '0')),
      ].join(''),
    })

    const outcome = await runStatus(stub.context)

    expect(outcome?.kind).toBe('refused')
    expect(stub.calls.filter((call) => call.data.startsWith('0x80f59a65'))).toHaveLength(0)
  })

  it('issues no per-owner read for an implausible configuration', async () => {
    const stub = context({ threshold: `0x${(9n).toString(16).padStart(64, '0')}` })

    const outcome = await runStatus(stub.context)

    expect(outcome?.kind).toBe('refused')
    expect(stub.calls.filter((call) => call.data.startsWith('0x80f59a65'))).toHaveLength(0)
  })

  it('issues no per-owner read for a tuple that does not match the row', async () => {
    const stub = context({ proposal: undefined, index: 3n })
    // A proposal for a different destination, built here so the mismatch is not a
    // decode failure.
    const mismatch = [
      '0x',
      '0'.repeat(24) + '11'.repeat(20),
      (1_000_000_000_000_000_000n).toString(16).padStart(64, '0'),
      (128n).toString(16).padStart(64, '0'),
      (0n).toString(16).padStart(64, '0'),
      (4n).toString(16).padStart(64, '0'),
      'deadbeef'.padEnd(64, '0'),
    ].join('')

    const withMismatch = context({ proposal: mismatch })

    const outcome = await runStatus(withMismatch.context)

    expect(outcome?.kind).toBe('refused')
    expect(withMismatch.calls.filter((call) => call.data.startsWith('0x80f59a65'))).toHaveLength(0)

    // And the unchanged context still produces a status, so the assertion above
    // is about the mismatch rather than about a broken fixture.
    expect((await runStatus(stub.context))?.kind).toBe('live')
  })

  it('stops the moment the attempt is retired', async () => {
    const base = context({})
    let live = true

    const retired: ActionReadContext = {
      ...base.context,
      call: async (data: string, tag?: string): Promise<unknown> => {
        const answer = await base.context.call(data, tag)
        live = false

        return answer
      },
      live: () => live,
    }

    expect(await runStatus(retired)).toBeNull()
  })
})

describe('checkStatusEligibility', () => {
  const event = {
    eventName: 'SubmitTransaction',
    multisigTxIndex: '3',
    payload: PAYLOAD,
  } as Parameters<typeof checkStatusEligibility>[0]

  it('offers the read on the verified deployment only', () => {
    expect(
      checkStatusEligibility(event, MULTISIG_ADDRESS, SEPOLIA_CHAIN_ID).eligible,
    ).toBe(true)

    const other = checkStatusEligibility(
      event,
      '0x00000000000000000000000000000000000000ff',
      SEPOLIA_CHAIN_ID,
    )

    expect(other).toEqual({
      eligible: false,
      refusal: 'other-contract',
      reason: 'Live status is only available on the verified Sepolia multisig contract.',
    })
  })

  it('offers it on no other chain, and for no other kind of event', () => {
    const chain = checkStatusEligibility(event, MULTISIG_ADDRESS, 1)

    expect(chain).toEqual({
      eligible: false,
      refusal: 'other-chain',
      reason: 'Live status is only available on chain 11155111.',
    })

    const other = checkStatusEligibility(
      { ...event, eventName: 'ConfirmTransaction' },
      MULTISIG_ADDRESS,
      SEPOLIA_CHAIN_ID,
    )

    expect(other).toEqual({
      eligible: false,
      refusal: 'not-submission',
      reason: 'Only a submitted proposal has a live status this app can read.',
    })
  })

  it('refuses an index and a payload it cannot read', () => {
    const index = checkStatusEligibility(
      { ...event, multisigTxIndex: 'three' },
      MULTISIG_ADDRESS,
      SEPOLIA_CHAIN_ID,
    )
    const payload = checkStatusEligibility(
      { ...event, payload: { to: 7 } as unknown as typeof event.payload },
      MULTISIG_ADDRESS,
      SEPOLIA_CHAIN_ID,
    )

    expect(index.eligible).toBe(false)
    expect(payload.eligible).toBe(false)
  })
})

describe('statusGate', () => {
  const connected = { status: 'connected', account: VIEWER, chainId: SEPOLIA_CHAIN_ID } as const
  const nothing = { status: 'disconnected', notice: null } as const

  it('opens for any connected account on Sepolia, whether or not it is an owner', () => {
    expect(statusGate(MULTISIG_ADDRESS, SEPOLIA_CHAIN_ID, connected).open).toBe(true)
  })

  it('closes on another chain, at another contract, and with nothing connected', () => {
    expect(
      statusGate(MULTISIG_ADDRESS, SEPOLIA_CHAIN_ID, {
        status: 'connected',
        account: VIEWER,
        chainId: 1,
      }).open,
    ).toBe(false)
    expect(
      statusGate('0x00000000000000000000000000000000000000ff', SEPOLIA_CHAIN_ID, connected).open,
    ).toBe(false)
    expect(
      statusGate(MULTISIG_ADDRESS, SEPOLIA_CHAIN_ID, nothing).open,
    ).toBe(false)
  })

  it('words the two refusals for reading rather than for writing', () => {
    const disconnected = statusGate(MULTISIG_ADDRESS, SEPOLIA_CHAIN_ID, nothing)
    const other = statusGate(
      '0x00000000000000000000000000000000000000ff',
      SEPOLIA_CHAIN_ID,
      connected,
    )

    expect(disconnected.reason).toBe('Connect a wallet on Sepolia to read this proposal from the contract.')
    expect(other.reason).toBe('Live status is only available on the verified Sepolia multisig contract.')
  })
})
