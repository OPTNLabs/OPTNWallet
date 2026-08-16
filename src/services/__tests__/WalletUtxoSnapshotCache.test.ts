import { beforeEach, describe, expect, it } from 'vitest';
import {
  cacheWalletUtxoSnapshot,
  clearCachedWalletUtxoSnapshot,
  getCachedWalletUtxoSnapshot,
  updateCachedWalletUtxoAddress,
} from '../WalletUtxoSnapshotCache';

const coin = (value: number) => ({
  tx_hash: 'a'.repeat(64),
  tx_pos: 0,
  height: 1,
  value,
});

describe('WalletUtxoSnapshotCache', () => {
  beforeEach(() => clearCachedWalletUtxoSnapshot());

  it('returns an isolated copy of the last completed snapshot', () => {
    const snapshot = { 'bchtest:qwallet': [coin(125_000)] };
    cacheWalletUtxoSnapshot(7, snapshot);

    const cached = getCachedWalletUtxoSnapshot(7)!;
    cached['bchtest:qwallet'].length = 0;

    expect(getCachedWalletUtxoSnapshot(7)).toEqual(snapshot);
  });

  it('updates one address without dropping other cached addresses', () => {
    cacheWalletUtxoSnapshot(7, {
      'bchtest:qone': [coin(100)],
      'bchtest:qtwo': [coin(200)],
    });

    updateCachedWalletUtxoAddress(7, 'bchtest:qone', [coin(300)]);

    expect(getCachedWalletUtxoSnapshot(7)).toEqual({
      'bchtest:qone': [coin(300)],
      'bchtest:qtwo': [coin(200)],
    });
  });

  it('does not retain a deleted wallet snapshot', () => {
    cacheWalletUtxoSnapshot(7, { 'bchtest:qwallet': [coin(125_000)] });
    clearCachedWalletUtxoSnapshot(7);

    expect(getCachedWalletUtxoSnapshot(7)).toBeNull();
  });
});
