/**
 * Hand-written mirrors of the response shapes in docs/openapi.yaml.
 *
 * There is no code generation here on purpose. The surface this block wires is
 * four endpoints, and a generator would have to be configured, pinned and kept
 * honest for less type coverage than this file gives.
 *
 * Only what this block actually uses is declared. Wallet, contract, chain and
 * event types arrive with the Week 8 views that consume them, so no type here
 * asserts a contract that nothing tests. When they do arrive, uint256 values
 * such as valueWei and multisigTxIndex are strings, never numbers.
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

export type RegisterRequest = {
  email: string
  password: string
}

export type LoginRequest = {
  email: string
  password: string
}
