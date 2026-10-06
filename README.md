# Web3 Wallet Dashboard

[![CI](https://github.com/samuraiigintoki/web3-wallet-dashboard/actions/workflows/ci.yml/badge.svg)](https://github.com/samuraiigintoki/web3-wallet-dashboard/actions/workflows/ci.yml)

A full-stack Web3 portfolio project for managing wallet and multisig contract data, interacting with an EVM smart contract, and displaying indexed blockchain events through a web dashboard.

The project uses the existing Solidity `MultiSigWallet` as its contract foundation.

## Current implementation

The Go backend features:

- Standard-library HTTP server, router, and three-layer architecture (Handler -> Service -> Repository interface), with `GET /health/live` liveness (`GET /health` compatibility alias) and PostgreSQL-backed `GET /health/ready` endpoints
- Bearer-token authentication: register, login, logout, and users/me, with sessions stored as SHA-256 hashes
- Full wallet CRUD (create, list, get, update label, delete), owner-scoped to the authenticated user
- Supported-chain metadata (`GET /api/v1/chains`) with chainId validation on wallet and contract writes
- Tracked-contract CRUD with per-user ownership
- Contract event indexing: a background scanner reads `eth_getLogs` over enabled Sepolia deployments, decodes the four `MultiSigWallet` events, and persists them idempotently with derived transaction and confirmation projections
- `GET /api/v1/contracts/{contractId}/events`, which serves a caller's indexed events newest first behind the existing bearer session, plus a read-time `indexingStatus` on every contract response
- PostgreSQL persistence for wallets, users, sessions, chains, contracts, indexed blocks, events, projections and checkpoints, wired in `cmd/api/main.go`
- PostgreSQL 16 container setup managed via Docker Compose
- Versioned SQL migrations (`backend/migrations/`, 0001 through 0008) embedded with `go:embed` and managed via `cmd/migrate`
- Table-driven unit tests plus PostgreSQL integration tests, including a restartable scan, reorg and rescan flow, gated by a GitHub Actions CI workflow

The React frontend now has its foundation in `frontend/`: authentication routes, a typed API client and a restored session. Its data screens, the browser-wallet write path and production deployment are planned for upcoming blocks.

## Architecture

```text
User
  |
  v
React + TypeScript dashboard
  |                         \
  | REST API                 \ viem/wagmi + browser wallet
  v                           v
Go backend                EVM JSON-RPC
  |                           |
  |                           v
  |                    Solidity MultiSigWallet
  |
  +-- PostgreSQL
  +-- go-ethereum client ------> EVM JSON-RPC
  +-- background indexer ------> EVM event logs
                                  |
                                  v
                       PostgreSQL -> API -> dashboard
```

The Go backend, the indexer and the indexed reads are implemented. The React dashboard is a foundation only: it signs users in and out and renders placeholder sections. Its wallet, contract and event screens and the browser-wallet write path are not implemented.

The browser wallet will sign user transactions. The Go backend will not receive or store users' private keys.

## Capabilities

Implemented in the Go backend: user registration and authentication, wallet and contract address management, filtering and pagination, EVM event indexing with PostgreSQL persistence and authenticated event reads, automated tests and CI, Docker-based local setup, and the architecture, API, database, and security documentation.

Implemented in the React frontend: the login and register screens, a protected application shell that redirects signed-out visitors, a hand-written typed API client over the documented response envelopes, and a session restored from browser storage on load.

Planned for later weeks:

- Wallet, contract and indexed event screens in the dashboard
- Browser wallet connection and on-chain reads and writes
- Multisig transaction submission, confirmation, revocation, and execution
- Contract state reads and transaction writes
- Indexed transaction and confirmation routes, and indexing progress reporting
- Testnet deployment and contract verification

## Repository structure

```text
web3-wallet-dashboard/
├── backend/
│   ├── cmd/
│   │   ├── api/              # API entry point (composition root)
│   │   └── migrate/          # Database migration CLI tool
│   ├── internal/
│   │   ├── httpapi/          # HTTP handlers, router, and DTOs
│   │   ├── wallet/           # Domain models, service logic, and repositories
│   │   ├── user/             # Authentication: users, sessions, password hashing
│   │   ├── chain/            # Supported-chain metadata and chainId validation
│   │   ├── contract/         # Tracked-contract domain, service, and repositories
│   │   ├── evm/              # Read-only EVM client: headers, logs, event decoding
│   │   └── indexer/          # Scanner, checkpointed persistence, reorg recovery
│   └── migrations/           # Versioned SQL schema migrations
├── frontend/                 # Vite + React + TypeScript dashboard
│   └── src/
│       ├── api/              # Hand-written typed client and error taxonomy
│       ├── auth/             # Token storage and the session state machine
│       ├── forms/            # Shared form validation rules
│       ├── pages/            # Auth pages, shell layout, placeholders
│       └── routes/           # Route guards and router state
├── contracts/                # Solidity MultiSigWallet contracts
├── docs/                     # Architecture, API, and schema documentation
│   ├── adr/                  # Architecture Decision Records
│   │   ├── 0001-wallet-id-and-schema-conventions.md
│   │   ├── 0002-migration-runner-and-execution-strategy.md
│   │   └── 0003-wallet-ownership-retrofit.md
│   ├── auth.md               # Session authentication design
│   ├── api.md                # REST API design specifications
│   ├── database-schema.md    # PostgreSQL schema definitions
│   └── security-assumptions.md # Security baseline and TLS assumptions
├── Dockerfile                # Multi-stage image: API and migrate binaries, non-root runtime
├── .dockerignore             # Keeps the build context to backend/
└── docker-compose.yml        # PostgreSQL 16, one-shot migrations, and the API image
```

## Prerequisites

- Go version declared in `backend/go.mod`
- Node version declared in `frontend/.nvmrc`, for the frontend only

## Run the backend

From the repository root:

```bash
cd backend
go run ./cmd/api
```

The API listens on `http://localhost:8080`.

Verify liveness and readiness from another terminal:

```bash
curl -i http://localhost:8080/health/live
curl -i http://localhost:8080/health       # compatibility alias
curl -i http://localhost:8080/health/ready # requires a reachable PostgreSQL database
```

When the database is reachable, all three return the JSON body `{"status":"ok"}` with `200 OK`. Readiness returns `503 Service Unavailable` with a neutral `not ready` message when PostgreSQL cannot be reached. The underlying database error is logged with the request ID and is not returned to clients.

The Go `GET` route patterns also accept `HEAD`. Unsupported methods return `405 Method Not Allowed` with an `Allow` header. For example:

```bash
curl -i -X POST http://localhost:8080/health/live
```

## Run the production-shaped stack

The image and the Compose topology are the deployment shape described in `docs/architecture.md`. From the repository root:

```bash
docker compose up --build
```

This builds one image and starts three services: `postgres`, a one-shot `migrate` service that applies the schema, and `api`, which starts only after migrations exit successfully and publishes port 8080. The image runs as a non-root user, sets `TZ=UTC`, and reports container health from liveness only.

Verify the running stack from another terminal:

```bash
curl -i http://localhost:8080/health/live   # liveness: process only, gates container health
curl -i http://localhost:8080/health/ready  # readiness: also checks PostgreSQL
```

Stop the stack and remove its volume:

```bash
docker compose down -v
```

## Run backend checks

From the repository root:

```bash
cd backend
gofmt -w .
go test -count=1 ./...
go vet ./...
go build ./...
```

## Run the frontend

The dashboard talks to the API on its own origin and the dev server proxies the
request, so the API must be running first. See "Run the backend" above.

Node is pinned in `frontend/.nvmrc`. With `nvm`:

```bash
cd frontend
nvm use
npm ci
npm run dev
```

Vite serves `http://localhost:5173`. The application requests the relative path
`/api/v1` and the dev server forwards `/api` to the API, so there is no URL to
configure in the browser and no CORS to arrange. The API publishes no CORS
headers, so this proxy is required rather than a convenience.

To point the proxy somewhere other than `http://localhost:8080`, copy
`frontend/.env.example` to `frontend/.env.local` and set `API_PROXY_TARGET`.
The name has no `VITE_` prefix on purpose: it is read by the dev server and
never reaches the bundle.

The database starts empty, so register an account first. Registration does not
sign you in, because the API issues no token there.

## Run frontend checks

From the repository root:

```bash
cd frontend
npm run lint
npm run typecheck
npm test
npm run build
```

These are the same four gates the `frontend` CI job runs after `npm ci`.

## Documentation Index

- [Project specification](docs/project-spec.md)
- [Architecture & Boundaries](docs/architecture.md)
- [REST API Specification](docs/api.md)
- [OpenAPI 3.0.3 spec](docs/openapi.yaml)
- [Database Schema](docs/database-schema.md)
- [Contract Integration Requirements](docs/contract-requirements.md)
- [Security Assumptions](docs/security-assumptions.md)
- [Authentication](docs/auth.md)
- [ADR 0001: Wallet Identity Type and MVP Schema Conventions](docs/adr/0001-wallet-id-and-schema-conventions.md)
- [ADR 0002: Migration Runner and Execution Strategy](docs/adr/0002-migration-runner-and-execution-strategy.md)
- [ADR 0003: Wallet Ownership Retrofit](docs/adr/0003-wallet-ownership-retrofit.md)

## Development status

- **Current milestone:** Week 7 in progress (frontend foundation: authentication routes, typed API client, and session handling)
- **Last completed milestone:** Week 6 (contract event indexer: persistence, scanner, retry, reorganization recovery, and authenticated event reads)
- **Status:** In active development