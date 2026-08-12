import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_WALLET_FUSION_POLICY,
  clearWalletFusionPolicy,
  readWalletFusionPolicy,
  writeWalletFusionPolicy,
} from '../walletFusionPolicy';

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string) {
    return this.map.has(k) ? (this.map.get(k) as string) : null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
}

const policy = (over: Partial<typeof DEFAULT_WALLET_FUSION_POLICY> = {}) => ({
  ...DEFAULT_WALLET_FUSION_POLICY,
  ...over,
});

describe('per-wallet fusion policy', () => {
  beforeEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
  });

  it('returns defaults for a wallet that has never been configured', () => {
    expect(readWalletFusionPolicy(5)).toEqual(DEFAULT_WALLET_FUSION_POLICY);
  });

  it('follows the WALLET, not the window that set it', () => {
    // The whole point: settings used to live in the per-window redux partition,
    // which is recreated on every window open, so they did not travel with the
    // wallet.
    writeWalletFusionPolicy(5, policy({ cashFusionEnabled: true, fuseDepth: 7 }));
    expect(readWalletFusionPolicy(5).cashFusionEnabled).toBe(true);
    expect(readWalletFusionPolicy(5).fuseDepth).toBe(7);
  });

  it('keeps wallets independent', () => {
    writeWalletFusionPolicy(5, policy({ p2pFusionEnabled: true, fuseDepth: 9 }));
    writeWalletFusionPolicy(6, policy({ p2pFusionEnabled: false, fuseDepth: 2 }));

    expect(readWalletFusionPolicy(5).p2pFusionEnabled).toBe(true);
    expect(readWalletFusionPolicy(5).fuseDepth).toBe(9);
    expect(readWalletFusionPolicy(6).p2pFusionEnabled).toBe(false);
    expect(readWalletFusionPolicy(6).fuseDepth).toBe(2);
  });

  it('clamps a stored depth that the UI could not have produced', () => {
    // A hand-edited or partially written record must not put the engine into a
    // state the UI cannot express; 0 would mean "never stop fusing".
    writeWalletFusionPolicy(5, policy({ fuseDepth: 0 }));
    expect(readWalletFusionPolicy(5).fuseDepth).toBeGreaterThanOrEqual(1);

    writeWalletFusionPolicy(6, policy({ fuseDepth: 999 }));
    expect(readWalletFusionPolicy(6).fuseDepth).toBeLessThanOrEqual(10);
  });

  it('fills defaults per FIELD for a partially written record', () => {
    (globalThis as { localStorage: MemoryStorage }).localStorage.setItem(
      'optn-wallet-fusion-policy',
      JSON.stringify({ '5': { cashFusionEnabled: true } })
    );
    const loaded = readWalletFusionPolicy(5);
    expect(loaded.cashFusionEnabled).toBe(true);
    expect(loaded.autoFuseEnabled).toBe(
      DEFAULT_WALLET_FUSION_POLICY.autoFuseEnabled
    );
    expect(loaded.fuseDepth).toBe(DEFAULT_WALLET_FUSION_POLICY.fuseDepth);
  });

  it('ignores a corrupt record rather than throwing', () => {
    (globalThis as { localStorage: MemoryStorage }).localStorage.setItem(
      'optn-wallet-fusion-policy',
      'not json at all'
    );
    expect(readWalletFusionPolicy(5)).toEqual(DEFAULT_WALLET_FUSION_POLICY);
  });

  it('rejects an invalid wallet id instead of writing a junk key', () => {
    writeWalletFusionPolicy(0, policy({ cashFusionEnabled: true }));
    expect(readWalletFusionPolicy(0)).toEqual(DEFAULT_WALLET_FUSION_POLICY);
  });

  it('forgets a deleted wallet so a reused id does not inherit its settings', () => {
    writeWalletFusionPolicy(5, policy({ cashFusionEnabled: true }));
    clearWalletFusionPolicy(5);
    expect(readWalletFusionPolicy(5)).toEqual(DEFAULT_WALLET_FUSION_POLICY);
  });

  it('leaves other wallets alone when one is cleared', () => {
    writeWalletFusionPolicy(5, policy({ cashFusionEnabled: true }));
    writeWalletFusionPolicy(6, policy({ cashFusionEnabled: true }));
    clearWalletFusionPolicy(5);
    expect(readWalletFusionPolicy(6).cashFusionEnabled).toBe(true);
  });
});
