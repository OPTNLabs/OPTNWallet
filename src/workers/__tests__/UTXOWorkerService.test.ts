import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  replaceAllUTXOs,
  setInitialized,
  setFetchingUTXOs,
} from '../../state/slices/utxoSlice';

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: vi.fn(() => 'android'),
  },
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: vi.fn(() => 'android'),
  },
}));

const dispatchMock = vi.fn();
const getStateMock = vi.fn();
const retrieveKeysMock = vi.fn();
const fetchAndStoreUTXOsManyMock = vi.fn();
const fetchUTXOsFromDatabaseMock = vi.fn();
const fetchContractInstancesMock = vi.fn();
const updateContractUTXOsMock = vi.fn();
const listTrackedAddressesMock = vi.fn();
const scheduleDatabaseSaveMock = vi.fn();
const preloadTokenMetadataMock = vi.fn();
const syncWalletSpecialActivitiesMock = vi.fn();
const reconnectMock = vi.fn();
const invalidateUTXOCacheMock = vi.fn();
const subscribeBlockHeadersMock = vi.fn();
const subscribeAddressMock = vi.fn();
const subscribeAddressesBulkMock = vi.fn(async () => {
  /* bulk subscribe resolves by default */
});
const unsubscribeAddressMock = vi.fn();
const unsubscribeBlockHeadersMock = vi.fn();
const fetchAndStoreTransactionHistoriesMock = vi.fn();
const fetchAndStoreTransactionHistoryMock = vi.fn();
const reconcileActiveWalletUtxosMock = vi.fn();
const runWalletUtxoRefreshMock = vi.fn(
  async (_walletId: number, task: () => Promise<void>) => task()
);

vi.mock('../../state/store', () => ({
  store: {
    getState: getStateMock,
    dispatch: dispatchMock,
  },
}));

vi.mock('../../services/KeyService', () => ({
  default: {
    retrieveKeys: retrieveKeysMock,
  },
}));

vi.mock('../../services/UTXOService', () => ({
  default: {
    fetchAndStoreUTXOsMany: fetchAndStoreUTXOsManyMock,
    fetchAllWalletUtxos: vi.fn(),
    fetchUTXOsFromDatabase: fetchUTXOsFromDatabaseMock,
    fetchAndStoreUTXOs: vi.fn(),
  },
}));

vi.mock('../../services/ElectrumService', () => ({
  default: {
    reconnect: reconnectMock,
    ensureFreshConnection: vi.fn(async () => undefined),
    subscribeBlockHeaders: subscribeBlockHeadersMock,
    subscribeAddress: subscribeAddressMock,
    subscribeAddressesBulk: subscribeAddressesBulkMock,
    unsubscribeAddress: unsubscribeAddressMock,
    unsubscribeBlockHeaders: unsubscribeBlockHeadersMock,
    getUTXOsMany: vi.fn(),
    getUTXOs: vi.fn(),
    getAddressState: vi.fn(async () => null),
  },
  invalidateUTXOCache: invalidateUTXOCacheMock,
}));

// HOT path: status gate helpers (optional). Balance is SQL/listunspent, not ledger.
vi.mock('../../platform/desktop/WalletLedgerService', () => ({
  addressHistoryIsFresh: vi.fn(async () => false),
  partitionAddressesByStatus: vi.fn(async (_w: number, addrs: string[]) => ({
    dirty: addrs,
    clean: [],
    probed: 0,
  })),
  getAddressHistoryStatusMap: vi.fn(async () => new Map()),
  EMPTY_HISTORY_STATUS: '',
}));

vi.mock('../../platform/desktop/desktopSchema', () => ({
  ensureDesktopLedgerTables: vi.fn(async () => undefined),
}));

vi.mock('../../apis/ContractManager/ContractManager', () => ({
  default: vi.fn(() => ({
    fetchContractInstances: fetchContractInstancesMock,
    updateContractUTXOs: updateContractUTXOsMock,
  })),
}));

vi.mock('../../apis/TransactionManager/TransactionManager', () => ({
  default: vi.fn(() => ({
    fetchAndStoreTransactionHistory: fetchAndStoreTransactionHistoryMock,
    fetchAndStoreTransactionHistories: fetchAndStoreTransactionHistoriesMock,
  })),
}));

vi.mock('../../apis/DatabaseManager/DatabaseService', () => ({
  default: vi.fn(() => ({
    scheduleDatabaseSave: scheduleDatabaseSaveMock,
  })),
}));

vi.mock('../../services/QuantumrootTrackingService', () => ({
  default: {
    listTrackedAddresses: listTrackedAddressesMock,
  },
}));

vi.mock('../../services/RefreshCoordinator', () => ({
  runWalletUtxoRefresh: runWalletUtxoRefreshMock,
}));

vi.mock('../../services/WalletUtxoRefreshService', () => ({
  reconcileActiveWalletUtxos: reconcileActiveWalletUtxosMock,
}));

vi.mock('../../hooks/useSharedTokenMetadata', () => ({
  preloadTokenMetadata: preloadTokenMetadataMock,
}));

vi.mock('../../services/WalletSpecialActivityService', () => ({
  syncWalletSpecialActivities: syncWalletSpecialActivitiesMock,
}));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('UTXOWorkerService.bootstrapAllUTXOs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getStateMock.mockReturnValue({
      wallet_id: { currentWalletId: 42, sessionGeneration: 1 },
      network: { currentNetwork: 'MAINNET' },
    });
    retrieveKeysMock.mockResolvedValue([{ address: 'bitcoincash:qaddr1' }]);
    fetchContractInstancesMock.mockResolvedValue([]);
    fetchUTXOsFromDatabaseMock.mockResolvedValue({
      utxosMap: {},
      cashTokenUtxosMap: {},
    });
    updateContractUTXOsMock.mockResolvedValue(undefined);
    listTrackedAddressesMock.mockResolvedValue([]);
    fetchAndStoreTransactionHistoriesMock.mockResolvedValue({});
    fetchAndStoreTransactionHistoryMock.mockResolvedValue([]);
    reconnectMock.mockResolvedValue(undefined);
    subscribeBlockHeadersMock.mockResolvedValue(undefined);
    subscribeAddressMock.mockResolvedValue(undefined);
    unsubscribeAddressMock.mockResolvedValue(undefined);
    unsubscribeBlockHeadersMock.mockResolvedValue(undefined);
    reconcileActiveWalletUtxosMock.mockResolvedValue({});
    syncWalletSpecialActivitiesMock.mockResolvedValue([]);
  });

  afterEach(async () => {
    const { stopUTXOWorker } = await import('../UTXOWorkerService');
    await stopUTXOWorker();
  });

  it('preloads BCMR metadata without blocking bootstrap completion and persists the db snapshot', async () => {
    const gate = deferred<void>();
    preloadTokenMetadataMock.mockReturnValue(gate.promise);

    fetchAndStoreUTXOsManyMock.mockResolvedValue({
      'bitcoincash:qaddr1': [
        {
          address: 'bitcoincash:qaddr1',
          tx_hash: 'tx1',
          tx_pos: 0,
          value: 1000,
          height: 1,
          token: {
            category: 'cat1',
            amount: 1,
          },
        },
        {
          address: 'bitcoincash:qaddr1',
          tx_hash: 'tx2',
          tx_pos: 1,
          value: 2000,
          height: 1,
          token: {
            category: 'cat2',
            amount: 2,
          },
        },
        {
          address: 'bitcoincash:qaddr1',
          tx_hash: 'tx3',
          tx_pos: 2,
          value: 3000,
          height: 1,
          token: {
            category: 'cat2',
            amount: 3,
          },
        },
      ],
    });

    const { bootstrapAllUTXOs } = await import('../UTXOWorkerService');
    // Token metadata must not gate Syncing off — bootstrap finishes while
    // the icon fetch is still pending.
    await bootstrapAllUTXOs();

    expect(preloadTokenMetadataMock).toHaveBeenCalledTimes(1);
    expect(preloadTokenMetadataMock).toHaveBeenCalledWith(['cat1', 'cat2']);
    expect(fetchContractInstancesMock).toHaveBeenCalledWith(42);

    expect(dispatchMock).toHaveBeenCalledWith(
      replaceAllUTXOs({
        utxosByAddress: expect.objectContaining({
          'bitcoincash:qaddr1': expect.any(Array),
        }),
      })
    );
    expect(scheduleDatabaseSaveMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock).toHaveBeenCalledWith(setFetchingUTXOs(false));
    expect(dispatchMock).toHaveBeenCalledWith(setInitialized(true));

    gate.resolve();
  });

  it('paints durable SQL balance before the network listunspent pass', async () => {
    fetchUTXOsFromDatabaseMock.mockResolvedValue({
      utxosMap: {
        'bitcoincash:qaddr1': [
          {
            address: 'bitcoincash:qaddr1',
            tx_hash: 'oldtx',
            tx_pos: 0,
            value: 42_000,
            height: 10,
          },
        ],
      },
      cashTokenUtxosMap: {},
    });
    const fetchGate = deferred<Record<string, unknown>>();
    fetchAndStoreUTXOsManyMock.mockReturnValueOnce(fetchGate.promise);

    const { bootstrapAllUTXOs } = await import('../UTXOWorkerService');
    const bootstrapPromise = bootstrapAllUTXOs();

    for (
      let i = 0;
      i < 30 &&
      !dispatchMock.mock.calls.some(
        (c) =>
          c[0]?.type === 'utxos/replaceAllUTXOs' &&
          c[0]?.payload?.utxosByAddress?.['bitcoincash:qaddr1']?.[0]?.value ===
            42_000
      );
      i += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(dispatchMock).toHaveBeenCalledWith(
      replaceAllUTXOs({
        utxosByAddress: {
          'bitcoincash:qaddr1': [
            expect.objectContaining({ value: 42_000, tx_hash: 'oldtx' }),
          ],
        },
      })
    );
    expect(dispatchMock).toHaveBeenCalledWith(setInitialized(true));
    // Network pass still pending — provisional paint must not wait on it.
    expect(fetchAndStoreUTXOsManyMock).toHaveBeenCalled();

    fetchGate.resolve({
      'bitcoincash:qaddr1': [
        {
          address: 'bitcoincash:qaddr1',
          tx_hash: 'newtx',
          tx_pos: 0,
          value: 50_000,
          height: 11,
        },
      ],
    });
    await bootstrapPromise;

    // Authoritative network result overwrites provisional SQL.
    expect(dispatchMock).toHaveBeenCalledWith(
      replaceAllUTXOs({
        utxosByAddress: {
          'bitcoincash:qaddr1': [
            expect.objectContaining({ value: 50_000, tx_hash: 'newtx' }),
          ],
        },
      })
    );
  });

  it('invalidates wallet and tracked-address caches before bootstrap batches', async () => {
    listTrackedAddressesMock.mockResolvedValue(['bchtest:qtracked']);
    fetchAndStoreUTXOsManyMock.mockResolvedValue({
      'bitcoincash:qaddr1': [],
      'bchtest:qtracked': [],
    });

    const { bootstrapAllUTXOs } = await import('../UTXOWorkerService');
    await bootstrapAllUTXOs();

    expect(invalidateUTXOCacheMock.mock.calls).toEqual([
      ['bitcoincash:qaddr1'],
      ['bchtest:qtracked'],
    ]);
    expect(invalidateUTXOCacheMock.mock.invocationCallOrder[0]).toBeLessThan(
      fetchAndStoreUTXOsManyMock.mock.invocationCallOrder[0]
    );
    expect(invalidateUTXOCacheMock.mock.invocationCallOrder[1]).toBeLessThan(
      fetchAndStoreUTXOsManyMock.mock.invocationCallOrder[0]
    );
    expect(fetchAndStoreUTXOsManyMock).toHaveBeenCalledTimes(1);
    expect(fetchAndStoreUTXOsManyMock).toHaveBeenCalledWith(
      42,
      ['bitcoincash:qaddr1', 'bchtest:qtracked'],
      expect.objectContaining({ onProgress: expect.any(Function) })
    );
  });

  it('publishes addresses materialized by discovery in the initial snapshot', async () => {
    fetchAndStoreUTXOsManyMock.mockResolvedValue({
      'bitcoincash:qaddr1': [],
      'bitcoincash:qdiscovered': [
        {
          address: 'bitcoincash:qdiscovered',
          tx_hash: 'discovered-tx',
          tx_pos: 0,
          value: 12_345,
          height: 0,
        },
      ],
    });

    const { bootstrapAllUTXOs } = await import('../UTXOWorkerService');
    await bootstrapAllUTXOs();

    expect(dispatchMock).toHaveBeenCalledWith(
      replaceAllUTXOs({
        utxosByAddress: expect.objectContaining({
          'bitcoincash:qdiscovered': [
            expect.objectContaining({
              tx_hash: 'discovered-tx',
              value: 12_345,
            }),
          ],
        }),
      })
    );
  });

  it('clears the syncing state without erasing balances when the wallet batch fails', async () => {
    fetchAndStoreUTXOsManyMock.mockRejectedValue(
      new Error('all Electrum servers unavailable')
    );
    const { bootstrapAllUTXOs } = await import('../UTXOWorkerService');

    await expect(bootstrapAllUTXOs()).rejects.toThrow(
      'all Electrum servers unavailable'
    );

    expect(dispatchMock).toHaveBeenCalledWith(setFetchingUTXOs(true));
    expect(dispatchMock).toHaveBeenCalledWith(setFetchingUTXOs(false));
    expect(
      dispatchMock.mock.calls.some(
        ([action]) => action.type === replaceAllUTXOs.type
      )
    ).toBe(false);
    expect(dispatchMock).not.toHaveBeenCalledWith(setInitialized(true));
  });

  it('discards a completed bootstrap when another wallet became active', async () => {
    const fetchGate = deferred<Record<string, never[]>>();
    fetchAndStoreUTXOsManyMock.mockReturnValueOnce(fetchGate.promise);

    const { bootstrapAllUTXOs } = await import('../UTXOWorkerService');
    const bootstrapPromise = bootstrapAllUTXOs();

    for (
      let i = 0;
      i < 20 && fetchAndStoreUTXOsManyMock.mock.calls.length === 0;
      i += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(fetchAndStoreUTXOsManyMock).toHaveBeenCalledTimes(1);

    getStateMock.mockReturnValue({
      wallet_id: { currentWalletId: 43, sessionGeneration: 2 },
      network: { currentNetwork: 'MAINNET' },
    });
    fetchGate.resolve({ 'bitcoincash:qaddr1': [] });
    await bootstrapPromise;

    expect(
      dispatchMock.mock.calls.some(
        ([action]) => action.type === replaceAllUTXOs.type
      )
    ).toBe(false);
    // Discarded bootstrap must not publish the new wallet's snapshot, but it
    // still owns the Syncing flag (no successor took over), so clear it —
    // otherwise Home stays on "Syncing…" forever after a mid-flight switch.
    expect(dispatchMock).toHaveBeenCalledWith(setFetchingUTXOs(false));
    expect(dispatchMock).not.toHaveBeenCalledWith(setInitialized(true));
    expect(scheduleDatabaseSaveMock).not.toHaveBeenCalled();
  });

  it('does not establish subscriptions after a pending start is cancelled', async () => {
    const fetchGate = deferred<Record<string, never[]>>();
    fetchAndStoreUTXOsManyMock.mockReturnValueOnce(fetchGate.promise);
    const { startUTXOWorker, stopUTXOWorker } = await import(
      '../UTXOWorkerService'
    );

    const startPromise = startUTXOWorker();
    for (
      let i = 0;
      i < 20 && fetchAndStoreUTXOsManyMock.mock.calls.length === 0;
      i += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(fetchAndStoreUTXOsManyMock).toHaveBeenCalledTimes(1);

    const stopPromise = stopUTXOWorker();
    fetchGate.resolve({ 'bitcoincash:qaddr1': [] });
    await Promise.all([startPromise, stopPromise]);

    expect(subscribeBlockHeadersMock).not.toHaveBeenCalled();
    expect(subscribeAddressMock).not.toHaveBeenCalled();
  });

  it('does not wait for optional special activity scans before completing startup', async () => {
    const specialActivityGate = deferred<never[]>();
    syncWalletSpecialActivitiesMock.mockReturnValueOnce(
      specialActivityGate.promise
    );
    fetchAndStoreUTXOsManyMock.mockResolvedValue({
      'bitcoincash:qaddr1': [],
    });

    const { startUTXOWorker } = await import('../UTXOWorkerService');
    let startCompleted = false;
    const startPromise = startUTXOWorker().then(() => {
      startCompleted = true;
    });

    for (
      let i = 0;
      i < 20 && syncWalletSpecialActivitiesMock.mock.calls.length === 0;
      i += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(syncWalletSpecialActivitiesMock).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 20 && !startCompleted; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(startCompleted).toBe(true);
    expect(subscribeBlockHeadersMock).toHaveBeenCalledTimes(1);

    specialActivityGate.resolve([]);
    await startPromise;
  });

  it('finishes old teardown before starting a replacement worker', async () => {
    fetchAndStoreUTXOsManyMock.mockResolvedValue({
      'bitcoincash:qaddr1': [],
    });
    const unsubscribeGate = deferred<void>();
    unsubscribeAddressMock.mockReturnValueOnce(unsubscribeGate.promise);
    const { startUTXOWorker, stopUTXOWorker } = await import(
      '../UTXOWorkerService'
    );

    await startUTXOWorker();
    expect(subscribeAddressesBulkMock).toHaveBeenCalledTimes(1);

    const stopPromise = stopUTXOWorker();
    getStateMock.mockReturnValue({
      wallet_id: { currentWalletId: 42, sessionGeneration: 2 },
      network: { currentNetwork: 'MAINNET' },
    });
    const restartPromise = startUTXOWorker();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(subscribeAddressesBulkMock).toHaveBeenCalledTimes(1);

    unsubscribeGate.resolve();
    await Promise.all([stopPromise, restartPromise]);

    expect(subscribeAddressesBulkMock).toHaveBeenCalledTimes(2);
    expect(unsubscribeAddressMock.mock.invocationCallOrder[0]).toBeLessThan(
      subscribeAddressesBulkMock.mock.invocationCallOrder[1]
    );
  });

  it('coalesces a block notification into one wallet-wide refresh', async () => {
    vi.useFakeTimers();
    try {
      let onBlock: ((header: unknown) => void) | undefined;
      subscribeBlockHeadersMock.mockImplementation(
        async (callback: (header: unknown) => void) => {
          onBlock = callback;
        }
      );
      retrieveKeysMock.mockResolvedValue([
        { address: 'bitcoincash:qaddr1' },
        { address: 'bitcoincash:qaddr2' },
        { address: 'bitcoincash:qaddr3' },
      ]);
      fetchAndStoreUTXOsManyMock.mockResolvedValue({
        'bitcoincash:qaddr1': [],
        'bitcoincash:qaddr2': [],
        'bitcoincash:qaddr3': [],
      });

      const { startUTXOWorker } = await import('../UTXOWorkerService');
      await startUTXOWorker();
      expect(onBlock).toBeTypeOf('function');

      onBlock?.({ height: 101 });
      onBlock?.({ height: 102 });
      onBlock?.({ height: 103 });
      await vi.advanceTimersByTimeAsync(300);

      expect(reconcileActiveWalletUtxosMock).toHaveBeenCalledTimes(1);
      expect(reconcileActiveWalletUtxosMock).toHaveBeenCalledWith(42);
    } finally {
      vi.useRealTimers();
    }
  });

  it('subscribes without a trailing wallet-wide catch-up (avoids right→wrong flip)', async () => {
    vi.useFakeTimers();
    try {
      subscribeBlockHeadersMock.mockImplementation(
        async (
          callback: (header: unknown) => void,
          options?: { emitCurrent?: boolean }
        ) => {
          if (options?.emitCurrent !== false) callback({ height: 100 });
        }
      );

      const { startUTXOWorker } = await import('../UTXOWorkerService');
      await startUTXOWorker();
      await vi.advanceTimersByTimeAsync(300);

      // Open force-listunspents HOT once; no trailing wallet-wide reconcile
      // after subscribe (that overwrote a good balance).
      expect(reconcileActiveWalletUtxosMock).not.toHaveBeenCalled();
      expect(subscribeBlockHeadersMock).toHaveBeenCalledWith(
        expect.any(Function),
        { emitCurrent: false }
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a queued wallet refresh after the active wallet session changes', async () => {
    vi.useFakeTimers();
    try {
      let onBlock: ((header: unknown) => void) | undefined;
      subscribeBlockHeadersMock.mockImplementation(
        async (callback: (header: unknown) => void) => {
          onBlock = callback;
        }
      );

      const { startUTXOWorker } = await import('../UTXOWorkerService');
      await startUTXOWorker();
      onBlock?.({ height: 101 });

      getStateMock.mockReturnValue({
        wallet_id: { currentWalletId: 43, sessionGeneration: 2 },
        network: { currentNetwork: 'MAINNET' },
      });
      await vi.advanceTimersByTimeAsync(300);

      expect(reconcileActiveWalletUtxosMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
