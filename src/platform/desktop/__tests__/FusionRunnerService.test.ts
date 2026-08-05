import { beforeEach, describe, expect, it, vi } from 'vitest';

const reconcile = vi.fn();
vi.mock('../../../services/WalletUtxoRefreshService', () => ({
  // Fusion uses the exclusive spend path so background joins cannot soft-fail.
  reconcileActiveWalletUtxosForSpend: (...a: unknown[]) => reconcile(...a),
  reconcileActiveWalletUtxos: (...a: unknown[]) => reconcile(...a),
}));

import {
  getFusionActivity,
  isFusionRunning,
  startFusionRound,
  subscribeFusionActivity,
  type FusionActivity,
} from '../FusionRunnerService';
import { Network } from '../../../state/slices/networkSlice';
import { clearFusionDepth, recordFusionRound } from '../fusionCoinDepth';
import { lastAutoAttemptAt } from '../fusionWalletLease';

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

const coin = (txid: string, token = false) =>
  ({
    tx_hash: txid,
    tx_pos: 0,
    value: 100_000,
    address: 'bchtest:q',
    token: token ? {} : undefined,
  }) as never;

const runP2p = vi.fn();
const runServer = vi.fn();

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const base = () => ({
  walletId: 3,
  network: Network.CHIPNET,
  mode: 'p2p' as const,
  trigger: 'auto' as const,
  fuseDepth: 3,
  runners: { runP2p, runServer },
});

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

describe('FusionRunnerService — one path for manual and automatic rounds', () => {
  beforeEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage =
      new MemoryStorage();
    installLocks();
    clearFusionDepth(3);
    reconcile.mockReset();
    runP2p.mockReset().mockResolvedValue({ txid: 'a'.repeat(64) });
    runServer.mockReset().mockResolvedValue({ txid: 'b'.repeat(64) });
  });

  it('takes its coins from the live refresh, never from a caller-supplied list', async () => {
    reconcile.mockResolvedValue({ addr: [coin('aa')] });
    const result = await startFusionRound(base());

    expect(reconcile).toHaveBeenCalledWith(3, undefined);
    expect(result).toEqual({
      status: 'fused',
      mode: 'p2p',
      txid: 'a'.repeat(64),
    });
  });

  it('reuses the fresh snapshot that woke the automatic engine', async () => {
    const snapshot = { addr: [coin('aa')] };

    const result = await startFusionRound({
      ...base(),
      freshSnapshot: snapshot,
    });

    expect(reconcile).not.toHaveBeenCalled();
    expect(runP2p).toHaveBeenCalledWith(
      snapshot.addr,
      undefined,
      expect.objectContaining({
        onStatus: expect.any(Function),
        onPhase: expect.any(Function),
      })
    );
    expect(result.status).toBe('fused');
  });

  it('treats a null refresh as "waiting for wallet", not as "no coins"', async () => {
    // null means this trigger joined an in-progress refresh or the session
    // changed. Starting a round here is exactly the stale-coin bug.
    reconcile.mockResolvedValue(null);
    expect(await startFusionRound(base())).toEqual({
      status: 'waiting-for-wallet',
    });
    expect(runP2p).not.toHaveBeenCalled();
  });

  it('does not burn the auto cooldown while the wallet is still refreshing', async () => {
    reconcile.mockResolvedValue(null);

    await startFusionRound(base());

    expect(lastAutoAttemptAt(3)).toBeNull();
  });

  it('excludes token UTXOs', async () => {
    reconcile.mockResolvedValue({ addr: [coin('tok', true)] });
    await expect(startFusionRound(base())).resolves.toMatchObject({
      status: 'no-eligible-coins',
    });
    expect(runP2p).not.toHaveBeenCalled();
  });

  it('does not burn the auto cooldown when there are no eligible coins', async () => {
    reconcile.mockResolvedValue({ addr: [coin('tok', true)] });

    await startFusionRound(base());

    expect(lastAutoAttemptAt(3)).toBeNull();
  });

  it('applies fuse depth to AUTOMATIC rounds', async () => {
    recordFusionRound(3, ['x:0'], ['deep:0']);
    recordFusionRound(3, ['deep:0'], ['deeper:0']);
    recordFusionRound(3, ['deeper:0'], ['maxed:0']); // depth 3
    reconcile.mockResolvedValue({ addr: [coin('maxed')] });

    await expect(startFusionRound(base())).resolves.toMatchObject({
      status: 'no-eligible-coins',
      detail: expect.stringMatching(/depth ≥ 3|rounds-per-coin/i),
    });
  });

  it('lets a MANUAL round re-fuse a coin already at the depth limit', async () => {
    recordFusionRound(3, ['x:0'], ['deep:0']);
    recordFusionRound(3, ['deep:0'], ['deeper:0']);
    recordFusionRound(3, ['deeper:0'], ['maxed:0']);
    reconcile.mockResolvedValue({ addr: [coin('maxed')] });

    const result = await startFusionRound({ ...base(), trigger: 'manual' });
    expect(result.status).toBe('fused');
  });

  it('claims the cooldown before transport work, so a failed round still counts', async () => {
    reconcile.mockResolvedValue({ addr: [coin('aa')] });
    runP2p.mockRejectedValue(new Error('relay died mid-round'));

    const result = await startFusionRound(base());
    expect(result).toEqual({
      status: 'failed',
      mode: 'p2p',
      message: 'relay died mid-round',
    });
    // Stamped anyway: otherwise a persistently failing wallet retries in a loop,
    // paying a fee each time.
    expect(lastAutoAttemptAt(3)).not.toBeNull();
  });

  it('does not rescan the wallet while an automatic cooldown is active', async () => {
    reconcile.mockResolvedValue({ addr: [coin('aa')] });

    await startFusionRound(base());
    reconcile.mockClear();

    await expect(startFusionRound(base())).resolves.toEqual({
      status: 'cooldown',
    });
    expect(reconcile).not.toHaveBeenCalled();
    expect(runP2p).toHaveBeenCalledOnce();
  });

  it('does not claim the cooldown for manual rounds', async () => {
    reconcile.mockResolvedValue({ addr: [coin('aa')] });
    await startFusionRound({ ...base(), trigger: 'manual' });
    expect(lastAutoAttemptAt(3)).toBeNull();
  });

  it('refuses a second concurrent round for the same wallet', async () => {
    let release: (v: unknown) => void = () => {};
    reconcile.mockResolvedValue({ addr: [coin('aa')] });
    runP2p.mockReturnValue(
      new Promise((r) => {
        release = r;
      })
    );

    const first = startFusionRound(base());
    // Taking the lease is now async (Web Lock + durable record), so drain
    // microtasks until it is actually held rather than guessing a tick count.
    for (let i = 0; i < 100 && !isFusionRunning(3); i += 1) {
      await Promise.resolve();
    }
    expect(isFusionRunning(3)).toBe(true);

    // A manual click landing mid-engine-round must not start a second one.
    expect(await startFusionRound({ ...base(), trigger: 'manual' })).toEqual({
      status: 'busy',
    });

    release({ txid: 'a'.repeat(64) });
    await first;
    expect(isFusionRunning(3)).toBe(false);
  });

  it.each(['p2p', 'server'] as const)(
    'publishes persistent wallet activity for a %s round until it settles',
    async (mode) => {
      reconcile.mockResolvedValue({ addr: [coin('aa')] });
      const transport = deferred<{ txid: string }>();
      if (mode === 'p2p') {
        runP2p.mockReturnValue(transport.promise);
      } else {
        runServer.mockReturnValue(transport.promise);
      }

      const events: Array<FusionActivity | null> = [];
      const unsubscribe = subscribeFusionActivity(3, (activity) => {
        events.push(activity);
      });

      const round = startFusionRound({
        ...base(),
        mode,
        trigger: 'manual',
      });
      for (let i = 0; i < 100 && !getFusionActivity(3); i += 1) {
        await Promise.resolve();
      }

      expect(getFusionActivity(3)).toMatchObject({
        walletId: 3,
        mode,
        trigger: 'manual',
      });
      expect(events.at(-1)).toMatchObject({ mode, trigger: 'manual' });

      transport.resolve({ txid: 'c'.repeat(64) });
      await round;

      expect(getFusionActivity(3)).toBeNull();
      expect(events.at(-1)).toBeNull();
      unsubscribe();
    }
  );

  it('routes server mode to the server runner', async () => {
    reconcile.mockResolvedValue({ addr: [coin('aa')] });
    const result = await startFusionRound({ ...base(), mode: 'server' });
    expect(runServer).toHaveBeenCalledOnce();
    expect(runP2p).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 'fused',
      mode: 'server',
      txid: 'b'.repeat(64),
    });
  });

  it('preserves a post-broadcast wallet-tracking warning', async () => {
    reconcile.mockResolvedValue({ addr: [coin('aa')] });
    runP2p.mockResolvedValue({
      txid: 'a'.repeat(64),
      warning: 'Wallet tracking will retry.',
    });

    await expect(
      startFusionRound({ ...base(), trigger: 'manual' })
    ).resolves.toEqual({
      status: 'fused',
      mode: 'p2p',
      txid: 'a'.repeat(64),
      warning: 'Wallet tracking will retry.',
    });
  });

  it('does not touch wallet state when the session is already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      startFusionRound({ ...base(), signal: controller.signal })
    ).resolves.toEqual({ status: 'cancelled' });
    expect(reconcile).not.toHaveBeenCalled();
    expect(runP2p).not.toHaveBeenCalled();
  });

  it('cancels after reconciliation and passes the session signal to the transport', async () => {
    const refresh = deferred<Record<string, unknown[]>>();
    reconcile.mockReturnValue(refresh.promise);
    const controller = new AbortController();

    const result = startFusionRound({
      ...base(),
      trigger: 'manual',
      signal: controller.signal,
    });
    for (let i = 0; i < 20 && reconcile.mock.calls.length === 0; i += 1) {
      await Promise.resolve();
    }
    controller.abort();
    refresh.resolve({ addr: [coin('aa')] });

    await expect(result).resolves.toEqual({ status: 'cancelled' });
    expect(reconcile).toHaveBeenCalledWith(3, controller.signal);
    expect(runP2p).not.toHaveBeenCalled();
  });

  it('forwards the active session signal to the selected runner', async () => {
    reconcile.mockResolvedValue({ addr: [coin('aa')] });
    const controller = new AbortController();

    await startFusionRound({
      ...base(),
      trigger: 'manual',
      signal: controller.signal,
    });

    expect(runP2p).toHaveBeenCalledWith(
      expect.any(Array),
      controller.signal,
      expect.objectContaining({
        onStatus: expect.any(Function),
        onPhase: expect.any(Function),
      })
    );
  });

  it('reports a completed irreversible round even when abort races with runner resolution', async () => {
    reconcile.mockResolvedValue({ addr: [coin('aa')] });
    const controller = new AbortController();
    runP2p.mockImplementation(async () => {
      controller.abort();
      return { txid: 'a'.repeat(64) };
    });

    await expect(
      startFusionRound({
        ...base(),
        trigger: 'manual',
        signal: controller.signal,
      })
    ).resolves.toEqual({
      status: 'fused',
      mode: 'p2p',
      txid: 'a'.repeat(64),
    });
  });

  it('preserves a post-signature failure even when abort races with the error', async () => {
    reconcile.mockResolvedValue({ addr: [coin('aa')] });
    const controller = new AbortController();
    runServer.mockImplementation(async () => {
      controller.abort();
      throw new Error('relay observation timed out after signing');
    });

    await expect(
      startFusionRound({
        ...base(),
        mode: 'server',
        trigger: 'manual',
        signal: controller.signal,
      })
    ).resolves.toEqual({
      status: 'failed',
      mode: 'server',
      message: 'relay observation timed out after signing',
    });
  });
});
