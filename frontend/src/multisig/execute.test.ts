import { describe, expect, it } from 'vitest'

import type { ContractEvent, SubmitTransactionPayload } from '../api/index.ts'
import { MULTISIG_ADDRESS, SEPOLIA_CHAIN_ID } from '../provider/multisig.ts'
import type { BrowserWalletState } from '../provider/useBrowserWallet.ts'
import {
  checkExecuteEligibility,
  decodeBlockNumber,
  encodeExecuteTransaction,
  evaluateExecutePreflight,
  EXECUTE_ABI,
  EXECUTE_SELECTOR,
  executeGate,
  MAX_EXECUTION_OWNERS,
  type ExecuteReads,
} from './execute.ts'

/**
 * The execution call, the block anchor, the eligibility rule in execution's
 * words, the gate, and the verdict on the anchored reads.
 *
 * The calldata and the selector are pinned to values checked against the deployed
 * contract. The verdict is where this slice's risk lives: it decides that a
 * proposal has met its threshold, and it does so from per-owner reads at one
 * block rather than from any summary or event the page may already hold.
 */

const DESTINATION = '0x14912965632cd9ab70c046e8d23e9b8dfa9f2746'
const ACCOUNT = '0x1e1D0e1D0e1D0e1D0e1D0e1D0e1D0e1D0e1D0e1D'
const HASH = `0x${'ab'.repeat(32)}`
const MAX_UINT256 = (1n << 256n) - 1n

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

/** A distinct address per position, so a duplicate check has something to see. */
function owner(position: number): string {
  return `0x${position.toString(16).padStart(40, '0')}`
}

function owners(count: number): string[] {
  return Array.from({ length: count }, (_, position) => owner(position + 1))
}

function event(overrides: Partial<ContractEvent> = {}): ContractEvent {
  return {
    contractId: 7,
    eventName: 'SubmitTransaction',
    blockNumber: 6_100_000,
    blockHash: `0x${'11'.repeat(32)}`,
    transactionHash: HASH,
    transactionIndex: 1,
    logIndex: 0,
    actorAddress: ACCOUNT,
    multisigTxIndex: '0',
    payload: PAYLOAD,
    ...overrides,
  } as ContractEvent
}

function connected(chainId = SEPOLIA_CHAIN_ID): BrowserWalletState {
  return { status: 'connected', account: ACCOUNT, chainId }
}

function reads(overrides: Partial<ExecuteReads> = {}): ExecuteReads {
  return {
    block: 6_100_042n,
    isOwner: true,
    transactionCount: 3n,
    proposal: PROPOSAL,
    owners: owners(2),
    threshold: 2n,
    confirmations: [true, true],
    ...overrides,
  }
}

describe('the execution call', () => {
  it('uses the selector the deployed contract answers to', () => {
    // Present in the runtime bytecode at MULTISIG_ADDRESS on Sepolia, next to
    // confirmTransaction (0xc01a8c84) and revokeConfirmation (0x20ea8d86).
    expect(EXECUTE_SELECTOR).toBe('0xee22610b')
    expect(EXECUTE_ABI[0].name).toBe('executeTransaction')
    expect(encodeExecuteTransaction(3n).startsWith(EXECUTE_SELECTOR)).toBe(true)
  })

  it('encodes the index as one word', () => {
    expect(encodeExecuteTransaction(0n)).toBe(
      '0xee22610b0000000000000000000000000000000000000000000000000000000000000000',
    )
    expect(encodeExecuteTransaction(3n)).toBe(
      '0xee22610b0000000000000000000000000000000000000000000000000000000000000003',
    )
    expect(encodeExecuteTransaction(MAX_UINT256)).toBe(`0xee22610b${'ff'.repeat(32)}`)
  })

  it('is a different call from the two own-confirmation actions', () => {
    const execute = encodeExecuteTransaction(1n)

    expect(execute).not.toContain('c01a8c84')
    expect(execute).not.toContain('20ea8d86')
  })
})

describe('the block anchor', () => {
  it('reads a hex quantity as a block number', () => {
    expect(decodeBlockNumber('0x0')).toBe(0n)
    expect(decodeBlockNumber('0x1')).toBe(1n)
    expect(decodeBlockNumber('0x5d13ca')).toBe(6_099_914n)
    expect(decodeBlockNumber('0xffffffffffffffff')).toBe(18_446_744_073_709_551_615n)
  })

  it('refuses anything that is not a hex quantity', () => {
    // A leading zero, a decimal string, a padded word, a negative value, an empty
    // payload and a non-string are all refusals: this value becomes the block tag
    // for every read that follows.
    for (const value of [
      '0x0f',
      '0x00',
      '6100042',
      '0x',
      '',
      '0x-1',
      '0x5D13CA ',
      `0x${'0'.repeat(63)}1`,
      6_100_042,
      null,
      undefined,
    ]) {
      expect(decodeBlockNumber(value)).toBeNull()
    }
  })

  it('accepts an upper case quantity, because case carries no meaning in hex', () => {
    expect(decodeBlockNumber('0x5D13CA')).toBe(6_099_914n)
  })
})

describe('eligibility, worded for executing', () => {
  it('accepts a submission row on the verified deployment', () => {
    expect(checkExecuteEligibility(event(), MULTISIG_ADDRESS, SEPOLIA_CHAIN_ID).eligible).toBe(true)
  })

  it('words each refusal for executing rather than for confirming', () => {
    const cases: [ContractEvent, string, number, string][] = [
      [event({ eventName: 'ConfirmTransaction' }), MULTISIG_ADDRESS, SEPOLIA_CHAIN_ID, 'not-submission'],
      [
        event(),
        '0x00000000000000000000000000000000000000ff',
        SEPOLIA_CHAIN_ID,
        'other-contract',
      ],
      [event(), MULTISIG_ADDRESS, 1, 'other-chain'],
      [event({ multisigTxIndex: 'one' }), MULTISIG_ADDRESS, SEPOLIA_CHAIN_ID, 'unreadable-index'],
      [
        event({ payload: {} as Record<string, never> }),
        MULTISIG_ADDRESS,
        SEPOLIA_CHAIN_ID,
        'unreadable-payload',
      ],
    ]

    for (const [row, address, chainId, refusal] of cases) {
      const result = checkExecuteEligibility(row, address, chainId)

      expect(result.eligible).toBe(false)

      if (result.eligible) {
        continue
      }

      expect(result.refusal).toBe(refusal)
      expect(result.reason).not.toContain('Confirming')
      expect(result.reason).not.toContain('Revoking')
    }
  })

  it('names execution in the sentence a user reads', () => {
    const result = checkExecuteEligibility(
      event(),
      '0x00000000000000000000000000000000000000ff',
      SEPOLIA_CHAIN_ID,
    )

    expect(result.eligible).toBe(false)

    if (result.eligible) {
      return
    }

    expect(result.reason).toBe(
      'Executing is only available on the verified Sepolia multisig contract.',
    )
  })
})

describe('the gate for executing', () => {
  it('opens for a connected wallet on the contract chain', () => {
    expect(executeGate(MULTISIG_ADDRESS, SEPOLIA_CHAIN_ID, connected()).open).toBe(true)
  })

  it('words the connection refusal for executing, and keeps the states apart', () => {
    expect(
      executeGate(MULTISIG_ADDRESS, SEPOLIA_CHAIN_ID, { status: 'disconnected', notice: null })
        .reason,
    ).toBe('Connect a wallet to execute a proposal.')
    expect(executeGate(MULTISIG_ADDRESS, SEPOLIA_CHAIN_ID, { status: 'checking' }).reason).toBe(
      'Checking the browser wallet.',
    )
  })

  it('refuses another chain and another contract', () => {
    expect(executeGate(MULTISIG_ADDRESS, SEPOLIA_CHAIN_ID, connected(1)).reason).toContain('chain 1')
    expect(
      executeGate('0x00000000000000000000000000000000000000ff', SEPOLIA_CHAIN_ID, connected())
        .reason,
    ).toBe('Executing is only available on the verified Sepolia multisig contract.')
  })
})

describe('the execution verdict', () => {
  it('is ready when the confirmations meet the threshold', () => {
    const outcome = evaluateExecutePreflight(reads(), 1n, PAYLOAD)

    expect(outcome.ok).toBe(true)

    if (!outcome.ok) {
      return
    }

    expect(outcome.preflight.indexText).toBe('1')
    expect(outcome.preflight.data).toBe(encodeExecuteTransaction(1n))
    expect(outcome.preflight.block).toBe('6100042')
    expect(outcome.preflight.threshold).toBe(2n)
    expect(outcome.preflight.confirmedCount).toBe(2)
    expect(outcome.preflight.ownerCount).toBe(2)
  })

  it('is ready above the threshold, and counts only the owners who confirmed', () => {
    const outcome = evaluateExecutePreflight(
      reads({ owners: owners(3), threshold: 2n, confirmations: [true, false, true] }),
      0n,
      PAYLOAD,
    )

    expect(outcome.ok).toBe(true)

    if (!outcome.ok) {
      return
    }

    expect(outcome.preflight.confirmedCount).toBe(2)
    expect(outcome.preflight.ownerCount).toBe(3)
  })

  it('refuses one confirmation short, and says how many of how many', () => {
    const outcome = evaluateExecutePreflight(
      reads({ owners: owners(3), threshold: 2n, confirmations: [true, false, false] }),
      0n,
      PAYLOAD,
    )

    expect(outcome.ok).toBe(false)

    if (outcome.ok) {
      return
    }

    expect(outcome.reason).toBe(
      'This proposal has 1 of the 2 confirmations this contract requires, so it cannot be executed yet.',
    )
  })

  it('refuses an account that is not an owner, even at the threshold', () => {
    const outcome = evaluateExecutePreflight(reads({ isOwner: false }), 0n, PAYLOAD)

    expect(outcome.ok).toBe(false)

    if (outcome.ok) {
      return
    }

    expect(outcome.reason).toContain('not an owner')
  })

  it('refuses an index the contract does not hold', () => {
    const outcome = evaluateExecutePreflight(reads(), 3n, PAYLOAD)

    expect(outcome.ok).toBe(false)

    if (outcome.ok) {
      return
    }

    expect(outcome.reason).toContain('no proposal at this index')
  })

  it('refuses a proposal that was already executed', () => {
    const outcome = evaluateExecutePreflight(
      reads({ proposal: { ...PROPOSAL, executed: true } }),
      0n,
      PAYLOAD,
    )

    expect(outcome.ok).toBe(false)

    if (outcome.ok) {
      return
    }

    expect(outcome.reason).toContain('already been executed')
  })

  it('refuses when the contract record is not the indexed event', () => {
    const outcome = evaluateExecutePreflight(
      reads({ proposal: { ...PROPOSAL, to: '0x00000000000000000000000000000000000000ff' } }),
      0n,
      PAYLOAD,
    )

    expect(outcome.ok).toBe(false)

    if (outcome.ok) {
      return
    }

    expect(outcome.reason).toContain('does not match the indexed event')
  })

  it('refuses an owner list past the cap, with the cap in the sentence', () => {
    const over = owners(MAX_EXECUTION_OWNERS + 1)
    const outcome = evaluateExecutePreflight(
      reads({ owners: over, threshold: 1n, confirmations: over.map(() => true) }),
      0n,
      PAYLOAD,
    )

    expect(outcome.ok).toBe(false)

    if (outcome.ok) {
      return
    }

    expect(outcome.reason).toBe(
      `The contract reports 33 owners, and this app will only execute from a list of at most ${String(
        MAX_EXECUTION_OWNERS,
      )}.`,
    )
  })

  it('accepts exactly the cap', () => {
    const atCap = owners(MAX_EXECUTION_OWNERS)
    const confirmations = atCap.map(() => true)

    const outcome = evaluateExecutePreflight(
      reads({ owners: atCap, threshold: 32n, confirmations }),
      0n,
      PAYLOAD,
    )

    expect(outcome.ok).toBe(true)
  })

  it('refuses a configuration the contract cannot be in', () => {
    const implausible: Partial<ExecuteReads>[] = [
      // No owners at all.
      { owners: [], threshold: 1n, confirmations: [] },
      // A zero threshold.
      { owners: owners(2), threshold: 0n, confirmations: [true, true] },
      // A threshold above the owner count.
      { owners: owners(2), threshold: 3n, confirmations: [true, true] },
      // A duplicate owner.
      { owners: [owner(1), owner(1)], threshold: 1n, confirmations: [true, true] },
      // The zero address as an owner.
      {
        owners: ['0x0000000000000000000000000000000000000000', owner(2)],
        threshold: 1n,
        confirmations: [true, true],
      },
    ]

    for (const overrides of implausible) {
      const outcome = evaluateExecutePreflight(reads(overrides), 0n, PAYLOAD)

      expect(outcome.ok).toBe(false)

      if (outcome.ok) {
        continue
      }

      expect(outcome.reason).toContain('not a configuration this app can believe')
    }
  })

  it('refuses a confirmation list that does not match the owner list', () => {
    const outcome = evaluateExecutePreflight(
      reads({ owners: owners(3), threshold: 1n, confirmations: [true] }),
      0n,
      PAYLOAD,
    )

    expect(outcome.ok).toBe(false)

    if (outcome.ok) {
      return
    }

    expect(outcome.reason).toBe(
      'The contract answered with data this app cannot read, so nothing was sent.',
    )
  })

  it('judges ownership before the confirmations it would count', () => {
    const outcome = evaluateExecutePreflight(
      reads({ isOwner: false, owners: owners(3), threshold: 2n, confirmations: [true, false, false] }),
      0n,
      PAYLOAD,
    )

    expect(outcome.ok).toBe(false)

    if (outcome.ok) {
      return
    }

    expect(outcome.reason).toContain('not an owner')
  })

  it('compares the value as an integer, not as text', () => {
    expect(
      evaluateExecutePreflight(reads(), 0n, { ...PAYLOAD, valueWei: '01000000000000000000' }).ok,
    ).toBe(true)
    expect(evaluateExecutePreflight(reads(), 0n, { ...PAYLOAD, valueWei: '1e18' }).ok).toBe(false)
  })
})
