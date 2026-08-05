import { describe, expect, it } from 'vitest';
import { computeHistoryStatusHash } from '../WalletLedgerService';

describe('computeHistoryStatusHash', () => {
  it('returns null for empty history', () => {
    expect(computeHistoryStatusHash([])).toBeNull();
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
});
