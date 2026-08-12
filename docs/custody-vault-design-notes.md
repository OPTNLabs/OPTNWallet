# Custody Vault Design Notes

This note describes the custody pattern used in OPTN Wallet for BCH UTXO contracts.

## Core Rule

Inbound UTXOs are not authenticated by sender identity.

Any wallet can send BCH to the vault address. The contract should treat that as a deposit and only enforce rules when the vault is later spent.

That means:

- do not try to identify the sender of an inbound vault UTXO
- do not rely on a signed off-chain message to prove the deposit origin
- do enforce exact spend rules when the vault is used

## Why This Fits BCH

BCH is UTXO-based, so a contract controls the spend of a UTXO, not the act of receiving funds.

The vault is therefore an open inbound address with a locked outbound policy:

- anyone can fund the address
- only the contract-defined branches can spend from it
- every spend must match the exact transaction shape
- each inbound payment creates its own UTXO
- the app must track all vault UTXOs individually

## Active Vault Shape

The active vault state is the one that accepts custody operations like refresh, release handoff, and recovery.

The active vault should lock down:

- `this.activeInputIndex == 0`
- exact input count
- exact output count
- BCH-only inputs and outputs
- exact successor locking bytecode where the branch creates a new state UTXO

If a token-bearing UTXO lands at the vault address, it should not be accepted by the custody spend branches.

## Release State Shape

The release state is a separate UTXO state of the same contract source.

It should:

- keep the same exact-output discipline
- require a timelock before finalization
- spend to the owner’s standard P2PKH output

The release state is not a second authority.
It is just the next UTXO state in the custody machine.

## What To Test

When building custody branches, test both positive and negative cases:

- valid BCH-only deposit followed by a valid spend
- token-bearing vault UTXO rejected on spend
- extra inputs rejected on refresh
- extra inputs rejected on recovery
- extra outputs rejected on release handoff
- timelock rejected before release finalization

## Operational Implications

Because inbound transfers are open, the app should assume:

- deposits may come from unknown senders
- deposits may arrive without any app session
- deposit monitoring should rely on chain state, not off-chain promises
- a single vault address may accumulate multiple independent UTXOs over time
- spending one vault UTXO does not consume the others

## Stress-Test Takeaways

The main attack and loss surfaces are:

- malformed UTXOs sent to the vault address
- stale or forgotten vault UTXOs not tracked by the app
- wrong constructor params creating a different deterministic address than expected
- release-state UTXOs not finalized before the timelock if the app loses track of them

The contract can only defend against malformed spend shapes and wrong token/value/output composition.
It cannot recover a UTXO if the app forgets to track it or if the vault was deployed with the wrong params.
Those are deployment and monitoring problems, so the app must treat chain state as authoritative and enumerate every UTXO at the vault address before reporting balances or attempting spends.

If the team later wants to handle accidental token deposits, that should be a separate, explicit policy branch. It should not be implied by the normal custody path.
