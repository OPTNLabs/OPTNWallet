import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearCachedPassword,
  getCachedOwnerWalletId,
  getCachedPasswordSnapshot,
  getCachedWalletKeyForWallet,
  hasCachedCredentialsForWallet,
  isCached,
  setCachedPassword,
} from '../WalletKeyCache';

/**
 * Mirror of DesktopAppShell's open-session gate (must stay in sync with
 * DesktopAppShell.tsx). Extracted here so we can prove the unlock regression
 * without mounting React.
 */
function shellWouldShowUi(walletId: number): boolean {
  // walletId <= 0 → landing/picker is allowed
  // walletId > 0 → must have credentials for that wallet in RAM
  return walletId <= 0 || hasCachedCredentialsForWallet(walletId);
}

/** The BROKEN gate that shipped after ciphertext migration. */
function shellWouldShowUiBroken(walletId: number): boolean {
  return walletId <= 0 || getCachedWalletKeyForWallet(walletId) !== null;
}

describe('WalletKeyCache wallet ownership', () => {
  beforeEach(() => clearCachedPassword());

  it('reports uncached state when empty', () => {
    expect(isCached()).toBe(false);
    expect(getCachedOwnerWalletId()).toBeNull();
    expect(getCachedPasswordSnapshot()).toBeNull();
    expect(hasCachedCredentialsForWallet(1)).toBe(false);
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
    // null owner = shared/legacy credentials: any walletId is allowed
    expect(hasCachedCredentialsForWallet(1)).toBe(true);
    expect(hasCachedCredentialsForWallet(99)).toBe(true);
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
    expect(hasCachedCredentialsForWallet(5)).toBe(true);
    expect(hasCachedCredentialsForWallet(6)).toBe(false);
  });

  it('clears all cached state', () => {
    setCachedPassword('pass', new Uint8Array([1]), 3);
    clearCachedPassword();

    expect(isCached()).toBe(false);
    expect(getCachedOwnerWalletId()).toBeNull();
    expect(getCachedPasswordSnapshot()).toBeNull();
    expect(hasCachedCredentialsForWallet(3)).toBe(false);
  });

  /**
   * Regression: after openWalletWithPassword succeeds it setCachedPassword(..., id)
   * then finishOpen dispatches setWalletId(id). The shell must keep rendering.
   * The deprecated getCachedWalletKeyForWallet always returned null, so the shell
   * treated a successful unlock as "stale" and blanked / reset the wallet.
   */
  it('EVIDENCE: broken CryptoKey check rejects a successful unlock session', () => {
    setCachedPassword('correct', new Uint8Array([9, 9, 9]), 1);

    // Password+salt ARE in RAM for wallet 1.
    expect(isCached()).toBe(true);
    expect(hasCachedCredentialsForWallet(1)).toBe(true);

    // Deprecated API still returns null (no CryptoKey is cached by design).
    expect(getCachedWalletKeyForWallet(1)).toBeNull();

    // Broken shell gate (what DesktopAppShell used before the fix):
    expect(shellWouldShowUiBroken(1)).toBe(false);

    // Fixed shell gate:
    expect(shellWouldShowUi(1)).toBe(true);

    // Picker / no wallet still shows either way.
    expect(shellWouldShowUi(0)).toBe(true);
    expect(shellWouldShowUiBroken(0)).toBe(true);
  });
});
