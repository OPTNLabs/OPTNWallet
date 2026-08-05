import { beforeEach, describe, expect, it, vi } from 'vitest';

const retrieveKeysMock = vi.fn();
const fetchUTXOsFromDatabaseMock = vi.fn();
const listCoinLabelsMock = vi.fn();
const exportFusionDepthStateMock = vi.fn();
const getDatabaseMock = vi.fn();

vi.mock('../../../services/KeyService', () => ({
  default: { retrieveKeys: retrieveKeysMock },
}));

vi.mock('../../../apis/UTXOManager/UTXOManager', () => ({
  default: vi.fn(async () => ({
    fetchUTXOsFromDatabase: fetchUTXOsFromDatabaseMock,
  })),
}));

vi.mock('../../../apis/DatabaseManager/DatabaseService', () => ({
  default: () => ({
    ensureDatabaseStarted: vi.fn(async () => undefined),
    getDatabase: getDatabaseMock,
  }),
}));

vi.mock('../CoinLabelService', () => ({
  listCoinLabels: listCoinLabelsMock,
}));

vi.mock('../fusionCoinDepth', () => ({
  exportFusionDepthState: exportFusionDepthStateMock,
}));

vi.mock('../../../state/store', () => ({
  store: {
    getState: () => ({ network: { currentNetwork: 'MAINNET' } }),
  },
}));

describe('WalletColdExportService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    retrieveKeysMock.mockResolvedValue([
      { address: 'bitcoincash:q1', tokenAddress: null },
    ]);
    fetchUTXOsFromDatabaseMock.mockResolvedValue({
      utxosMap: {
        'bitcoincash:q1': [
          {
            address: 'bitcoincash:q1',
            tx_hash: 'aa'.repeat(32),
            tx_pos: 0,
            value: 1000,
            height: 1,
          },
        ],
      },
      cashTokenUtxosMap: {},
    });
    listCoinLabelsMock.mockResolvedValue([
      {
        kind: 'outpoint',
        refKey: `${'aa'.repeat(32)}:0`,
        label: 'test',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    exportFusionDepthStateMock.mockReturnValue({
      coinDepth: { [`${'aa'.repeat(32)}:0`]: { d: 2, at: 1 } },
      fusionTxids: ['bb'.repeat(32)],
    });
    getDatabaseMock.mockReturnValue({
      prepare: () => {
        let stepped = false;
        return {
          bind: () => {},
          step: () => {
            if (stepped) return false;
            stepped = true;
            return true;
          },
          getAsObject: () => ({
            tx_hash: 'cc'.repeat(32),
            height: 10,
            amount: 500,
          }),
          free: () => {},
        };
      },
    });
  });

  it('builds archive with public data and containsSecrets false', async () => {
    const { buildColdArchive, COLD_EXPORT_FORMAT } = await import(
      '../WalletColdExportService'
    );
    const archive = await buildColdArchive(5);
    expect(archive.format).toBe(COLD_EXPORT_FORMAT);
    expect(archive.containsSecrets).toBe(false);
    expect(archive.walletId).toBe(5);
    expect(archive.addresses).toHaveLength(1);
    expect(archive.utxos).toHaveLength(1);
    expect(archive.labels).toHaveLength(1);
    expect(archive.fusion.fusionTxids).toHaveLength(1);
    expect(archive.transactions).toHaveLength(1);
    expect(archive).not.toHaveProperty('mnemonic');
    expect(archive).not.toHaveProperty('seed');
    expect(archive).not.toHaveProperty('xprv');
    expect(archive).not.toHaveProperty('privateKey');
  });

  it('rejects invalid wallet id', async () => {
    const { buildColdArchive } = await import('../WalletColdExportService');
    await expect(buildColdArchive(0)).rejects.toThrow(/No active wallet/);
  });
});
