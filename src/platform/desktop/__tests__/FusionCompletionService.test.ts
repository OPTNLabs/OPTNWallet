import { beforeEach, describe, expect, it, vi } from 'vitest';

const recordBroadcastMock = vi.fn();
const observeTransactionMock = vi.fn();
const reconcileActiveWalletUtxosForSpendMock = vi.fn();

const markStateMock = vi.fn();
vi.mock('../../../services/OutboundTransactionTracker', () => ({
  default: {
    recordBroadcast: recordBroadcastMock,
    markState: markStateMock,
  },
}));

vi.mock('../../../services/WalletBackendSyncService', () => ({
  default: {
    observeTransaction: observeTransactionMock,
  },
}));

vi.mock('../../../services/WalletUtxoRefreshService', () => ({
  reconcileActiveWalletUtxosForSpend: reconcileActiveWalletUtxosForSpendMock,
}));

describe('completeFusionBroadcast', () => {
  // This file's module graph (OutboundTransactionTracker, WalletBackendSyncService,
  // libauth-backed fusionDepthRecorder) takes several seconds to transform under
  // parallel load. The default 5s budget aborts test 1 mid-await, leaving its
  // detached observeTransaction chain to land in test 2's window ("expected once,
  // got 2 times"). A longer budget lets the chain settle inside test 1.
  beforeEach(async () => {
    // completeFusionBroadcast dispatches observeTransaction fire-and-forget, so
    // the previous test's call can still be pending here. Clearing the mocks
    // first lets that stray call land inside THIS test and be counted against
    // it — which is exactly how "expected once, got 2 times" appeared on a
    // loaded machine while the file passed in isolation. Let the detached work
    // settle before resetting the counters.
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.clearAllMocks();
    recordBroadcastMock.mockResolvedValue({ state: 'broadcasted' });
    markStateMock.mockResolvedValue({ state: 'seen' });
    observeTransactionMock.mockResolvedValue(undefined);
    // Exclusive spend refresh returns a snapshot (or null), not a boolean.
    reconcileActiveWalletUtxosForSpendMock.mockResolvedValue({});
  });

  it('persists, observes, and immediately refreshes a completed Fusion transaction', async () => {
    const { completeFusionBroadcast } = await import(
      '../FusionCompletionService'
    );
    const spentInputs = [
      {
        tx_hash: 'a'.repeat(64),
        tx_pos: 0,
        address: 'bchtest:qinput',
        value: 200_000,
        height: 1,
      },
    ];

    await expect(
      completeFusionBroadcast({
        walletId: 5,
        txid: 'b'.repeat(64),
        txHex: '00',
        spentInputs,
        source: 'p2p-fusion',
        sourceLabel: 'P2P Fusion',
      })
      // No ownedOutputScripts supplied, so no coin is ours to advance.
    ).resolves.toEqual({ tracked: true, refreshed: true, depthRecorded: 0 });

    expect(recordBroadcastMock).toHaveBeenCalledWith({
      walletId: 5,
      rawTx: '00',
      expectedTxid: 'b'.repeat(64),
      spentInputs,
      source: 'p2p-fusion',
      sourceLabel: 'P2P Fusion',
    });
    expect(observeTransactionMock).toHaveBeenCalledWith(
      5,
      'b'.repeat(64),
      '00'
    );
    expect(reconcileActiveWalletUtxosForSpendMock).toHaveBeenCalledWith(5);
  });

  it('refreshes immediately even when backend observation does not resolve', async () => {
    observeTransactionMock.mockReturnValue(new Promise(() => {}));
    const { completeFusionBroadcast } = await import(
      '../FusionCompletionService'
    );

    await expect(
      completeFusionBroadcast({
        walletId: 5,
        txid: 'c'.repeat(64),
        txHex: '00',
        spentInputs: [],
        source: 'server-fusion',
        sourceLabel: 'CashFusion',
      })
    ).resolves.toEqual({ tracked: true, refreshed: true, depthRecorded: 0 });

    expect(observeTransactionMock).toHaveBeenCalledOnce();
    expect(reconcileActiveWalletUtxosForSpendMock).toHaveBeenCalledWith(5);
  });

  it('reports tracker persistence failure without hiding the successful refresh', async () => {
    recordBroadcastMock.mockRejectedValue(new Error('IndexedDB unavailable'));
    const { completeFusionBroadcast, fusionCompletionWarning } = await import(
      '../FusionCompletionService'
    );

    const completion = await completeFusionBroadcast({
      walletId: 5,
      txid: 'd'.repeat(64),
      txHex: '00',
      spentInputs: [],
      source: 'p2p-fusion',
      sourceLabel: 'P2P Fusion',
    });

    expect(completion).toEqual({
      tracked: false,
      refreshed: true,
      depthRecorded: 0,
    });
    expect(fusionCompletionWarning(completion)).toBe(
      'The balance refreshed, but the outbound tracking record could not be saved.'
    );
  });

  it('distinguishes a fully healthy completion from a dual recovery failure', async () => {
    const { fusionCompletionWarning } = await import(
      '../FusionCompletionService'
    );

    expect(
      fusionCompletionWarning({ tracked: true, refreshed: true })
    ).toBeUndefined();
    expect(fusionCompletionWarning({ tracked: false, refreshed: false })).toBe(
      'Wallet tracking and the immediate balance refresh both failed. Sync the wallet before starting another send.'
    );
  });

  it('keeps Tor-only observation private but still refreshes UTXOs for depth rebind', async () => {
    const { completeFusionBroadcast } = await import(
      '../FusionCompletionService'
    );

    await expect(
      completeFusionBroadcast({
        walletId: 5,
        txid: 'e'.repeat(64),
        txHex: '00',
        spentInputs: [],
        source: 'server-fusion',
        sourceLabel: 'CashFusion server',
        privacyRoute: 'tor-only',
      })
    ).resolves.toEqual({
      tracked: true,
      // UTXO refresh is required so Auto fuse-depth can climb (tor-only used to
      // skip this and leave depths at 0 forever).
      refreshed: true,
      depthRecorded: 0,
    });

    expect(recordBroadcastMock).toHaveBeenCalledWith({
      walletId: 5,
      rawTx: '00',
      expectedTxid: 'e'.repeat(64),
      spentInputs: [],
      source: 'server-fusion',
      sourceLabel: 'CashFusion server',
      privacyRoute: 'tor-only',
    });
    // Still do NOT push the fusion tx through ordinary Electrum observation.
    expect(observeTransactionMock).not.toHaveBeenCalled();
    expect(reconcileActiveWalletUtxosForSpendMock).toHaveBeenCalled();
  });
}, 15_000);
