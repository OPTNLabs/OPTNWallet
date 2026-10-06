# Changelog

All notable changes to the OPTN Wallet add-on SDK will be documented here.

## Unreleased — private WIP

- Added the dependency-free typed client and versioned postMessage transport.
- Added capability-scoped wallet reads, proposal-based transaction execution,
  operation polling, host-owned message signing, and CashToken intent types.
- Added response projection and publication checks that exclude wallet secrets,
  raw builders, signed transaction export, and provider access.
- Added host-owned persistence, idempotency, timeout recovery, and native lock
  injection behind internal interfaces.
- Added bounded idempotency-key validation to the client and host metadata,
  bounded retention while loading persisted records, and explicit distinction
  between definite broadcast and provider submission uncertainty.
- Tightened CashToken burn intents so fungible and NFT burns are unambiguous and
  the wallet builder's implicit fungible-burn permission is scoped accordingly.
- Added an optional validated transaction ID to execution operations so host
  recovery can correlate uncertain submissions without exposing raw transactions.
- Wired Marketplace startup recovery to wallet-owned transaction visibility
  checks while preserving `submission_unknown` for missing or ambiguous data.
- Extracted and tested the host transaction-visibility recovery resolver so
  provider-state mapping is explicit and reusable across adapters.
- Isolated provider and telemetry failures per recovery operation so one failed
  lookup or audit sink cannot abort reconciliation of later operations.
- Added `tx.waitForOperation` for bounded, abortable polling that returns only
  wallet-reported terminal states.
- Added bounded request-parameter serialization that preserves CashToken BigInt
  values while rejecting oversized or non-serializable client requests.
- Hardened proposal and operation persistence against identifier reuse with
  different immutable context, and rejected malformed outpoints, timestamps,
  empty proposals, and CashToken intent amounts before execution.
- Added host-controlled iframe session revocation checks, including before
  sandbox initialization, and bounded both legacy and versioned bridge inputs.
- Added local validation for proposal/operation identifiers and finite positive
  operation-polling controls while preserving asynchronous client errors.
- Added runtime SDK-method allowlisting in the low-level postMessage transport
  so callers cannot bypass the public method catalog through a raw adapter.
- Added public proposal projection so direct and iframe transports expose only
  `tx_hash`, `tx_pos`, `value`, and `height` UTXO fields; executable unlockers
  and callbacks are rejected at proposal creation.
- Added package-to-host and authenticated postMessage integration fixtures,
  plus bounded wallet-builder output checks before broadcast.
- Added explicit operation projection so authority, persistence, and bridge
  responses expose only public operation state and never host-only metadata.

This package is intentionally unpublished. The `private` guard and `0.0.0`
version remain until the protocol, supported adapters, security review, and
release evidence are approved.
