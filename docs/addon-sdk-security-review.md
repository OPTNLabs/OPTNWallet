# Add-on SDK security review worksheet

Status: **pre-review; publication is not approved**.

This worksheet records the evidence already available on the SDK hardening
branch and the manual review still required before exposing the package to
third-party developers.

## Automated evidence

- Public package has no wallet implementation dependencies.
- Package checks reject key material, mnemonics, unlockers, raw transaction
  builders, provider access, and broadcast symbols in source and declarations.
- Public response parsers project wallet data into bounded schemas.
- Transport checks session ID, protocol version, peer window, peer origin,
  expiry, request timeout, cancellation, and disposal behavior.
- Host bridge checks iframe source, method catalog, capability grants, and
  versioned request envelopes.
- Public and iframe proposal responses use the same chain-facing UTXO
  projection; internal `txid`/`vout`/`valueSats` records and executable
  unlockers do not cross the add-on boundary.
- Wallet BCH and CashToken authorities reject malformed or oversized builder
  results before invoking the broadcaster.
- The package-to-host and authenticated postMessage integration fixtures cover
  proposal creation, execution hand-off, session/origin binding, and sanitized
  `submission_unknown` state.
- SDK/add-on/package suite and repository security tests pass on this branch.
- Repository production dependency audit currently reports four high-severity
  Axios advisories through the OneKey hardware-wallet dependency chain. The
  standalone add-on package has no dependencies; wallet-wide publication still
  requires a separately reviewed upgrade or documented risk acceptance.

## Manual review gates

### Bridge and transport

- Confirm every mounted bridge validates `event.source` and origin before
  dispatching a request.
- Confirm opaque-origin iframe use remains limited to the temporary sandbox.
- Confirm session revocation and wallet-lock transitions reject pending and
  subsequent requests on browser, desktop, and mobile adapters.

### Runtime authority

- Confirm every execution route rechecks wallet identity, grant revision,
  authority epoch, proposal commitment, and current UTXO state.
- Confirm duplicate approval, build, broadcast, and retry paths remain
  idempotent across windows and restarts.

### Persistence and recovery

- Review encryption-key ownership and storage migration behavior.
- Prove atomic cross-context locking and bounded retention on every supported
  platform.
- Prove `submission_unknown` reconciliation against provider and mempool
  evidence without allowing an add-on to declare confirmation.
- **Current implementation status:** Marketplace startup now invokes the
  recovery coordinator with a wallet-owned Electrum visibility resolver.
  Operations carry an optional validated transaction ID for correlation. Full
  browser/desktop/mobile restart evidence and provider failure testing remain
  open.

### Signing

- Verify purpose, address ownership, approval UX, hardware-wallet behavior,
  watch-only behavior, and signature encoding.
- Confirm no signer error, audit event, or UI callback can carry private-key
  material or an unrestricted signing primitive.

### CashTokens

- Review token-aware change, genesis/category rules, NFT lineage, mint/burn
  authorization, and final transaction invariants against wallet-owned chain
  state.

## Release decision

Do not remove the package `private` guard or publish while any manual gate
above is unresolved. Attach signed review results and platform evidence to the
release checklist when the gates are closed.
