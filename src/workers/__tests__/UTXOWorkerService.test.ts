import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setInitialized, setFetchingUTXOs, setUTXOs } from '../../state/slices/utxoSlice';

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
const subscribeBlockHeadersMock = vi.fn();
const subscribeAddressMock = vi.fn();
const unsubscribeAddressMock = vi.fn();
const unsubscribeBlockHeadersMock = vi.fn();
const fetchAndStoreTransactionHistoriesMock = vi.fn();
const fetchAndStoreTransactionHistoryMock = vi.fn();
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
  invalidateUTXOCache: vi.fn(),
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
      wallet_id: { currentWalletId: 42 },
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

    expect(dispatchMock.mock.calls.some(([action]) => action.type === setUTXOs.type)).toBe(true);
    expect(scheduleDatabaseSaveMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock).toHaveBeenCalledWith(setFetchingUTXOs(false));
    expect(dispatchMock).toHaveBeenCalledWith(setInitialized(true));
  });
});
