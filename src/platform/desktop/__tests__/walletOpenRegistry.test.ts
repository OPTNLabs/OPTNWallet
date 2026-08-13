import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claimWalletOpen,
  runExclusiveWalletOpen,
  refreshWalletOpenClaim,
  releaseWalletOpen,
  windowHoldingWallet,
  OPEN_CLAIM_TTL_MS,
} from '../walletOpenRegistry';

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

function installLocks() {
  const chains = new Map<string, Promise<unknown>>();
  vi.stubGlobal('navigator', {
    locks: {
      request: <T>(name: string, fn: () => Promise<T>): Promise<T> => {
        const prior = chains.get(name) ?? Promise.resolve();
        const run = prior.then(() => fn());
        chains.set(
          name,
          run.then(
            () => undefined,
            () => undefined
          )
        );
        return run;
      },
    },
  });
}

describe('single-window rule for an open wallet', () => {
  beforeEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
    installLocks();
  });

  it('lets the first window open a wallet', async () => {
    expect(await claimWalletOpen(5, 'window-a')).toBeNull();
    expect(windowHoldingWallet(5)).toBe('window-a');
  });

  it('refuses a second window and names the one to focus', async () => {
    await claimWalletOpen(5, 'window-a');
    // Electron Cash raises the existing window rather than loading the wallet
    // twice; the caller needs to know WHICH window to raise.
    expect(await claimWalletOpen(5, 'window-b')).toBe('window-a');
  });

  it('still allows DIFFERENT wallets side by side', async () => {
    // The whole point of multi-window: two wallets at once is supported, the
    // same wallet twice is not.
    expect(await claimWalletOpen(5, 'window-a')).toBeNull();
    expect(await claimWalletOpen(6, 'window-b')).toBeNull();
  });

  it('lets the SAME window re-claim, so a reload does not lock the user out', async () => {
    await claimWalletOpen(5, 'window-a');
    expect(await claimWalletOpen(5, 'window-a')).toBeNull();
  });

  it('frees the wallet when its window releases it', async () => {
    await claimWalletOpen(5, 'window-a');
    await releaseWalletOpen(5, 'window-a');
    expect(windowHoldingWallet(5)).toBeNull();
    expect(await claimWalletOpen(5, 'window-b')).toBeNull();
  });

  it('ignores a release from a window that does not hold it', async () => {
    await claimWalletOpen(5, 'window-a');
    await releaseWalletOpen(5, 'window-impostor');
    expect(windowHoldingWallet(5)).toBe('window-a');
  });

  it('reclaims a wallet from a window that died without releasing', async () => {
    const longAgo = Date.now() - (OPEN_CLAIM_TTL_MS + 1_000);
    await claimWalletOpen(5, 'window-a', longAgo);
    // A crashed window must not lock a wallet away permanently.
    expect(await claimWalletOpen(5, 'window-b')).toBeNull();
  });

  it('keeps a live claim alive through its heartbeat', async () => {
    const t0 = 1_000_000;
    await claimWalletOpen(5, 'window-a', t0);
    await refreshWalletOpenClaim(5, 'window-a', t0 + OPEN_CLAIM_TTL_MS - 1_000);
    // Still held a moment after the ORIGINAL claim would have expired.
    expect(
      await claimWalletOpen(5, 'window-b', t0 + OPEN_CLAIM_TTL_MS + 500)
    ).toBe('window-a');
  });

  it('does not let a stale window steal a claim back by heartbeating', async () => {
    const t0 = 1_000_000;
    await claimWalletOpen(5, 'window-a', t0);
    // window-a died; window-b legitimately took over after the TTL.
    await claimWalletOpen(5, 'window-b', t0 + OPEN_CLAIM_TTL_MS + 1_000);
    // A late heartbeat from the old window must not reclaim it.
    await refreshWalletOpenClaim(5, 'window-a', t0 + OPEN_CLAIM_TTL_MS + 2_000);
    expect(windowHoldingWallet(5, t0 + OPEN_CLAIM_TTL_MS + 2_000)).toBe(
      'window-b'
    );
  });

  it('opens the wallet even with no lock manager', async () => {
    vi.stubGlobal('navigator', {});
    // Unlike the fusion lease, this must NOT fail closed: refusing a round costs
    // a missed round, refusing to open a wallet makes the app unusable.
    expect(await claimWalletOpen(5, 'window-a')).toBeNull();
  });

  it('releases a claim when password verification rejects the open', async () => {
    await expect(
      runExclusiveWalletOpen(5, 'window-a', async () => null)
    ).resolves.toEqual({ status: 'rejected' });

    expect(windowHoldingWallet(5)).toBeNull();
    expect(await claimWalletOpen(5, 'window-b')).toBeNull();
  });

  it('releases a claim when wallet opening throws', async () => {
    await expect(
      runExclusiveWalletOpen(5, 'window-a', async () => {
        throw new Error('database failed');
      })
    ).rejects.toThrow('database failed');

    expect(windowHoldingWallet(5)).toBeNull();
  });

  it('keeps a successful biometric or password claim until the wallet closes', async () => {
    await expect(
      runExclusiveWalletOpen(5, 'window-a', async () => ({ unlocked: true }))
    ).resolves.toEqual({
      status: 'opened',
      value: { unlocked: true },
    });

    expect(windowHoldingWallet(5)).toBe('window-a');
    await expect(
      runExclusiveWalletOpen(5, 'window-b', async () => ({ unlocked: true }))
    ).resolves.toEqual({ status: 'held', windowLabel: 'window-a' });
  });
});

describe('a claim held by a window that no longer exists', () => {
  beforeEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
    installLocks();
  });

  it('is taken over, because closing a window releases nothing', () => {
    // Reported: "it says wallet 6 is already open although I closed it". The X
    // button runs no handler we control and a crash runs none at all, so the
    // claim survived its window and blocked reopening for the whole TTL.
    return (async () => {
      await claimWalletOpen(6, 'window-gone');
      const taken = await claimWalletOpen(6, 'window-new', Date.now(), async () => false);
      expect(taken).toBeNull();
      expect(windowHoldingWallet(6)).toBe('window-new');
    })();
  });

  it('still refuses when the holding window IS open', async () => {
    await claimWalletOpen(6, 'window-a');
    expect(
      await claimWalletOpen(6, 'window-b', Date.now(), async () => true)
    ).toBe('window-a');
  });

  it('keeps the claim when liveness cannot be determined', async () => {
    // An unknown answer must not hand the wallet to a second window; the TTL
    // remains the backstop.
    await claimWalletOpen(6, 'window-a');
    expect(
      await claimWalletOpen(6, 'window-b', Date.now(), async () => {
        throw new Error('cannot enumerate windows');
      })
    ).toBe('window-a');
  });

  it('does not let two contenders both replace the same dead claim', async () => {
    await claimWalletOpen(6, 'window-gone');

    let probes = 0;
    let releaseProbes!: () => void;
    const bothProbed = new Promise<void>((resolve) => {
      releaseProbes = resolve;
    });
    const isWindowOpen = async (label: string) => {
      expect(label).toBe('window-gone');
      probes += 1;
      if (probes === 2) releaseProbes();
      await bothProbed;
      return false;
    };

    const [fromB, fromC] = await Promise.all([
      claimWalletOpen(6, 'window-b', Date.now(), isWindowOpen),
      claimWalletOpen(6, 'window-c', Date.now(), isWindowOpen),
    ]);

    const winners = [
      fromB === null ? 'window-b' : null,
      fromC === null ? 'window-c' : null,
    ].filter((label): label is string => label !== null);
    expect(winners).toHaveLength(1);
    const winner = winners[0];
    expect([fromB, fromC].filter((held) => held === winner)).toHaveLength(1);
    expect(windowHoldingWallet(6)).toBe(winner);
  });
});
