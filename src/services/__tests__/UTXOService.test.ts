import { beforeEach, describe, expect, it, vi } from 'vitest';

const ensureInitialAddressBatchesMock = vi.fn();
const getUTXOsManyMock = vi.fn();
const replaceWalletAddressUTXOsMock = vi.fn();
const fetchTokenAddressesMock = vi.fn();
const fetchAddressesByWalletIdMock = vi.fn();
const fetchTransactionHistoriesMock = vi.fn();
const fetchUTXOsFromDatabaseMock = vi.fn();
const flushDatabaseToFileMock = vi.fn();
const scheduleDatabaseSaveMock = vi.fn();
const listActiveMock = vi.fn();
const cashAddressToLockingBytecodeMock = vi.fn();
const decodeTransactionMock = vi.fn();

vi.mock('../WalletDiscoveryService', () => ({
  default: {
    ensureInitialAddressBatches: ensureInitialAddressBatchesMock,
  },
}));

vi.mock('../OutboundTransactionTracker', () => ({
  default: {
    listActive: listActiveMock,
  },
}));

vi.mock('@bitauth/libauth', () => ({
  cashAddressToLockingBytecode: cashAddressToLockingBytecodeMock,
  decodeTransaction: decodeTransactionMock,
  hexToBin: vi.fn((hex: string) => {
    const bytes = new Uint8Array(Math.ceil(hex.length / 2));
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2) || '00', 16);
    }
    return bytes;
  }),
  binToUtf8: vi.fn(() => ''),
  secp256k1: {
    derivePublicKeyCompressed: vi.fn(() => new Uint8Array([])),
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
    fetchAddressesByWalletId: fetchAddressesByWalletIdMock,
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
    fetchAddressesByWalletIdMock.mockResolvedValue([]);
    flushDatabaseToFileMock.mockResolvedValue(undefined);
    scheduleDatabaseSaveMock.mockReset();
    listActiveMock.mockResolvedValue([]);
    cashAddressToLockingBytecodeMock.mockImplementation((address: string) => {
      if (address === 'bitcoincash:q1') {
        return { bytecode: new Uint8Array([0x51]) };
      }
      return 'invalid address';
    });
    decodeTransactionMock.mockReturnValue({
      outputs: [],
    });
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

  it('keeps known token payloads when a refresh returns the same outpoint without token data', async () => {
    fetchUTXOsFromDatabaseMock.mockResolvedValue({
      utxosMap: {},
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
            token: {
              category: 'cat',
              amount: 7,
              BcmrTokenMetadata: {
                name: 'Cat',
                description: 'Known token',
                token: {
                  category: 'cat',
                  decimals: 0,
                  symbol: 'CAT',
                },
                is_nft: false,
                uris: {},
                extensions: {},
              },
            },
            wallet_id: 11,
          },
        ],
      },
    });
    getUTXOsManyMock.mockResolvedValue({
      'bitcoincash:q2': [
        {
          tx_hash: 'c'.repeat(64),
          tx_pos: 2,
          value: 1000,
          height: 11,
        },
      ],
    });

    const { default: UTXOService } = await import('../UTXOService');

    const result = await UTXOService.fetchAndStoreUTXOsMany(11, [
      'bitcoincash:q2',
    ]);

    expect(replaceWalletAddressUTXOsMock).toHaveBeenCalledWith(11, {
      'bitcoincash:q2': [
        expect.objectContaining({
          tx_hash: 'c'.repeat(64),
          tx_pos: 2,
          value: 1000,
          token: expect.objectContaining({
            category: 'cat',
            amount: 7,
            BcmrTokenMetadata: expect.objectContaining({
              name: 'Cat',
            }),
          }),
        }),
      ],
    });
    expect(result['bitcoincash:q2'][0].token).toEqual(
      expect.objectContaining({
        category: 'cat',
        amount: 7,
        BcmrTokenMetadata: expect.objectContaining({
          name: 'Cat',
        }),
      })
    );
  });

  it('includes pending outbound token outputs for wallet-owned addresses', async () => {
    fetchAddressesByWalletIdMock.mockResolvedValue([
      { address: 'bitcoincash:q1' },
    ]);
    fetchUTXOsFromDatabaseMock.mockResolvedValue({
      utxosMap: {
        'bitcoincash:q1': [
          {
            id: 'pendingtx:0',
            tx_hash: 'pendingtx',
            tx_pos: 0,
            value: 1000,
            amount: 1000,
            address: 'bitcoincash:q1',
            height: 0,
            prefix: 'bitcoincash',
            token: null,
            wallet_id: 11,
          },
        ],
      },
      cashTokenUtxosMap: {},
    });
    listActiveMock.mockResolvedValue([
      {
        txid: 'pendingtx',
        rawTx: 'feedface',
        walletId: 11,
        source: 'wallet',
        state: 'broadcasting',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        spentOutpoints: [],
      },
    ]);
    decodeTransactionMock.mockReturnValue({
      outputs: [
        {
          lockingBytecode: new Uint8Array([0x51]),
          valueSatoshis: 1000n,
          token: {
            amount: 1n,
            category: new Uint8Array([0xaa, 0xbb, 0xcc]),
            nft: {
              capability: 'mutable',
              commitment: new Uint8Array([0xde, 0xad]),
            },
          },
        },
      ],
    });

    const { default: UTXOService } = await import('../UTXOService');

    const result = await UTXOService.fetchAllWalletUtxos(11);

    expect(result.tokenUtxos).toHaveLength(1);
    expect(result.tokenUtxos[0]).toEqual(
      expect.objectContaining({
        tx_hash: 'pendingtx',
        tx_pos: 0,
        address: 'bitcoincash:q1',
        prefix: 'bitcoincash',
        wallet_id: 11,
        token: expect.objectContaining({
          category: 'aabbcc',
          amount: 1n,
          nft: {
            capability: 'mutable',
            commitment: 'dead',
          },
        }),
      })
    );
    expect(result.allUtxos).toEqual([]);
    expect(decodeTransactionMock).toHaveBeenCalledWith(expect.any(Uint8Array));
  });
});
