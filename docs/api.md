# Initial REST API Outline

## Status

This document is an initial API design. Only `GET /health` is implemented at the time of writing. All `/api/v1` routes below are planned and may change during implementation.

## Design principles

- Use JSON over HTTPS.
- Version application routes under `/api/v1`.
- Keep liveness and readiness endpoints outside authenticated API routes.
- Authenticate protected routes.
- Enforce record ownership in services and repository queries.
- Use consistent errors, pagination, filtering, and request identifiers.
- Keep browser-wallet contract writes out of the Go API. Users sign state-changing transactions in their browser wallet.
- Distinguish direct chain state from eventually consistent indexed data.

## Base paths

```text
/health          Operational liveness
/ready           Planned dependency readiness
/api/v1          Versioned application API
```

## Content types

Requests with a body:

```http
Content-Type: application/json
```

Responses:

```http
Content-Type: application/json
```

## Authentication

The final mechanism—secure cookie-based session or bearer token—will be selected before authentication implementation.

Protected routes require an authenticated application user. Browser-wallet connection does not replace application authentication, and saving an address does not prove control of its private key.

## Common response conventions

### Single resource

```json
{
  "data": {
    "id": "resource-id"
  }
}
```

### Collection

```json
{
  "data": [],
  "pagination": {
    "page": 1,
    "pageSize": 20,
    "totalItems": 0,
    "totalPages": 0
  }
}
```

The first implementation may use offset pagination. Cursor pagination can be considered only if measured data volume requires it.

### Error Response Catalog

| Status | Code | Condition | Details Shape |
|---|---|---|---|
| `400 Bad Request` | `INVALID_JSON` | Malformed JSON syntax, unknown fields, field type mismatch, body > 1MB | None |
| `422 Unprocessable Entity` | `VALIDATION_ERROR` | Domain rule failure (address length/prefix, label length, chainId <= 0) | `{"details": {"<field>": "<message>"}}` |
| `409 Conflict` | `RESOURCE_CONFLICT` | Duplicate `(address, chainId)` record | None |
| `500 Internal Server Error` | `INTERNAL_SERVER_ERROR` | Unhandled internal server error | None |

## Common status codes

- `200 OK` — successful read or update
- `201 Created` — resource created
- `204 No Content` — successful deletion or logout
- `400 Bad Request` — malformed request or invalid input
- `401 Unauthorized` — missing or invalid authentication
- `403 Forbidden` — authenticated but not permitted
- `404 Not Found` — resource not found or not visible to the user
- `409 Conflict` — duplicate or conflicting state
- `422 Unprocessable Entity` — valid JSON with domain-invalid values
- `429 Too Many Requests` — rate limit exceeded
- `500 internal Server Error` — unexpected application failure
- `502 Bad Gateway` — upstream RPC failure where appropriate
- `503 Service Unavailable` — required dependency unavailable

## Operational endpoints

### `GET /health`

**Status:** Implemented

Purpose: process liveness. It does not check PostgreSQL or EVM RPC.

Response:

```json
{
  "status": "ok"
}
```

Expected status: `200 OK`.

Unsupported methods return `405 Method Not Allowed`.

### `GET /ready`

**Status:** Planned

Purpose: indicate whether dependencies required to serve application traffic are ready.

Potential checks:

- PostgreSQL connectivity
- Required migrations applied
- Configuration loaded

RPC readiness must be designed carefully: a temporary provider failure should be reported without unnecessarily restarting an otherwise healthy API process.

## Authentication routes

### `POST /api/v1/auth/register`

**Authentication:** Public

Request:

```json
{
  "email": "user@example.com",
  "password": "user-supplied-password"
}
```

Behavior:

- Normalize email.
- Validate password policy.
- Store only an approved password hash, never plaintext.
- Reject duplicate accounts consistently.

Success: `201 Created`.

### `POST /api/v1/auth/login`

**Authentication:** Public

Request:

```json
{
  "email": "user@example.com",
  "password": "user-supplied-password"
}
```

Behavior depends on the selected authentication mechanism. Authentication failures should not reveal whether the email exists.

Success: `200 OK`.

### `POST /api/v1/auth/logout`

**Authentication:** Required

Invalidates the current session or token state where applicable.

Success: `204 No Content`.

### `GET /api/v1/users/me`

**Authentication:** Required

Returns the authenticated application user's public profile.

Example response:

```json
{
  "data": {
    "id": "user-id",
    "email": "user@example.com",
    "createdAt": "2026-08-18T00:00:00Z"
  }
}
```

## Saved-wallet routes

A saved wallet is an off-chain address record. It does not prove control of the address.

### `POST /api/v1/wallets`

**Status:** Implemented — in-memory repository, unauthenticated

**Authentication:** Public (authentication deferred to future block)

Request:

```json
{
  "address": "0x0000000000000000000000000000000000000001",
  "chainId": 11155111,
  "label": "Primary Sepolia signer"
}
```
Validation:

- Address: non-empty after trimming, starts with 0x, exactly 42 characters total.
- Chain ID: positive integer (> 0).
- Label: non-empty after trimming, maximum 50 Unicode characters (runes).
- Duplicate (address, chainId) rejected with 409 Conflict.
- Request body size bounded to 1 MB maximum.

Success: `201 Created`.
```json
{
  "data": {
    "address": "0x0000000000000000000000000000000000000001",
    "chainId": 11155111,
    "label": "Primary Sepolia signer"
  }
}
```

### `GET /api/v1/wallets`

**Authentication:** Required

Query parameters:

- `page`
- `pageSize`
- `chainId`
- `search` for label or address where supported

Only the authenticated user's records are returned.

### `GET /api/v1/wallets/{walletId}`

**Authentication:** Required

Returns one user-owned saved wallet.

### `PATCH /api/v1/wallets/{walletId}`

**Authentication:** Required

Initial mutable field:

```json
{
  "label": "Updated label"
}
```

Changing address or chain should create a new record rather than silently changing resource identity unless a later requirement justifies it.

### `DELETE /api/v1/wallets/{walletId}`

**Authentication:** Required

Removes the authenticated user's saved-wallet record. It does not perform an on-chain action.

Success: `204 No Content`.

## Tracked-contract routes

The database separates a globally identified contract deployment from a user's tracking relationship. API responses may present them as one resource.

### `POST /api/v1/contracts`

**Authentication:** Required

Request:

```json
{
  "address": "0x0000000000000000000000000000000000000002",
  "chainId": 11155111,
  "label": "Team multisig",
  "startBlock": 1234567
}
```

Behavior:

- Validate address, chain, and start block.
- Create or reuse the global contract deployment record.
- Create the authenticated user's tracking relationship.
- Optionally perform a bounded compatibility check against the known `MultiSigWallet` ABI.

Success: `201 Created`.

### `GET /api/v1/contracts`

**Authentication:** Required

Query parameters:

- `page`
- `pageSize`
- `chainId`
- `enabled`
- `search`

Returns contracts tracked by the authenticated user.

### `GET /api/v1/contracts/{contractId}`

**Authentication:** Required

Returns saved metadata and indexing status for one visible contract.

### `PATCH /api/v1/contracts/{contractId}`

**Authentication:** Required

Initially mutable user-specific fields:

```json
{
  "label": "Treasury multisig",
  "enabled": true
}
```

Changing chain, address, or deployment block requires explicit migration behavior and is not an ordinary label update.

### `DELETE /api/v1/contracts/{contractId}`

**Authentication:** Required

Removes the user's tracking relationship. Shared global contract and indexed records must not be deleted merely because one user stops tracking them.

Success: `204 No Content`.

## Contract-state routes

These routes return direct or recently fetched chain state and must identify the source clearly.

### `GET /api/v1/contracts/{contractId}/state`

**Authentication:** Required

Planned response:

```json
{
  "data": {
    "chainId": 11155111,
    "address": "0x0000000000000000000000000000000000000002",
    "owners": [],
    "threshold": "2",
    "transactionCount": "0",
    "blockNumber": "1234567",
    "source": "rpc"
  }
}
```

Large on-chain integers may be serialized as decimal strings to avoid JavaScript precision loss. This convention must remain consistent across API types.

### `GET /api/v1/contracts/{contractId}/owners`

**Authentication:** Required

Returns owner addresses from direct chain state or a documented cached representation.

## Indexed multisig transaction routes

These routes expose eventually consistent PostgreSQL projections produced by the indexer.

### `GET /api/v1/contracts/{contractId}/transactions`

**Authentication:** Required

Query parameters:

- `page`
- `pageSize`
- `executed`
- `submittedBy`
- `to`
- `fromBlock`
- `toBlock`
- `sort`, initially restricted to supported values

Response entries should include:

- Contract transaction index
- Destination
- ETH value as a decimal string
- Calldata
- Executed state
- Submission actor and EVM transaction hash
- Current derived confirmation count
- Threshold
- Last indexed block
- Data source set to `indexer`

### `GET /api/v1/contracts/{contractId}/transactions/{txIndex}`

**Authentication:** Required

Returns one indexed multisig transaction and its current confirmation projection.

A missing indexed transaction does not prove that it does not exist on-chain; the API should communicate indexing lag where relevant.

### `GET /api/v1/contracts/{contractId}/transactions/{txIndex}/confirmations`

**Authentication:** Required

Returns current confirmation state derived from confirm and revoke events.

## Indexed-event routes

### `GET /api/v1/contracts/{contractId}/events`

**Authentication:** Required

Query parameters:

- `page`
- `pageSize`
- `eventName`
- `actor`
- `transactionHash`
- `fromBlock`
- `toBlock`

Supported event names initially correspond to the actual contract ABI:

- `SubmitTransaction`
- `ConfirmTransaction`
- `RevokeConfirmation`
- `ExecuteTransaction`
- `Deposit`, if added in the integration revision

### `GET /api/v1/contracts/{contractId}/events/{eventId}`

**Authentication:** Required

Returns one decoded indexed event with chain identifiers and decoded payload.

## Indexing-status routes

### `GET /api/v1/contracts/{contractId}/indexing-status`

**Authentication:** Required

Planned response:

```json
{
  "data": {
    "state": "running",
    "startBlock": "1234567",
    "lastIndexedBlock": "1234999",
    "latestObservedBlock": "1235005",
    "lagBlocks": "6",
    "lastError": null,
    "updatedAt": "2026-08-18T00:00:00Z"
  }
}
```

Do not expose secrets or raw provider URLs.

## Browser-wallet write boundary

The following are contract operations, not ordinary Go API write endpoints:

- `submitTransaction(address,uint256,bytes)`
- `confirmTransaction(uint256)`
- `revokeConfirmation(uint256)`
- `executeTransaction(uint256)`

The intended path is:

```text
React → viem/wagmi → browser wallet → EVM JSON-RPC → MultiSigWallet
```

The Go API may provide contract metadata, normalized reads, and indexed results. It must not request or store a private key to perform these actions.

## Validation conventions

- Reject unknown JSON fields where practical.
- Enforce request-body size limits.
- Validate UUID or resource identifier syntax before querying.
- Normalize EVM addresses consistently for storage and equality.
- Validate positive chain IDs and supported networks.
- Bound page size, block ranges, label lengths, and search lengths.
- Treat client-supplied user IDs and ownership fields as untrusted; ownership comes from authentication context.

## Pagination defaults

Initial proposal:

- Default `page`: `1`
- Default `pageSize`: `20`
- Maximum `pageSize`: `100`

Exact limits may change after implementation measurements.

## Rate limiting

Rate limiting is planned for authentication and RPC-backed routes. It should be added after route behavior is correct and tested, with limits documented rather than copied blindly.

## Open API decisions

1. Cookie session or bearer-token authentication.
2. UUID or another public resource identifier format.
3. Exact error-code catalog (partially resolved: `INVALID_JSON` for 400 and `VALIDATION_ERROR` for 422 implemented for wallet routes).
4. Whether contract-state reads are always direct RPC reads or may use a short cache.
5. Whether large EVM integers are always decimal strings.
6. Whether transaction-receipt lookup needs a dedicated API route.
7. Whether optional status notifications use WebSocket or server-sent events.
8. Whether API documentation is generated from an OpenAPI specification or maintained alongside code.
