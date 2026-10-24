/**
 * The Sepolia multisig this app reads, and the decoding of what it answers.
 *
 * The address is a constant here rather than a setting, a prop or anything the
 * UI can change, so no page state can point the read at another contract.
 *
 * How the target was verified, before any of this was written: the source at
 * `samuraiigintoki/multisig-wallet` commit `f34634cf0ebc28de95b856f34641466a0f9dbb20`
 * pins `solc = "0.8.33"`, and compiling `src/MultiSigWallet.sol` with solc 0.8.33
 * unoptimized and `evm-version cancun` reproduces the runtime bytecode deployed
 * at this address byte for byte apart from the embedded IPFS source hash. Live
 * reads at `latest` answer with one owner, threshold 1 and transaction count 0,
 * and an unknown selector reverts, so it is this contract's dispatcher and not a
 * proxy that answers everything. The selectors below come from the compiler.
 */

/** The chain this app reads the multisig on. */
export const SEPOLIA_CHAIN_ID = 11155111

/** The verified Sepolia deployment, in its checksummed form. */
export const MULTISIG_ADDRESS = '0x5B324F41E5889cf94CbA8e909089683a1a97c318'

/** `getOwners()` */
export const SELECTOR_GET_OWNERS = '0xa0e67e2b'

/** `threshold()` */
export const SELECTOR_THRESHOLD = '0x42cde4e8'

/** `getTransactionCount()` */
export const SELECTOR_TRANSACTION_COUNT = '0x2e7700f0'

/**
 * The longest owner list this app will render.
 *
 * The contract has no maximum owner count, so a hostile or broken answer could
 * otherwise put an unbounded list into the page. A multisig with more than this
 * many owners is not something this screen is built for, and the read says the
 * answer was malformed rather than trying to draw it.
 */
const MAX_OWNERS = 256

/** A whole return payload: hex bytes, even length. */
const HEX = /^0x(?:[0-9a-fA-F]{2})*$/

/** An address as the ABI left-pads it: twelve zero bytes, then twenty. */
const ADDRESS_WORD = /^0x0{24}[0-9a-fA-F]{40}$/

function bytesOf(value: unknown): string | null {
  if (typeof value !== 'string' || !HEX.test(value)) {
    return null
  }

  return value.slice(2)
}

function wordAt(body: string, index: number): string | null {
  const start = index * 64
  const word = body.slice(start, start + 64)

  return word.length === 64 ? `0x${word}` : null
}

/**
 * Reads one unsigned 256-bit word as an exact integer.
 *
 * `bigint` rather than `number`: an ABI word holds up to 78 decimal digits, and
 * every conversion through `Number` would round it.
 */
export function decodeUint256(value: unknown): bigint | null {
  const body = bytesOf(value)

  if (body === null || body.length !== 64) {
    return null
  }

  const word = wordAt(body, 0)

  return word === null ? null : BigInt(word)
}

/**
 * Reads the dynamic `address[]` that `getOwners()` returns.
 *
 * The layout is an offset to the array, its length, then one word per address.
 * This is the ABI shape only. Whether the addresses it returns are ones the
 * contract can hold is `summaryIsPlausible`'s job.
 *
 * Every one of those is checked against the payload length rather than trusted:
 * an offset that does not point at the length word, a length that runs past the
 * data, an address whose high twelve bytes are not zero, or a payload with
 * trailing bytes beyond the declared array is a malformed answer, and the whole
 * answer is refused rather than partly rendered.
 */
export function decodeAddressArray(value: unknown): string[] | null {
  const body = bytesOf(value)

  if (body === null) {
    return null
  }

  const offsetWord = wordAt(body, 0)

  if (offsetWord === null) {
    return null
  }

  // The ABI encodes this array at the head of the payload, so the offset is 32.
  // Accepting another offset would mean accepting a layout this code does not
  // understand.
  if (BigInt(offsetWord) !== 32n) {
    return null
  }

  const lengthWord = wordAt(body, 1)

  if (lengthWord === null) {
    return null
  }

  const length = BigInt(lengthWord)

  if (length > BigInt(MAX_OWNERS)) {
    return null
  }

  const count = Number(length)

  // Exactly the words the length declares, and no trailing bytes: a payload that
  // carries more than it says it does is not the answer this decoder was built
  // for.
  if (body.length !== (2 + count) * 64) {
    return null
  }

  const owners: string[] = []

  for (let index = 0; index < count; index += 1) {
    const word = wordAt(body, 2 + index)

    if (word === null || !ADDRESS_WORD.test(word)) {
      return null
    }

    owners.push(`0x${word.slice(26)}`)
  }

  return owners
}

/** The exact decimal form of a decoded count, for display. */
export function formatCount(value: bigint): string {
  return value.toString(10)
}

/** The address no owner can be, on this contract or any other. */
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/**
 * Whether a decoded summary can be believed.
 *
 * `decodeAddressArray` above checks only that the payload is a well-formed ABI
 * array. This checks the other half: that the configuration it describes is one
 * the contract can actually be in. Everything here is a constructor invariant of
 * `MultiSigWallet`, verified against the source at `f34634c`:
 *
 * - at least one owner (`MultiSigWallet__EmptyOwnersArray`),
 * - no zero address among them (`MultiSigWallet__ZeroAddressOwner`),
 * - no duplicates (`MultiSigWallet__DuplicateOwner`),
 * - a non-zero threshold (`MultiSigWallet__ZeroThreshold`),
 * - a threshold no higher than the owner count (`MultiSigWallet__ThresholdTooHigh`).
 *
 * These are lifetime invariants, not just deploy-time ones: `owners` is written
 * only inside the constructor, since the contract has no add or remove owner
 * function. So an answer that breaks one of them cannot be the state of this
 * deployment, however well-formed its ABI encoding is, and drawing it would be
 * presenting untrusted provider data as a plausible summary.
 */
export function summaryIsPlausible(owners: readonly string[], threshold: bigint): boolean {
  if (owners.length === 0 || threshold <= 0n || threshold > BigInt(owners.length)) {
    return false
  }

  const seen = new Set<string>()

  for (const owner of owners) {
    // Compared in lower case: an address is a number, so `0xAB..` and `0xab..`
    // are the same owner and a duplicate check that missed that would be no
    // check at all.
    const address = owner.toLowerCase()

    if (address === ZERO_ADDRESS || seen.has(address)) {
      return false
    }

    seen.add(address)
  }

  return true
}
