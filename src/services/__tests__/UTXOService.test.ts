import { beforeEach, describe, expect, it, vi } from 'vitest';

const ensureInitialAddressBatchesMock = vi.fn();
const getUTXOsManyMock = vi.fn();
const replaceWalletAddressUTXOsMock = vi.fn();
const fetchTokenAddressesMock = vi.fn();
const fetchTransactionHistoriesMock = vi.fn();

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
    replaceWalletAddressUTXOs: replaceWalletAddressUTXOsMock,
  })),
}));

vi.mock('../../apis/AddressManager/AddressManager', () => ({
  default: vi.fn(() => ({
    fetchTokenAddresses: fetchTokenAddressesMock,
  })),
}));

vi.mock('../../redux/store', () => ({
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
  });

  it('runs wallet discovery before Electrum-backed UTXO fetches', async () => {
    const { default: UTXOService } = await import('../UTXOService');

    await UTXOService.fetchAndStoreUTXOsMany(11, ['bitcoincash:q1']);

    expect(ensureInitialAddressBatchesMock).toHaveBeenCalledWith(
      11,
      'mainnet',
      expect.any(Function)
    );
  });
});
