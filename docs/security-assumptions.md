# Security Assumptions & Baseline

## Database Transport Security
- **Local Development:** `sslmode=disable` is strictly permitted for local containerized development inside Docker.
- **Staging & Production:** Connecting to external or production PostgreSQL databases mandates TLS encryption (`sslmode=require` or `sslmode=verify-full`).

## Credentials Management
- Database passwords and sensitive keys must never be hardcoded in application source code or default fallbacks.
- Configuration must fail closed: if required environment variables (e.g., `DATABASE_URL`) are missing or empty at startup, the application terminates immediately.

## Password Policy
- **Registration floor:** at least 15 Unicode code points, at most 72 UTF-8 bytes, not whitespace only. The minimum follows NIST SP 800-63B-4 section 3.1.1.2 and ASVS 5.0 requirement 6.2.1. The password is hashed exactly as received, with no trimming, no normalization and no composition rules.
- **Login is unaffected by the floor** and keeps working for accounts created before it. There is no password change or reset route, so those accounts stay as they are until one exists.
- **Not in place:** no breached or common password blocklist, no Unicode normalization before hashing, so two visually identical passwords in different normal forms are different passwords, and no second factor. Length is counted in code points rather than grapheme clusters, so an emoji built from several code points counts as more than one character. Validation messages are English only. The 72-byte ceiling also means the 64-character permit of NIST SP 800-63B-4 and ASVS 5.0 requirement 6.2.9 holds for ASCII only: a password of three-byte characters tops out at 24 characters, and the remedy, pre-hashing or Argon2id, would change stored hashes.

## Browser Session Storage
- **Accepted tradeoff:** the frontend keeps the session token in `localStorage`, under one namespaced key, holding the token string only. Any script running on the origin can read it, so a successful XSS is a session compromise. This is a recorded limitation of the current frontend, not a defect to be filed.
- **Why not an `HttpOnly` cookie today:** the API authenticates with a bearer header and sets no cookie, and the client sends `credentials: 'omit'`. Moving to a cookie is an API change plus a CSRF design, which is a deliberate decision rather than a frontend detail.
- **Containment while it stands:** the token is written and read in exactly one module, never logged, never placed in a URL or an error message, and never sent anywhere but this origin, because the request helper rejects absolute URLs. `index.html` loads no third-party script.
- **Not yet in place:** there is no Content Security Policy. Adding one belongs with the deployment design, since it depends on how the built frontend is served.

## Third-party assets
- **No third-party origin:** the built frontend loads nothing from another origin. No CDN font, script or stylesheet is referenced anywhere in `frontend/`; the guard tests reject absolute URLs in the stylesheets and the production build is checked for the measuring library's absence.
- **Fonts are self-hosted:** the two variable faces, Geist Sans and Geist Mono, are vendored woff2 files in `frontend/src/fonts/`, loaded from this origin. Each file's byte size and SHA-256, its copyright line and the complete SIL OFL 1.1 text are recorded in `docs/design/NOTICE.md`.
- **Test-only dependencies:** `colorjs.io` exists as a development dependency for the guard tests and is never imported by application code; a guard builds the app and asserts the bundle contains no trace of it.

