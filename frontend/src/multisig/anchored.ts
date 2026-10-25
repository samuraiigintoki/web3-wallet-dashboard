/**
 * The parts of a multi-read contract snapshot that execution and status share.
 *
 * A snapshot is only a snapshot if every read in it is answered at one block: at
 * `latest` a confirmation could land between two reads and the count would
 * describe no state the contract was ever in. Both readers therefore validate the
 * block number once, then pass the same block tag to every call, and both refuse
 * an owner list longer than they are willing to read one confirmation from.
 *
 * Nothing here reads the chain. These are the two encoders, the one block decoder
 * and the one cap, kept together so the readers cannot disagree about them.
 */

import { encodeFunctionData, type Abi } from 'viem'

/** `getOwners()` and `threshold()`, the two configuration reads. */
export const CONFIGURATION_ABI = [
  {
    type: 'function',
    name: 'getOwners',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address[]' }],
  },
  {
    type: 'function',
    name: 'threshold',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const satisfies Abi

/**
 * The most owners this app will issue one read per.
 *
 * The contract has no maximum owner count, and a snapshot needs one
 * `isConfirmed` read per owner. A list longer than this is refused with a
 * sentence rather than turned into an unbounded burst of requests against a
 * wallet that has to answer every one of them.
 */
export const MAX_ANCHORED_OWNERS = 32

/** One 32-byte word as hexadecimal, the only block tag form read here. */
const BLOCK_QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/

/** The two configuration reads, encoded from their ABI. */
export function encodeConfiguration(name: 'getOwners' | 'threshold'): string {
  return encodeFunctionData({ abi: CONFIGURATION_ABI, functionName: name }).toLowerCase()
}

/**
 * A block number as the node reports one, or null.
 *
 * `eth_blockNumber` answers with a hex quantity: a `0x`, then either `0` or a
 * digit that is not a leading zero, then hex digits. A decimal string, a padded
 * word, a negative number or an empty payload is refused, because the value is
 * used as the block tag for every read that follows: an anchor this app
 * misunderstood would anchor the whole snapshot somewhere else.
 */
export function decodeBlockNumber(value: unknown): bigint | null {
  if (typeof value !== 'string' || !BLOCK_QUANTITY.test(value)) {
    return null
  }

  return BigInt(value)
}

/** The block tag for one anchored read, in the only form this app sends. */
export function blockTag(block: bigint): string {
  return `0x${block.toString(16)}`
}
