# Web3 Wallet Dashboard

A full-stack Web3 portfolio project for managing wallet and multisig contract data, interacting with an EVM smart contract, and displaying indexed blockchain events through a web dashboard.

The project will use the existing Solidity `MultiSigWallet` as its contract foundation rather than introducing a separate, unrelated contract.

## Current implementation

The initial Go backend is running with:

- A standard-library HTTP server and router
- A `GET /health` endpoint
- A JSON health response
- Method-specific routing
- Unit tests for successful and unsupported-method responses

The PostgreSQL integration, authentication, frontend, contract integration, event indexer, CI, and deployment are not implemented yet.

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
│   │   └── api/              # API entry point
│   ├── internal/
│   │   └── httpapi/          # Router, handlers, and HTTP tests
│   └── go.mod
├── frontend/                 # Planned React and TypeScript application
├── contracts/                # Planned MultiSigWallet and Foundry tests
├── docs/                     # Architecture and project documentation
│   └── adr/                  # Architecture decision records
├── .github/
│   └── workflows/            # Planned CI workflows
└── README.md
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
