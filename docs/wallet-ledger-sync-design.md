# OPTN Wallet Ledger & Sync Design (Option A hybrid)

**Status:** adopted 2026-08-05 (PR #12 worktree)  
**References:** Electron Cash `txi`/`txo` + status hash; Selene `addresses.state` + Rebuild Wallet.

## Goal

One durable **ledger** is the source of truth for coins and history.  
The SQL `UTXOs` table is a **materialized cache** rebuilt from the ledger.  
Live Electrum checks still guard **sends**.

## Ledger (source of truth)

| Table | Purpose |
|-------|---------|
| `ledger_transactions` | Full tx hex (when known) + height |
| `ledger_txo` | Outputs this wallet received (`tx_hash:n` → address, value, token) |
| `ledger_txi` | Inputs this wallet spent (prevout → spent by tx) |
| `address_sync_status` | Per-address history status hash (EC/Selene style) |
| `transactions` (existing) | UI history rows (kept for compatibility) |
| `UTXOs` (existing) | Cache only — regenerated from unspent `ledger_txo` |

**Unspent coin** = row in `ledger_txo` whose outpoint is not in `ledger_txi`.

## Status hash (change detection)

Same idea as Electron Cash / Selene:

```
status = sha256( "txid:height:" for each history item, ordered as server list )
```

- **Open / auto:** load SQL → paint UI → for each address, compare local status to server; only re-fetch dirty addresses.
- **Manual Sync:** force-refresh (ignore/clear statuses), re-scan addresses + history + UTXOs — **no wipe**.
- **Rebuild Wallet (Settings):** wipe ledger + UTXO cache + history tables for wallet; keep keys/seed; full network rebuild. Rare.

## Three tiers

| Action | Wipes disk chain data? | Network |
|--------|------------------------|---------|
| Open / background | No | Status-hash delta |
| Manual Sync (Home) | No | Force recheck all known addresses |
| Rebuild Wallet (Settings) | Yes (chain data only) | Full resubscribe + rescan |

## Divergence rule

Never treat history and UTXOs as two independent bosses.  
Apply network results into the ledger (and/or address UTXO replace under the same wallet write), then `rebuildUtxosFromLedger`.

## Send-time safety

Before broadcast, verify selected outpoints still exist (listunspent / chain).  
Durable cache ≠ trust forever.

## Encryption

- Secrets (seed/keys): always encrypted (existing model).  
- Public chain data (history, UTXOs, txi/txo): durable; whole-DB encryption is optional later, not required for correctness.
