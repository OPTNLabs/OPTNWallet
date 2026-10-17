import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { NativeFusionEvent, NativeFusionFinished } from '../nativeFusion';

// The Rust driver, as the renderer hears it: a start, a stop, and events.
let emitEvent: (event: NativeFusionEvent) => void = () => undefined;
let emitFinished: (finished: NativeFusionFinished) => void = () => undefined;
const startNative = vi.fn();
const stopNative = vi.fn();
const nativeRunning = vi.fn();
vi.mock('../nativeFusion', () => ({
  listenNativeFusion: vi.fn(
    async (
      onEvent: (event: NativeFusionEvent) => void,
      onFinished: (finished: NativeFusionFinished) => void
    ) => {
      emitEvent = onEvent;
      emitFinished = onFinished;
      return () => undefined;
    }
  ),
  startNativeFusion: (...a: unknown[]) => startNative(...a),
  stopNativeFusion: (...a: unknown[]) => stopNative(...a),
  nativeFusionRunning: (...a: unknown[]) => nativeRunning(...a),
}));

const reconcile = vi.fn();
const findPendingFusion = vi.fn();
const recordFusionTxid = vi.fn();
const syncRuntimeFusionDepth = vi.fn();
vi.mock('../../../services/WalletUtxoRefreshService', () => ({
  reconcileActiveWalletUtxosForSpend: (...a: unknown[]) => reconcile(...a),
}));
vi.mock('../../../services/OutboundTransactionTracker', () => ({
  default: {
    findFusionVerificationPending: (...a: unknown[]) => findPendingFusion(...a),
  },
}));
vi.mock('../../../services/OutboundTransactionReconciler', () => ({
  reconcileOutboundTransactions: vi.fn(async () => []),
}));
vi.mock('../fusionCoinDepth', () => ({
  recordFusionTxid: (...a: unknown[]) => recordFusionTxid(...a),
  syncRuntimeFusionDepth: (...a: unknown[]) => syncRuntimeFusionDepth(...a),
}));
vi.mock('../../../apis/DatabaseManager/DatabaseService', () => ({
  default: () => ({
    ensureDatabaseStarted: async () => undefined,
    getDatabase: () => null,
  }),
}));
vi.mock('../../../utils/errorHandling', () => ({ logError: vi.fn() }));
vi.mock('../logger', () => ({ log: { info: vi.fn(), error: vi.fn() } }));

import {
  autoFusionRun,
  cancelFusionRound,
  getFusionActivity,
  getFusionLastResult,
  isFusionRunning,
  outcomeOf,
  reconcileIdleFusionState,
  startAutoFusion,
  startFusionRound,
  stopFusionRun,
} from '../FusionRunnerService';
import { Network } from '../../../state/slices/networkSlice';
import { reservedOutpoints } from '../fusionRoundState';

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

const WALLET = 3;
const manual = () =>
  startFusionRound({
    walletId: WALLET,
    network: Network.CHIPNET,
    mode: 'p2p',
    venue: { mode: 'p2p' },
    fuseDepth: 3,
  });
const auto = () =>
  startAutoFusion({
    walletId: WALLET,
    mode: 'server',
    venue: { mode: 'server', selected: 'a:1', configured: ['a:1', 'b:1'] },
    fuseDepth: 3,
    key: 'k1',
  });
const flush = () => new Promise((done) => setTimeout(done, 0));
const round = (seen = true) => ({
  txid: 'ab'.repeat(32),
  seen,
  spent: ['aa:0'],
  created: ['ab:0'],
});

describe('FusionRunnerService — a view of the Rust driver', () => {
  beforeEach(async () => {
    vi.stubGlobal('localStorage', new MemoryStorage());
    startNative.mockReset().mockResolvedValue(undefined);
    stopNative.mockReset().mockResolvedValue(true);
    nativeRunning.mockReset().mockResolvedValue(null);
    findPendingFusion.mockReset().mockResolvedValue(null);
    reconcile.mockReset().mockResolvedValue({});
    recordFusionTxid.mockReset();
    syncRuntimeFusionDepth.mockReset().mockResolvedValue(true);
    // Whatever an earlier test left running ends here.
    emitFinished({
      walletId: WALLET,
      mode: 'p2p',
      auto: false,
      ok: true,
      stopped: 'interrupted',
    });
    await flush();
  });

  it('names a venue and nothing else, and resolves when the driver finishes', async () => {
    const outcome = manual();
    await flush();
    expect(startNative).toHaveBeenCalledWith({
      walletId: WALLET,
      venue: { mode: 'p2p' },
      auto: false,
      fuseDepth: 3,
    });
    expect(isFusionRunning(WALLET)).toBe(true);

    emitEvent({
      walletId: WALLET,
      event: 'round',
      mode: 'p2p',
      coins: 2,
      outpoints: ['aa:0', 'aa:1'],
    });
    // The send screens see the round's coins held, as Rust holds them.
    expect([...reservedOutpoints(WALLET)].sort()).toEqual(['aa:0', 'aa:1']);
    emitEvent({ walletId: WALLET, event: 'status', message: 'Signing…' });
    expect(getFusionActivity(WALLET)?.status).toBe('Signing…');
    // The P2P stepper follows the steps the Rust round reports.
    expect(getFusionActivity(WALLET)?.phase).toBe(1);
    emitEvent({ walletId: WALLET, event: 'phase', phase: 3 });
    expect(getFusionActivity(WALLET)?.phase).toBe(3);
    emitEvent({
      walletId: WALLET,
      event: 'released',
      outpoints: ['aa:0', 'aa:1'],
    });
    expect(reservedOutpoints(WALLET).size).toBe(0);
    emitEvent({ walletId: WALLET, event: 'fused', round: round() });
    emitFinished({
      walletId: WALLET,
      mode: 'p2p',
      auto: false,
      ok: true,
      rounds: [round()],
      stopped: null,
    });

    await expect(outcome).resolves.toEqual({
      status: 'fused',
      mode: 'p2p',
      txid: 'ab'.repeat(32),
    });
    await flush();
    expect(isFusionRunning(WALLET)).toBe(false);
    expect(recordFusionTxid).toHaveBeenCalledWith(WALLET, 'ab'.repeat(32));
    expect(syncRuntimeFusionDepth).toHaveBeenCalledWith(WALLET);
    expect(reconcile).toHaveBeenCalledWith(WALLET);
  });

  it('ignores another wallet’s events', async () => {
    const outcome = manual();
    await flush();
    emitEvent({
      walletId: WALLET + 1,
      event: 'round',
      mode: 'p2p',
      coins: 1,
      outpoints: ['ff:0'],
    });
    expect(reservedOutpoints(WALLET + 1).size).toBe(0);
    emitFinished({
      walletId: WALLET + 1,
      mode: 'p2p',
      auto: false,
      ok: false,
      error: 'not ours',
    });
    expect(isFusionRunning(WALLET)).toBe(true);
    emitFinished({
      walletId: WALLET,
      mode: 'p2p',
      auto: false,
      ok: true,
      stopped: 'interrupted',
    });
    await expect(outcome).resolves.toEqual({ status: 'cancelled' });
  });

  it('releases what a round held when the run ends without saying so', async () => {
    const outcome = manual();
    await flush();
    emitEvent({
      walletId: WALLET,
      event: 'round',
      mode: 'p2p',
      coins: 1,
      outpoints: ['aa:0'],
    });
    emitFinished({
      walletId: WALLET,
      mode: 'p2p',
      auto: false,
      ok: false,
      error: 'relay closed',
    });
    await expect(outcome).resolves.toEqual({
      status: 'failed',
      mode: 'p2p',
      message: 'relay closed',
    });
    expect(reservedOutpoints(WALLET).size).toBe(0);
    expect(getFusionLastResult(WALLET)).toMatchObject({
      ok: false,
      message: 'relay closed',
    });
  });

  it('reports a second run Rust refused as busy, and an error as failed', async () => {
    startNative.mockRejectedValueOnce(
      'CashFusion is already running for this wallet.'
    );
    await expect(manual()).resolves.toEqual({ status: 'busy' });
    startNative.mockRejectedValueOnce(
      new Error('Open this wallet in the shared engine before fusing.')
    );
    await expect(manual()).resolves.toEqual({
      status: 'failed',
      mode: 'p2p',
      message: 'Open this wallet in the shared engine before fusing.',
    });
    expect(isFusionRunning(WALLET)).toBe(false);
  });

  it('waits for an earlier unverified Fusion transaction before spending again', async () => {
    findPendingFusion.mockResolvedValue({
      txid: 'cd'.repeat(32),
      source: 'server-fusion',
    });
    await expect(manual()).resolves.toMatchObject({
      status: 'verification-pending',
      mode: 'server',
      txid: 'cd'.repeat(32),
    });
    await expect(auto()).resolves.toBe('pending');
    expect(startNative).not.toHaveBeenCalled();
  });

  it('runs Auto as one native run whose quiet spells show as the last result', async () => {
    await expect(auto()).resolves.toBe('started');
    expect(startNative).toHaveBeenCalledWith({
      walletId: WALLET,
      venue: { mode: 'server', selected: 'a:1', configured: ['a:1', 'b:1'] },
      auto: true,
      fuseDepth: 3,
    });
    // Between rounds Auto is not "fusing": Start stays usable.
    expect(isFusionRunning(WALLET)).toBe(false);
    emitEvent({
      walletId: WALLET,
      event: 'idle',
      reason: 'every coin is at depth',
    });
    expect(getFusionLastResult(WALLET)).toMatchObject({
      trigger: 'auto',
      ok: true,
      message: 'Auto: every coin is at depth',
    });
    emitEvent({
      walletId: WALLET,
      event: 'retry',
      error: 'connection refused',
      transient: true,
    });
    expect(getFusionLastResult(WALLET)).toMatchObject({
      ok: false,
      message: 'Auto: connection refused — retrying…',
    });
    await expect(auto()).resolves.toBe('busy');
  });

  it('stops Auto before a manual round, and starts nothing until it finished', async () => {
    await auto();
    stopNative.mockImplementation(async () => {
      setTimeout(
        () =>
          emitFinished({
            walletId: WALLET,
            mode: 'server',
            auto: true,
            ok: true,
            stopped: 'interrupted',
          }),
        0
      );
      return true;
    });
    const outcome = manual();
    await flush();
    await flush();
    expect(stopNative).toHaveBeenCalledTimes(1);
    expect(startNative).toHaveBeenCalledTimes(2);
    expect(startNative).toHaveBeenLastCalledWith(
      expect.objectContaining({ auto: false })
    );
    // Auto cannot slip back in while the manual round runs.
    await expect(auto()).resolves.toBe('busy');
    emitFinished({
      walletId: WALLET,
      mode: 'p2p',
      auto: false,
      ok: true,
      stopped: 'every coin is at depth',
    });
    await expect(outcome).resolves.toEqual({
      status: 'no-eligible-coins',
      detail: 'every coin is at depth',
    });
  });

  it('stops only its own wallet’s run', async () => {
    await auto();
    expect(cancelFusionRound(WALLET + 1)).toBe(false);
    expect(cancelFusionRound(WALLET)).toBe(true);
    expect(stopNative).toHaveBeenCalledTimes(1);
    const stopped = stopFusionRun(WALLET);
    emitFinished({
      walletId: WALLET,
      mode: 'server',
      auto: true,
      ok: true,
      stopped: 'interrupted',
    });
    await stopped;
    await expect(auto()).resolves.toBe('started');
  });

  it('drops a run Rust no longer has, and its held coins', async () => {
    void manual();
    await flush();
    emitEvent({
      walletId: WALLET,
      event: 'round',
      mode: 'p2p',
      coins: 1,
      outpoints: ['aa:0'],
    });
    nativeRunning.mockResolvedValue({
      walletId: WALLET,
      mode: 'p2p',
      auto: false,
    });
    await reconcileIdleFusionState(WALLET);
    expect(isFusionRunning(WALLET)).toBe(true);
    // Rust not answering changes nothing.
    nativeRunning.mockRejectedValueOnce(new Error('ipc closed'));
    await reconcileIdleFusionState(WALLET);
    expect(isFusionRunning(WALLET)).toBe(true);
    nativeRunning.mockResolvedValue(null);
    await reconcileIdleFusionState(WALLET);
    expect(isFusionRunning(WALLET)).toBe(false);
    expect(reservedOutpoints(WALLET).size).toBe(0);
  });

  it('never drops a run whose start Rust has not confirmed yet', async () => {
    // Found live: the panel re-checked on Start, before Rust listed the run,
    // and showed every round cancelled while Rust went on fusing.
    let confirm: () => void = () => undefined;
    startNative.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          confirm = resolve;
        })
    );
    const outcome = manual();
    await flush();
    await reconcileIdleFusionState(WALLET);
    expect(isFusionRunning(WALLET)).toBe(true);
    confirm();
    await flush();
    emitFinished({
      walletId: WALLET,
      mode: 'p2p',
      auto: false,
      ok: true,
      rounds: [round()],
      stopped: null,
    });
    await expect(outcome).resolves.toMatchObject({ status: 'fused' });
  });

  it('adopts a run of this wallet it lost track of, and none of another', async () => {
    nativeRunning.mockResolvedValue({
      walletId: WALLET + 1,
      mode: 'server',
      auto: true,
    });
    await reconcileIdleFusionState(WALLET);
    expect(autoFusionRun(WALLET)).toBeNull();

    nativeRunning.mockResolvedValue({
      walletId: WALLET,
      mode: 'server',
      auto: true,
    });
    await reconcileIdleFusionState(WALLET);
    // Shown as an Auto run with settings no hook chose, so the hook
    // restarts or stops it.
    expect(autoFusionRun(WALLET)).toEqual({ key: 'adopted' });
    emitEvent({
      walletId: WALLET,
      event: 'round',
      mode: 'server',
      coins: 2,
      outpoints: ['cc:0', 'cc:1'],
    });
    expect(getFusionActivity(WALLET)?.mode).toBe('server');
    expect(cancelFusionRound(WALLET)).toBe(true);
    emitFinished({
      walletId: WALLET,
      mode: 'server',
      auto: true,
      ok: true,
      stopped: 'interrupted',
    });
    expect(autoFusionRun(WALLET)).toBeNull();
  });
});

describe('outcomeOf — how a manual run ended', () => {
  const finished = (extra: Partial<NativeFusionFinished>) => ({
    walletId: WALLET,
    mode: 'p2p' as const,
    auto: false,
    ok: true,
    ...extra,
  });

  it('is pending verification when the network was not seen to hold it', () => {
    expect(
      outcomeOf(finished({ rounds: [round(false)] }), 'p2p')
    ).toMatchObject({ status: 'verification-pending', txid: 'ab'.repeat(32) });
  });

  it('tells a stop from nothing to fuse', () => {
    expect(outcomeOf(finished({ stopped: 'interrupted' }), 'p2p')).toEqual({
      status: 'cancelled',
    });
    expect(outcomeOf(finished({ stopped: 'no coins' }), 'p2p')).toEqual({
      status: 'no-eligible-coins',
      detail: 'no coins',
    });
  });

  it('carries the driver’s error', () => {
    expect(
      outcomeOf(finished({ ok: false, error: 'tier unaffordable' }), 'server')
    ).toEqual({
      status: 'failed',
      mode: 'server',
      message: 'tier unaffordable',
    });
  });
});
