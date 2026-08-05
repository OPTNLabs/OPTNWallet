# OPTN Hot / Cold Wallet Design

**Status:** adopted 2026-08-05 (PR #12 worktree)  
**Base:** OPTN Labs 1.7.0 spendable-coin path  
**Goal:** one truth for money + decades of depth without dual-boss balance bugs

## Law (one source of truth for money)

| Question | Store | Name |
|----------|--------|------|
| What can I spend? | SQL `UTXOs` via Electrum `listunspent` | **HOT** |
| UI balance / send / fusion coin pick | Same HOT map in Redux | **HOT** |
| History, labels, fusion depth, export | Separate tables / future archive | **COLD** |

**HOT never reads ledger txi/txo for balance.**  
**COLD never overrides HOT.**

## HOT path (implemented)

```
listunspent → format → replaceWalletAddressUTXOs (SQL) → return map → Redux
```

- Missing Electrum key ≠ empty (keep prior SQL).  
- Soft-fail on connection lost → keep SQL.  
- **No status-hash skip on wallet-wide UTXO fetch.**  
- Invalidate Electrum short TTL cache before each wallet-wide fetch.  
- Trust authoritative empty listunspent; missing RPC key still keeps prior.  
- **Open does not paint SQL into Redux first** (avoids wrong→right flash).  
- Dual-boss ledger APIs **removed** (not just unused).

## COLD path (product roadmap — not balance)

| Feature | Status |
|---------|--------|
| Transaction history UI | Existing |
| Fusion depth / round metadata | Existing (`fusionCoinDepth`) + UTXO “Fused ×N” |
| Labels on UTXO/tx | **Slice 1 done** — `coin_labels` + `CoinLabelService` |
| Labels export CSV | **Slice 1** — `exportCoinLabelsCsv` |
| Wallet pack (2 files) | **Done** — see pack wiring below |
| Passwordless / unlocked export | **Done** — `resolveWalletPassword` (cache → empty → prompt) |
| Sibling `.optn-cold` auto-load | **Done** — Rust `optn_cold_file_exists` (any path, not appdata-only) |
| Network on re-import | **Done** — `.optn` network field + cold peek; no forced mainnet; keystore dedupe |
| Tx graph (in→out) | Planned |
| Contacts (Paytaca-style) | Schema reserved later inside `.optn-cold` |

### Wallet pack (keystore + data) — wired

| File | Contents | Encryption |
|------|----------|------------|
| `<name>.optn` | Keystore / encrypted seed + optional `network` | Wallet password (existing) |
| `<name>.optn-cold` | Addresses, UTXOs snapshot, history, labels, fusion | Same password + `kdf_salt` (AES-GCM) |

- **Export:** Wallet → Export Wallet… → (no password if unlocked/empty) → Save `.optn` → `.optn-cold` beside it via Rust I/O  
- **Save-as name:** stem of the path you type is written into JSON `name` (not stuck on DB name)  
- **Import:** File → Open Wallet Pack… → pick `.optn` (sibling cold auto-loads)  
- **Data-only:** open wallet, select only `.optn-cold`  
- Import data restores labels + fusion only (**HOT** coins still from network listunspent)  
- Re-import of the same keystore **opens the existing row** (no `wallet5_2` / `_3` clones)
| Archive compaction (old spent txs) | Planned |
| Optional raw-tx ancestry (power user) | Later — still not balance boss |

### Coin labels (slice 1)

- Table: `coin_labels` (desktop schema only; zero-touch)  
- Kinds: `outpoint` (`txid:pos`), `txid`, `address`  
- UI: UTXO card + transaction detail “Edit” label  
- **Never** used by listunspent / balance / send selection

## What we rejected (and removed from code)

- Ledger as Redux balance boss (dual truth → wallet 5 fake balance)  
- Synthetic `external:` spends / `applyAddressUtxoSnapshot`  
- `listUnspentFromLedger` / `rebuildUtxosFromLedger` for HOT  
- Background raw-tx apply that rewrote UTXOs from incomplete ledger  
- Creating `ledger_txo` / `ledger_txi` tables for balance  

**Kept (good):** address_sync_status gate, send-time `verifyOutpointsStillUnspent`, Rebuild wipe of old tables if present.

## Evidence of “fixed” for HOT

For a wallet after Manual Sync + wait:

1. Home balance stable  
2. Reopen → same  
3. Idle 5–10 min → same  
4. Console may show `[UTXOService] HOT balance (SQL UTXOs)` — not ledger boss  

## Safe testing

- Prefer **chipnet** for new wallets / funds  
- Never log seeds or mainnet test spam  
- Wallet 5: Manual Sync once after upgrade, then wait  
