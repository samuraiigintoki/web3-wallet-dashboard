/**
 * One multisig write: four reads, a review, one call to the wallet.
 *
 * Confirming and revoking are the same shape. Both read the same four facts from
 * the contract, both show the same review before the wallet opens, both dispense
 * with one dispatch of one call, and both are killed by the same changes of
 * context. They differ in the verdict the four reads produce and in the calldata
 * sent, so those are the two things this hook takes from its caller. Writing the
 * lifetime rules twice would be writing them differently twice, which is exactly
 * the kind of difference a screen about spending money cannot afford.
 *
 * The rules, and what each is for:
 *
 * - The wallet is opened only from `ready`, which is only reachable through a
 *   preflight whose four reads all parsed and all passed the caller's verdict.
 *   Nothing about the wallet prompt is decided by the indexed row alone.
 * - The reads are `isOwner`, `getTransactionCount`, `transactions(index)` and
 *   `isConfirmed(index, account)`, in that order, and they are read-only calls
 *   with no sender and no value. The wallet is given nothing to sign.
 * - The account and the chain are read again immediately before dispatch. A call
 *   proposed for one account, or on one chain, must not be sent from another, so
 *   a change between the review and the press aborts with a sentence and no
 *   `eth_sendTransaction`.
 * - Every phase is stamped with the account, the chain, the contract and the
 *   proposal index, and a phase whose stamp is not current is neither drawn nor
 *   kept. An answer that lands after the wallet moved, after the row changed, or
 *   after the screen went, describes a situation this screen has lost sight of.
 * - One dispatch at a time: the controls disable and a ref refuses a second call.
 * - Nothing is retried, and no provider text is ever rendered.
 *
 * A successful send is not a fact about the proposal. It is a transaction that
 * may or may not be included, and even an included one may leave the proposal
 * where it was. The `sent` phase says the hash and nothing more.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { encodeFunctionData } from 'viem'

import type { SubmitTransactionPayload } from '../api/index.ts'
import {
  describeProviderFailure,
  parseAccountList,
  parseChainId,
  providerErrorCode,
  readInjectedProvider,
  USER_REJECTED_CODE,
} from '../provider/injected.ts'
import type { BrowserWalletState } from '../provider/useBrowserWallet.ts'
import {
  decodeBool,
  decodeProposal,
  decodeUint,
  PREFLIGHT_ABI,
  type Preflight,
  type PreflightOutcome,
  type PreflightReads,
} from './confirm.ts'
import type { MultisigGate } from './gate.ts'

/**
 * Where one action is.
 *
 * `ready` is the only state from which a wallet can be opened, and it holds the
 * proposal as the contract answered it, not as the event described it. `sent`
 * holds a transaction hash and nothing else.
 */
export type MultisigActionPhase =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'refused'; reason: string }
  | { kind: 'ready'; preflight: Preflight }
  | { kind: 'sending'; preflight: Preflight }
  | { kind: 'sent'; preflight: Preflight; hash: string }
  | { kind: 'failed'; preflight: Preflight; message: string; declined: boolean }

type ReadName = 'isOwner' | 'getTransactionCount' | 'transactions' | 'isConfirmed'

/** A transaction hash as a wallet returns one. */
const HASH = /^0x[0-9a-fA-F]{64}$/

function parseHash(value: unknown): string | null {
  return typeof value === 'string' && HASH.test(value) ? value : null
}

const UNREADABLE_ACCOUNTS =
  'The wallet answered with something that is not a list of addresses, so nothing was sent.'

const UNREADABLE_CHAIN =
  'The wallet answered with something that is not a chain id, so nothing was sent.'

const CHANGED_ACCOUNT = 'The wallet is now on a different account, so nothing was sent.'

const MALFORMED = 'The contract answered with data this app cannot read, so nothing was sent.'

/**
 * A preflight read, encoded from the ABI rather than from a typed selector.
 *
 * The four names are the four functions in `PREFLIGHT_ABI`, so the union is total
 * over it, and the arguments are the ones each function declares. Nothing in this
 * file spells a selector or a word layout by hand.
 */
function calldataFor(name: ReadName, args: readonly unknown[]): string {
  return encodeFunctionData({
    abi: PREFLIGHT_ABI,
    functionName: name,
    args: args as never,
  })
}

export type UseMultisigActionOptions = {
  /** The tracked contract's address, as the server record has it. */
  contractAddress: string
  /** The tracked contract's chain, as the server record has it. */
  contractChainId: number
  /** The proposal index from this row's event. */
  index: bigint
  /** This row's event payload, which the contract's own record must match. */
  payload: SubmitTransactionPayload
  /** The browser wallet, for its state as well as its account and chain. */
  wallet: BrowserWalletState
  /** Whether the action is offered at all, computed by the caller. */
  gate: MultisigGate
  /**
   * The verdict on the four reads, which also builds the calldata for this index.
   * The call and the decision come from one function so the bytes sent are always
   * the bytes that were checked.
   */
  decide: (
    reads: PreflightReads,
    index: bigint,
    payload: SubmitTransactionPayload,
  ) => PreflightOutcome
  /** What a refusal in the wallet is called for this action. */
  declined: string
  /** The scope the injected provider is read from. The window, in the app. */
  scope?: unknown
}

export function useMultisigAction({
  contractAddress,
  contractChainId,
  index,
  payload,
  wallet,
  gate,
  decide,
  declined,
  scope = globalThis,
}: UseMultisigActionOptions): {
  phase: MultisigActionPhase
  gate: MultisigGate
  check: () => Promise<void>
  cancel: () => void
  submit: () => Promise<void>
  retry: () => void
} {
  const provider = useMemo(() => readInjectedProvider(scope), [scope])

  const account = wallet.status === 'connected' ? wallet.account : null
  const chainId = wallet.status === 'connected' ? wallet.chainId : null

  /**
   * The account as an ABI argument, which is lower case.
   *
   * A wallet is free to report an address in any case, and `viem` refuses a mixed
   * case address whose checksum does not match the letters it was given. That
   * refusal is right for a human typed address and wrong here: this value came
   * from the provider and will be encoded to the same twenty bytes either way. So
   * the address is lower cased before it becomes calldata, and a wallet that
   * reports `0xAbC...` is not turned into a preflight failure.
   */
  const accountArg = account === null ? null : account.toLowerCase()

  const stamp =
    account === null || chainId === null
      ? null
      : `${account.toLowerCase()}:${String(chainId)}:${contractAddress.toLowerCase()}:${index.toString(10)}`

  const [lastStamp, setLastStamp] = useState<string | null>(stamp)
  const [stored, setStored] = useState<{ stamp: string; phase: MultisigActionPhase } | null>(null)

  // A different account, chain, contract or index drops what the last one said,
  // during render, so no frame shows an old review beside a new row.
  if (lastStamp !== stamp) {
    setLastStamp(stamp)
    setStored(null)
  }

  const mountedRef = useRef(true)
  const attemptRef = useRef(0)
  const sendingRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true

    return () => {
      mountedRef.current = false
      attemptRef.current += 1
      sendingRef.current = false
    }
  }, [])

  const phase: MultisigActionPhase =
    stored !== null && stamp !== null && stored.stamp === stamp ? stored.phase : { kind: 'idle' }

  /**
   * The four reads, in the order the contract itself checks them, then the
   * caller's verdict. Nothing is drawn from a read that did not parse.
   */
  const check = useCallback(async (): Promise<void> => {
    const live = provider

    if (live === null || stamp === null || accountArg === null || !gate.open) {
      return
    }

    const attempt = attemptRef.current + 1
    attemptRef.current = attempt

    const current = (): boolean => attemptRef.current === attempt && mountedRef.current

    const settle = (next: MultisigActionPhase): void => {
      if (current()) {
        setStored({ stamp, phase: next })
      }
    }

    setStored({ stamp, phase: { kind: 'checking' } })

    const read = async (data: string): Promise<unknown> =>
      await live.request({
        method: 'eth_call',
        params: [{ to: contractAddress, data }, 'latest'],
      })

    try {
      let ownerRaw: unknown
      let countRaw: unknown
      let proposalRaw: unknown
      let confirmedRaw: unknown

      try {
        // Sequential rather than concurrent: four calls to one wallet are not
        // worth a burst, and a wallet that serialises them gains nothing from
        // being asked all at once.
        ownerRaw = await read(calldataFor('isOwner', [accountArg]))
        if (!current()) {
          return
        }

        countRaw = await read(calldataFor('getTransactionCount', []))
        if (!current()) {
          return
        }

        proposalRaw = await read(calldataFor('transactions', [index]))
        if (!current()) {
          return
        }

        confirmedRaw = await read(calldataFor('isConfirmed', [index, accountArg]))
        if (!current()) {
          return
        }
      } catch (error) {
        // A revert lands here: `transactions(index)` for an index the contract
        // does not hold is a revert, and it is reported as a provider failure
        // rather than as bad data.
        settle({ kind: 'refused', reason: describeProviderFailure(error) })
        return
      }

      const isOwner = decodeBool(ownerRaw)
      const transactionCount = decodeUint(countRaw)
      const proposal = decodeProposal(proposalRaw)
      const alreadyConfirmed = decodeBool(confirmedRaw)

      if (
        isOwner === null ||
        transactionCount === null ||
        proposal === null ||
        alreadyConfirmed === null
      ) {
        settle({ kind: 'refused', reason: MALFORMED })
        return
      }

      const outcome = decide(
        { isOwner, transactionCount, proposal, alreadyConfirmed },
        index,
        payload,
      )

      settle(
        outcome.ok
          ? { kind: 'ready', preflight: outcome.preflight }
          : { kind: 'refused', reason: outcome.reason },
      )
    } finally {
      // Nothing to release: no dispatch happened on this path.
    }
  }, [accountArg, contractAddress, decide, gate.open, index, payload, provider, stamp])

  /** Leaves the review. Sends nothing, and retires anything in flight. */
  const cancel = useCallback((): void => {
    if (sendingRef.current) {
      return
    }

    attemptRef.current += 1
    setStored(null)
  }, [])

  /** Goes back to the row after a refusal or a failure. */
  const retry = useCallback((): void => {
    if (sendingRef.current) {
      return
    }

    setStored(null)
  }, [])

  const submit = useCallback(async (): Promise<void> => {
    const live = provider

    if (live === null || stamp === null || account === null || chainId === null || !gate.open) {
      return
    }

    if (sendingRef.current) {
      return
    }

    if (stored === null || stored.phase.kind !== 'ready' || stored.stamp !== stamp) {
      return
    }

    const preflight = stored.phase.preflight
    const expectedAccount = account.toLowerCase()
    const sendStamp = stamp

    const attempt = attemptRef.current + 1
    attemptRef.current = attempt
    sendingRef.current = true

    const current = (): boolean => attemptRef.current === attempt && mountedRef.current

    const settle = (next: MultisigActionPhase): void => {
      if (current()) {
        setStored({ stamp: sendStamp, phase: next })
      }
    }

    const fail = (message: string, refused = false): void => {
      settle({ kind: 'failed', preflight, message, declined: refused })
    }

    setStored({ stamp: sendStamp, phase: { kind: 'sending', preflight } })

    try {
      let accounts: string[] | null
      let liveChain: number | null

      try {
        accounts = parseAccountList(await live.request({ method: 'eth_accounts' }))
        if (!current()) {
          return
        }

        liveChain = parseChainId(await live.request({ method: 'eth_chainId' }))
      } catch (error) {
        fail(describeProviderFailure(error))
        return
      }

      if (!current()) {
        return
      }

      if (accounts === null) {
        fail(UNREADABLE_ACCOUNTS)
        return
      }

      if (accounts.length === 0) {
        fail('The wallet reported no connected account, so nothing was sent.')
        return
      }

      const sender = accounts[0]!

      if (sender.toLowerCase() !== expectedAccount) {
        fail(CHANGED_ACCOUNT)
        return
      }

      if (liveChain === null) {
        fail(UNREADABLE_CHAIN)
        return
      }

      if (liveChain !== contractChainId) {
        fail(
          `The wallet is now on chain ${String(liveChain)}, and this contract is on chain ${String(
            contractChainId,
          )}, so nothing was sent.`,
        )
        return
      }

      let answer: unknown

      try {
        // The one write in this slice. The outer call carries no value: the index
        // is inside the calldata, and paying the contract is not part of
        // confirming or revoking anything.
        answer = await live.request({
          method: 'eth_sendTransaction',
          params: [
            {
              from: sender,
              to: contractAddress,
              value: '0x0',
              data: preflight.data,
            },
          ],
        })
      } catch (error) {
        const refused = providerErrorCode(error) === USER_REJECTED_CODE

        fail(refused ? declined : describeProviderFailure(error), refused)
        return
      }

      if (!current()) {
        return
      }

      const hash = parseHash(answer)

      if (hash === null) {
        fail(
          'The wallet did not answer with a transaction hash, so this app cannot say whether the call was submitted.',
        )
        return
      }

      settle({ kind: 'sent', preflight, hash })
    } finally {
      sendingRef.current = false
    }
  }, [account, chainId, contractAddress, contractChainId, declined, gate.open, provider, stamp, stored])

  return { phase, gate, check, cancel, submit, retry }
}
