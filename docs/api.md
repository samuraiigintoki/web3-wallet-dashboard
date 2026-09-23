# Initial REST API Outline

## Status

This document is the living REST API design. `GET /health`, `POST /api/v1/wallets`, `GET /api/v1/wallets`, `GET /api/v1/wallets/{id}`, `PATCH /api/v1/wallets/{id}`, `DELETE /api/v1/wallets/{id}`, `POST /api/v1/auth/register`, `POST /api/v1/auth/login`, `POST /api/v1/auth/logout`, `GET /api/v1/users/me`, `GET /api/v1/chains`, `POST /api/v1/contracts`, `GET /api/v1/contracts`, `GET /api/v1/contracts/{id}`, `PATCH /api/v1/contracts/{id}` and `DELETE /api/v1/contracts/{id}` are implemented. Additional routes remain planned.

## Design principles

- Use JSON over HTTPS.
- Version application routes under `/api/v1`.
- Keep liveness and readiness endpoints outside authenticated API routes.
- Authenticate protected routes (planned for auth milestone).
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

Authentication uses stateful bearer tokens passed via the `Authorization: Bearer <token>` header. Sessions are stored as SHA-256 hashes in PostgreSQL (`user_sessions`) with a fixed 7-day TTL and instant revocation on logout (see `docs/auth.md`).

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
| `400 Bad Request` | `VALIDATION_ERROR` | Syntactic failures with no field to name: non-integer query parameters (`page`, `pageSize`, `chainId`), a path `id` that is not a positive integer, or an `enabled` value other than the literal `true` / `false` (including empty) | None |
| `400 Bad Request` | `VALIDATION_ERROR` | Query-parameter caps, which do name a field: `page` > 10000, `pageSize` > 100 | `{"<field>": "<message>"}` (e.g. `{"page": "page must not exceed 10000"}`) |
| `401 Unauthorized` | `INVALID_CREDENTIALS` | Unknown email or incorrect password during login (timing-safe, identical body) | None |
| `401 Unauthorized` | `UNAUTHENTICATED` | Missing, malformed, expired, or non-existent session token | None |
| `404 Not Found` | `RESOURCE_NOT_FOUND` | Resource matching requested ID does not exist | None |
| `409 Conflict` | `RESOURCE_CONFLICT` | Duplicate `(address, chainId)` wallet record, or duplicate per-user tracking of the same `(address, chainId)` contract | None |
| `409 Conflict` | `USER_CONFLICT` | Duplicate registration email (`idx_users_email_lower`) | None |
| `422 Unprocessable Entity` | `VALIDATION_ERROR` | Semantic domain validation failures (e.g., malformed address format, empty label, label > 50 chars, unsupported or disabled chainId, negative chainId) | `{"<field>": "<message>"}` (e.g. `{"chainId": "unsupported chain id"}`) |
| `500 Internal Server Error` | `INTERNAL_SERVER_ERROR` | Unhandled internal server error | None |

*Note on 405 Method Not Allowed: Method mismatch rejections (e.g. `POST /health`) are handled natively by `http.ServeMux` and return `405 Method Not Allowed` in `text/plain` format.*

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

**Status:** Implemented — PostgreSQL persistence

**Authentication:** Public

Request:
```json
{
  "email": "user@example.com",
  "password": "user-supplied-password"
}
```

Behavior:
- Normalize email (trimmed and lowercased).
- Hard validation: email must contain `@` (simple MVP rule), password length <= 72 bytes (pre-bcrypt check).
- Store cost-10 bcrypt password hash, never plaintext.
- Duplicate email rejected with `409 USER_CONFLICT`.
- Does not expose password or hash in response.

Success: `201 Created`.
```json
{
  "data": {
    "id": 1,
    "email": "user@example.com",
    "createdAt": "2026-09-18T10:00:00Z"
  }
}
```

Errors:
- `400 Bad Request`: `INVALID_JSON` (Malformed body or unknown fields)
- `409 Conflict`: `USER_CONFLICT` (Email already registered)
- `422 Unprocessable Entity`: `VALIDATION_ERROR` with structured field details.
  ```json
  {
    "error": {
      "code": "VALIDATION_ERROR",
      "message": "validation failed",
      "details": {
        "password": "password exceeds maximum allowed length of 72 bytes"
      }
    }
  }
  ```

### `POST /api/v1/auth/login`

**Status:** Implemented — PostgreSQL persistence

**Authentication:** Public

Request:
```json
{
  "email": "user@example.com",
  "password": "user-supplied-password"
}
```

Behavior:
- Generates 32-byte `crypto/rand` token (base64url encoded).
- Stores `sha256(token)` in `user_sessions` with 7-day TTL.
- Constant-time unknown-email verification via dummy bcrypt hash prevents timing oracle.
- Returns identical 401 `INVALID_CREDENTIALS` for both unknown email and wrong password.

Success: `200 OK`.
```json
{
  "data": {
    "token": "dGVzdC10b2tlbi1yYW5kb20tMzItYnl0ZXM",
    "expiresAt": "2026-09-25T10:00:00Z"
  }
}
```

### `POST /api/v1/auth/logout`

**Status:** Implemented — PostgreSQL persistence

**Authentication:** Required (`Authorization: Bearer <token>`)

Behavior:
- Hashes token from header and deletes session row (`DELETE FROM user_sessions WHERE token_hash = $1`).
- Instantly revokes session across all requests.
- Idempotent: repeating logout or calling with an already-revoked session succeeds with 200 (no-op delete).

Success: `200 OK`.
```json
{
  "data": {
    "message": "logged out"
  }
}
```

Errors:
- `401 Unauthorized`: `UNAUTHENTICATED` (Missing or malformed Authorization header)

### `GET /api/v1/users/me`

**Status:** Implemented — PostgreSQL persistence

**Authentication:** Required (`Authorization: Bearer <token>`)

Returns the authenticated application user's profile.

Success: `200 OK`.
```json
{
  "data": {
    "id": 1,
    "email": "user@example.com",
    "createdAt": "2026-09-18T10:00:00Z"
  }
}
```

## Saved-wallet routes

A saved wallet is an off-chain address record. It does not prove control of the address.

### `POST /api/v1/wallets`

**Status:** Implemented — PostgreSQL persistence

**Authentication:** Public (unauthenticated for MVP slice)

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
- Chain ID: positive integer (> 0). Non-positive → 422 VALIDATION_ERROR with details {"chainId": "invalid chainId"}. Positive but absent from the chain catalog, or disabled → 422 VALIDATION_ERROR with details {"chainId": "unsupported chain id"}.
- Label: non-empty after trimming, maximum 50 Unicode characters (runes).
- Duplicate (address, chainId) rejected with 409 Conflict.
- Request body size bounded to 1 MB maximum.

Success: `201 Created`.
```json
{
  "data": {
    "id": 1,
    "address": "0x0000000000000000000000000000000000000001",
    "chainId": 11155111,
    "label": "Primary Sepolia signer"
  }
}
```

### `GET /api/v1/wallets`

**Status:** Implemented — PostgreSQL persistence

**Authentication:** Public (unauthenticated for MVP slice)

Query parameters:

- `page` — optional integer. Default `1`. Maximum `10000`. Omitted, `0`, or negative uses the default. Non-integer or greater than `10000` → `400` `VALIDATION_ERROR`.
- `pageSize` — optional integer. Default `20`. Maximum `100`. Omitted, `0`, or negative uses the default. Non-integer or greater than `100` → `400` `VALIDATION_ERROR`.
- `chainId` (optional integer query filter):
  - Passing a non-integer value returns `400 Bad Request` with `VALIDATION_ERROR` (e.g., `?chainId=abc`).
  - Passing a negative number returns `422 Unprocessable Entity` with details `{"chainId": "invalid chainId"}` (e.g., `?chainId=-5`).
  - Passing an integer that does not exist in the chain catalog or is disabled returns `422 Unprocessable Entity` with details `{"chainId": "unsupported chain id"}` (e.g., `?chainId=999999`).
  - Omit or pass `0` to completely skip the filter and list wallets across all chains.
- `search` — optional string. Trimmed; case-insensitive substring match on `label` or `address`. Empty after trim means no search filter. `%` and `_` are literal characters, not SQL wildcards. Send `%` as `%25`. A raw `search=%` is an invalid URL escape and is dropped (same as omitting `search`).

Sort: `createdAt` descending, then `id` descending.

A page past the last page returns `200` with `"data": []` and the true `totalItems` / `totalPages`.

`createdAt` is RFC3339 from `time.Time` (UTC if the value is UTC).

Success: `200 OK`.

```json
{
  "data": [
    {
      "id": 2,
      "address": "0x00000000000000000000000000000000000000bb",
      "chainId": 1,
      "label": "beta search-hit",
      "createdAt": "2026-09-12T12:00:00Z"
    }
  ],
  "pagination": {
    "page": 1,
    "pageSize": 20,
    "totalItems": 1,
    "totalPages": 1
  }
}
```


### `GET /api/v1/wallets/{id}`

**Status:** Implemented — PostgreSQL persistence

**Authentication:** Public (unauthenticated for MVP slice)

Returns one saved wallet by database identity ID.

Success: `200 OK`.

```json
{
  "data": {
    "id": 1,
    "address": "0x0000000000000000000000000000000000000001",
    "chainId": 11155111,
    "label": "Primary Sepolia signer",
    "createdAt": "2026-09-12T12:00:00Z"
  }
}
```
`404` `RESOURCE_NOT_FOUND` if the id does not exist. Invalid or non-positive `id` → `400` `VALIDATION_ERROR`.


### `PATCH /api/v1/wallets/{id}`

**Status:** Implemented — PostgreSQL persistence

**Authentication:** Public (unauthenticated for MVP slice)

Updates the label of an existing saved wallet. This is the only mutable field.

Request:

```json
{
  "label": "Updated label"
}
```

Behavior:

- `label` is optional. Absent, or `{"label":null}`, is a no-op: the wallet is
  returned unchanged, `200 OK`.
- `label` present and non-empty after trimming: validated under the same rule
  as `POST` (max 50 Unicode characters), then updated.
- `label` present but empty or whitespace-only after trimming: `422`
  `VALIDATION_ERROR`.
- Unknown fields (including `address` or `chainId`) are rejected as
  `400` `INVALID_JSON`, same as `POST`. Changing address or chain identity is
  not supported through `PATCH`; create a new record instead.
- `createdAt` is never modified by `PATCH`, on any path including the no-op
  case.

Success: `200 OK`.

```json
{
  "data": {
    "id": 1,
    "address": "0x0000000000000000000000000000000000000001",
    "chainId": 11155111,
    "label": "Updated label",
    "createdAt": "2026-09-12T12:00:00Z"
  }
}
```

`404` `RESOURCE_NOT_FOUND` if the id does not exist. Invalid or non-positive
`id` → `400` `VALIDATION_ERROR`. Malformed JSON, unknown fields, or an empty
body → `400` `INVALID_JSON`. Whitespace-only `label` → `422`
`VALIDATION_ERROR`.

**Accepted MVP risk:** no auth until the auth milestone (B6) — any caller can
`PATCH` any wallet by id. Recorded and accepted, not accidental.

### `DELETE /api/v1/wallets/{id}`

**Status:** Implemented — PostgreSQL persistence

**Authentication:** Public (unauthenticated for MVP slice)

Removes a saved-wallet record. It does not perform an on-chain action.

Success: `204 No Content`, with an empty response body.

`404` `RESOURCE_NOT_FOUND` if the id does not exist — including a second
`DELETE` of an id already removed. This endpoint is not idempotent: a repeated
delete of the same id returns `404`, not another `204`. A client that loses
the response to a successful `204` (timeout, dropped connection, etc.) and
retries must treat the resulting `404` as confirmation the wallet is already
deleted, not as a new failure.

Invalid or non-positive `id` → `400` `VALIDATION_ERROR`.

**Accepted MVP risk:** no auth until the auth milestone (B6) — any caller can
`DELETE` any wallet by id. Recorded and accepted, not accidental.

## Chain routes

### GET /api/v1/chains

**Status:** Implemented — PostgreSQL persistence
**Authentication:** Public (unauthenticated)

Returns a list of all blockchain networks currently supported and enabled in the system.

- **Behavior:** Returns only chains where `enabled = true`, ordered by `chainId` ascending.
- **Contract:** Returns a flat envelope JSON array under the `"data"` field. This collection is unpaginated (query parameters `page` and `pageSize` are ignored). An empty system will safely return `"data": []`, never `null`.

#### Response: `200 OK`
```json
{
  "data": [
    {
      "chainId": 1,
      "name": "Ethereum Mainnet",
      "symbol": "ETH",
      "isTestnet": false
    },
    {
      "chainId": 137,
      "name": "Polygon",
      "symbol": "POL",
      "isTestnet": false
    },
    {
      "chainId": 11155111,
      "name": "Sepolia",
      "symbol": "ETH",
      "isTestnet": true
    }
  ]
}
```


## Tracked-contract routes

A tracked contract is a global deployment record plus the authenticated user's tracking relationship to it. The database separates the two; API responses present them as one resource.

**Status:** Implemented — PostgreSQL persistence.

**Authentication:** Required on all five routes below. A missing, malformed, expired, or unknown bearer token returns `401 UNAUTHENTICATED`.

**Visibility rule: 404, never 403.** A contract the caller does not track is indistinguishable from one that does not exist. Both produce `404 RESOURCE_NOT_FOUND` with a byte-identical body, so the API never reveals whether a deployment exists or belongs to another user.

**Deployment reuse.** One global record exists per `(chainId, address)`. When a second user tracks the same deployment, the existing record is reused: the response carries the same `id` and the `startBlock` stored on first create. Each user keeps their own `label` and `enabled`.

**Sort:** `createdAt` descending, then `id` descending.

### `POST /api/v1/contracts`

**Status:** Implemented — PostgreSQL persistence

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

Validation:

- `address`: non-empty after trimming, `0x`-prefixed, exactly 42 characters, hexadecimal. Stored lowercased as the canonical form, so `0xABC…` and `0xabc…` resolve to the same deployment.
- `chainId`: positive integer that is present and enabled in the chain catalog. Non-positive → `422 Unprocessable Entity` with details `{"chainId": "invalid chainId"}`. Positive but absent from the catalog or disabled → `422` with details `{"chainId": "unsupported chain id"}`.
- `label`: non-empty after trimming, maximum 50 Unicode characters (runes).
- `startBlock`: required integer, `>= 0`. Negative → `422` with details `{"startBlock": "start block must be non-negative"}`.
- Request body bounded to 1 MB. Unknown fields, malformed JSON, or a field type mismatch → `400 INVALID_JSON`.
- Tracking the same `(address, chainId)` twice as the same user → `409 RESOURCE_CONFLICT`.

Reuse truth: `startBlock` is honored on first create; reuse returns the stored value.

Success: `201 Created`.

```json
{
  "data": {
    "id": 1,
    "address": "0x0000000000000000000000000000000000000002",
    "chainId": 11155111,
    "label": "Team multisig",
    "enabled": true,
    "startBlock": 1234567,
    "createdAt": "2026-09-23T19:36:21Z"
  }
}
```

A new tracking starts with `enabled: true`. `createdAt` is RFC3339 from `time.Time` (UTC if the value is UTC).

### `GET /api/v1/contracts`

**Status:** Implemented — PostgreSQL persistence

**Authentication:** Required

Query parameters:

- `page` — optional integer. Default `1`. Maximum `10000`. Omitted, `0`, or negative uses the default. Non-integer → `400 VALIDATION_ERROR`. Greater than `10000` → `400 VALIDATION_ERROR` with details `{"page": "page must not exceed 10000"}`.
- `pageSize` — optional integer. Default `20`. Maximum `100`. Omitted, `0`, or negative uses the default. Non-integer → `400 VALIDATION_ERROR`. Greater than `100` → `400 VALIDATION_ERROR` with details `{"pageSize": "pageSize must not exceed 100"}`.
- `chainId` — optional integer. Non-integer → `400 VALIDATION_ERROR`. Negative → `422` with details `{"chainId": "invalid chainId"}`. Absent from the catalog or disabled → `422` with details `{"chainId": "unsupported chain id"}`. Omit or pass `0` to skip the filter entirely.
- `enabled` — optional. Only the exact literals `true` and `false` are accepted. Any other value — `1`, `0`, `TRUE`, `False`, `banana`, or an empty value such as `?enabled=` — → `400 VALIDATION_ERROR` with no details. Omitted entirely, the filter is off and both enabled and disabled trackings are returned.
- `search` — optional string. Trimmed; case-insensitive literal substring match on `label` or `address`. `%` and `_` are literal characters, not SQL wildcards.

Sort: `createdAt` descending, then `id` descending.

A page past the last page returns `200` with `"data": []` and the true `totalItems` / `totalPages`.

Only the authenticated user's own trackings are returned. `totalItems` counts that user's matches, not the global number of deployments.

Success: `200 OK`.

```json
{
  "data": [
    {
      "id": 2,
      "address": "0x00000000000000000000000000000000000000bb",
      "chainId": 1,
      "label": "beta tracked contract",
      "enabled": true,
      "startBlock": 19000000,
      "createdAt": "2026-09-23T12:00:00Z"
    }
  ],
  "pagination": {
    "page": 1,
    "pageSize": 20,
    "totalItems": 1,
    "totalPages": 1
  }
}
```

### `GET /api/v1/contracts/{contractId}`

**Status:** Implemented — PostgreSQL persistence

**Authentication:** Required

Returns the saved metadata for one tracked contract. `indexingStatus` is not part of the response: indexing status is deferred to Week 6, and this route gains that field only when the indexer ships.

`404 RESOURCE_NOT_FOUND` when the caller does not track the id — including when the id exists only for another user, and when it does not exist at all. The two cases return byte-identical bodies.

Invalid or non-positive `contractId` → `400 VALIDATION_ERROR`.

Success: `200 OK`, `data` shaped like the `POST` example.

### `PATCH /api/v1/contracts/{contractId}`

**Status:** Implemented — PostgreSQL persistence

**Authentication:** Required

Updates the user-specific fields of a tracked contract. `label` and `enabled` are the only mutable fields.

Request:

```json
{
  "label": "Treasury multisig",
  "enabled": false
}
```

Behavior:

- Both fields are optional and independent. Absent, or explicitly `null`, leaves that field unchanged.
- `{}` (both absent) is a no-op: the record is returned unchanged with `200 OK`, and nothing is written.
- `label` present but empty or whitespace-only after trimming → `422 VALIDATION_ERROR` with details `{"label": "cannot be empty"}`. Longer than 50 runes → `422` with details `{"label": "must be 50 characters or less"}`.
- `enabled` present must be a JSON boolean.
- Unknown fields (including `address`, `chainId`, or `startBlock`) → `400 INVALID_JSON`. Changing address, chain, or start block is not a label-style update; create a new tracking instead.
- `createdAt` is never modified, on any path including the no-op case. The row's internal `updated_at` is bumped on a real update but is not exposed in any response.

Ordering, in this order:

1. Invalid or non-positive `contractId` → `400 VALIDATION_ERROR`.
2. Malformed JSON, unknown fields, or wrong types → `400 INVALID_JSON`. This fires identically for existing and non-existent ids, so a bad body cannot probe for existence.
3. A record the caller does not track → `404 RESOURCE_NOT_FOUND`, which takes precedence over any field validation.
4. Field validation (`label`, `enabled`) → `422 VALIDATION_ERROR`.

Success: `200 OK`.

```json
{
  "data": {
    "id": 1,
    "address": "0x0000000000000000000000000000000000000002",
    "chainId": 11155111,
    "label": "Treasury multisig",
    "enabled": false,
    "startBlock": 1234567,
    "createdAt": "2026-09-23T19:36:21Z"
  }
}
```

### `DELETE /api/v1/contracts/{contractId}`

**Status:** Implemented — PostgreSQL persistence

**Authentication:** Required

Removes the authenticated user's tracking relationship. The global contract deployment is not deleted, and other users tracking the same deployment are unaffected. Indexed records are likewise not deleted by this route.

Success: `204 No Content`, with an empty response body.

`404 RESOURCE_NOT_FOUND` when the caller does not track the id — including a second `DELETE` of an id already removed, and an id tracked only by another user. This endpoint is not idempotent: a repeated delete returns `404`, not another `204`. A client that loses the response to a successful `204` and retries must treat the resulting `404` as confirmation the tracking is already gone, not as a new failure.

Invalid or non-positive `contractId` → `400 VALIDATION_ERROR`.

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

**Status:** Planned — deferred to Week 6

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

1. Cookie session or bearer-token authentication (Resolved: Bearer token with server-side SHA-256 session hash and instant revocation; see `docs/auth.md`).
2. UUID or another public resource identifier format.
3. Exact error-code catalog (Resolved for B3: added `INVALID_CREDENTIALS`, `UNAUTHENTICATED`, `USER_CONFLICT`).
4. Whether contract-state reads are always direct RPC reads or may use a short cache.
5. Whether large EVM integers are always decimal strings.
6. Whether transaction-receipt lookup needs a dedicated API route.
7. Whether optional status notifications use WebSocket or server-sent events.
8. Whether API documentation is generated from an OpenAPI specification or maintained alongside code.
