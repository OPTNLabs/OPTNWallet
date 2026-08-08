import { beforeEach, describe, expect, it, vi } from 'vitest';
import { binToHex, encodeTransaction } from '@bitauth/libauth';

const {
  databaseRunMock,
  ensureDatabaseStartedMock,
  getDatabaseMock,
  saveDatabaseToFileMock,
  scheduleDatabaseSaveMock,
  dispatchMock,
  addTransactionsMock,
} = vi.hoisted(() => {
  const databaseRun = vi.fn();
  return {
    databaseRunMock: databaseRun,
    ensureDatabaseStartedMock: vi.fn(),
    getDatabaseMock: vi.fn(() => ({ run: databaseRun })),
    saveDatabaseToFileMock: vi.fn(),
    scheduleDatabaseSaveMock: vi.fn(),
    dispatchMock: vi.fn(),
    addTransactionsMock: vi.fn((payload: unknown) => ({
      type: 'transactions/addTransactions',
      payload,
    })),
  };
});

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

vi.mock('../../../apis/DatabaseManager/DatabaseService', () => ({
  default: () => ({
    ensureDatabaseStarted: ensureDatabaseStartedMock,
    getDatabase: getDatabaseMock,
    saveDatabaseToFile: saveDatabaseToFileMock,
    scheduleDatabaseSave: scheduleDatabaseSaveMock,
  }),
}));

vi.mock('../../../state/store', () => ({
  store: { dispatch: dispatchMock },
}));

vi.mock('../../../state/slices/transactionSlice', () => ({
  addTransactions: addTransactionsMock,
}));

// Depth persistence has its own focused suite. Keep its detached SQL label
// cache out of this completion-lifecycle suite so no background import can
// outlive Vitest's mocked database environment.
vi.mock('../fusionCoinDepth', () => ({
  hydrateFusionLabels: vi.fn().mockResolvedValue(0),
  recordFusionRound: vi.fn(),
  recordFusionTxid: vi.fn(),
  fuseDepthEligibility: vi.fn(() => ({
    total: 0,
    eligible: 0,
    atOrAboveDepth: 0,
    maxDepth: 99,
    minDepth: 0,
    maxCoinDepth: 0,
  })),
}));

function oneOutputFusionHex(): string {
  return binToHex(
    encodeTransaction({
      version: 2,
      locktime: 0,
      inputs: [
        {
          outpointTransactionHash: new Uint8Array(32),
          outpointIndex: 0,
          sequenceNumber: 0xffffffff,
          unlockingBytecode: Uint8Array.of(),
        },
      ],
      outputs: [
        {
          lockingBytecode: Uint8Array.of(0x51),
          valueSatoshis: 50_000n,
        },
      ],
    })
  );
}

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
    databaseRunMock.mockReset();
    ensureDatabaseStartedMock.mockReset().mockResolvedValue(undefined);
    getDatabaseMock.mockReset().mockReturnValue({ run: databaseRunMock });
    saveDatabaseToFileMock.mockReset().mockResolvedValue(undefined);
    scheduleDatabaseSaveMock.mockReset();
    dispatchMock.mockReset();
    addTransactionsMock.mockClear();
  });

  it('keeps completion pending until the SQL history write is durably saved', async () => {
    let releaseSave!: () => void;
    saveDatabaseToFileMock.mockReturnValue(
      new Promise<void>((resolve) => {
        releaseSave = resolve;
      })
    );
    const { completeFusionBroadcast } = await import(
      '../FusionCompletionService'
    );

    let settled = false;
    const completion = completeFusionBroadcast({
      walletId: 5,
      txid: '1'.repeat(64),
      txHex: '00',
      spentInputs: [],
      source: 'server-fusion',
      sourceLabel: 'CashFusion',
    }).then((result) => {
      settled = true;
      return result;
    });

    await vi.waitFor(() => {
      expect(
        databaseRunMock.mock.calls.some(([sql]) =>
          String(sql).includes('INSERT INTO transactions')
        )
      ).toBe(true);
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(dispatchMock).not.toHaveBeenCalled();

    releaseSave();
    await expect(completion).resolves.toMatchObject({ historyRecorded: true });
    expect(saveDatabaseToFileMock).toHaveBeenCalledWith(5);
    expect(dispatchMock).toHaveBeenCalledOnce();
  });

  it('keeps completion pending until the Redux history injection finishes', async () => {
    let releaseDispatch!: () => void;
    dispatchMock.mockReturnValue(
      new Promise<void>((resolve) => {
        releaseDispatch = resolve;
      })
    );
    const { completeFusionBroadcast } = await import(
      '../FusionCompletionService'
    );

    let settled = false;
    const completion = completeFusionBroadcast({
      walletId: 5,
      txid: '2'.repeat(64),
      txHex: '00',
      spentInputs: [],
      source: 'p2p-fusion',
      sourceLabel: 'P2P Fusion',
    }).then((result) => {
      settled = true;
      return result;
    });

    await vi.waitFor(() => {
      expect(dispatchMock).toHaveBeenCalledOnce();
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseDispatch();
    await expect(completion).resolves.toMatchObject({ historyRecorded: true });
  });

  it('warns on history persistence failure without losing tracking, refresh, or depth', async () => {
    saveDatabaseToFileMock.mockRejectedValue(new Error('disk unavailable'));
    const { completeFusionBroadcast, fusionCompletionWarning } = await import(
      '../FusionCompletionService'
    );

    const completion = await completeFusionBroadcast({
      walletId: 5,
      txid: '3'.repeat(64),
      txHex: oneOutputFusionHex(),
      spentInputs: [],
      source: 'p2p-fusion',
      sourceLabel: 'P2P Fusion',
      ownedOutputScripts: ['51'],
    });

    expect(completion).toEqual({
      tracked: true,
      refreshed: true,
      depthRecorded: 1,
      historyRecorded: false,
    });
    expect(fusionCompletionWarning(completion)).toBe(
      'The Fusion transaction is safely tracked, but its wallet history entry could not be saved. Sync the wallet before starting another Fusion round.'
    );
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(reconcileActiveWalletUtxosForSpendMock).toHaveBeenCalledWith(5);
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
    ).resolves.toEqual({
      tracked: true,
      refreshed: true,
      depthRecorded: 0,
      historyRecorded: true,
    });

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
    ).resolves.toEqual({
      tracked: true,
      refreshed: true,
      depthRecorded: 0,
      historyRecorded: true,
    });

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
      historyRecorded: true,
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
      historyRecorded: true,
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
