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
  ContractEvent,
  ContractEventList,
  ContractList,
  CreateWalletRequest,
  EventName,
  IndexingStatus,
  ListContractEventsParams,
  ListContractsParams,
  ListWalletsParams,
  LoginRequest,
  LoginResult,
  MessageResult,
  Pagination,
  RegisterRequest,
  SubmitTransactionPayload,
  TrackedContract,
  UpdateWalletRequest,
  User,
  Wallet,
  WalletList,
} from './types.ts'
export {
  isChain,
  isChainList,
  isContractEvent,
  isContractEventList,
  isContractList,
  isTrackedContract,
} from './guards.ts'
