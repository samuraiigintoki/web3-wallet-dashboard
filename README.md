# Web3 Wallet Dashboard

A full-stack Web3 portfolio project for managing wallet and multisig contract data, interacting with an EVM smart contract, and displaying indexed blockchain events through a web dashboard.

The project will use the existing Solidity `MultiSigWallet` as its contract foundation rather than introducing a separate, unrelated contract.

## Planned architecture

```text
React + TypeScript frontend
          |
          | REST API / optional WebSocket
          v
Go backend
          |-- PostgreSQL
          |-- background event indexer
          |-- EVM JSON-RPC client
          |
          v
Solidity MultiSigWallet
          |
          | contract events
          v
Go indexer -> PostgreSQL -> dashboard
```

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
├── backend/             # Go API and blockchain indexer
├── frontend/            # React and TypeScript application
├── contracts/           # Solidity MultiSigWallet and Foundry tests
├── docs/                # Architecture and project documentation
│   └── adr/             # Architecture decision records
├── .github/
│   └── workflows/       # CI workflows
└── README.md
```

## Current milestone

**Week 1: Go foundation and project architecture**

Current objectives:

- Learn the Go fundamentals required for implementation
- Establish the monorepo structure
- Initialize the backend Go module
- Define the initial architecture and project scope
- Build a Go HTTP server with a tested health endpoint

## Current status

The monorepo structure and backend Go module have been initialized.

Application features are not implemented yet. The HTTP API, PostgreSQL integration, frontend, contract integration, event indexer, CI, and deployment remain future work.
