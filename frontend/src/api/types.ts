/**
 * Hand-written mirrors of the response shapes in docs/openapi.yaml.
 *
 * There is no code generation here on purpose. The surface this block wires is
 * four endpoints, and a generator would have to be configured, pinned and kept
 * honest for less type coverage than this file gives.
 *
 * Only what is actually consumed is declared. Contract, chain and event types
 * arrive with the views that consume them, so no type here asserts a contract
 * that nothing tests. uint256 values are strings, never numbers.
 */

/** Every list response carries this alongside its data array. */
export type Pagination = {
  page: number
  pageSize: number
  totalItems: number
  totalPages: number
}

/** POST /api/v1/auth/register and GET /api/v1/users/me. */
export type User = {
  id: number
  email: string
  /** RFC 3339 timestamp, kept as the string the API sent. */
  createdAt: string
}

/**
 * POST /api/v1/auth/login.
 *
 * The login response carries no identity, which is why signing in is two
 * calls: this one, then GET /api/v1/users/me.
 */
export type LoginResult = {
  token: string
  /** RFC 3339 timestamp. Not stored: the server is the authority on expiry. */
  expiresAt: string
}

/** POST /api/v1/auth/logout. */
export type MessageResult = {
  message: string
}

/**
 * GET /api/v1/wallets, one row.
 *
 * Exactly the five fields the handler and the OpenAPI `wallet` schema carry.
 * There is no balance, no indexing status and no key-control proof on a saved
 * address, so none of those are declared here.
 */
export type Wallet = {
  id: number
  address: string
  chainId: number
  label: string
  /** RFC 3339 timestamp, kept as the string the API sent. */
  createdAt: string
}

/** GET /api/v1/wallets, one page. */
export type WalletList = {
  wallets: Wallet[]
  pagination: Pagination
}

/**
 * The page this client asks for. Both values are validated before they reach a
 * URL or a query key, because the server answers a malformed or over-cap one
 * with 400 rather than clamping it.
 */
export type ListWalletsParams = {
  page: number
  pageSize: number
}

/**
 * How indexing availability reads for a tracked contract.
 *
 * Three values, all of them about the deployment rather than about a scan: the
 * API computes this at read time and never sends the scanner's running state or
 * its error text. There is no fourth value for progress because the API does not
 * describe progress.
 */
export type IndexingStatus = 'pending' | 'disabled' | 'unsupported'

/**
 * GET /api/v1/contracts, one tracked record.
 *
 * Exactly the fields the handler sends, all of them, including `createdAt`. A
 * row missing one is a contract violation rather than a record with a blank
 * cell, so the guard refuses the whole page instead of drawing a row with a gap.
 *
 * `startBlock` is the first block the indexer was asked to scan from, kept as a
 * number because the API sends an int64 block height, not a uint256 value.
 */
export type TrackedContract = {
  id: number
  address: string
  chainId: number
  label: string
  enabled: boolean
  startBlock: number
  createdAt: string
  indexingStatus: IndexingStatus
}

/** GET /api/v1/contracts, one page. */
export type ContractList = {
  contracts: TrackedContract[]
  pagination: Pagination
}

/** The page of tracked contracts this client asks for. */
export type ListContractsParams = {
  page: number
  pageSize: number
}

/**
 * The four events the indexer stores for the deployed contract.
 *
 * A closed set, like the availability values: `eventName` selects which payload
 * shape a row carries, so a name outside this set is a row this client cannot
 * read and must not render.
 */
export type EventName =
  | 'SubmitTransaction'
  | 'ConfirmTransaction'
  | 'RevokeConfirmation'
  | 'ExecuteTransaction'

/**
 * The payload of a `SubmitTransaction` event.
 *
 * `valueWei` is the decimal text of a uint256 exactly as stored: it is kept as a
 * string and never parsed into a number, because most of the range does not fit
 * in one. `data` is the raw calldata in hex and is not decoded here: this view
 * shows what was submitted, it does not interpret it.
 */
export type SubmitTransactionPayload = {
  to: string
  valueWei: string
  data: string
}

/**
 * One indexed event.
 *
 * `multisigTxIndex` is a uint256 rendered as decimal text by the server, so it
 * arrives as a string for the same reason `valueWei` does.
 */
export type ContractEvent = {
  contractId: number
  eventName: EventName
  blockNumber: number
  blockHash: string
  transactionHash: string
  transactionIndex: number
  logIndex: number
  actorAddress: string
  multisigTxIndex: string
  /** `{}` for the three owner events, the submit payload for `SubmitTransaction`. */
  payload: SubmitTransactionPayload | Record<string, never>
}

/** GET /api/v1/contracts/{id}/events, one page. */
export type ContractEventList = {
  events: ContractEvent[]
  pagination: Pagination
}

/** The page of events this client asks for. */
export type ListContractEventsParams = {
  page: number
  pageSize: number
}

/**
 * GET /api/v1/chains, one row of the public catalog.
 *
 * Exactly the four fields the handler sends. There is no `enabled` flag here:
 * the route returns enabled chains only, so a disabled chain is absent rather
 * than present and false.
 */
export type Chain = {
  chainId: number
  name: string
  symbol: string
  isTestnet: boolean
}

/**
 * POST /api/v1/wallets, the request body.
 *
 * Three fields and no more. The handler decodes with unknown fields
 * disallowed, so a fourth key is a 400 rather than an ignored extra, and the
 * owner is never a body field the client could get wrong.
 */
export type CreateWalletRequest = {
  address: string
  chainId: number
  label: string
}

/**
 * PATCH /api/v1/wallets/{id}, the request body.
 *
 * One field. Address and chain are not mutable through this route, and the
 * handler rejects an unknown key with `400 INVALID_JSON`, so a caller that hands
 * over more than a label is refused rather than silently trimmed.
 *
 * The handler and `docs/api.md` also accept an omitted or null label as a
 * no-op, while `docs/openapi.yaml` describes a string. This client always sends
 * a validated string, so the discrepancy is neither relied on nor changed here.
 */
export type UpdateWalletRequest = {
  label: string
}

export type RegisterRequest = {
  email: string
  password: string
}

export type LoginRequest = {
  email: string
  password: string
}
