import { beforeEach, describe, expect, it, vi } from 'vitest';

const ensureInitialAddressBatchesMock = vi.fn();
const getUTXOsManyMock = vi.fn();
const replaceWalletAddressUTXOsMock = vi.fn();
const fetchTokenAddressesMock = vi.fn();
const fetchTransactionHistoriesMock = vi.fn();
const fetchUTXOsFromDatabaseMock = vi.fn();
const flushDatabaseToFileMock = vi.fn();
const scheduleDatabaseSaveMock = vi.fn();

vi.mock('../WalletDiscoveryService', () => ({
  default: {
    ensureInitialAddressBatches: ensureInitialAddressBatchesMock,
  },
}));

vi.mock('../ElectrumService', () => ({
  default: {
    getUTXOsMany: getUTXOsManyMock,
  },
}));

vi.mock('../BcmrService', () => ({
  default: vi.fn(() => ({
    getSnapshot: vi.fn(async () => null),
  })),
}));

vi.mock('../../apis/TransactionManager/TransactionManager', () => ({
  default: vi.fn(() => ({
    fetchAndStoreTransactionHistories: fetchTransactionHistoriesMock,
  })),
}));

vi.mock('../../apis/UTXOManager/UTXOManager', () => ({
  default: vi.fn(async () => ({
    fetchUTXOsFromDatabase: fetchUTXOsFromDatabaseMock,
    replaceWalletAddressUTXOs: replaceWalletAddressUTXOsMock,
  })),
}));

vi.mock('../../apis/DatabaseManager/DatabaseService', () => ({
  default: vi.fn(() => ({
    flushDatabaseToFile: flushDatabaseToFileMock,
    scheduleDatabaseSave: scheduleDatabaseSaveMock,
  })),
}));

vi.mock('../../apis/AddressManager/AddressManager', () => ({
  default: vi.fn(() => ({
    fetchTokenAddresses: fetchTokenAddressesMock,
  })),
}));

vi.mock('../../state/store', () => ({
  store: {
    getState: vi.fn(() => ({
      network: { currentNetwork: 'mainnet' },
      wallet_id: { currentWalletId: 11 },
    })),
  },
}));

describe('UTXOService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureInitialAddressBatchesMock.mockResolvedValue(undefined);
    getUTXOsManyMock.mockResolvedValue({});
    fetchTransactionHistoriesMock.mockResolvedValue({});
    fetchTokenAddressesMock.mockResolvedValue({});
    fetchUTXOsFromDatabaseMock.mockResolvedValue({
      utxosMap: {},
      cashTokenUtxosMap: {},
    });
    flushDatabaseToFileMock.mockResolvedValue(undefined);
    scheduleDatabaseSaveMock.mockReset();
  });

  it('runs wallet discovery before Electrum-backed UTXO fetches', async () => {
    const { default: UTXOService } = await import('../UTXOService');

    await UTXOService.fetchAndStoreUTXOsMany(11, ['bitcoincash:q1']);

    expect(ensureInitialAddressBatchesMock).toHaveBeenCalledWith(
      11,
      'mainnet',
      expect.any(Function)
    );
    expect(flushDatabaseToFileMock).toHaveBeenCalledTimes(1);
  });

  it('preserves existing UTXOs when Electrum omits an address from a partial failure', async () => {
    fetchUTXOsFromDatabaseMock.mockResolvedValue({
      utxosMap: {
        'bitcoincash:q2': [
          {
            id: 'b'.repeat(64) + ':1',
            tx_hash: 'b'.repeat(64),
            tx_pos: 1,
            value: 2000,
            amount: 2000,
            address: 'bitcoincash:q2',
            height: 10,
            prefix: 'bitcoincash',
            token: null,
            wallet_id: 11,
          },
        ],
      },
      cashTokenUtxosMap: {
        'bitcoincash:q2': [
          {
            id: 'c'.repeat(64) + ':2',
            tx_hash: 'c'.repeat(64),
            tx_pos: 2,
            value: 1000,
            amount: 1000,
            address: 'bitcoincash:q2',
            height: 11,
            prefix: 'bitcoincash',
            token: { category: 'cat', amount: 7 },
            wallet_id: 11,
          },
        ],
      },
    });
    getUTXOsManyMock.mockResolvedValue({
      'bitcoincash:q1': [
        {
          tx_hash: 'a'.repeat(64),
          tx_pos: 0,
          value: 1500,
          height: 12,
        },
      ],
    });

    const { default: UTXOService } = await import('../UTXOService');

    await UTXOService.fetchAndStoreUTXOsMany(11, [
      'bitcoincash:q1',
      'bitcoincash:q2',
    ]);

    expect(replaceWalletAddressUTXOsMock).toHaveBeenCalledWith(11, {
      'bitcoincash:q1': [
        expect.objectContaining({
          tx_hash: 'a'.repeat(64),
          tx_pos: 0,
          value: 1500,
          prefix: 'bitcoincash',
          token: null,
        }),
      ],
      'bitcoincash:q2': expect.arrayContaining([
        expect.objectContaining({
          tx_hash: 'b'.repeat(64),
          tx_pos: 1,
          value: 2000,
          token: null,
        }),
        expect.objectContaining({
          tx_hash: 'c'.repeat(64),
          tx_pos: 2,
          value: 1000,
          token: { category: 'cat', amount: 7 },
        }),
      ]),
    });
    expect(flushDatabaseToFileMock).toHaveBeenCalledTimes(1);
  });
});
