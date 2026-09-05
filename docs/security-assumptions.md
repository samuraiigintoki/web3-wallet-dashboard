# Security Assumptions & Baseline

## Database Transport Security
- **Local Development:** `sslmode=disable` is strictly permitted for local containerized development inside Docker.
- **Staging & Production:** Connecting to external or production PostgreSQL databases mandates TLS encryption (`sslmode=require` or `sslmode=verify-full`).

## Credentials Management
- Database passwords and sensitive keys must never be hardcoded in application source code or default fallbacks.
- Configuration must fail closed: if required environment variables (e.g., `DATABASE_URL`) are missing or empty at startup, the application terminates immediately.