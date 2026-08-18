# MultiSigWallet Integration Requirements

## Decision

Use the existing `MultiSigWallet` as the contract foundation. Do not replace it with another repository contract and do not build an unrelated contract from scratch.

Baseline repository:

```text
https://github.com/samuraiigintoki/multisig-wallet
```

Reviewed baseline commit:

```text
00822d32371e5cabe075209f7123b44e1b53b608
```

Reviewed baseline:

- Solidity `0.8.20`
- Fixed owner set and threshold
- Submit, confirm, revoke, and execute lifecycle
- ETH custody and arbitrary external calls
- Checks-Effects-Interactions execution
- Four lifecycle events
- 24 passing Foundry tests reported by the source repository
- Security assumptions and self-audit documentation

The integration should evolve this contract only where the dashboard and indexer have a concrete requirement. The result may be documented as an integration-focused v1.1, not a new multisig design.

## Why this contract is selected

- It matches the wallet-dashboard domain directly.
- It already has a coherent transaction lifecycle for frontend actions.
- Its events support a meaningful Go event-indexing feature.
- Its fixed-owner model keeps contract scope bounded while the project focuses on Go, PostgreSQL, React, and EVM integration.
- It has stronger existing tests and security documentation than the other account repositories considered for this application.
- Replacing it with a raffle, token, stablecoin, crowdfunding contract, or tutorial contract would require changing the product and 12-week architecture without solving a real blocker.

The portfolio differentiator is the complete system and its reliability, not an artificially complex Solidity contract.

## Current contract model

### Transaction

```solidity
struct Transaction {
    address to;
    uint256 value;
    bytes data;
    bool executed;
}
```

### Current state

```solidity
Transaction[] public transactions;
address[] public owners;
uint256 public threshold;
mapping(address => bool) public isOwner;
mapping(uint256 => mapping(address => bool)) public isConfirmed;
```

### Current write functions

```solidity
submitTransaction(address to, uint256 value, bytes data)
confirmTransaction(uint256 txIndex)
revokeConfirmation(uint256 txIndex)
executeTransaction(uint256 txIndex)
receive() external payable
```

All lifecycle write functions are owner-restricted. The owner set and threshold are fixed at deployment.

## Current events

### `SubmitTransaction`

```solidity
event SubmitTransaction(
    address indexed owner,
    uint256 indexed txIndex,
    address indexed to,
    uint256 value,
    bytes data
);
```

Indexer projection:

- Create `multisig_transactions` row.
- Store submitter, target, value, calldata, transaction index, EVM transaction hash, block, and log identity.

### `ConfirmTransaction`

```solidity
event ConfirmTransaction(address indexed owner, uint256 indexed txIndex);
```

Indexer projection:

- Upsert current confirmation state to `confirmed = true`.
- Preserve the event in `contract_events`.

### `RevokeConfirmation`

```solidity
event RevokeConfirmation(address indexed owner, uint256 indexed txIndex);
```

Indexer projection:

- Update current confirmation state to `confirmed = false`.
- Preserve the event in `contract_events`.

### `ExecuteTransaction`

```solidity
event ExecuteTransaction(address indexed owner, uint256 indexed txIndex);
```

Indexer projection:

- Mark the corresponding multisig transaction as executed.
- Store executor, EVM transaction hash, block, and event identity.

A failed execution reverts and therefore does not produce a persistent `ExecuteTransaction` event. Transaction failure must be identified through the wallet/RPC receipt and revert data rather than an event.

## Required reads

The frontend and Go chain client need to read:

- Complete owner list
- Threshold
- Owner membership for an address
- Transaction count
- Transaction fields by index
- Confirmation state for an owner and transaction
- Derived confirmation count
- Contract ETH balance through the EVM account balance RPC

## Integration gaps in the current v1

### 1. Complete owners getter — required

The generated `owners(uint256)` getter returns only one array element and does not expose array length directly.

Add:

```solidity
function getOwners() external view returns (address[] memory)
```

This enables straightforward Go and frontend owner enumeration.

### 2. Transaction-count getter — required

The generated `transactions(uint256)` getter returns one transaction but does not expose array length directly.

Add:

```solidity
function getTransactionCount() external view returns (uint256)
```

Implementation should return `transactions.length`.

### 3. Confirmation-count getter — recommended

Add a view that derives confirmation count from the owner set and `isConfirmed` mapping:

```solidity
function getConfirmationCount(uint256 txIndex) external view returns (uint256)
```

Requirements:

- Revert for a nonexistent transaction.
- Count only current confirmations.
- Preserve the existing design choice of deriving rather than caching confirmation count.

The frontend or backend can otherwise derive this through `getOwners()` plus repeated `isConfirmed(txIndex, owner)` calls, but a dedicated view reduces RPC round trips.

### 4. Deposit event — recommended for indexing

The current `receive()` accepts ETH but emits no event. Add:

```solidity
event Deposit(address indexed sender, uint256 amount, uint256 balance);
```

Update `receive()` to emit the event after ETH is received.

This enables event-based funding history. The contract balance remains the source of truth for current ETH balance.

### 5. Consistent owner authorization error — recommended

The current `onlyOwner` modifier uses:

```solidity
require(isOwner[msg.sender], "not owner");
```

Replace it with a custom error such as:

```solidity
error MultiSigWallet__NotOwner();
```

This makes revert decoding consistent with the rest of the contract and avoids string matching in Go and TypeScript.

### 6. Zero-address target policy — decision required

The current contract allows submission to `address(0)`. A value-bearing call to the zero address may permanently remove ETH.

Before integration, explicitly choose and document one policy:

- Reject `address(0)` targets as a safety measure, or
- Preserve arbitrary target semantics and present a strong UI warning.

The recommended initial policy is to reject the zero address because the dashboard is not intended to support deliberate ETH burning.

## Behaviors that should not be added to the initial version

Do not add these without a new requirement and security review:

- Owner rotation
- Threshold updates
- Upgradeability
- Delegatecall modules
- ERC-1271 signature validation
- Off-chain signature aggregation
- Transaction batching
- Timelocks
- Proxies
- Token swaps or bridging

These features would materially expand the threat model and distract from the full-stack and indexer goals.

## Frontend write requirements

The frontend will use viem and wagmi to invoke:

```text
submitTransaction
confirmTransaction
revokeConfirmation
executeTransaction
```

For every write, the UI must:

1. Confirm a browser wallet is connected.
2. Confirm the active chain matches the tracked contract.
3. Display the contract address and action.
4. Validate user input before requesting a signature.
5. Request approval from the browser wallet.
6. Display submitted transaction hash.
7. Track pending, success, reverted, rejected, and replaced states where supported.
8. Avoid treating wallet approval as mined success.
9. Refresh direct state and indexed data after receipt confirmation.

The frontend may indicate whether the connected address is an owner, but the Solidity `onlyOwner` rule remains the security control.

## Go chain-client requirements

The Go `go-ethereum` boundary will:

- Verify configured chain ID.
- Load a generated binding or parsed ABI from the reviewed contract version.
- Read owners, threshold, transaction count, transaction state, owner membership, confirmations, and balance.
- Fetch transaction receipts.
- Query event logs in bounded block ranges.
- Decode only known ABI events.
- Map recognized custom-error selectors into application-level errors.
- Apply request contexts and RPC timeouts.
- Avoid holding or using user private keys.

Generated Go bindings should be reproducible from a pinned ABI/contract version and should not be edited manually.

## Indexer requirements

### Event identity

Each log must retain:

- Chain ID
- Contract address
- Block number
- Block hash
- EVM transaction hash
- Transaction index where available
- Log index
- Event signature/name
- Removed status where provided by the client

### Idempotency

A unique database identity must include at least:

```text
contract deployment + EVM transaction hash + log index
```

Reprocessing the same range must not create duplicate events or corrupt projections.

### Projection rules

- `SubmitTransaction` creates the transaction projection.
- `ConfirmTransaction` sets one owner's current confirmation to true.
- `RevokeConfirmation` sets one owner's current confirmation to false.
- `ExecuteTransaction` marks the projected transaction as executed.
- `Deposit`, if added, records funding history but does not replace direct balance reads.

### Checkpoint rule

Event insertion, projection updates, and checkpoint advancement must commit atomically. If processing fails, the checkpoint must not advance.

## Error mapping requirements

Current custom errors include:

- `MultiSigWallet__ZeroAddressOwner`
- `MultiSigWallet__EmptyOwnersArray`
- `MultiSigWallet__DuplicateOwner`
- `MultiSigWallet__ZeroThreshold`
- `MultiSigWallet__ThresholdTooHigh`
- `MultiSigWallet__TxDoesNotExist`
- `MultiSigWallet__TxAlreadyConfirmed`
- `MultiSigWallet__TxAlreadyExecuted`
- `MultiSigWallet__TxNotConfirmed`
- `MultiSigWallet__TxExecutionFailed`
- `MultiSigWallet__NotEnoughConfirmations`

Recommended addition:

- `MultiSigWallet__NotOwner`
- A zero-target error if the recommended target policy is selected

User-facing applications should map selectors into understandable messages while retaining the original selector and transaction context in safe diagnostic logs.

## Security assumptions

- Owners and threshold are selected correctly at deployment.
- Owner keys remain secured by their browser wallets.
- The fixed owner set is acceptable for the portfolio demonstration.
- Targets may execute arbitrary code, so execution must preserve Checks-Effects-Interactions.
- A failed external call reverts the execution and the `executed` state change.
- Confirmation count remains derived from current mapping state.
- Contract ETH may be locked if owners lose access or the threshold becomes unreachable.
- The testnet deployment must not hold meaningful real-world value.
- Frontend and backend checks improve UX but do not replace Solidity authorization.

## Required contract tests before integration release

Keep the existing 24 tests passing and add tests for any revision.

Required additions if the proposed v1.1 changes are adopted:

- `getOwners()` returns the complete deployment owner set.
- `getTransactionCount()` is zero initially and increments after submission.
- `getConfirmationCount()` rejects nonexistent transactions.
- Confirmation count reflects confirm, revoke, and re-confirm transitions.
- `Deposit` emits correct sender, amount, and resulting balance.
- Non-owner calls revert with the new custom error.
- Zero-address target behavior matches the documented policy.
- Existing submit, confirm, revoke, execute, receive, and failed-call tests remain green.
- Event assertions cover all indexed event fields.

Recommended quality additions:

- Fuzz constructor owner/threshold validation within bounded arrays.
- Fuzz transaction values and call data for submission storage.
- Invariant: an executed transaction never becomes unexecuted.
- Invariant: executed transactions cannot be reconfirmed, revoked, or re-executed.
- Invariant: confirmation count never exceeds owner count.

## Monorepo integration

When contract integration begins:

1. Copy the reviewed Foundry source, tests, scripts, configuration, and required documentation into `contracts/`.
2. Do not copy the source repository's `.git` directory.
3. Do not initialize another Git repository inside `contracts/`.
4. Preserve the MIT license and link the original repository in documentation.
5. Pin the imported baseline commit in an import note or ADR.
6. Apply integration revisions through a dedicated issue, feature branch, tests, and self-reviewed PR.
7. Generate and commit or reproducibly build the ABI used by Go and TypeScript.

A Git submodule or separate runtime dependency is not required for this monorepo.

## Definition of contract integration done

Contract integration is complete when:

- The reviewed contract source exists under `contracts/`.
- Foundry tests pass locally and in CI.
- The ABI used by Go and TypeScript matches the deployed bytecode version.
- Required owner, threshold, count, transaction, and confirmation reads work.
- Browser-wallet submit, confirm, revoke, and execute flows work on the selected testnet.
- Go decodes all required events and persists them idempotently.
- Deployment address, chain ID, start block, verification link, and contract version are documented.
- Security assumptions and known limitations are updated.

## Open decisions

1. Whether to add `Deposit` in v1.1 or leave funding history outside event indexing.
2. Whether to reject zero-address transaction targets.
3. Exact testnet and deployment configuration.
4. Whether the Go client uses generated bindings, parsed ABI calls, or a small combination.
5. Confirmation depth and basic reorganization policy for indexed data.
