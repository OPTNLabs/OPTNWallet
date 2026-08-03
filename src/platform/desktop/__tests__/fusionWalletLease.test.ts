import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acquireRoundLease,
  releaseRoundLease,
  tryClaimAutoCooldown,
  lastAutoAttemptAt,
  roundLeaseIsLive,
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

  it('reclaims a lease abandoned by a crashed round', async () => {
    const stale = Date.now() - 11 * 60_000; // beyond the 10 minute TTL
    await acquireRoundLease(2, stale);
    // A window that died without releasing must not lock the wallet forever.
    expect(await acquireRoundLease(2)).not.toBeNull();
  });

  it('ignores a release from a window that no longer owns the lease', async () => {
    const owner = await acquireRoundLease(2);
    await releaseRoundLease(2, 'some-other-window-token');
    // The impostor release must not free it for a third window.
    expect(await acquireRoundLease(2)).toBeNull();

    await releaseRoundLease(2, owner as string);
    expect(await acquireRoundLease(2)).not.toBeNull();
  });

  it('fails closed when no lock manager exists', async () => {
    vi.stubGlobal('navigator', {});
    // Without exclusivity we cannot promise a single round, so refuse rather
    // than risk two windows both paying.
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

  it('refuses again until the cooldown has fully elapsed', async () => {
    const t0 = 1_000_000;
    expect(await tryClaimAutoCooldown(7, COOLDOWN, t0)).toBe(true);
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
    // Same storage, brand new "window": the stamp must still be visible.
    installLocks();
    expect(await tryClaimAutoCooldown(7, COOLDOWN, t0 + 1_000)).toBe(false);
    expect(lastAutoAttemptAt(7)).toBe(t0);
  });

  it('keeps wallets independent', async () => {
    const t0 = 1_000_000;
    expect(await tryClaimAutoCooldown(7, COOLDOWN, t0)).toBe(true);
    expect(await tryClaimAutoCooldown(8, COOLDOWN, t0)).toBe(true);
  });
});

describe('roundLeaseIsLive', () => {
  // Auto-lock consults this before wiping the key. Locking mid-round kills the
  // round for every peer waiting on our components, not only for us.
  const TTL_MS = 10 * 60_000;

  it('reports a round held by any window', async () => {
    const owner = await acquireRoundLease(77, 1_000);
    expect(owner).not.toBeNull();
    expect(roundLeaseIsLive(77, 1_000)).toBe(true);
  });

  it('reports nothing when no round is running', () => {
    expect(roundLeaseIsLive(78, 1_000)).toBe(false);
  });

  it('stops reporting once the lease is released', async () => {
    const owner = await acquireRoundLease(79, 1_000);
    await releaseRoundLease(79, owner as string);
    expect(roundLeaseIsLive(79, 1_000)).toBe(false);
  });

  it('expires with the TTL, so a dead window cannot defer the lock forever', async () => {
    await acquireRoundLease(80, 1_000);
    expect(roundLeaseIsLive(80, 1_000 + TTL_MS - 1)).toBe(true);
    expect(roundLeaseIsLive(80, 1_000 + TTL_MS)).toBe(false);
  });

  it('does not take or refresh the lease merely by observing it', async () => {
    // A probe that stamped the record would keep the wallet unlockable forever
    // and would also steal the lease from the window actually running the round.
    expect(roundLeaseIsLive(81, 1_000)).toBe(false);
    const owner = await acquireRoundLease(81, 2_000);
    expect(owner).not.toBeNull();
    roundLeaseIsLive(81, 2_500);
    expect(roundLeaseIsLive(81, 2_000 + TTL_MS)).toBe(false);
  });
});
