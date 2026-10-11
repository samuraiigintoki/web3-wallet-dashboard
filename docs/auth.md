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
5. **Revocation:** Logout executes `DELETE FROM user_sessions WHERE token_hash = $1` to revoke one session. Revoke-all executes `DELETE FROM user_sessions WHERE user_id = $1` for the authenticated user, including the session used for that request; every affected token fails authentication on subsequent requests.

## Why Session over JWT
- **Instant Revocation:** In stateless JWTs, a token remains valid until its cryptographic expiry unless a distributed blacklist/denylist (e.g. Redis) is introduced, which eliminates the stateless benefit. With database sessions, logout is a single `DELETE` query that takes effect instantly across all servers.
- **Immediate State Consistency:** If an account is suspended or credentials are changed, deleting or invalidating active session rows cuts access on the very next HTTP request.
- **Simplicity:** No need for public/private key rotation, JWKS endpoints, or token refreshing logic in MVP.

## Trade-offs and Mitigations
- **Database Load:** Every authenticated request executes two indexed queries (lookup session by token hash, then lookup user by ID). 
  - *Mitigation:* At current scale, indexed queries on primary key / unique index take < 1ms. If traffic scales, Redis or an in-memory cache layer can sit in front of Postgres without altering the external API contract.
- **Timing Attacks:** Comparing passwords using `bcrypt` takes ~80–100ms. An unknown email lookup could short-circuit in 1ms, allowing user enumeration.
  - *Mitigation:* On unknown email, the service executes a dummy cost-10 bcrypt comparison, guaranteeing both valid and invalid email login attempts consume identical CPU time and return byte-identical 401 responses.
- **Password Length Floor:** A short password is cheap to guess offline if a hash dump ever leaks, and composition rules push people toward predictable substitutions instead of length.
  - *Mitigation:* Registration requires at least 15 Unicode code points and rejects a whitespace-only password, with no composition rules, no trimming and no normalization. 15 is the single-factor minimum in NIST SP 800-63B-4 section 3.1.1.2 and the strong recommendation in ASVS 5.0 requirement 6.2.1.
  - *Scope:* The floor applies where a password is set, which today is registration only. Login does not apply it. Rejecting a legacy password at login would lock out an account that was created legally and could not strengthen the hash already stored. There is no password change or reset route yet, so an existing sub-floor account has no way to come up to the new rule.
- **Bcrypt 72-byte Limit:** The Blowfish cipher underlying bcrypt silently truncates input beyond 72 bytes.
  - *Mitigation:* Pre-bcrypt validation strictly rejects passwords > 72 bytes with HTTP 422 `VALIDATION_ERROR`, rather than truncating. The minimum is counted in code points and this ceiling in bytes, so they cannot both fail: a password under 15 code points is at most 56 bytes. The ceiling does cap a multibyte passphrase at 18 four-byte code points.