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
  isWalletList,
} from './guards.ts'
import {
  createRequest,
  type ApiResult,
  type CallInit,
  type RequestDependencies,
} from './request.ts'
import type {
  ListWalletsParams,
  LoginRequest,
  LoginResult,
  MessageResult,
  Pagination,
  RegisterRequest,
  User,
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
  }
}
