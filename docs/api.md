# Initial REST API Outline

## Status

Machine-readable spec: [docs/openapi.yaml](openapi.yaml).

This document is the living REST API design. `GET /health/live` (`GET /health` is its compatibility alias), `GET /health/ready`, `POST /api/v1/wallets`, `GET /api/v1/wallets`, `GET /api/v1/wallets/{id}`, `PATCH /api/v1/wallets/{id}`, `DELETE /api/v1/wallets/{id}`, `POST /api/v1/auth/register`, `POST /api/v1/auth/login`, `POST /api/v1/auth/logout`, `POST /api/v1/auth/revoke-all`, `GET /api/v1/users/me`, `GET /api/v1/chains`, `POST /api/v1/contracts`, `GET /api/v1/contracts`, `GET /api/v1/contracts/{id}`, `PATCH /api/v1/contracts/{id}`, `DELETE /api/v1/contracts/{id}` and `GET /api/v1/contracts/{contractId}/events` are implemented. Additional routes remain planned.

## Design principles

- Use JSON over HTTPS.
- Version application routes under `/api/v1`.
- Keep liveness and readiness endpoints outside authenticated API routes.
- Authenticate protected routes (done: contract and wallet routes require a bearer token; a missing, malformed, expired, or unknown token returns `401 UNAUTHENTICATED`).
- Enforce record ownership in services and repository queries.
- Use consistent errors, pagination, filtering, and request identifiers.
- Keep browser-wallet contract writes out of the Go API. Users sign state-changing transactions in their browser wallet.
- Distinguish direct chain state from eventually consistent indexed data.

## Base paths

```text
/health/live     Process liveness
/health          Compatibility alias for liveness
/health/ready    PostgreSQL readiness
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
| `409 Conflict` | `RESOURCE_CONFLICT` | Duplicate `(address, chainId)` wallet record for the requesting user, or duplicate per-user tracking of the same `(address, chainId)` contract | None |
| `409 Conflict` | `USER_CONFLICT` | Duplicate registration email (`idx_users_email_lower`) | None |
| `422 Unprocessable Entity` | `VALIDATION_ERROR` | Semantic domain validation failures (e.g., malformed address format, empty label, label > 50 chars, unsupported or disabled chainId, negative chainId) | `{"<field>": "<message>"}` (e.g. `{"chainId": "unsupported chain id"}`) |
| `500 Internal Server Error` | `INTERNAL_SERVER_ERROR` | Unhandled internal server error | None |
| `503 Service Unavailable` | `SERVICE_UNAVAILABLE` | PostgreSQL readiness check failed, timed out, or the request was canceled | None; message is the neutral `not ready` |
| `429 Too Many Requests` | `RATE_LIMITED` | The caller exhausted its bucket on the global or the authentication tier | None; `Retry-After` carries the wait in whole seconds |

*Note on 405 Method Not Allowed: Method mismatch rejections (e.g. `POST /health/live`) are handled natively by `http.ServeMux` and return `405 Method Not Allowed` in `text/plain` with an `Allow` header.*

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
- `429 Too Many Requests`: rate limit exceeded (`RATE_LIMITED`, with `Retry-After`)
- `500 internal Server Error` — unexpected application failure
- `502 Bad Gateway` — upstream RPC failure where appropriate
- `503 Service Unavailable` — required dependency unavailable

## Operational endpoints

### `GET /health/live`

**Status:** Implemented

Purpose: process liveness only. This handler does not check PostgreSQL, EVM RPC, or domain state. The legacy `GET /health` path is an identical liveness alias.

Response:

```json
{
  "status": "ok"
}
```

Expected status: `200 OK`. The Go `GET` route pattern also accepts `HEAD`; unsupported methods such as POST return `405 Method Not Allowed` with an `Allow` header.

### `GET /health`

**Status:** Implemented — compatibility alias for `GET /health/live`

Returns the same liveness response and performs no dependency checks.

### `GET /health/ready`

**Status:** Implemented — PostgreSQL connectivity

Purpose: indicate whether the API's required PostgreSQL dependency is reachable. Every request pings PostgreSQL with a fixed two-second timeout derived from the request context; readiness is not cached. This probe does not inspect domain state or EVM RPC.

When the check succeeds, the endpoint returns `200 OK` with `{"status":"ok"}`. If the check fails, times out, or the request is canceled, it returns `503 Service Unavailable` with the standard error envelope and the neutral message `not ready`:

```json
{
  "error": {
    "code": "SERVICE_UNAVAILABLE",
    "message": "not ready"
  }
}
```

The cause is logged at error level with the request ID and is never included in the response. The Go `GET` route pattern also accepts `HEAD`; unsupported methods such as POST return `405 Method Not Allowed` with an `Allow` header.

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
- Hard validation: email must contain `@` (simple MVP rule); the password must not be whitespace only, must be at least 15 Unicode code points, and must be at most 72 UTF-8 bytes (pre-bcrypt check).
- The checks run in that order, so a password of only spaces reports blank rather than short. The minimum counts code points and the ceiling counts bytes, so a 19 character passphrase of four-byte code points is 76 bytes and is rejected.
- No trimming and no normalization: the password is hashed exactly as received, and leading or trailing spaces are part of it.
- The minimum applies here only. Login has no minimum, so accounts created before this rule keep working.
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
        "password": "password must be at least 15 characters"
      }
    }
  }
  ```

  `details` carries one key. The password messages are `password must not be blank`, `password must be at least 15 characters`, and `password exceeds maximum allowed length of 72 bytes`. The submitted password never appears in the response.

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
- No password length rule is applied. The registration minimum is not re-checked here, so an account created before that rule still logs in.

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

### `POST /api/v1/auth/revoke-all`

**Status:** Implemented, backed by PostgreSQL.

**Authentication:** Required (`Authorization: Bearer <token>`)

Behavior:
- Deletes every session belonging to the authenticated user, including the session used for this request.
- Subsequent requests with any revoked token return `401 UNAUTHENTICATED`.

Success: `204 No Content` with an empty body.

Errors:
- `401 Unauthorized`: `UNAUTHENTICATED` (Missing, malformed, expired, or unknown bearer token)
- `500 Internal Server Error`: `INTERNAL_SERVER_ERROR` (Unexpected repository failure)

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

**Authentication:** Required (Authorization: Bearer <token>)

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

**Authentication:** Required (Authorization: Bearer <token>)

Returns only the requesting user's wallets. The owner comes from the bearer
token and never from the request, so another user's rows are absent from every
page and from `totalItems`.

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

Every entry carries `indexingStatus`, the read-time indexing availability of that deployment: `disabled` (the deployment is excluded from indexing), `unsupported` (the deployment is not on the chain the indexer follows, currently Sepolia), or `pending` (indexed, so far with no progress to report). The values are a description of what the backend can do, never a live scanner state: the scanner's own `running` / `idle` / `error` states and its error text are not part of any response in v1. `indexingStatus` never changes `enabled`, and `enabled` never changes `indexingStatus`.

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

**Authentication:** Required (Authorization: Bearer <token>)

Returns one saved wallet by database identity ID. The wallet must belong to
the requesting user. A foreign id is reported exactly as a missing id,
`404` `RESOURCE_NOT_FOUND`.

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

**Authentication:** Required (Authorization: Bearer <token>)

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

**Ownership:** the id must belong to the requesting user. A foreign id is
reported as `404 RESOURCE_NOT_FOUND`, byte for byte identical to a missing id,
so ids cannot be probed across accounts. A foreign id is never a `403` and
never a `422`.

### `DELETE /api/v1/wallets/{id}`

**Status:** Implemented — PostgreSQL persistence

**Authentication:** Required (Authorization: Bearer <token>)

Removes a saved-wallet record. It does not perform an on-chain action.

Success: `204 No Content`, with an empty response body.

`404` `RESOURCE_NOT_FOUND` if the id does not exist — including a second
`DELETE` of an id already removed. This endpoint is not idempotent: a repeated
delete of the same id returns `404`, not another `204`. A client that loses
the response to a successful `204` (timeout, dropped connection, etc.) and
retries must treat the resulting `404` as confirmation the wallet is already
deleted, not as a new failure.

Invalid or non-positive `id` → `400` `VALIDATION_ERROR`.

**Ownership:** the id must belong to the requesting user. A foreign id is
reported as `404 RESOURCE_NOT_FOUND`, byte for byte identical to a missing id,
so ids cannot be probed across accounts.

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
      "createdAt": "2026-09-23T12:00:00Z",
      "indexingStatus": "unsupported"
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

Returns the saved metadata for one tracked contract, including `indexingStatus` with the same three read-time values, and the same rules, as the collection route above.

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

**Status:** Planned

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

**Status:** Planned

**Authentication:** Required

Returns owner addresses from direct chain state or a documented cached representation.

## Indexed multisig transaction routes

These routes expose eventually consistent PostgreSQL projections produced by the indexer.

### `GET /api/v1/contracts/{contractId}/transactions`

**Status:** Planned

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

**Status:** Planned

**Authentication:** Required

Returns one indexed multisig transaction and its current confirmation projection.

A missing indexed transaction does not prove that it does not exist on-chain; the API should communicate indexing lag where relevant.

### `GET /api/v1/contracts/{contractId}/transactions/{txIndex}/confirmations`

**Status:** Planned

**Authentication:** Required

Returns current confirmation state derived from confirm and revoke events.

## Indexed-event routes

### `GET /api/v1/contracts/{contractId}/events`

**Status:** Implemented — PostgreSQL projections written by the indexer

**Authentication:** Required

Returns one page of the events the indexer has stored for a deployment, newest first. The route reads the `contract_events` projection only; it never calls the RPC, and it never triggers indexing.

Authorization is the caller's own `user_contracts` row for `contractId`, the same association the other contract routes use. A contract the caller does not track, including one tracked only by another user and one that does not exist at all, returns `404 RESOURCE_NOT_FOUND` with a byte-identical body. The association authorizes the read even when the caller's `enabled` display toggle is `false`: `enabled` filters what a user wants to see, it never changes what the indexer follows.

Only canonical events are returned. An event the indexer later marked `removed` after a chain reorg is excluded from both the page and `totalItems`, so the count and the page always agree. Rows are ordered by `(blockNumber, transactionIndex, logIndex)` descending, which is chain order reversed.

Query parameters:

- `page` — optional integer. Default `1`. Maximum `10000`. Omitted, `0`, or negative uses the default. Non-integer or greater than `10000` → `400 VALIDATION_ERROR`.
- `pageSize` — optional integer. Default `20`. Maximum `100`. Omitted, `0`, or negative uses the default. Non-integer or greater than `100` → `400 VALIDATION_ERROR`.

There are no further filters in v1: no `eventName`, `actor`, `transactionHash`, or block range. They arrive once the projection has a query shape that can serve them without scanning. There is no WebSocket or streaming variant of this route; clients poll it.

A page past the last page returns `200` with `"data": []` and the true `totalItems` / `totalPages`.

Success: `200 OK`.

```json
{
  "data": [
    {
      "contractId": 2,
      "eventName": "SubmitTransaction",
      "blockNumber": 1234567,
      "blockHash": "0x6f4d4b0a4a5b3c7f0f5b0e1a2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6e5f40",
      "transactionHash": "0x1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809",
      "transactionIndex": 3,
      "logIndex": 12,
      "actorAddress": "0x00000000000000000000000000000000000000aa",
      "multisigTxIndex": "7",
      "payload": {
        "to": "0x00000000000000000000000000000000000000bb",
        "valueWei": "1000000000000000000",
        "data": "0x"
      }
    }
  ],
  "pagination": {
    "page": 1,
    "pageSize": 20,
    "totalItems": 41,
    "totalPages": 3
  }
}
```

Encoding rules, which hold for every event name:

- `uint256` values are decimal strings: `multisigTxIndex` here, and `valueWei` inside a `SubmitTransaction` payload. They are never JSON numbers, so nothing above 2^53 is rounded.
- `bytes` values are lowercase `0x` hex strings; an empty value is `"0x"`.
- `SubmitTransaction` payloads are `{to, valueWei, data}`. `ConfirmTransaction`, `RevokeConfirmation`, and `ExecuteTransaction` carry an empty object `{}`, because their subject and transaction index are already top-level fields.

A stored payload that does not satisfy those invariants returns `500 INTERNAL_SERVER_ERROR` rather than a partial or re-shaped body. The handler re-validates every payload through the same decoders the writer used before it is serialized.

### `GET /api/v1/contracts/{contractId}/events/{eventId}`

**Status:** Planned

**Authentication:** Required

Returns one decoded indexed event with chain identifiers and decoded payload.

## Indexing-status routes

v1 has no dedicated indexing-status route. Every contract representation returned by `POST /api/v1/contracts`, `GET /api/v1/contracts`, `GET /api/v1/contracts/{contractId}`, and `PATCH /api/v1/contracts/{contractId}` carries `indexingStatus`, described under `GET /api/v1/contracts` above. It answers whether the deployment is being indexed at all, not how far the scanner has got.

### `GET /api/v1/contracts/{contractId}/indexing-status`

**Status:** Planned

**Authentication:** Required

Reserved for per-deployment progress: the checkpoint block, the last indexed block, the observed chain head, and the resulting lag. If it ever ships, it reports a derived lag and a coarse state, never the scanner's internal error text and never provider URLs or secrets.

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

Implemented and shared by `GET /api/v1/wallets`, `GET /api/v1/contracts` and `GET /api/v1/contracts/{contractId}/events`:

- Default `page`: `1`
- Maximum `page`: `10000`
- Default `pageSize`: `20`
- Maximum `pageSize`: `100`
- Omitted, `0` or negative values take the defaults; a value above a cap is a `400 VALIDATION_ERROR`, and a non-integer is the same `400`.

A page past the end returns `200` with an empty `data` array and the true `totalItems` and `totalPages`.

## Rate limiting

Implemented. One global tier wraps the whole API, and a stricter tier wraps the two credential routes. Health and readiness probes are exempt from both.

| Tier | Applies to | Limit | Burst |
|---|---|---|---|
| Global | Every route outside the health probes | 60 requests per minute | 10 |
| Authentication | `POST /api/v1/auth/login`, `POST /api/v1/auth/register` | 5 requests per minute | 2 |

Both numbers are per key, and the key is the client address with the source port dropped. One key namespace covers the whole API.

**Ordering.** The global tier runs before the router matches a route and before any authentication, which is why a missing or invalid bearer token is counted like any other request instead of reaching the session lookup untouched. A path with no route is counted too. The authentication tier runs on the two credential routes after the global one, so a blocked brute-force attempt spends both budgets.

**Rejection.** A denied request returns `429` with the standard envelope, code `RATE_LIMITED`, and `Retry-After` in whole seconds, rounded up. `Retry-After` is set on the 429 only; no `X-RateLimit-*` headers are sent.

**Exemption.** `GET /health`, `GET /health/live`, and `GET /health/ready` are infrastructure traffic and are skipped by both tiers.

**State.** Buckets are in-process, one per key, refilled from elapsed wall-clock time on each request. There is no shared store, so limits are per API instance and reset on restart. A sweep runs at most once a minute from the first request after the interval elapses, deleting every bucket untouched for longer than the idle threshold. In between sweeps, a key that goes idle is replaced full on its next request. The idle threshold is never shorter than a full refill, so a dropped bucket can never hold more than a fresh one would.

The numbers are code constants (`backend/cmd/api/ratelimit.go`), not configuration, until real traffic argues otherwise.

## Open API decisions

1. Cookie session or bearer-token authentication (Resolved: Bearer token with server-side SHA-256 session hash and instant revocation; see `docs/auth.md`).
2. UUID or another public resource identifier format.
3. Exact error-code catalog (Resolved for B3: added `INVALID_CREDENTIALS`, `UNAUTHENTICATED`, `USER_CONFLICT`).
4. Whether contract-state reads are always direct RPC reads or may use a short cache.
5. Whether large EVM integers are always decimal strings.
6. Whether transaction-receipt lookup needs a dedicated API route.
7. Whether optional status notifications use WebSocket or server-sent events.
8. Whether API documentation is generated from an OpenAPI specification or maintained alongside code.

## Request correlation

Responses carry the `X-Request-ID` header. A valid client value must contain 1 to 64 ASCII letters, digits, dots, underscores, or hyphens, and is echoed unchanged. A missing or invalid value is replaced with a generated identifier. Request IDs are not added to JSON error bodies.
