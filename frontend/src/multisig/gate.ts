/**
 * Whether a multisig action may be offered at all, and why not when it may not.
 *
 * Confirming and revoking are the same question here and differ only in the noun
 * they use, so the rule is written once. What the wallet reports is the whole
 * input: nothing in this file reads the chain, and nothing in it assumes a
 * provider is even present.
 *
 * The chain check comes first among the two conditions because every read that
 * follows an action is an `eth_call` against whatever chain the wallet is on. A
 * contract address is not unique across chains, so reading the verified address
 * from the wrong chain would describe a different contract entirely.
 */

import type { BrowserWalletState } from '../provider/useBrowserWallet.ts'
import { MULTISIG_ADDRESS } from '../provider/multisig.ts'

/** Whether an action is offered, and the sentence that says why it is not. */
export type MultisigGate = { open: boolean; reason: string }

/** The two sentences that differ between actions at this point. */
export type GateWords = {
  /** Why the verified deployment is the only one this app writes to. */
  unavailable: string
  /** What to do when nothing is connected. */
  connect: string
}

/**
 * The gate for one write against one fixed contract on one fixed chain.
 *
 * The states of the wallet are told apart rather than collapsed: a wallet still
 * being checked, one that is not there, one that failed to answer, one waiting
 * for permission and one with nothing connected are five different situations,
 * and a user who is told the wrong one will look in the wrong place.
 */
export function walletGate(
  contractAddress: string,
  contractChainId: number,
  wallet: BrowserWalletState,
  words: GateWords,
): MultisigGate {
  switch (wallet.status) {
    case 'checking':
      return { open: false, reason: 'Checking the browser wallet.' }
    case 'unsupported':
      return { open: false, reason: 'No browser wallet was found in this browser.' }
    case 'error':
      return { open: false, reason: 'The browser wallet could not be read.' }
    case 'connecting':
      return { open: false, reason: 'Waiting for the wallet to grant access.' }
    case 'disconnected':
      return { open: false, reason: words.connect }
    case 'connected':
      break
  }

  if (wallet.chainId !== contractChainId) {
    return {
      open: false,
      reason: `The wallet is on chain ${String(wallet.chainId)}, and this contract is on chain ${String(
        contractChainId,
      )}.`,
    }
  }

  if (contractAddress.toLowerCase() !== MULTISIG_ADDRESS.toLowerCase()) {
    return { open: false, reason: words.unavailable }
  }

  return { open: true, reason: '' }
}
