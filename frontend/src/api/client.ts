/**
 * The four calls this block wires, as thin functions over the request helper.
 *
 * A factory rather than a module singleton, so tests inject the token source,
 * the unauthorized callback, fetch and the timeout instead of patching
 * modules.
 */

import { ApiError } from './errors.ts'
import {
  isCollectionPagination,
  isLoginResult,
  isMessageResult,
  isUser,
  isWallet,
  isWalletList,
} from './guards.ts'
import {
  createRequest,
  type ApiResult,
  type CallInit,
  type RequestDependencies,
} from './request.ts'
import type {
  CreateWalletRequest,
  UpdateWalletRequest,
  ListWalletsParams,
  LoginRequest,
  LoginResult,
  MessageResult,
  Pagination,
  RegisterRequest,
  User,
  Wallet,
  WalletList,
} from './types.ts'

export type ApiClient = {
  /** Returns the created user. The API issues no token here, so this is not a sign-in. */
  register: (body: RegisterRequest, init?: CallInit) => Promise<User>
  /** Returns the token only. Identity comes from a following getMe call. */
  login: (body: LoginRequest, init?: CallInit) => Promise<LoginResult>
  /** Idempotent: 200 even for a token the server already revoked. */
  logout: (init?: CallInit) => Promise<MessageResult | null>
  getMe: (init?: CallInit) => Promise<User>
  /** The caller's own wallets, one page. The owner comes from the bearer. */
  listWallets: (params: ListWalletsParams, init?: CallInit) => Promise<WalletList>
  /** Saves one wallet for the caller. The owner comes from the bearer. */
  createWallet: (body: CreateWalletRequest, init?: CallInit) => Promise<Wallet>
  /**
   * Replaces the label of one saved wallet. The owner comes from the bearer, so
   * a foreign id is the same `404` a missing one is.
   */
  updateWalletLabel: (
    id: number,
    body: UpdateWalletRequest,
    init?: CallInit,
  ) => Promise<Wallet>
}

/** A body is required where the contract says one is returned. */
function requireData<T>(result: ApiResult<T>): T {
  if (result.data === null) {
    throw new ApiError({
      code: 'UNEXPECTED_RESPONSE',
      status: 0,
      message: 'the server returned an empty body where one was required',
      requestId: result.requestId,
    })
  }

  return result.data
}

function unusablePagination(
  message: string,
  requestId: string | undefined,
): ApiError {
  return new ApiError({
    code: 'UNEXPECTED_RESPONSE',
    status: 0,
    message,
    requestId,
  })
}

/**
 * A list response owes its pagination, and it has to describe the page that
 * was asked for.
 *
 * The request helper allows the block to be absent, because a single-resource
 * response has no page to describe. A collection does, so a wallet page without
 * one is a broken response rather than an empty page: the UI would otherwise
 * have no total to render and no last page to stop at.
 *
 * The values also have to match the request. This client always sends an
 * explicit page and page size, so the effective values are the ones it sent, and
 * a reply describing a different page is not a past-end page: rendering those
 * rows under the requested page number would label one page's data as another.
 * A past-end page is legitimate and is preserved, because it echoes the page
 * that was requested and carries the real totals.
 */
function requirePagination(
  result: ApiResult<unknown>,
  requested: ListWalletsParams,
): Pagination {
  const pagination = result.pagination

  if (pagination === null || !isCollectionPagination(pagination)) {
    throw unusablePagination(
      'the server returned a list without usable pagination',
      result.requestId,
    )
  }

  if (pagination.page !== requested.page) {
    throw unusablePagination(
      `the server described page ${String(pagination.page)} for a request for page ${String(requested.page)}`,
      result.requestId,
    )
  }

  if (pagination.pageSize !== requested.pageSize) {
    throw unusablePagination(
      `the server described a page size of ${String(pagination.pageSize)} for a request for ${String(requested.pageSize)}`,
      result.requestId,
    )
  }

  return pagination
}

/**
 * The id this client is willing to put in a path.
 *
 * `int64` ids arrive as JavaScript numbers, so a float, a value beyond 2^53 or a
 * non-positive number is not an id this client can address. Building the path
 * from one would ask the API about a wallet nobody named, and the answer would
 * then be applied to whatever row the caller had in hand.
 */
function addressableId(id: number): string {
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw unusableId(id)
  }

  return String(id)
}

function unusableId(id: number): ApiError {
  return new ApiError({
    code: 'UNEXPECTED_RESPONSE',
    status: 0,
    message: `the wallet id ${String(id)} is not one this client can address`,
  })
}

/**
 * A success that describes a different wallet than the one asked for.
 *
 * The row may well have been updated; this response just cannot be trusted to
 * say so. It is left as an unexpected response rather than accepted against the
 * requested id, because writing another row's fields into this row would be a
 * silent corruption and the label shown would belong to an id nobody opened.
 */
function wrongTarget(requestedId: number, returnedId: number): ApiError {
  return new ApiError({
    code: 'UNEXPECTED_RESPONSE',
    status: 200,
    message: `the server described wallet ${String(returnedId)} for a request about wallet ${String(requestedId)}`,
  })
}

export function createApiClient(dependencies: RequestDependencies): ApiClient {
  const request = createRequest(dependencies)

  return {
    async register(body, init) {
      // No auth: the caller has no token yet, and sending one would be
      // meaningless on a route that creates an account.
      //
      // The fields are selected here rather than forwarded, because the
      // server rejects unknown keys. A caller that hands over its whole form
      // object, confirm-password and all, still sends exactly two fields.
      const result = await request({
        method: 'POST',
        path: '/auth/register',
        body: { email: body.email, password: body.password },
        guard: isUser,
        signal: init?.signal,
      })

      return requireData(result)
    },

    async login(body, init) {
      // Selected, not forwarded, for the same reason register selects.
      const result = await request({
        method: 'POST',
        path: '/auth/login',
        body: { email: body.email, password: body.password },
        guard: isLoginResult,
        signal: init?.signal,
      })

      return requireData(result)
    },

    async logout(init) {
      const result = await request({
        method: 'POST',
        path: '/auth/logout',
        auth: true,
        guard: isMessageResult,
        signal: init?.signal,
      })

      return result.data
    },

    async getMe(init) {
      const result = await request({
        method: 'GET',
        path: '/users/me',
        auth: true,
        guard: isUser,
        signal: init?.signal,
      })

      return requireData(result)
    },

    async listWallets(params, init) {
      // Owner-scoped by construction: the handler takes the owner from the
      // bearer, so no user id is sent and none can be sent.
      const query = new URLSearchParams({
        page: String(params.page),
        pageSize: String(params.pageSize),
      })

      const result = await request({
        method: 'GET',
        path: `/wallets?${query.toString()}`,
        auth: true,
        guard: isWalletList,
        signal: init?.signal,
      })

      return {
        wallets: requireData(result),
        pagination: requirePagination(result, params),
      }
    },

    async createWallet(body, init) {
      // Owner-scoped by construction, exactly like the list: the handler takes
      // the owner from the bearer, so no user id is sent and none can be sent.
      //
      // Selected field by field rather than forwarded. The handler decodes with
      // unknown fields disallowed, so a fourth key is a 400 rather than an
      // ignored extra, and a caller that hands over its whole form state, error
      // messages and all, still sends exactly three fields.
      const result = await request({
        method: 'POST',
        path: '/wallets',
        auth: true,
        body: { address: body.address, chainId: body.chainId, label: body.label },
        // All five fields, including createdAt. A row missing the timestamp is
        // not a row this client can render or key, so it is a contract
        // violation rather than a wallet with a blank cell.
        guard: isWallet,
        signal: init?.signal,
      })

      return requireData(result)
    },

    async updateWalletLabel(id, body, init) {
      // Built from a checked id, never from a string the caller happened to
      // have. `label` is the only key sent: the handler rejects unknown fields,
      // and the owner is the bearer.
      const result = await request({
        method: 'PATCH',
        path: `/wallets/${addressableId(id)}`,
        auth: true,
        body: { label: body.label },
        // The same five-field guard creation uses, `createdAt` included. A row
        // missing a field is a contract violation, not a wallet with a blank
        // cell.
        guard: isWallet,
        signal: init?.signal,
      })

      const wallet = requireData(result)

      if (wallet.id !== id) {
        throw wrongTarget(id, wallet.id)
      }

      return wallet
    },
  }
}
