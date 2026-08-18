# Project Specification

## Project

**Name:** Web3 Wallet Dashboard  
**Primary portfolio target:** Junior Web3 Full-Stack / Blockchain Developer  
**Current milestone:** Week 1: Go foundation and project architecture

## Current status

Implemented:

- Monorepo structure
- Go backend module
- Standard-library HTTP server and router
- `GET /health` returning a JSON response
- Tests for successful and unsupported-method health requests

Not implemented yet:

- Authentication
- PostgreSQL persistence
- Wallet and contract management
- Blockchain client and event indexer
- React and TypeScript frontend
- Browser-wallet and contract integration
- CI, Docker, deployment, and monitoring

This distinction must remain clear in documentation and portfolio descriptions.

## Problem statement

A multisig wallet produces information across two different systems:

1. User and application data, such as accounts, saved wallet addresses, tracked contracts, filters, and preferences.
2. On-chain data, such as multisig transactions, confirmations, executions, receipts, and emitted contract events.

Users need one interface where they can manage tracked addresses, perform permitted multisig actions through their own browser wallet, and view indexed contract activity without manually querying an RPC endpoint or block explorer.

The project will demonstrate how a React frontend, Go backend, PostgreSQL database, EVM event indexer, and Solidity contract can operate as one coherent application.

## Target users

### Multisig participant

A person whose externally owned account is an owner of a tracked `MultiSigWallet`. They need to inspect contract state and submit, confirm, revoke, or execute transactions when authorized by the contract.

### Dashboard user

A registered application user who wants to save wallet addresses, track deployed multisig contracts, and browse indexed transaction and event history.

### Portfolio reviewer

A recruiter or engineer who needs to understand, run, test, and evaluate the application and its architectural decisions.

## Terminology

- **Application user:** A person registered with the off-chain Go application.
- **Browser wallet:** A user-controlled wallet, such as MetaMask, that holds private keys and signs transactions.
- **Saved wallet:** An address and its metadata stored by an application user. Saving an address does not prove ownership of its private key.
- **Tracked contract:** A deployed `MultiSigWallet` address associated with a chain and optional deployment/start block.
- **Multisig owner:** An address recognized as an owner by the Solidity contract.
- **Multisig transaction:** A transaction proposed inside the `MultiSigWallet`, separate from the outer EVM transaction that calls the contract.
- **Indexed event:** A decoded contract log persisted by the Go indexer.
- **Checkpoint:** The last block that the indexer has processed successfully.

## Goals

1. Build a production-shaped Go REST API with clear handler, service, and repository boundaries.
2. Persist users, saved wallets, tracked contracts, multisig data, events, and indexer state in PostgreSQL.
3. Read EVM state, receipts, and logs through a Go `go-ethereum` client.
4. Index `MultiSigWallet` events without creating duplicates and resume safely after interruption.
5. Build a typed React and TypeScript dashboard for off-chain and indexed data.
6. Use viem and wagmi for browser-wallet connection, chain detection, contract reads, and user-approved writes.
7. Demonstrate submit, confirm, revoke, and execute flows using the existing `MultiSigWallet`.
8. Provide automated tests, CI, Docker-based setup, testnet deployment, and public documentation.
9. Document security assumptions, known limitations, and important design decisions.
10. Ensure the project can be demonstrated and explained without relying on tutorial-specific terminology.

## Non-goals

The initial portfolio version will not:

- Act as a custodial wallet or store private keys or seed phrases.
- Sign user transactions in the Go backend.
- Replace a browser wallet or general-purpose block explorer.
- Support arbitrary smart contracts without a known ABI.
- Target production mainnet funds.
- Introduce microservices, RabbitMQ, Kafka, Redis, or Kubernetes without a measured requirement.
- Implement advanced chain-reorganization handling beyond a documented basic strategy.
- Provide token swaps, bridging, portfolio valuation, or trading features.
- Use Rust before the core Go, React, PostgreSQL, Solidity, and indexer flow is complete.

## Functional scope

### 1. Authentication and authorization

Planned capabilities:

- Register an application user.
- Log in and obtain an authenticated application session or token.
- Retrieve the current user profile.
- Restrict saved wallets and tracked-contract records to their owning application user.
- Return consistent errors for unauthenticated and unauthorized requests.

The authentication mechanism—session cookie or token—will be selected and documented before implementation.

### 2. Saved-wallet management

Planned capabilities:

- Add a wallet address with a label and chain metadata.
- List the authenticated user's saved wallets.
- Retrieve one saved wallet by identifier.
- Remove a saved wallet owned by the authenticated user.
- Validate address format and normalize representation where appropriate.
- Prevent one user from reading or modifying another user's records.

Saving an address does not imply cryptographic proof of ownership.

### 3. Tracked-contract management

Planned capabilities:

- Add a deployed `MultiSigWallet` address.
- Associate it with a chain ID, label, and indexing start block.
- Validate that the configured chain and address are supported.
- List and retrieve tracked contracts owned by the authenticated user.
- Remove or disable contract tracking without corrupting previously indexed data.

### 4. Contract reads

Planned reads include:

- Contract owners
- Required confirmation threshold
- Multisig transaction count
- Individual transaction details
- Confirmation state where supported by the contract ABI
- EVM transaction receipts and status

The Go backend may expose normalized read results. The frontend may also perform selected public reads directly through viem.

### 5. Multisig writes

Planned user actions:

- Submit a multisig transaction.
- Confirm a pending transaction.
- Revoke an existing confirmation.
- Execute a transaction after the required threshold is reached.

All state-changing actions must be approved and signed by the user's browser wallet. The Go backend must not receive the user's private key.

### 6. Event indexing

The Go indexer will:

- Start from a configured block or stored checkpoint.
- Query logs in bounded block ranges.
- Filter logs for tracked `MultiSigWallet` contracts.
- Decode supported events using the contract ABI.
- Store raw identifiers and normalized event data in PostgreSQL.
- Prevent duplicates using chain ID, transaction hash, and log index or an equivalent unique key.
- Update the checkpoint only after event persistence succeeds.
- Resume after process or RPC failure.
- Retry transient RPC failures with bounded backoff.
- expose indexed data through the REST API.

Basic reorganization assumptions and limitations will be documented before testnet deployment.

### 7. Dashboard

Planned screens and states:

- Registration and login
- Saved-wallet list and forms
- Tracked-contract list and forms
- Contract overview
- Multisig transaction table
- Transaction details and confirmations
- Indexed event history
- Pagination and filtering
- Loading, empty, error, pending, success, and failure states
- Active-account and network-mismatch warnings

### 8. Operational capabilities

The completed portfolio version will include:

- Backend, frontend, contract, and indexer tests
- GitHub Actions checks
- Docker-based local setup
- Structured logs and request identifiers
- Health and readiness endpoints
- Graceful shutdown
- Configuration through documented environment variables
- Testnet contract deployment and verification
- Public deployment instructions and known limitations

## User stories

### Authentication

- As a new user, I want to register so that I can maintain my own dashboard data.
- As a returning user, I want to log in so that I can access my saved wallets and tracked contracts.
- As an authenticated user, I want my records isolated from other users so that application data is not exposed across accounts.

### Wallet management

- As an authenticated user, I want to save a wallet address with a label and chain so that I can recognize it later.
- As an authenticated user, I want to list my saved wallets so that I can choose an address to inspect.
- As an authenticated user, I want to remove a saved wallet so that obsolete addresses no longer appear in my dashboard.

### Contract management

- As an authenticated user, I want to add a deployed multisig contract with its chain and start block so that the application can track it correctly.
- As an authenticated user, I want to list my tracked contracts so that I can select one to inspect.
- As an authenticated user, I want invalid addresses or unsupported networks rejected with a useful error so that I can correct my input.

### Multisig inspection

- As a dashboard user, I want to view contract owners and the confirmation threshold so that I understand who can authorize transactions.
- As a dashboard user, I want to view pending and executed multisig transactions so that I understand the contract's current state.
- As a dashboard user, I want receipt and indexing status distinguished so that I understand whether a transaction is mined, failed, or awaiting indexer synchronization.

### Multisig actions

- As a connected multisig owner, I want to submit a transaction through my browser wallet so that the contract records the proposal.
- As a connected multisig owner, I want to confirm a pending transaction so that it can progress toward execution.
- As a connected multisig owner, I want to revoke my confirmation when the contract permits it so that my current decision is represented on-chain.
- As a connected multisig owner, I want to execute a sufficiently confirmed transaction so that the proposed call is performed.
- As a connected user, I want a network-mismatch warning so that I do not submit a transaction on the wrong chain.

### Indexed dashboard

- As a dashboard user, I want contract events indexed into searchable application data so that I do not need to query raw logs.
- As a dashboard user, I want pagination and filtering so that large histories remain usable.
- As a dashboard user, I want clear empty and error states so that missing data is not confused with a broken application.
- As a dashboard user, I want recently mined activity to appear after indexing so that the dashboard reflects the chain.

### Portfolio review

- As a reviewer, I want documented setup and test commands so that I can verify the project.
- As a reviewer, I want architecture and security assumptions documented so that I can evaluate the author's engineering judgment.
- As a reviewer, I want known limitations stated honestly so that planned work is not presented as completed work.

## Primary user flows

### Flow A - Register and save an address

1. User registers or logs in through the React application.
2. React sends an authenticated request to the Go API.
3. The API validates the request and invokes the wallet service.
4. The service persists the user-owned wallet record through a repository.
5. The API returns the saved representation to the frontend.

### Flow B - Track a multisig contract

1. User provides a contract address, chain ID, label, and optional start block.
2. The backend validates the request and may verify basic contract compatibility through EVM JSON-RPC.
3. The tracked-contract configuration is persisted.
4. The indexer discovers the contract configuration and begins from the required checkpoint.

### Flow C - Submit or confirm a transaction

1. User connects a browser wallet and selects the required network.
2. React reads the connected account and current contract state.
3. React requests the desired contract write through viem and wagmi.
4. The browser wallet displays the transaction for user approval and signs it locally.
5. The transaction is submitted to the EVM network.
6. React displays pending, success, or failure state from the transaction receipt.
7. The contract emits events when the call succeeds.
8. The Go indexer later persists those events for dashboard queries.

### Flow D - Index and display events

1. The indexer loads its stored checkpoint.
2. It queries a bounded block range through EVM JSON-RPC.
3. It decodes relevant `MultiSigWallet` logs.
4. It stores events and derived records without duplicates.
5. It advances the checkpoint after successful persistence.
6. The frontend retrieves indexed data through the Go API.
7. The frontend refreshes by polling initially; optional real-time notification may be added later.

## Technical constraints and initial decisions

- The repository remains a monorepo.
- The backend is implemented in Go.
- PostgreSQL is the persistent database.
- The backend uses `go-ethereum` for EVM JSON-RPC and ABI handling.
- The frontend uses React and TypeScript.
- viem and wagmi provide frontend EVM integration.
- The existing Foundry-tested `MultiSigWallet` is the contract foundation.
- REST is the initial application transport. WebSocket communication is optional.
- The first deployment targets a supported EVM testnet.
- The initial indexer is a background Go component; a separate queue is not required.
- Application code must not store private keys or seed phrases.

## Non-functional requirements

### Correctness

- Validate external input at system boundaries.
- Use database constraints and idempotency keys to prevent duplicate records.
- Keep Foundry contract tests green.
- Map RPC and application failures into consistent errors.

### Reliability

- The indexer must resume from a persisted checkpoint.
- Transient RPC failures must not corrupt checkpoint state.
- The backend must support graceful shutdown before deployment.

### Security

- Authenticate protected API requests.
- Enforce ownership checks for application records.
- Never log credentials, tokens, seed phrases, or private keys.
- Require browser-wallet approval for state-changing contract calls.
- Document contract assumptions and trust boundaries.

### Maintainability

- Keep handlers focused on HTTP concerns.
- Put business rules in services.
- Isolate persistence in repositories.
- Keep EVM-specific behavior behind a chain-client boundary.
- Test components at appropriate unit and integration boundaries.

### Observability

- Use structured logs.
- Add request IDs.
- Expose liveness and readiness endpoints.
- Record enough indexer context to investigate failures without exposing secrets.

## MVP definition

The portfolio MVP is complete when a reviewer can:

1. Run or access the public application.
2. Register and authenticate.
3. Save a wallet and track a deployed `MultiSigWallet` on a testnet.
4. Connect a browser wallet on the expected chain.
5. Read contract state.
6. Submit, confirm, revoke, and execute transactions when permitted.
7. Observe the resulting event data after the Go indexer persists it.
8. Filter and paginate relevant dashboard records.
9. Run backend, frontend, contract, and indexer tests through documented commands and CI.
10. Understand the architecture, security assumptions, and known limitations from the repository documentation.

## Known limitations

- The first version targets a testnet and must not be represented as mainnet-ready.
- Event data is eventually consistent with the chain because indexing occurs after block processing.
- Basic reorganization behavior will be documented, but deep-reorganization guarantees are outside the initial scope.
- Direct public contract reads and indexed database views may briefly disagree while indexing catches up.
- Saving a wallet address does not prove control of that address.
- WebSocket updates are optional; polling is the initial refresh strategy.
- RPC-provider availability and rate limits may affect reads and indexing.

## Open questions

The following decisions must be resolved before their implementation phase:

1. Will application authentication use secure cookie-based sessions or bearer tokens?
2. Which EVM testnet and RPC provider will be used for the public demonstration?
3. Which exact events are emitted by the current `MultiSigWallet` ABI, and do any contract changes need to be made before deployment?
4. What deployment block or configured start block will each tracked contract use?
5. What confirmation and finality depth will the indexer use before treating data as stable?
6. How will basic chain reorganizations update or invalidate persisted events?
7. Will optional WebSocket notifications provide only refresh signals or complete event payloads?
8. Which fields require encryption or additional protection at rest?
9. What retention policy, if any, applies to authentication and operational logs?
