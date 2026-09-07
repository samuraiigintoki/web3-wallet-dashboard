# Web3 Wallet Dashboard

A full-stack Web3 portfolio project for managing wallet and multisig contract data, interacting with an EVM smart contract, and displaying indexed blockchain events through a web dashboard.

The project uses the existing Solidity `MultiSigWallet` as its contract foundation.

## Current implementation

The Go backend features:

- Standard-library HTTP server, router, and three-layer architecture (Handler -> Service -> Repository interface)
- `PostgresWalletRepo` active in `cmd/api/main.go` providing PostgreSQL database persistence
- `GET /health` operational liveness endpoint
- `POST /api/v1/wallets` endpoint with validation, identity primary key, and database persistence
- `GET /api/v1/wallets/{id}` endpoint retrieving saved wallets by database identity ID
- PostgreSQL 16 container setup managed via Docker Compose
- Versioned SQL migrations (`backend/migrations/`) embedded with `go:embed` and managed via `cmd/migrate`
- Table-driven unit tests for service, handler, and routing layers, plus database integration tests

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

## Planned capabilities

- User registration and authentication
- Wallet and contract address management
- Multisig transaction submission, confirmation, revocation, and execution
- Contract state reads and transaction writes
- EVM event indexing and PostgreSQL persistence
- Transaction status and error handling
- Filtering and pagination
- Automated tests and CI
- Docker-based local setup
- Testnet deployment and contract verification
- Architecture, API, database, and security documentation

## Repository structure

```text
web3-wallet-dashboard/
├── backend/
│   ├── cmd/
│   │   ├── api/              # API entry point (composition root)
│   │   └── migrate/          # Database migration CLI tool
│   ├── internal/
│   │   ├── httpapi/          # HTTP handlers, router, and DTOs
│   │   └── wallet/           # Domain models, service logic, and repositories
│   └── migrations/           # Versioned SQL schema migrations
├── contracts/                # Solidity MultiSigWallet contracts
├── docs/                     # Architecture, API, and schema documentation
│   ├── adr/                  # Architecture Decision Records
│   │   ├── 0001-wallet-id-and-schema-conventions.md
│   │   └── 0002-migration-runner-and-execution-strategy.md
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

Verify the health endpoint from another terminal:

```bash
curl -i http://localhost:8080/health
```

Expected JSON body:

```json
{"status":"ok"}
```

Only `GET` and `HEAD` are accepted for this route. For example, a `POST` request returns `405 Method Not Allowed`:

```bash
curl -i -X POST http://localhost:8080/health
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
- [Database Schema](docs/database-schema.md)
- [Contract Integration Requirements](docs/contract-requirements.md)
- [Security Assumptions](docs/security-assumptions.md)
- [ADR 0001: Wallet Identity Type and MVP Schema Conventions](docs/adr/0001-wallet-id-and-schema-conventions.md)
- [ADR 0002: Migration Runner and Execution Strategy](docs/adr/0002-migration-runner-and-execution-strategy.md)

## Development status

- **Current milestone:** Week 2 (Backend principles, three-layer architecture, and PostgreSQL integration)
- **Status:** In active development