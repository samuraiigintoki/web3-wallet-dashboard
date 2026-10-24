import { describe, expect, it } from 'vitest'

import type { ContractEvent, SubmitTransactionPayload } from '../api/index.ts'
import { MULTISIG_ADDRESS, SEPOLIA_CHAIN_ID } from '../provider/multisig.ts'
import type { BrowserWalletState } from '../provider/useBrowserWallet.ts'
import type { PreflightReads } from './confirm.ts'
import {
  checkRevokeEligibility,
  encodeRevokeTransaction,
  evaluateRevokePreflight,
  REVOKE_ABI,
  REVOKE_SELECTOR,
  revokeGate,
} from './revoke.ts'

/**
 * The revocation call, the eligibility rule in revoking's words, the gate, and
 * the verdict on the four reads.
 *
 * The calldata is pinned to bytes generated with `viem` in a scratch directory, so
 * the encoder is checked against something other than itself. The selector is
 * pinned to the value the deployed contract answers to, which is what makes
 * `REVOKE_SELECTOR` evidence rather than a constant.
 *
 * The verdict is the inverse of confirming's, and that inversion is the one thing
 * this file exists to hold still: an account that has not confirmed has nothing to
 * revoke.
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

describe('the revocation call', () => {
  it('uses the selector the deployed contract answers to', () => {
    // Present in the runtime bytecode at MULTISIG_ADDRESS on Sepolia, next to
    // confirmTransaction (0xc01a8c84) and executeTransaction (0xee22610b).
    expect(REVOKE_SELECTOR).toBe('0x20ea8d86')
    expect(REVOKE_ABI[0].name).toBe('revokeConfirmation')
    expect(encodeRevokeTransaction(3n).startsWith(REVOKE_SELECTOR)).toBe(true)
  })

  it('encodes the index as one word', () => {
    expect(encodeRevokeTransaction(0n)).toBe(
      '0x20ea8d860000000000000000000000000000000000000000000000000000000000000000',
    )
    expect(encodeRevokeTransaction(1n)).toBe(
      '0x20ea8d860000000000000000000000000000000000000000000000000000000000000001',
    )
    expect(encodeRevokeTransaction(3n)).toBe(
      '0x20ea8d860000000000000000000000000000000000000000000000000000000000000003',
    )
    expect(encodeRevokeTransaction(MAX_UINT256)).toBe(`0x20ea8d86${'ff'.repeat(32)}`)
  })

  it('is a different call from confirming, at the same index', () => {
    expect(encodeRevokeTransaction(7n)).not.toContain('c01a8c84')
  })
})

describe('eligibility, worded for revoking', () => {
  it('accepts a submission row on the verified deployment', () => {
    const result = checkRevokeEligibility(event(), MULTISIG_ADDRESS, SEPOLIA_CHAIN_ID)

    expect(result.eligible).toBe(true)
  })

  it('refuses another contract in revoking words', () => {
    const result = checkRevokeEligibility(
      event(),
      '0x00000000000000000000000000000000000000ff',
      SEPOLIA_CHAIN_ID,
    )

    expect(result.eligible).toBe(false)

    if (result.eligible) {
      return
    }

    expect(result.refusal).toBe('other-contract')
    expect(result.reason).toBe(
      'Revoking is only available on the verified Sepolia multisig contract.',
    )
  })

  it('words each refusal for revoking rather than for confirming', () => {
    const cases: [ContractEvent, string, number, string][] = [
      [event({ eventName: 'ConfirmTransaction' }), MULTISIG_ADDRESS, SEPOLIA_CHAIN_ID, 'not-submission'],
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
      const result = checkRevokeEligibility(row, address, chainId)

      expect(result.eligible).toBe(false)

      if (result.eligible) {
        continue
      }

      expect(result.refusal).toBe(refusal)
      expect(result.reason).not.toContain('Confirming')
    }
  })

  it('says a proposal row is the only thing that can have a confirmation revoked', () => {
    const result = checkRevokeEligibility(
      event({ eventName: 'RevokeConfirmation' }),
      MULTISIG_ADDRESS,
      SEPOLIA_CHAIN_ID,
    )

    expect(result.eligible).toBe(false)

    if (result.eligible) {
      return
    }

    expect(result.reason).toBe('Only a submitted proposal can have a confirmation revoked.')
  })
})

describe('the gate for revoking', () => {
  it('opens for a connected wallet on the contract chain', () => {
    expect(revokeGate(MULTISIG_ADDRESS, SEPOLIA_CHAIN_ID, connected()).open).toBe(true)
  })

  it('keeps the wallet states apart and words the connection refusal for revoking', () => {
    expect(revokeGate(MULTISIG_ADDRESS, SEPOLIA_CHAIN_ID, { status: 'checking' }).reason).toBe(
      'Checking the browser wallet.',
    )
    expect(revokeGate(MULTISIG_ADDRESS, SEPOLIA_CHAIN_ID, { status: 'unsupported' }).reason).toBe(
      'No browser wallet was found in this browser.',
    )
    expect(
      revokeGate(MULTISIG_ADDRESS, SEPOLIA_CHAIN_ID, { status: 'disconnected', notice: null }).reason,
    ).toBe('Connect a wallet to revoke your confirmation.')
    expect(
      revokeGate(MULTISIG_ADDRESS, SEPOLIA_CHAIN_ID, { status: 'error', message: 'x' }).reason,
    ).toBe('The browser wallet could not be read.')
  })

  it('refuses another chain before anything is read, and names both chains', () => {
    const gate = revokeGate(MULTISIG_ADDRESS, SEPOLIA_CHAIN_ID, connected(1))

    expect(gate.open).toBe(false)
    expect(gate.reason).toContain('chain 1')
    expect(gate.reason).toContain(String(SEPOLIA_CHAIN_ID))
  })

  it('refuses a contract that is not the verified deployment', () => {
    const gate = revokeGate(
      '0x00000000000000000000000000000000000000ff',
      SEPOLIA_CHAIN_ID,
      connected(),
    )

    expect(gate.open).toBe(false)
    expect(gate.reason).toBe(
      'Revoking is only available on the verified Sepolia multisig contract.',
    )
  })
})

describe('the revoke preflight verdict', () => {
  const reads: PreflightReads = {
    isOwner: true,
    transactionCount: 3n,
    proposal: PROPOSAL,
    alreadyConfirmed: true,
  }

  it('is ready when this account has confirmed the proposal', () => {
    const outcome = evaluateRevokePreflight(reads, 1n, PAYLOAD)

    expect(outcome.ok).toBe(true)

    if (!outcome.ok) {
      return
    }

    expect(outcome.preflight.indexText).toBe('1')
    expect(outcome.preflight.data).toBe(encodeRevokeTransaction(1n))
    expect(outcome.preflight.proposal).toEqual(PROPOSAL)
  })

  it('refuses an account that has not confirmed, which is the inverse of confirming', () => {
    const outcome = evaluateRevokePreflight({ ...reads, alreadyConfirmed: false }, 1n, PAYLOAD)

    expect(outcome.ok).toBe(false)

    if (outcome.ok) {
      return
    }

    expect(outcome.reason).toBe(
      'This account has not confirmed this proposal, so there is no confirmation to revoke.',
    )
  })

  it('refuses an account that is not an owner', () => {
    const outcome = evaluateRevokePreflight({ ...reads, isOwner: false }, 1n, PAYLOAD)

    expect(outcome.ok).toBe(false)

    if (outcome.ok) {
      return
    }

    expect(outcome.reason).toContain('not an owner')
  })

  it('refuses an index the contract does not hold', () => {
    const outcome = evaluateRevokePreflight(reads, 3n, PAYLOAD)

    expect(outcome.ok).toBe(false)

    if (outcome.ok) {
      return
    }

    expect(outcome.reason).toContain('no proposal at this index')
  })

  it('refuses an executed proposal', () => {
    const outcome = evaluateRevokePreflight(
      { ...reads, proposal: { ...PROPOSAL, executed: true } },
      1n,
      PAYLOAD,
    )

    expect(outcome.ok).toBe(false)

    if (outcome.ok) {
      return
    }

    expect(outcome.reason).toContain('already been executed')
  })

  it('refuses when the contract record is not the indexed event', () => {
    const outcome = evaluateRevokePreflight(
      { ...reads, proposal: { ...PROPOSAL, to: '0x00000000000000000000000000000000000000ff' } },
      1n,
      PAYLOAD,
    )

    expect(outcome.ok).toBe(false)

    if (outcome.ok) {
      return
    }

    expect(outcome.reason).toContain('does not match the indexed event')
  })

  it('checks ownership before the confirmation it is revoking', () => {
    // Both are wrong at once. The refusal names the first thing the contract
    // itself would refuse, so the user is not sent to fix the second.
    const outcome = evaluateRevokePreflight(
      { ...reads, isOwner: false, alreadyConfirmed: false },
      1n,
      PAYLOAD,
    )

    expect(outcome.ok).toBe(false)

    if (outcome.ok) {
      return
    }

    expect(outcome.reason).toContain('not an owner')
  })

  it('compares the proposal value as an integer, not as text', () => {
    const padded = evaluateRevokePreflight(reads, 1n, {
      ...PAYLOAD,
      valueWei: '01000000000000000000',
    })
    const exponent = evaluateRevokePreflight(reads, 1n, { ...PAYLOAD, valueWei: '1e18' })

    expect(padded.ok).toBe(true)
    expect(exponent.ok).toBe(false)
  })
})
