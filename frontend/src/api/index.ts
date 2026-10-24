export { createApiClient, type ApiClient } from './client.ts'
export {
  chainCatalog,
  createChainCatalog,
  type ChainCatalog,
} from './chains.ts'
export {
  ApiError,
  isApiError,
  isServerErrorCode,
  CLIENT_ERROR_CODES,
  SERVER_ERROR_CODES,
  type ApiErrorCode,
  type ClientErrorCode,
  type ServerErrorCode,
} from './errors.ts'
export { describeApiError } from './messages.ts'
export {
  API_BASE,
  DEFAULT_TIMEOUT_MS,
  createRequest,
  type ApiResult,
  type CallInit,
  type RequestDependencies,
  type RequestFn,
  type RequestOptions,
} from './request.ts'
export type {
  Chain,
  ContractList,
  CreateWalletRequest,
  IndexingStatus,
  ListContractsParams,
  ListWalletsParams,
  LoginRequest,
  LoginResult,
  MessageResult,
  Pagination,
  RegisterRequest,
  TrackedContract,
  UpdateWalletRequest,
  User,
  Wallet,
  WalletList,
} from './types.ts'
export { isChain, isChainList, isContractList, isTrackedContract } from './guards.ts'
