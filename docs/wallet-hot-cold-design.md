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
- Empty listunspent without `force` keeps prior (no wipe on flaky empty).  
- Soft-fail on connection lost → keep SQL.  
- **No status-hash skip on wallet-wide UTXO fetch** (that re-served poisoned SQL).  
- Invalidate Electrum short TTL cache before each wallet-wide fetch.  
- Manual Sync / open: `force` listunspent all known addresses.  
- Trust authoritative empty listunspent; missing RPC key still keeps prior.

## COLD path (product roadmap — not balance)

| Feature | Status |
|---------|--------|
| Transaction history UI | Existing |
| Fusion depth / round metadata | Partial (existing services) |
| Labels on UTXO/tx | Planned |
| Tx graph (in→out) | Planned |
| Export history + labels + fusion log | Planned |
| Archive compaction (old spent txs) | Planned |
| Optional raw-tx ancestry (power user) | Later — still not balance boss |

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
