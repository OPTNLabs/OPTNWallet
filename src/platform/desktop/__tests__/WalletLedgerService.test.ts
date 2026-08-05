import { describe, expect, it } from 'vitest';
import {
  computeHistoryStatusHash,
  EMPTY_HISTORY_STATUS,
  historyStatusesMatch,
} from '../WalletLedgerService';

describe('computeHistoryStatusHash', () => {
  it('returns empty-history sentinel for empty history (not null)', () => {
    expect(computeHistoryStatusHash([])).toBe(EMPTY_HISTORY_STATUS);
    expect(historyStatusesMatch(EMPTY_HISTORY_STATUS, null)).toBe(true);
  });

  it('is stable for the same history list', () => {
    const hist = [
      { tx_hash: 'aa'.repeat(32), height: 100 },
      { tx_hash: 'bb'.repeat(32), height: 101 },
    ];
    expect(computeHistoryStatusHash(hist)).toBe(computeHistoryStatusHash(hist));
  });

  it('changes when height changes', () => {
    const a = computeHistoryStatusHash([
      { tx_hash: 'aa'.repeat(32), height: 100 },
    ]);
    const b = computeHistoryStatusHash([
      { tx_hash: 'aa'.repeat(32), height: 101 },
    ]);
    expect(a).not.toBe(b);
  });

  it('matches EC/Selene style shape (64 hex chars)', () => {
    const h = computeHistoryStatusHash([
      { tx_hash: 'cc'.repeat(32), height: 1 },
    ]);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is order-sensitive (concatenates in server order)', () => {
    const a = computeHistoryStatusHash([
      { tx_hash: 'aa'.repeat(32), height: 1 },
      { tx_hash: 'bb'.repeat(32), height: 2 },
    ]);
    const b = computeHistoryStatusHash([
      { tx_hash: 'bb'.repeat(32), height: 2 },
      { tx_hash: 'aa'.repeat(32), height: 1 },
    ]);
    expect(a).not.toBe(b);
  });
});

describe('WalletLedgerService public API surface (HOT helpers only)', () => {
  it('exports status gate + verify + rebuild wipe — not dual-boss balance APIs', async () => {
    const mod = await import('../WalletLedgerService');
    expect(typeof mod.partitionAddressesByStatus).toBe('function');
    expect(typeof mod.addressHistoryIsFresh).toBe('function');
    expect(typeof mod.clearAddressStatuses).toBe('function');
    expect(typeof mod.recordHistoryItems).toBe('function');
    expect(typeof mod.verifyOutpointsStillUnspent).toBe('function');
    expect(typeof mod.clearWalletChainData).toBe('function');
    // Removed dual-boss balance path
    expect((mod as Record<string, unknown>).listUnspentFromLedger).toBeUndefined();
    expect((mod as Record<string, unknown>).rebuildUtxosFromLedger).toBeUndefined();
    expect((mod as Record<string, unknown>).applyAddressUtxoSnapshot).toBeUndefined();
    expect((mod as Record<string, unknown>).applyRawTransaction).toBeUndefined();
    expect((mod as Record<string, unknown>).clearSyntheticExternalSpends).toBeUndefined();
  });
});
