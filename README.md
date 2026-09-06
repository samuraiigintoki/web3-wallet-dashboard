# Web3 Wallet Dashboard

A full-stack Web3 portfolio project for managing wallet and multisig contract data, interacting with an EVM smart contract, and displaying indexed blockchain events through a web dashboard.

The project uses the existing Solidity `MultiSigWallet` as its contract foundation.

## Current implementation

The Go backend features:

- A standard-library HTTP server, router, and three-layer architecture (Handler -> Service -> Repository interface)
- `InMemoryWalletRepo` active in `cmd/api/main.go` providing ephemeral in-memory persistence
- `GET /health` operational liveness endpoint
- `POST /api/v1/wallets` endpoint with validation and repository persistence
- Local PostgreSQL 16 container setup managed via Docker Compose
- Versioned SQL migrations (`backend/migrations/`) ready for the Block 9 database-backed repository
- Automated table-driven unit tests for service, handler, and routing layers

PostgreSQL repository integration (Block 9), smart contract event indexing, React frontend, and production deployment are planned for upcoming blocks.

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
│   │   └── api/              # API entry point (composition root)
│   ├── internal/
│   │   ├── httpapi/          # HTTP handlers, router, and DTOs
│   │   └── wallet/           # Domain models, service logic, and repositories
│   └── migrations/           # Versioned SQL schema migrations
├── contracts/                # Solidity MultiSigWallet contracts
├── docs/                     # Architecture, API, and schema documentation
│   ├── adr/                  # Architecture Decision Records (ADR 0001, ADR 0002)
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

## Documentation

- [Project specification](docs/project-spec.md)
- [System architecture](docs/architecture.md)
- [REST API outline](docs/api.md)
- [PostgreSQL schema](docs/database-schema.md)
- [MultiSigWallet integration requirements](docs/contract-requirements.md)

## Current milestone

**Week 1: Go foundation and project architecture**

Current objectives:

- Learn the Go fundamentals required for implementation
- Establish the monorepo structure
- Initialize the backend Go module
- Define the initial architecture and project scope
- Build a Go HTTP server with a tested health endpoint
