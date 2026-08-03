import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearCachedPassword,
  getCachedOwnerWalletId,
  getCachedPasswordSnapshot,
  isCached,
  setCachedPassword,
} from '../WalletKeyCache';

describe('WalletKeyCache wallet ownership', () => {
  beforeEach(() => clearCachedPassword());

  it('reports uncached state when empty', () => {
    expect(isCached()).toBe(false);
    expect(getCachedOwnerWalletId()).toBeNull();
    expect(getCachedPasswordSnapshot()).toBeNull();
  });

  it('caches credentials without a wallet id (gate/provisional)', () => {
    const salt = new Uint8Array([1, 2, 3]);
    setCachedPassword('pass', salt);

    expect(isCached()).toBe(true);
    expect(getCachedOwnerWalletId()).toBeNull();
    expect(getCachedPasswordSnapshot()).toEqual({
      password: 'pass',
      salt,
      ownerWalletId: null,
    });
  });

  it('caches credentials bound to a specific wallet id', () => {
    const salt = new Uint8Array([4, 5, 6]);
    setCachedPassword('pass2', salt, 5);

    expect(isCached()).toBe(true);
    expect(getCachedOwnerWalletId()).toBe(5);
    expect(getCachedPasswordSnapshot()).toEqual({
      password: 'pass2',
      salt,
      ownerWalletId: 5,
    });
  });

  it('clears all cached state', () => {
    setCachedPassword('pass', new Uint8Array([1]), 3);
    clearCachedPassword();

    expect(isCached()).toBe(false);
    expect(getCachedOwnerWalletId()).toBeNull();
    expect(getCachedPasswordSnapshot()).toBeNull();
  });
});
