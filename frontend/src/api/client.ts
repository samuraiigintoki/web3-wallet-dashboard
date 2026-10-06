/**
 * The four calls this block wires, as thin functions over the request helper.
 *
 * A factory rather than a module singleton, so tests inject the token source,
 * the unauthorized callback, fetch and the timeout instead of patching
 * modules.
 */

import { ApiError } from './errors.ts'
import { isLoginResult, isMessageResult, isUser } from './guards.ts'
import {
  createRequest,
  type ApiResult,
  type CallInit,
  type RequestDependencies,
} from './request.ts'
import type {
  LoginRequest,
  LoginResult,
  MessageResult,
  RegisterRequest,
  User,
} from './types.ts'

export type ApiClient = {
  /** Returns the created user. The API issues no token here, so this is not a sign-in. */
  register: (body: RegisterRequest, init?: CallInit) => Promise<User>
  /** Returns the token only. Identity comes from a following getMe call. */
  login: (body: LoginRequest, init?: CallInit) => Promise<LoginResult>
  /** Idempotent: 200 even for a token the server already revoked. */
  logout: (init?: CallInit) => Promise<MessageResult | null>
  getMe: (init?: CallInit) => Promise<User>
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

export function createApiClient(dependencies: RequestDependencies): ApiClient {
  const request = createRequest(dependencies)

  return {
    async register(body, init) {
      // No auth: the caller has no token yet, and sending one would be
      // meaningless on a route that creates an account.
      const result = await request({
        method: 'POST',
        path: '/auth/register',
        body,
        guard: isUser,
        signal: init?.signal,
      })

      return requireData(result)
    },

    async login(body, init) {
      const result = await request({
        method: 'POST',
        path: '/auth/login',
        body,
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
  }
}
