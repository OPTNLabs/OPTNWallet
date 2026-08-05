# OPTN Wallet Ledger & Sync Design (historical Option A notes)

**Status:** SUPERSEDED for **balance** — use `wallet-hot-cold-design.md`.  
Ledger tables may remain for future **COLD** archive only.

**Balance law (current):** HOT = SQL `UTXOs` from Electrum listunspent (OPTN 1.7.0 style).  
**Not** ledger txi/txo as Redux boss.

## Locked decisions (current)

1. **ONE truth for spendable money = HOT (SQL UTXOs).**  
2. **COLD** = history / labels / fusion depth / export — never overrides HOT.  
3. Status gate only skips network; returns SQL.  
4. Manual Sync = clear statuses + force listunspent.  
5. Open = paint SQL + force listunspent once (heal).  
6. Missing listunspent key ≠ empty `[]`.  
7. Zero-touch desktop tables via `desktopSchema`.

## Goal (updated)

HOT stays correct and small. COLD holds decades of story.  
Live Electrum checks still guard **sends**.

## Ledger (source of truth)

| Table | Purpose |
|-------|---------|
| `ledger_transactions` | Full tx hex (when known) + height |
| `ledger_txo` | Outputs this wallet received (`tx_hash:n` → address, value, token) |
| `ledger_txi` | Inputs this wallet spent (prevout → spent by tx) |
| `address_sync_status` | Per-address history status hash (EC/Selene style) |
| `wallet_ledger_meta` | `genesis_height` + `tip_height` scan window |
| `transactions` (existing) | UI history rows (kept for compatibility) |
| `UTXOs` (existing) | Cache only — regenerated from unspent `ledger_txo` |

**Unspent coin** = row in `ledger_txo` whose outpoint is not in `ledger_txi`.

## End-to-end data flow

1. **History** — Electrum history per address; status-hash gate skips clean addrs.  
   Stubs → `ledger_transactions`; status → `address_sync_status`; heights → `wallet_ledger_meta`.
2. **Raw tx apply** — `getRawTransaction(Many)` for stubs missing hex → `applyRawTransaction`:  
   wallet outputs → `ledger_txo`; spends of known `ledger_txo` → `ledger_txi`; store full hex.
3. **UTXO path** — same status-hash gate skips `listunspent` on clean addresses;  
   dirty addresses snapshot via `applyAddressUtxoSnapshot` then `rebuildUtxosFromLedger`.
4. **Send** — `verifyOutpointsStillUnspent` (live listunspent) before broadcast;  
   on success, apply the just-sent raw hex into the ledger immediately.
5. **Rebuild** — wipe all ledger + cache tables (incl. genesis meta), then bootstrap.

## Status hash (change detection)

Same idea as Electron Cash / Selene:

```
status = sha256( "txid:height:" for each history item, ordered as server list )
```

- **Open / auto:** load SQL → paint UI → for each address, compare local status to server; only re-fetch dirty addresses (history **and** listunspent).
- **Manual Sync:** clear statuses + `force: true` listunspent; re-scan addresses + history + UTXOs — **no wipe**.
- **Rebuild Wallet (Settings → Wallet & security → Rebuild Wallet):** wipe ledger + UTXO cache + history + genesis meta; keep keys/seed; full network rebuild. Rare.

## Three tiers

| Action | Wipes disk chain data? | Network |
|--------|------------------------|---------|
| Open / background | No | Status-hash delta |
| Manual Sync (Home) | No | Force recheck all known addresses |
| Rebuild Wallet (Settings) | Yes (chain data only) | Full resubscribe + rescan |

## Genesis height / scan window

`wallet_ledger_meta.genesis_height` = lowest positive confirmation height seen.  
`getScanFromHeight(walletId)` returns that (or 0 if unknown). Used as the start of any deep/SPV-style scan window so rebuilds and future bip37 do not pretend the wallet existed at block 0.

## Divergence rule

Never treat history and UTXOs as two independent bosses.  
Apply network results into the ledger (and/or address UTXO replace under the same wallet write), then `rebuildUtxosFromLedger`.

### Address snapshot rules (listunspent → ledger)

For each **dirty** address in a wallet-wide fetch pass:

1. `applyAddressUtxoSnapshot` upserts remote unspents into `ledger_txo`.  
2. Outpoints present on remote that still have only an `external:%` spend row must  
   **clear that synthetic txi** (coin is unspent again). Never clear real spend rows  
   from known wallet txs.  
3. **Synthetic `external:` spends only when `force` (Manual Sync).**  
   Open/background/subscription must **not** mark missing outpoints spent —  
   partial listunspent re-poisoned wallet 5 after a good Manual Sync.  
   Real spends: Manual Sync force, or EC raw-tx → `ledger_txi`.  
4. `rebuildUtxosFromLedger` rewrites SQL `UTXOs` from unspent `ledger_txo`.  
5. **Wallet-wide Redux payload** = `listUnspentFromLedger` (full wallet), same as EC  
   deriving coins from txi/txo — not a partial listunspent map for only dirty addrs.  
6. **Single-address (Selene notify):** apply that address only; do **not** full-wallet  
   rebuild; return that address’s coins only.

## Send-time safety

Before broadcast, verify selected outpoints still exist (listunspent / chain).  
Durable cache ≠ trust forever. Implemented in `TransactionService.sendTransaction` via `verifyOutpointsStillUnspent`.

## Encryption

- Secrets (seed/keys): always encrypted (existing model).  
- Public chain data (history, UTXOs, txi/txo): durable; whole-DB encryption is optional later, not required for correctness.

## Zero-touch

Ledger tables live in `desktopSchema.ensureDesktopLedgerTables` — **not** shared `schema.ts` — so mobile upstream stays untouched.
