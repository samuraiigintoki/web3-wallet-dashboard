/**
 * The calls this block wires, as thin functions over the request helper.
 *
 * A factory rather than a module singleton, so tests inject the token source,
 * the unauthorized callback, fetch and the timeout instead of patching
 * modules.
 */

import { ApiError } from './errors.ts'
import {
  isCollectionPagination,
  isContractEventList,
  isContractList,
  isLoginResult,
  isMessageResult,
  isTrackedContract,
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
  ContractEventList,
  ContractList,
  CreateWalletRequest,
  UpdateWalletRequest,
  ListContractEventsParams,
  ListContractsParams,
  ListWalletsParams,
  LoginRequest,
  LoginResult,
  MessageResult,
  Pagination,
  RegisterRequest,
  TrackedContract,
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
  /**
   * The caller's own tracked contracts, one page. Owner-scoped exactly like the
   * wallet list: the handler takes the owner from the bearer, so no user id is
   * sent and none can be. Read-only: nothing in this slice creates, updates,
   * enables or removes a record.
   */
  listContracts: (params: ListContractsParams, init?: CallInit) => Promise<ContractList>
  /**
   * One tracked contract by id, for the context above an event list.
   *
   * The owner comes from the bearer, so a contract belonging to someone else is
   * the same `404` a missing one is, and the caller cannot tell them apart.
   */
  getContract: (id: number, init?: CallInit) => Promise<TrackedContract>
  /**
   * One page of the indexed events the server stored for a tracked contract.
   *
   * Owner-scoped by the same association the other contract routes use, so a
   * foreign id is a `404` rather than an empty page. Read-only: this client
   * cannot start a scan, re-index, or ask for anything live.
   */
  listContractEvents: (
    id: number,
    params: ListContractEventsParams,
    init?: CallInit,
  ) => Promise<ContractEventList>
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
  /**
   * Removes one saved record. Resolves only when the server confirmed it with
   * `204 No Content`; every other answer is an ApiError.
   */
  deleteWallet: (id: number, init?: CallInit) => Promise<void>
  /**
   * Reads one saved record by id, for reconciling an outcome this client could
   * not confirm. A foreign id is the same typed `404` a missing one is.
   */
  getWallet: (id: number, init?: CallInit) => Promise<Wallet>
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

/**
 * A response that answers about something other than what was asked for.
 *
 * A structurally valid body is not automatically the answer to this request. A
 * contract read that returns a different contract, or an event page whose rows
 * belong to another contract, would be drawn under this URL as if it were this
 * one: the shape checks pass, so nothing else would catch it. The correlation
 * check is what keeps the screen's subject and the server's answer the same
 * thing.
 */
function mismatchedResponse(message: string, requestId: string | undefined): ApiError {
  return new ApiError({
    code: 'UNEXPECTED_RESPONSE',
    status: 0,
    message,
    requestId,
  })
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
  requested: { page: number; pageSize: number },
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
 * A 2xx that is not the `204` the delete contract promises.
 *
 * An empty body is not a confirmation on its own: only `204 No Content` is the
 * documented answer for a removed record, so an empty `200` or `202` is a
 * response this client cannot read as a removal. It keeps its real status, so
 * the caller can treat it as the unknown outcome it is rather than as a
 * success.
 */
function unconfirmedRemoval(status: number, requestId: string | undefined): ApiError {
  return new ApiError({
    code: 'UNEXPECTED_RESPONSE',
    status,
    message: `the server answered ${String(status)} where the delete contract says 204`,
    requestId,
  })
}

/**
 * A success that describes a different wallet than the one asked for.
 *
 * The row may well have been updated; this response just cannot be trusted to
 * say so. It is left as an unexpected response rather than accepted against the
 * requested id, because writing another row's fields into this row would be a
 * silent corruption and the label shown would belong to an id nobody opened.
 *
 * `X-Request-ID` is carried through. This is a real response from the server,
 * and the id is the only thing that lets a user report it and someone find it in
 * the access log.
 */
function wrongTarget(
  requestedId: number,
  returnedId: number,
  requestId: string | undefined,
): ApiError {
  return new ApiError({
    code: 'UNEXPECTED_RESPONSE',
    status: 200,
    message: `the server described wallet ${String(returnedId)} for a request about wallet ${String(requestedId)}`,
    requestId,
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

    async listContracts(params, init) {
      // Owner-scoped by construction, the same way the wallet list is: the
      // handler resolves the owner from the bearer. Two query parameters and
      // nothing else, so no filter can narrow the list to someone else's rows
      // or widen it past the page the screen asked for.
      const query = new URLSearchParams({
        page: String(params.page),
        pageSize: String(params.pageSize),
      })

      const result = await request({
        method: 'GET',
        path: `/contracts?${query.toString()}`,
        auth: true,
        guard: isContractList,
        signal: init?.signal,
      })

      return {
        contracts: requireData(result),
        pagination: requirePagination(result, params),
      }
    },

    async getContract(id, init) {
      const result = await request({
        method: 'GET',
        path: `/contracts/${addressableId(id)}`,
        auth: true,
        guard: isTrackedContract,
        signal: init?.signal,
      })

      const contract = requireData(result)

      // The body must be the contract this client asked about. A row that is
      // well formed but describes another contract would otherwise become the
      // context for this URL, and the events read that follows would be enabled
      // by a successful read of the wrong record.
      if (contract.id !== id) {
        throw mismatchedResponse(
          `the server answered with contract ${String(contract.id)} for a request for contract ${String(id)}`,
          result.requestId,
        )
      }

      return contract
    },

    async listContractEvents(id, params, init) {
      // The same two query parameters as every other list: no filter, no sort,
      // no page size the caller chooses. The order is the server's, and so are
      // the totals.
      const query = new URLSearchParams({
        page: String(params.page),
        pageSize: String(params.pageSize),
      })

      const result = await request({
        method: 'GET',
        path: `/contracts/${addressableId(id)}/events?${query.toString()}`,
        auth: true,
        guard: isContractEventList,
        signal: init?.signal,
      })

      const events = requireData(result)

      // Every row must belong to the contract in the path. One page for one
      // contract is the whole premise of this call, so a page holding another
      // contract's rows is a broken answer, not a page to render and trust: a
      // single foreign row would put somebody else's event under this URL.
      const foreign = events.find((event) => event.contractId !== id)

      if (foreign !== undefined) {
        throw mismatchedResponse(
          `the server answered with events for contract ${String(foreign.contractId)} for a request about contract ${String(id)}`,
          result.requestId,
        )
      }

      return {
        events,
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
        throw wrongTarget(id, wallet.id, result.requestId)
      }

      return wallet
    },

    async deleteWallet(id, init) {
      // Owner-scoped by the bearer, exactly like every other wallet call. No
      // body: the route takes the id from the path and nothing else, and the
      // handler answers an unexpected body the way it answers any malformed
      // request.
      const result = await request({
        method: 'DELETE',
        path: `/wallets/${addressableId(id)}`,
        auth: true,
        // Only reached when the server sends a body, which the contract says a
        // `204` does not. A wallet here is still not a confirmation, and it is
        // refused below with its real status.
        guard: isWallet,
        signal: init?.signal,
      })

      if (result.status !== 204 || result.data !== null) {
        throw unconfirmedRemoval(result.status, result.requestId)
      }
    },

    async getWallet(id, init) {
      const result = await request({
        method: 'GET',
        path: `/wallets/${addressableId(id)}`,
        auth: true,
        // All five fields, `createdAt` included: a row missing one is a
        // contract violation, not an absence.
        guard: isWallet,
        signal: init?.signal,
      })

      const wallet = requireData(result)

      // The same target check the update applies. A read that describes another
      // record says nothing about the one being reconciled.
      if (wallet.id !== id) {
        throw wrongTarget(id, wallet.id, result.requestId)
      }

      return wallet
    },
  }
}
