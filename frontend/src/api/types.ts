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

export type RegisterRequest = {
  email: string
  password: string
}

export type LoginRequest = {
  email: string
  password: string
}
