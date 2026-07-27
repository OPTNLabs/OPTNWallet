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

const dispatchMock = vi.fn();
const getStateMock = vi.fn();
const retrieveKeysMock = vi.fn();
const fetchAndStoreUTXOsManyMock = vi.fn();
const fetchContractInstancesMock = vi.fn();
const updateContractUTXOsMock = vi.fn();
const listTrackedAddressesMock = vi.fn();
const scheduleDatabaseSaveMock = vi.fn();
const preloadTokenMetadataMock = vi.fn();
const reconnectMock = vi.fn();
const invalidateUTXOCacheMock = vi.fn();
const subscribeBlockHeadersMock = vi.fn();
const subscribeAddressMock = vi.fn();
const unsubscribeAddressMock = vi.fn();
const unsubscribeBlockHeadersMock = vi.fn();
const fetchAndStoreTransactionHistoriesMock = vi.fn();
const fetchAndStoreTransactionHistoryMock = vi.fn();
const reconcileActiveWalletUtxosMock = vi.fn();
const runWalletUtxoRefreshMock = vi.fn(async (_walletId: number, task: () => Promise<void>) =>
  task()
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
    fetchAndStoreUTXOs: vi.fn(),
  },
}));

vi.mock('../../services/ElectrumService', () => ({
  default: {
    reconnect: reconnectMock,
    subscribeBlockHeaders: subscribeBlockHeadersMock,
    subscribeAddress: subscribeAddressMock,
    unsubscribeAddress: unsubscribeAddressMock,
    unsubscribeBlockHeaders: unsubscribeBlockHeadersMock,
    getUTXOsMany: vi.fn(),
    getUTXOs: vi.fn(),
  },
  invalidateUTXOCache: invalidateUTXOCacheMock,
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
  });

  afterEach(async () => {
    const { stopUTXOWorker } = await import('../UTXOWorkerService');
    await stopUTXOWorker();
  });

  it('preloads BCMR metadata before completing the bootstrap and persists the db snapshot', async () => {
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
    const bootstrapPromise = bootstrapAllUTXOs();

    for (let i = 0; i < 20 && preloadTokenMetadataMock.mock.calls.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(preloadTokenMetadataMock).toHaveBeenCalledTimes(1);
    expect(preloadTokenMetadataMock).toHaveBeenCalledWith(['cat1', 'cat2']);
    expect(scheduleDatabaseSaveMock).not.toHaveBeenCalled();

    gate.resolve();
    await bootstrapPromise;

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
    expect(
      invalidateUTXOCacheMock.mock.invocationCallOrder[0]
    ).toBeLessThan(fetchAndStoreUTXOsManyMock.mock.invocationCallOrder[0]);
    expect(
      invalidateUTXOCacheMock.mock.invocationCallOrder[1]
    ).toBeLessThan(fetchAndStoreUTXOsManyMock.mock.invocationCallOrder[0]);
    expect(fetchAndStoreUTXOsManyMock).toHaveBeenCalledTimes(1);
    expect(fetchAndStoreUTXOsManyMock).toHaveBeenCalledWith(42, [
      'bitcoincash:qaddr1',
      'bchtest:qtracked',
    ]);
  });

  it('discards a completed bootstrap when another wallet became active', async () => {
    const fetchGate = deferred<Record<string, never[]>>();
    fetchAndStoreUTXOsManyMock.mockReturnValueOnce(fetchGate.promise);

    const { bootstrapAllUTXOs } = await import('../UTXOWorkerService');
    const bootstrapPromise = bootstrapAllUTXOs();

    for (let i = 0; i < 20 && fetchAndStoreUTXOsManyMock.mock.calls.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(fetchAndStoreUTXOsManyMock).toHaveBeenCalledTimes(1);

    getStateMock.mockReturnValue({
      wallet_id: { currentWalletId: 43, sessionGeneration: 2 },
      network: { currentNetwork: 'MAINNET' },
    });
    fetchGate.resolve({ 'bitcoincash:qaddr1': [] });
    await bootstrapPromise;

    expect(dispatchMock.mock.calls.some(([action]) => action.type === replaceAllUTXOs.type)).toBe(
      false
    );
    expect(dispatchMock).not.toHaveBeenCalledWith(setFetchingUTXOs(false));
    expect(dispatchMock).not.toHaveBeenCalledWith(setInitialized(true));
    expect(scheduleDatabaseSaveMock).not.toHaveBeenCalled();
  });

  it('does not establish subscriptions after a pending start is cancelled', async () => {
    const fetchGate = deferred<Record<string, never[]>>();
    fetchAndStoreUTXOsManyMock.mockReturnValueOnce(fetchGate.promise);
    const { startUTXOWorker, stopUTXOWorker } = await import('../UTXOWorkerService');

    const startPromise = startUTXOWorker();
    for (let i = 0; i < 20 && fetchAndStoreUTXOsManyMock.mock.calls.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(fetchAndStoreUTXOsManyMock).toHaveBeenCalledTimes(1);

    const stopPromise = stopUTXOWorker();
    fetchGate.resolve({ 'bitcoincash:qaddr1': [] });
    await Promise.all([startPromise, stopPromise]);

    expect(subscribeBlockHeadersMock).not.toHaveBeenCalled();
    expect(subscribeAddressMock).not.toHaveBeenCalled();
  });

  it('finishes old teardown before starting a replacement worker', async () => {
    fetchAndStoreUTXOsManyMock.mockResolvedValue({
      'bitcoincash:qaddr1': [],
    });
    const unsubscribeGate = deferred<void>();
    unsubscribeAddressMock.mockReturnValueOnce(unsubscribeGate.promise);
    const { startUTXOWorker, stopUTXOWorker } = await import('../UTXOWorkerService');

    await startUTXOWorker();
    expect(subscribeAddressMock).toHaveBeenCalledTimes(1);

    const stopPromise = stopUTXOWorker();
    getStateMock.mockReturnValue({
      wallet_id: { currentWalletId: 42, sessionGeneration: 2 },
      network: { currentNetwork: 'MAINNET' },
    });
    const restartPromise = startUTXOWorker();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(subscribeAddressMock).toHaveBeenCalledTimes(1);

    unsubscribeGate.resolve();
    await Promise.all([stopPromise, restartPromise]);

    expect(subscribeAddressMock).toHaveBeenCalledTimes(2);
    expect(unsubscribeAddressMock.mock.invocationCallOrder[0]).toBeLessThan(
      subscribeAddressMock.mock.invocationCallOrder[1]
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

  it('runs one post-subscription catch-up without replaying the current tip', async () => {
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

      expect(reconcileActiveWalletUtxosMock).toHaveBeenCalledTimes(1);
      expect(reconcileActiveWalletUtxosMock).toHaveBeenCalledWith(42);
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
