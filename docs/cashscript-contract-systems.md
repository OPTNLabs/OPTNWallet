# CashScript Contract Systems

This document captures the BCH covenant patterns we should use for OPTN Wallet when building new CashScript-based systems.

Use it as a working reference for custody, lending, escrow, and any other UTXO-native state machine.

## Repository Layout

- Editable CashScript sources live in the root [`cashscript/`](../cashscript) folder.
- Compiled artifacts are written to `src/apis/ContractManager/artifacts/`.
- Use `npm run cashscript:compile` to rebuild shipped JSON from the source contracts.
- The app should import only the JSON artifacts, not the `.cash` sources.

## Core Mental Model

- BCH contracts do not "call" each other like account-based smart contracts.
- A contract interacts with another contract by being part of the same transaction.
- The handoff is always:
  - spend one UTXO
  - validate the transaction shape
  - create one or more successor UTXOs
- If two contracts have different constructor params, they should be treated as different deterministic contract instances.
- If the contract source and constructor params are the same, the address should be the same.
- Off-chain code builds and signs transactions.
- On-chain code enforces exact state transitions.

## How Multi-Contract Systems Are Usually Composed

### 1) Top-Level State Contract + Helper Function Contracts

Use this when the main contract is a stable state container and the branch logic is split into smaller files.

- The top-level contract holds the authoritative UTXO state.
- A helper function contract selects the branch to execute.
- The top-level contract and helper function appear together in the same transaction.
- The helper is not a remote service; it is part of the same spend.

Typical use:

- loan management
- pool management
- branch-specific covenant flows

### 2) Main UTXO + Sidecar UTXO

Use this when a contract needs a second UTXO to carry adjacent state, token metadata, or a companion balance.

- The sidecar is a sibling UTXO, not an independent caller.
- The relationship is usually verified by outpoint adjacency:
  - same transaction hash
  - next output index
- The sidecar travels with the main state machine and is recreated or updated alongside it.

Typical use:

- token tracking
- immutable receipts
- companion NFT state

### 3) Parent/Factory Contract + Child Contracts

Use this when a parent contract needs to create a new contract instance that later behaves independently.

- The parent transaction creates a new child UTXO with preloaded state.
- The child later spends independently, but only within the rules encoded at creation.
- The child is not "accessing" the parent.
- The parent is handing off by creating the next state object.

Typical use:

- delayed release states
- redemption objects
- receipts, claims, payout contracts
- recovery or authorization objects

## State Categories

These categories are useful when deciding how much output enforcement a contract needs.

- Exactly self-replicating:
  - recreates the same UTXO state exactly
  - useful for factories or sentinel contracts
- State-mutating:
  - recreates the same contract shell
  - mutable NFT commitment changes over time
- State-and-balance-mutating:
  - state changes and BCH balance changes together
  - common for pooled funds and payout accumulators
- Conditionally replicating:
  - only recreates on some branches
  - may split into multiple outputs or disappear on terminal branches

## Fields That Usually Matter

- `lockingBytecode`
  - identifies the script instance
  - must match exactly when preserving a UTXO state
- `tokenCategory`
  - carries authority and token identity
  - may include capability bytes
- `nftCommitment`
  - carries mutable or immutable state
  - often holds stage, identifiers, prices, or counters
- `tokenAmount`
  - fungible token balance, if applicable
- `value`
  - BCH value on the UTXO
- `activeInputIndex`
  - defines which input the contract is currently validating
- `outpointTransactionHash` and `outpointIndex`
  - used to prove sibling outputs belong to the same logical bundle
- `tx.locktime` and `tx.time`
  - used for time gates and delayed transitions

## Design Rules

- Treat every contract as a UTXO state machine.
- Never assume one contract can directly access another contract's funds.
- If a branch depends on another contract in the same transaction, that dependency is part of the security boundary.
- Lock down exact output order and count whenever a branch is not exactly self-replicating.
- Validate BCH value and token state separately.
- Treat off-chain state as advisory; the chain is authoritative.
- Build transactions deterministically.
- Do not rely on hidden ordering, implicit side effects, or "best effort" output matching.
- Keep legacy bytecode immutable once live.
- Put new behavior in new contract sources or new constructor-param variants rather than rewriting deployed artifacts.

## Constructor Params and Address Planning

Constructor params are part of the contract identity.

- Same source + same params = same address.
- Same source + different params = different address.
- This is useful for:
  - namespacing multiple active instances
  - encoding distinct custody stages
  - creating deterministic release or recovery variants

Design implication:

- If you want a new logical state, decide whether it should be:
  - a new output of the same contract with new state, or
  - a new contract instance with different constructor params.
- Do not use different addresses to imply a direct access relationship.
- Different addresses only mean different script instances.

## Custody-Specific Guidance

For custody systems, model the wallet as a sequence of explicit UTXO states:

1. deposit
2. active custody
3. pending release or pending recovery
4. finalize to owner or authorized recipient

Rules:

- The vault UTXO should only transition into an explicitly allowed successor UTXO.
- The vault may accept deposits from any sender; sender identity is not part of the on-chain custody rule.
- Inbound deposits should be treated as plain BCH unless a separate policy branch explicitly handles tokens.
- If a second contract is used, it must be the successor state, not a "callee".
- Release, recovery, freeze, and audit paths should be explicit branches in the state machine.
- Timelocks are useful for delayed recovery or delayed release, but the contract must enforce the exact lock semantics.
- Any recovery or freeze branch should be tested for stale state, duplicate spends, and malformed outputs.

## Lending-Specific Guidance

If we build lending later, the same model applies:

- collateral is locked in a covenant UTXO
- loan state is updated by explicit successor outputs
- repayment, refinance, liquidation, and rollover are all state transitions
- the contract determines the only valid next outputs

## Testing Checklist

For each contract system, add tests for:

- valid state transition
- invalid output count
- invalid output order
- wrong locking bytecode
- wrong token category or capability
- wrong commitment/state
- wrong value or token amount
- stale UTXO / duplicate execution
- timelock branch behavior
- branch-specific successor outputs
- deterministic address behavior for same params
- distinct address behavior for different params

## Reference Architectures Reviewed

These reference systems reinforce the same BCH-native model:

- ParyonUSD:
  - top-level state contracts
  - helper function contracts
  - sidecars
  - independent child contracts
- CashStarter:
  - one campaign state UTXO
  - multiple transition contracts
  - explicit refund, stop, cancel, and claim branches

Both systems confirm the same rule:

- multi-contract BCH systems are transaction-composed UTXO state machines, not contract-to-contract method call systems.
