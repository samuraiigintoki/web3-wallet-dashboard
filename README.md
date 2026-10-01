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
- PostgreSQL persistence for wallets, users, sessions, chains, and contracts, wired in `cmd/api/main.go`
- PostgreSQL 16 container setup managed via Docker Compose
- Versioned SQL migrations (`backend/migrations/`, 0001 through 0006) embedded with `go:embed` and managed via `cmd/migrate`
- Table-driven unit tests plus PostgreSQL integration tests, gated by a GitHub Actions CI workflow

Smart contract event indexing, React frontend, and production deployment are planned for upcoming blocks.

## Planned architecture

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

The browser wallet will sign user transactions. The Go backend will not receive or store users' private keys.

## Capabilities

Implemented in the Go backend: user registration and authentication, wallet and contract address management, filtering and pagination, automated tests and CI, Docker-based local setup, and the architecture, API, database, and security documentation.

Planned for later weeks:

- Multisig transaction submission, confirmation, revocation, and execution
- Contract state reads and transaction writes
- EVM event indexing and PostgreSQL persistence
- Transaction status and error handling
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
│   │   └── contract/         # Tracked-contract domain, service, and repositories
│   └── migrations/           # Versioned SQL schema migrations
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
└── docker-compose.yml        # Local PostgreSQL 16 service
```

## Prerequisites

- Go version declared in `backend/go.mod`

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

## Run backend checks

From the repository root:

```bash
cd backend
gofmt -w .
go test -count=1 ./...
go vet ./...
go build ./...
```

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

- **Current milestone:** Week 3 (authentication, wallet and contract CRUD, per-user ownership, and API documentation)
- **Status:** In active development