import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acquireRoundLease,
  forceClearRoundLease,
  releaseRoundLease,
  touchRoundLease,
  tryClaimAutoCooldown,
  lastAutoAttemptAt,
} from '../fusionWalletLease';

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

/**
 * Serialising lock manager, modelling the real Web Locks contract: one holder per
 * name at a time, queued in order. Two "windows" here are two concurrent callers
 * sharing this manager and the storage below it.
 */
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

/** Matches production success spacing — never multi-minute. */
const COOLDOWN = 40_000;
const FAIL_BACKOFF = 25_000;

describe('cross-window fusion lease', () => {
  beforeEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage =
      new MemoryStorage();
    installLocks();
  });

  it('grants the lease to exactly one of two concurrent windows', async () => {
    const [a, b] = await Promise.all([
      acquireRoundLease(2),
      acquireRoundLease(2),
    ]);
    const granted = [a, b].filter((token) => token !== null);
    expect(granted).toHaveLength(1);
  });

  it('covers both transports and both triggers — the lease is per WALLET', async () => {
    // Server fusion previously ignored P2P's reservations entirely.
    const first = await acquireRoundLease(2);
    expect(first).not.toBeNull();
    expect(await acquireRoundLease(2)).toBeNull();
  });

  it('lets a different wallet run concurrently', async () => {
    expect(await acquireRoundLease(2)).not.toBeNull();
    expect(await acquireRoundLease(3)).not.toBeNull();
  });

  it('reclaims a lease abandoned by a crashed round (absolute TTL)', async () => {
    const stale = Date.now() - 5 * 60_000; // beyond 4 minute absolute TTL
    await acquireRoundLease(2, stale);
    // A window that died without releasing must not lock the wallet forever.
    expect(await acquireRoundLease(2)).not.toBeNull();
  });

  it('reclaims a lease with no heartbeat after LEASE_STALE_MS', async () => {
    const { LEASE_STALE_MS, touchRoundLease } = await import(
      '../fusionWalletLease'
    );
    const t0 = Date.now();
    const owner = await acquireRoundLease(2, t0);
    expect(owner).not.toBeNull();
    // Fresh lease still blocks.
    expect(await acquireRoundLease(2, t0 + 30_000)).toBeNull();
    // Heartbeat keeps it live past the stale window.
    expect(await touchRoundLease(2, owner as string, t0 + 30_000)).toBe(true);
    expect(await acquireRoundLease(2, t0 + 30_000 + 30_000)).toBeNull();
    // No heartbeat → reclaim after stale.
    expect(
      await acquireRoundLease(2, t0 + 30_000 + LEASE_STALE_MS + 1)
    ).not.toBeNull();
  });

  it('ignores a release from a window that no longer owns the lease', async () => {
    const owner = await acquireRoundLease(2);
    await releaseRoundLease(2, 'some-other-window-token');
    // The impostor release must not free it for a third window.
    expect(await acquireRoundLease(2)).toBeNull();

    await releaseRoundLease(2, owner as string);
    expect(await acquireRoundLease(2)).not.toBeNull();
  });

  it('fails closed for every new fee-spending lease without Web Locks', async () => {
    vi.stubGlobal('navigator', {});
    expect(await acquireRoundLease(2)).toBeNull();
    expect(globalThis.localStorage.getItem('optn-fusion-lease-2')).toBeNull();
    expect(await tryClaimAutoCooldown(2, COOLDOWN)).toBe(false);
  });

  it('does not grant a phantom lease when durable storage is full', async () => {
    const storage = new MemoryStorage();
    const setItem = storage.setItem.bind(storage);
    vi.spyOn(storage, 'setItem').mockImplementation((key, value) => {
      if (key === 'optn-fusion-lease-2') {
        throw new DOMException('Storage quota exceeded', 'QuotaExceededError');
      }
      setItem(key, value);
    });
    (globalThis as { localStorage?: unknown }).localStorage = storage;

    expect(await acquireRoundLease(2, 1_000)).toBeNull();
    expect(storage.getItem('optn-fusion-lease-2')).toBeNull();
  });

  it('does not grant a phantom lease when a storage write disappears', async () => {
    const storage = new MemoryStorage();
    vi.spyOn(storage, 'setItem').mockImplementation(() => undefined);
    (globalThis as { localStorage?: unknown }).localStorage = storage;

    expect(await acquireRoundLease(2, 1_000)).toBeNull();
  });

  it('fails the heartbeat when the refreshed lease was not persisted', async () => {
    const storage = globalThis.localStorage as unknown as MemoryStorage;
    const owner = await acquireRoundLease(2, 1_000);
    expect(owner).not.toBeNull();
    const setItem = storage.setItem.bind(storage);
    vi.spyOn(storage, 'setItem').mockImplementation((key, value) => {
      if (key === 'optn-fusion-lease-2') return;
      setItem(key, value);
    });

    expect(await touchRoundLease(2, owner as string, 13_000)).toBe(false);
  });

  it('re-reads under the wallet lock and preserves a fresh lease acquired after a stale observation', async () => {
    const storage = globalThis.localStorage as unknown as MemoryStorage;
    const now = 1_000_000;
    storage.setItem(
      'optn-fusion-lease-2',
      JSON.stringify({ owner: 'stale', at: now - 60_000 })
    );
    vi.stubGlobal('navigator', {
      locks: {
        request: async <T>(_name: string, fn: () => Promise<T>): Promise<T> => {
          storage.setItem(
            'optn-fusion-lease-2',
            JSON.stringify({ owner: 'fresh-window', at: now })
          );
          return fn();
        },
      },
    });
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);

    expect(await forceClearRoundLease(2)).toBe(false);
    expect(JSON.parse(storage.getItem('optn-fusion-lease-2') ?? '{}')).toEqual({
      owner: 'fresh-window',
      at: now,
    });
    nowSpy.mockRestore();
  });

  it('fails closed without Web Locks and never removes a stale lease', async () => {
    const storage = globalThis.localStorage as unknown as MemoryStorage;
    storage.setItem(
      'optn-fusion-lease-2',
      JSON.stringify({ owner: 'stale', at: 1 })
    );
    vi.stubGlobal('navigator', {});

    expect(await forceClearRoundLease(2)).toBe(false);
    expect(storage.getItem('optn-fusion-lease-2')).not.toBeNull();
  });
});

describe('atomic auto-fusion cooldown claim', () => {
  beforeEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage =
      new MemoryStorage();
    installLocks();
  });

  it('lets only ONE of two concurrent windows claim the slot', async () => {
    const [a, b] = await Promise.all([
      tryClaimAutoCooldown(7, COOLDOWN),
      tryClaimAutoCooldown(7, COOLDOWN),
    ]);
    // The old read-then-write let both through, and both paid a fee.
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it('refuses again until nextAllowedAt elapses', async () => {
    const { stampAutoSuccess } = await import('../fusionWalletLease');
    const t0 = 1_000_000;
    expect(await tryClaimAutoCooldown(7, COOLDOWN, t0)).toBe(true);
    await stampAutoSuccess(7, COOLDOWN, t0);
    expect(await tryClaimAutoCooldown(7, COOLDOWN, t0 + COOLDOWN - 1)).toBe(
      false
    );
    expect(await tryClaimAutoCooldown(7, COOLDOWN, t0 + COOLDOWN)).toBe(true);
  });

  it('treats a backwards clock as not-yet, never as elapsed', async () => {
    const t0 = 1_000_000;
    await tryClaimAutoCooldown(7, COOLDOWN, t0);
    expect(await tryClaimAutoCooldown(7, COOLDOWN, t0 - 60_000)).toBe(false);
  });

  it('claims durably, so a reload cannot reset the fee ceiling', async () => {
    const t0 = 1_000_000;
    await tryClaimAutoCooldown(7, COOLDOWN, t0);
    // Same storage, brand new "window": the soft hold must still be visible.
    installLocks();
    expect(await tryClaimAutoCooldown(7, COOLDOWN, t0 + 1_000)).toBe(false);
    expect(lastAutoAttemptAt(7)).toBe(t0);
  });

  it('keeps wallets independent', async () => {
    const t0 = 1_000_000;
    expect(await tryClaimAutoCooldown(7, COOLDOWN, t0)).toBe(true);
    expect(await tryClaimAutoCooldown(8, COOLDOWN, t0)).toBe(true);
  });

  it('failure backoff is 25s, not multi-minute', async () => {
    const { stampAutoFailure, isAutoCooldownReady } = await import(
      '../fusionWalletLease'
    );
    const t0 = 1_000_000;
    await stampAutoFailure(7, FAIL_BACKOFF, t0);
    expect(isAutoCooldownReady(7, COOLDOWN, t0 + FAIL_BACKOFF)).toBe(true);
    expect(isAutoCooldownReady(7, COOLDOWN, t0 + FAIL_BACKOFF - 1)).toBe(false);
  });

  it('wallet activity wakes depth-met idle when coins are below depth again', async () => {
    const {
      stampAutoDepthMetIdle,
      isAutoDepthMetIdle,
      isAutoCooldownReady,
      wakeAutoFromWalletActivity,
    } = await import('../fusionWalletLease');
    const t0 = 2_000_000;
    await stampAutoDepthMetIdle(7, 30 * 60_000, t0);
    expect(isAutoDepthMetIdle(7, t0 + 1_000)).toBe(true);

    // Still all-depth / no eligible → stay idle.
    expect(await wakeAutoFromWalletActivity(7, false, t0 + 1_000)).toBe(false);
    expect(isAutoDepthMetIdle(7, t0 + 1_000)).toBe(true);

    // Receive/send/tx left below-depth coins → clear long idle.
    expect(await wakeAutoFromWalletActivity(7, true, t0 + 1_000)).toBe(true);
    expect(isAutoDepthMetIdle(7, t0 + 1_000)).toBe(false);
    expect(isAutoCooldownReady(7, COOLDOWN, t0 + 1_000)).toBe(true);
  });

  it('wallet activity does not break short success cooldown', async () => {
    const {
      stampAutoSuccess,
      isAutoDepthMetIdle,
      isAutoCooldownReady,
      wakeAutoFromWalletActivity,
    } = await import('../fusionWalletLease');
    const t0 = 3_000_000;
    await stampAutoSuccess(7, COOLDOWN, t0);
    expect(isAutoDepthMetIdle(7, t0 + 1_000)).toBe(false);
    expect(await wakeAutoFromWalletActivity(7, true, t0 + 1_000)).toBe(false);
    expect(isAutoCooldownReady(7, COOLDOWN, t0 + 1_000)).toBe(false);
  });

  it('wakes legacy long fail-stamped idle (old depth-met used stampAutoFailure)', async () => {
    const {
      stampAutoFailure,
      isAutoCooldownReady,
      wakeAutoFromWalletActivity,
    } = await import('../fusionWalletLease');
    const t0 = 4_000_000;
    // 30m "depth met" used to stamp as fail without reason: depth-met
    await stampAutoFailure(7, 30 * 60_000, t0);
    expect(await wakeAutoFromWalletActivity(7, true, t0 + 1_000)).toBe(true);
    expect(isAutoCooldownReady(7, COOLDOWN, t0 + 1_000)).toBe(true);
  });
});
