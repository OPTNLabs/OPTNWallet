import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getStateMock = vi.fn();
const retrieveKeysMock = vi.fn();
const listTrackedAddressesMock = vi.fn();
const fetchHistoriesMock = vi.fn();
const getTransactionDetailsMock = vi.fn();
const requestWalletUTXORefreshMock = vi.fn();

vi.mock('../../state/store', () => ({
  store: {
    getState: getStateMock,
    dispatch: vi.fn(),
  },
}));

vi.mock('../../services/KeyService', () => ({
  default: {
    retrieveKeys: retrieveKeysMock,
  },
}));

vi.mock('../../services/QuantumrootTrackingService', () => ({
  default: {
    listTrackedAddresses: listTrackedAddressesMock,
  },
}));

vi.mock('../../apis/TransactionManager/TransactionManager', () => ({
  default: vi.fn(() => ({
    fetchAndStoreTransactionHistories: fetchHistoriesMock,
  })),
}));

vi.mock('../../services/ElectrumService', () => ({
  default: {
    getTransactionDetails: getTransactionDetailsMock,
  },
}));

vi.mock('../UTXOWorkerService', () => ({
  requestWalletUTXORefresh: requestWalletUTXORefreshMock,
}));

describe('TransactionWorkerService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getStateMock.mockReturnValue({
      wallet_id: { currentWalletId: 42 },
      utxos: { initialized: false },
      transactions: { transactions: { 42: [] } },
    });
    retrieveKeysMock.mockResolvedValue([
      { address: 'bitcoincash:qaddr1' },
      { address: 'bitcoincash:qaddr2' },
      { address: 'bitcoincash:qaddr3' },
    ]);
    listTrackedAddressesMock.mockResolvedValue([]);
    fetchHistoriesMock.mockResolvedValue({
      'bitcoincash:qaddr1': [],
      'bitcoincash:qaddr2': [],
      'bitcoincash:qaddr3': [],
    });
    getTransactionDetailsMock.mockResolvedValue(null);
  });

  afterEach(async () => {
    const { stopTransactionWorker } = await import(
      '../TransactionWorkerService'
    );
    stopTransactionWorker();
  });

  it('requests one wallet-wide UTXO refresh after a batched history poll', async () => {
    const { startTransactionWorker } = await import(
      '../TransactionWorkerService'
    );

    startTransactionWorker();

    await vi.waitFor(() => {
      expect(fetchHistoriesMock).toHaveBeenCalledTimes(1);
      expect(requestWalletUTXORefreshMock).toHaveBeenCalledTimes(1);
    });
  });
});
