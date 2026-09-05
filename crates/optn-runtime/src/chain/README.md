# OPTN chain runtime scaffold

Canonical architecture: https://github.com/OPTNLabs/OPTNWallet/issues/75

This directory is the compile-time landing zone for PR #63's multi-source BCH
network architecture. `mod.rs` deliberately defines provider-neutral contracts
before concrete transports are moved behind them.

The key separations are:

- **source catalog**: bootstrap, user-added, or user-owned infrastructure;
- **source lifecycle**: bootstrap entries can be disabled/banned but not deleted,
  while user-created entries are removable;
- **protocol filter**: Fulcrum/Electrum, BIP37, Neutrino, BCHN RPC/ZMQ;
- **primary/fallback scopes**: an explicit one-source scope is manual/exact,
  an explicit multi-source scope is a failover pool, and an optional broader
  fallback scope provides controlled automatic failover;
- **capability discovery**: keep `Advertised` separate from `Verified`;
- **evidence**: never vote providers 2-of-3; reconcile typed evidence;
- **SHV/MMR**: a provider-neutral header verification/storage primitive;
- **ZMQ**: an event/wake-up source, not a sync mode or proof;
- **explorer routing**: navigation/privacy, not wallet truth.

## Implementation order

1. Persist the source catalog and `ConnectionPolicy`.
2. Ingest/normalize bootstrap feeds with provenance and deduplication.
3. Adapt the existing BIP37 engine behind `ChainProvider` + capability probes.
4. Adapt native Electrum/Fulcrum behind the same contracts.
5. Add compact-filter/Neutrino provider where compatible peers advertise and
   pass active capability probes.
6. Add trusted BCHN RPC and direct ZMQ event adapters.
7. Implement `ChainObservation` reconciliation and progressive sync workers.
8. Port SHV/MMR from the authoritative CHIP + Electron Cash reference work.
9. Add explorer routing and surface the source catalog in the advanced UI.

Do not move network ownership into Leptos/Tauri code. The renderer may edit the
policy/catalog through typed actions later, but `optn-runtime` owns selection,
health, failover, verification, and authoritative state.
