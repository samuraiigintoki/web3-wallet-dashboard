import { describe, expect, it } from 'vitest'

import type { ContractEvent, SubmitTransactionPayload } from '../api/index.ts'
import { MULTISIG_ADDRESS, SEPOLIA_CHAIN_ID } from '../provider/multisig.ts'
import {
  checkEligibility,
  CONFIRM_SELECTOR,
  decodeBool,
  decodeProposal,
  decodeUint,
  encodeConfirmTransaction,
  evaluatePreflight,
  parseProposalIndex,
  proposalMatchesEvent,
  type PreflightReads,
} from './confirm.ts'

/**
 * The confirmation call, the preflight readings, and the verdict.
 *
 * The calldata and the `transactions(uint256)` payloads are pinned to bytes
 * generated with `viem` in a scratch directory, so the encoding and the decoder
 * are checked against something other than themselves. The selectors are pinned
 * to values that were checked against the deployed runtime bytecode on Sepolia,
 * which is what makes `CONFIRM_SELECTOR` evidence rather than a constant.
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

/** `transactions(0)` for (DESTINATION, 1 ether, 0xdeadbeef, false). */
const PROPOSAL_ONE_ETHER =
  '0x00000000000000000000000014912965632cd9ab70c046e8d23e9b8dfa9f2746' +
  '0000000000000000000000000000000000000000000000000de0b6b3a7640000' +
  '0000000000000000000000000000000000000000000000000000000000000080' +
  '0000000000000000000000000000000000000000000000000000000000000000' +
  '0000000000000000000000000000000000000000000000000000000000000004' +
  'deadbeef00000000000000000000000000000000000000000000000000000000'

/** The same with empty calldata and a zero value. */
const PROPOSAL_EMPTY =
  '0x00000000000000000000000000000000000000000000000000000000000000ff' +
  '0000000000000000000000000000000000000000000000000000000000000000' +
  '0000000000000000000000000000000000000000000000000000000000000080' +
  '0000000000000000000000000000000000000000000000000000000000000000' +
  '0000000000000000000000000000000000000000000000000000000000000000'

/** Thirty-three bytes of calldata, executed. */
const PROPOSAL_EXECUTED =
  '0x00000000000000000000000014912965632cd9ab70c046e8d23e9b8dfa9f2746' +
  '0000000000000000000000000000000000000000000000000000000000000001' +
  '0000000000000000000000000000000000000000000000000000000000000080' +
  '0000000000000000000000000000000000000000000000000000000000000001' +
  '0000000000000000000000000000000000000000000000000000000000000021' +
  `${'ab'.repeat(32)}` +
  'ab00000000000000000000000000000000000000000000000000000000000000'

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

describe('the confirmation call', () => {
  it('uses the selector the deployed contract answers to', () => {
    // Present in the runtime bytecode at MULTISIG_ADDRESS on Sepolia, alongside
    // submitTransaction (0xc6427474), isOwner (0x2f54bf6e), isConfirmed
    // (0x80f59a65), transactions (0x9ace38c2) and getTransactionCount (0x2e7700f0).
    expect(CONFIRM_SELECTOR).toBe('0xc01a8c84')
    expect(encodeConfirmTransaction(3n).startsWith(CONFIRM_SELECTOR)).toBe(true)
  })

  it('encodes the index as one word', () => {
    expect(encodeConfirmTransaction(0n)).toBe(
      '0xc01a8c840000000000000000000000000000000000000000000000000000000000000000',
    )
    expect(encodeConfirmTransaction(1n)).toBe(
      '0xc01a8c840000000000000000000000000000000000000000000000000000000000000001',
    )
    expect(encodeConfirmTransaction(3n)).toBe(
      '0xc01a8c840000000000000000000000000000000000000000000000000000000000000003',
    )
    expect(encodeConfirmTransaction(MAX_UINT256)).toBe(
      `0xc01a8c84${'ff'.repeat(32)}`,
    )
  })

  it('reads an index from the decimal form the server sends', () => {
    expect(parseProposalIndex('0')).toBe(0n)
    expect(parseProposalIndex('42')).toBe(42n)
    expect(parseProposalIndex(MAX_UINT256.toString(10))).toBe(MAX_UINT256)
  })

  it('refuses an index that is not whole decimal digits or is out of range', () => {
    for (const value of ['', '-1', '1.5', '0x10', ' 1', 'one', 1, null, undefined]) {
      expect(parseProposalIndex(value)).toBeNull()
    }

    expect(parseProposalIndex((MAX_UINT256 + 1n).toString(10))).toBeNull()
  })
})

describe('the preflight readings', () => {
  it('reads the proposal tuple the contract returns', () => {
    expect(decodeProposal(PROPOSAL_ONE_ETHER)).toEqual({
      to: DESTINATION,
      valueWei: 1_000_000_000_000_000_000n,
      data: '0xdeadbeef',
      executed: false,
    })
  })

  it('reads empty calldata and an executed flag', () => {
    expect(decodeProposal(PROPOSAL_EMPTY)).toEqual({
      to: '0x00000000000000000000000000000000000000ff',
      valueWei: 0n,
      data: '0x',
      executed: false,
    })

    const executed = decodeProposal(PROPOSAL_EXECUTED)

    expect(executed?.executed).toBe(true)
    expect(executed?.data).toBe(`0x${'ab'.repeat(33)}`)
  })

  it('refuses a tuple that is not the four members', () => {
    // Too short, wrong offset, trailing bytes, a malformed length, and a head
    // that is not a word are all refusals rather than partial reads.
    const wrongOffset = PROPOSAL_EMPTY.replace(
      '0000000000000000000000000000000000000000000000000000000000000080',
      '00000000000000000000000000000000000000000000000000000000000000a0',
    )

    for (const value of [
      '0x',
      '0x00',
      PROPOSAL_EMPTY.slice(0, -64),
      `${PROPOSAL_EMPTY}${'00'.repeat(32)}`,
      wrongOffset,
      'not hex',
      null,
    ]) {
      expect(decodeProposal(value)).toBeNull()
    }
  })

  it('refuses an executed word that is neither zero nor one', () => {
    const bad = `${PROPOSAL_EMPTY.slice(0, 3 * 64)}${'00'.repeat(31)}02${PROPOSAL_EMPTY.slice(4 * 64)}`

    expect(decodeProposal(bad)).toBeNull()
  })

  it('reads booleans and integers, and refuses anything else', () => {
    expect(decodeBool(`0x${'0'.repeat(64)}`)).toBe(false)
    expect(decodeBool(`0x${'0'.repeat(63)}1`)).toBe(true)
    expect(decodeBool(`0x${'0'.repeat(62)}02`)).toBeNull()
    expect(decodeBool('0x')).toBeNull()
    expect(decodeBool(1)).toBeNull()

    expect(decodeUint(`0x${'0'.repeat(63)}7`)).toBe(7n)
    expect(decodeUint('0x')).toBeNull()
    expect(decodeUint(7)).toBeNull()
  })
})

describe('eligibility', () => {
  it('offers confirmation on a read submission to the verified deployment', () => {
    const result = checkEligibility(event(), MULTISIG_ADDRESS, SEPOLIA_CHAIN_ID)

    expect(result.eligible).toBe(true)

    if (!result.eligible) {
      return
    }

    expect(result.index).toBe(0n)
    expect(result.payload.to).toBe(DESTINATION)
  })

  it('compares the contract address without caring about case', () => {
    expect(
      checkEligibility(event(), MULTISIG_ADDRESS.toLowerCase(), SEPOLIA_CHAIN_ID).eligible,
    ).toBe(true)
  })

  it('refuses another contract, naming the verified one', () => {
    const result = checkEligibility(event(), '0x00000000000000000000000000000000000000ff', SEPOLIA_CHAIN_ID)

    expect(result.eligible).toBe(false)

    if (result.eligible) {
      return
    }

    expect(result.reason).toContain('verified Sepolia multisig contract')
  })

  it('refuses another chain', () => {
    const result = checkEligibility(event(), MULTISIG_ADDRESS, 1)

    expect(result.eligible).toBe(false)
  })

  it('refuses an event that is not a submission', () => {
    expect(
      checkEligibility(event({ eventName: 'ConfirmTransaction' }), MULTISIG_ADDRESS, SEPOLIA_CHAIN_ID)
        .eligible,
    ).toBe(false)
  })

  it('refuses an index this app cannot read', () => {
    for (const multisigTxIndex of ['', '-1', '1.5', 'x', (MAX_UINT256 + 1n).toString(10)]) {
      const result = checkEligibility(
        event({ multisigTxIndex }),
        MULTISIG_ADDRESS,
        SEPOLIA_CHAIN_ID,
      )

      expect(result.eligible).toBe(false)
    }
  })

  it('refuses a payload that is not a submission payload', () => {
    const result = checkEligibility(
      event({ payload: {} as Record<string, never> }),
      MULTISIG_ADDRESS,
      SEPOLIA_CHAIN_ID,
    )

    expect(result.eligible).toBe(false)
  })
})

describe('the contract record against the event', () => {
  const proposal = {
    to: DESTINATION,
    valueWei: 1_000_000_000_000_000_000n,
    data: '0xdeadbeef',
    executed: false,
  }

  it('agrees when address, value and calldata are the same', () => {
    expect(proposalMatchesEvent(proposal, PAYLOAD)).toBe(true)
    expect(
      proposalMatchesEvent({ ...proposal, to: DESTINATION.toUpperCase().replace('0X', '0x') }, PAYLOAD),
    ).toBe(true)
    expect(proposalMatchesEvent({ ...proposal, data: '0xDEADBEEF' }, PAYLOAD)).toBe(true)
  })

  it('disagrees on a different destination, value or calldata', () => {
    expect(
      proposalMatchesEvent({ ...proposal, to: '0x00000000000000000000000000000000000000ff' }, PAYLOAD),
    ).toBe(false)
    expect(proposalMatchesEvent({ ...proposal, valueWei: 1n }, PAYLOAD)).toBe(false)
    expect(proposalMatchesEvent({ ...proposal, data: '0x' }, PAYLOAD)).toBe(false)
  })

  it('compares the value as an integer, not as text', () => {
    expect(
      proposalMatchesEvent(proposal, { ...PAYLOAD, valueWei: '01000000000000000000' }),
    ).toBe(true)
    expect(proposalMatchesEvent(proposal, { ...PAYLOAD, valueWei: '1e18' })).toBe(false)
  })
})

describe('the preflight verdict', () => {
  const reads: PreflightReads = {
    isOwner: true,
    transactionCount: 3n,
    proposal: {
      to: DESTINATION,
      valueWei: 1_000_000_000_000_000_000n,
      data: '0xdeadbeef',
      executed: false,
    },
    alreadyConfirmed: false,
  }

  it('is ready when every reading allows it', () => {
    const outcome = evaluatePreflight(reads, 1n, PAYLOAD)

    expect(outcome.ok).toBe(true)

    if (!outcome.ok) {
      return
    }

    expect(outcome.preflight.indexText).toBe('1')
    expect(outcome.preflight.data).toBe(encodeConfirmTransaction(1n))
  })

  it('refuses when the account is not an owner', () => {
    const outcome = evaluatePreflight({ ...reads, isOwner: false }, 1n, PAYLOAD)

    expect(outcome.ok).toBe(false)

    if (outcome.ok) {
      return
    }

    expect(outcome.reason).toContain('not an owner')
  })

  it('refuses an index the contract does not hold', () => {
    const outcome = evaluatePreflight(reads, 3n, PAYLOAD)

    expect(outcome.ok).toBe(false)

    if (outcome.ok) {
      return
    }

    expect(outcome.reason).toContain('no proposal at this index')
  })

  it('refuses an executed proposal', () => {
    const outcome = evaluatePreflight(
      { ...reads, proposal: { ...reads.proposal, executed: true } },
      1n,
      PAYLOAD,
    )

    expect(outcome.ok).toBe(false)

    if (outcome.ok) {
      return
    }

    expect(outcome.reason).toContain('already been executed')
  })

  it('refuses a proposal this account already confirmed', () => {
    const outcome = evaluatePreflight({ ...reads, alreadyConfirmed: true }, 1n, PAYLOAD)

    expect(outcome.ok).toBe(false)

    if (outcome.ok) {
      return
    }

    expect(outcome.reason).toContain('already confirmed')
  })

  it('refuses when the contract record is not the event, before offering a review', () => {
    const outcome = evaluatePreflight(
      { ...reads, proposal: { ...reads.proposal, to: '0x00000000000000000000000000000000000000ff' } },
      1n,
      PAYLOAD,
    )

    expect(outcome.ok).toBe(false)

    if (outcome.ok) {
      return
    }

    expect(outcome.reason).toContain('does not match the indexed event')
  })
})
