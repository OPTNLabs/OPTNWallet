import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearCachedWalletKey,
  getCachedWalletKey,
  getCachedWalletKeyForWallet,
  getCachedWalletKeySnapshot,
  setCachedWalletKey,
} from '../WalletKeyCache';

describe('WalletKeyCache wallet ownership', () => {
  beforeEach(() => clearCachedWalletKey());

  it('does not treat an unbound gate key as an opened wallet key', () => {
    const key = {} as CryptoKey;
    setCachedWalletKey(key);

    expect(getCachedWalletKey()).toBe(key);
    expect(getCachedWalletKeyForWallet(5)).toBeNull();
  });

  it('returns a wallet key only for its exact owner id', () => {
    const key = {} as CryptoKey;
    setCachedWalletKey(key, 5);

    expect(getCachedWalletKeyForWallet(5)).toBe(key);
    expect(getCachedWalletKeyForWallet(4)).toBeNull();
    expect(getCachedWalletKeySnapshot()).toEqual({ key, ownerWalletId: 5 });
  });
});
