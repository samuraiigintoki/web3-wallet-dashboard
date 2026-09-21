# ADR: Stateful Session Tokens over Stateless JWTs

## Status
Accepted (B3 Auth Milestone)

## Context
The Web3 Wallet Dashboard backend requires an authentication mechanism to associate saved wallets and tracked contracts with individual users. Key requirements:
- Secure credential verification.
- Immediate revocation capability upon logout.
- Multi-device login support.
- Protection against token forgery and database breach exposure.

## Decision
We chose **stateful session tokens stored in PostgreSQL** over stateless JSON Web Tokens (JWT).

### Implementation Details:
1. **Token Generation:** On login, the server generates 32 cryptographically secure random bytes via `crypto/rand`, encoded as base64 URL-safe string.
2. **Hash at Rest:** The raw token is returned only to the client. The server computes `SHA-256(raw_token)` and stores only the hash in `user_sessions`.
3. **Transport:** Passed via standard `Authorization: Bearer <token>` HTTP header. No cookies, eliminating CSRF attack surface.
4. **Validation:** On protected routes, the middleware extracts the token, computes `SHA-256`, queries `user_sessions`, and checks expiry in the service layer.
5. **Revocation:** Logout executes `DELETE FROM user_sessions WHERE token_hash = $1`, revoking access immediately.

## Why Session over JWT
- **Instant Revocation:** In stateless JWTs, a token remains valid until its cryptographic expiry unless a distributed blacklist/denylist (e.g. Redis) is introduced, which eliminates the stateless benefit. With database sessions, logout is a single `DELETE` query that takes effect instantly across all servers.
- **Immediate State Consistency:** If an account is suspended or credentials are changed, deleting or invalidating active session rows cuts access on the very next HTTP request.
- **Simplicity:** No need for public/private key rotation, JWKS endpoints, or token refreshing logic in MVP.

## Trade-offs and Mitigations
- **Database Load:** Every authenticated request executes two indexed queries (lookup session by token hash, then lookup user by ID). 
  - *Mitigation:* At current scale, indexed queries on primary key / unique index take < 1ms. If traffic scales, Redis or an in-memory cache layer can sit in front of Postgres without altering the external API contract.
- **Timing Attacks:** Comparing passwords using `bcrypt` takes ~80–100ms. An unknown email lookup could short-circuit in 1ms, allowing user enumeration.
  - *Mitigation:* On unknown email, the service executes a dummy cost-10 bcrypt comparison, guaranteeing both valid and invalid email login attempts consume identical CPU time and return byte-identical 401 responses.
- **Bcrypt 72-byte Limit:** The Blowfish cipher underlying bcrypt silently truncates input beyond 72 bytes.
  - *Mitigation:* Pre-bcrypt validation strictly rejects passwords > 72 bytes with HTTP 422 `VALIDATION_ERROR`.