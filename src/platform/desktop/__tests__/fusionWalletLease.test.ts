import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acquireRoundLease,
  releaseRoundLease,
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

const COOLDOWN = 5 * 60_000;

describe('cross-window fusion lease', () => {
  beforeEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
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
    const { LEASE_STALE_MS, touchRoundLease } = await import('../fusionWalletLease');
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

  it('falls back to storage-only lease when no lock manager exists', async () => {
    vi.stubGlobal('navigator', {});
    // Single-window WebViews without Web Locks still fuse; stale reclaim
    // remains the exclusivity backstop.
    expect(await acquireRoundLease(2)).not.toBeNull();
    expect(await acquireRoundLease(2)).toBeNull();
    expect(await tryClaimAutoCooldown(2, COOLDOWN)).toBe(false);
  });
});

describe('atomic auto-fusion cooldown claim', () => {
  beforeEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
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
    expect(await tryClaimAutoCooldown(7, COOLDOWN, t0 + COOLDOWN - 1)).toBe(false);
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

  it('short failure backoff does not enforce the full 5-minute gap', async () => {
    const { stampAutoFailure, isAutoCooldownReady } = await import(
      '../fusionWalletLease'
    );
    const t0 = 1_000_000;
    await stampAutoFailure(7, 90_000, t0);
    expect(isAutoCooldownReady(7, COOLDOWN, t0 + 90_000)).toBe(true);
    expect(isAutoCooldownReady(7, COOLDOWN, t0 + 89_000)).toBe(false);
  });
});
