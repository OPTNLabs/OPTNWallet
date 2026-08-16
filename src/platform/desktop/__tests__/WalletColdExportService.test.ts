import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deriveKey,
  aesEncrypt,
  bytesToBase64,
  randomSalt,
} from '../WalletCrypto';

const retrieveKeysMock = vi.fn();
const fetchUTXOsFromDatabaseMock = vi.fn();
const listCoinLabelsMock = vi.fn();
const setCoinLabelMock = vi.fn();
const exportFusionDepthStateMock = vi.fn();
const importFusionDepthStateMock = vi.fn();
const getDatabaseMock = vi.fn();
let reduxNetwork = 'mainnet';

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
  setCoinLabel: setCoinLabelMock,
}));

vi.mock('../fusionCoinDepth', () => ({
  exportFusionDepthState: exportFusionDepthStateMock,
  importFusionDepthState: importFusionDepthStateMock,
}));

vi.mock('../../../state/store', () => ({
  store: {
    getState: () => ({ network: { currentNetwork: reduxNetwork } }),
  },
}));

describe('WalletColdExportService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reduxNetwork = 'mainnet';
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
    listCoinLabelsMock.mockResolvedValue([]);
    exportFusionDepthStateMock.mockReturnValue({
      coinDepth: {},
      fusionTxids: [],
    });
    importFusionDepthStateMock.mockReturnValue({ coins: 0, txids: 0 });
    getDatabaseMock.mockReturnValue({
      prepare: (sql: string) => {
        let stepped = false;
        return {
          bind: () => {},
          step: () => {
            if (stepped) return false;
            stepped = true;
            return true;
          },
          getAsObject: () => {
            if (sql.includes('kdf_salt')) {
              return { kdf_salt: bytesToBase64(randomSalt(16)) };
            }
            if (sql.includes('mnemonic')) {
              return { mnemonic: 'enc:v1:notused' };
            }
            if (sql.includes('networkType')) {
              return { networkType: 'mainnet' };
            }
            return {
              tx_hash: 'cc'.repeat(32),
              height: 10,
              amount: 500,
            };
          },
          free: () => {},
        };
      },
    });
  });

  it('builds plaintext archive with containsSecrets false', async () => {
    const { buildColdArchive, COLD_EXPORT_FORMAT } = await import(
      '../WalletColdExportService'
    );
    const archive = await buildColdArchive(5);
    expect(archive.format).toBe(COLD_EXPORT_FORMAT);
    expect(archive.containsSecrets).toBe(false);
    expect(archive.utxos).toHaveLength(1);
  });

  it('encrypts and decrypts with password + salt', async () => {
    const salt = randomSalt(16);
    const password = 'correct-horse';
    const key = await deriveKey(password, salt);
    const plain = JSON.stringify({
      format: 'optn-cold-archive-v1',
      exportedAt: '2026-01-01T00:00:00.000Z',
      walletId: 5,
      network: 'mainnet',
      containsSecrets: false,
      disclaimer: 'x',
      addresses: [{ address: 'bitcoincash:q1' }],
      utxos: [],
      transactions: [],
      labels: [{ kind: 'txid', refKey: 'aa', label: 'hi', updatedAt: 't' }],
      fusion: { coinDepth: {}, fusionTxids: [] },
    });
    const ciphertext = await aesEncrypt(key, plain);
    const file = {
      format: 'optn-cold-archive-enc-v1' as const,
      version: 1 as const,
      sourceWalletId: 5,
      kdfSalt: bytesToBase64(salt),
      ciphertext,
    };
    const { decryptColdArchive, parseEncryptedColdArchive } = await import(
      '../WalletColdExportService'
    );
    const parsed = parseEncryptedColdArchive(JSON.stringify(file));
    const archive = await decryptColdArchive(parsed, password);
    expect(archive.labels[0].label).toBe('hi');
    await expect(decryptColdArchive(parsed, 'wrong')).rejects.toThrow(
      /Wrong password/
    );
  });

  it('uses the wallet database network instead of Redux display state', async () => {
    reduxNetwork = 'chipnet';
    const { buildColdArchive } = await import('../WalletColdExportService');
    const archive = await buildColdArchive(5);
    expect(archive.network).toBe('mainnet');
  });

  it('rejects an encrypted archive whose outer and inner wallet identities differ', async () => {
    const salt = randomSalt(16);
    const key = await deriveKey('correct-horse', salt);
    const plain = JSON.stringify({
      format: 'optn-cold-archive-v1',
      exportedAt: '2026-01-01T00:00:00.000Z',
      walletId: 5,
      network: 'mainnet',
      containsSecrets: false,
      disclaimer: 'x',
      addresses: [{ address: 'bitcoincash:q1' }],
      utxos: [],
      transactions: [],
      labels: [],
      fusion: { coinDepth: {}, fusionTxids: [] },
    });
    const parsed = {
      format: 'optn-cold-archive-enc-v1' as const,
      version: 1 as const,
      sourceWalletId: 6,
      kdfSalt: bytesToBase64(salt),
      ciphertext: await aesEncrypt(key, plain),
    };
    const { decryptColdArchive } = await import('../WalletColdExportService');
    await expect(decryptColdArchive(parsed, 'correct-horse')).rejects.toThrow(
      /identity does not match/
    );
  });

  it('rejects plaintext cold archives on parse', async () => {
    const { parseEncryptedColdArchive } = await import(
      '../WalletColdExportService'
    );
    expect(() =>
      parseEncryptedColdArchive(
        JSON.stringify({ format: 'optn-cold-archive-v1', version: 1 })
      )
    ).toThrow(/unencrypted/);
  });

  it('importColdArchiveIntoWallet writes labels and fusion', async () => {
    const { importColdArchiveIntoWallet, COLD_EXPORT_FORMAT } = await import(
      '../WalletColdExportService'
    );
    const stats = await importColdArchiveIntoWallet(5, {
      format: COLD_EXPORT_FORMAT,
      exportedAt: 't',
      walletId: 5,
      network: 'mainnet',
      containsSecrets: false,
      disclaimer: '',
      addresses: [{ address: 'bitcoincash:q1' }],
      utxos: [],
      transactions: [],
      labels: [
        {
          kind: 'outpoint',
          refKey: 'aa:0',
          label: 'salary',
          updatedAt: 't',
        },
      ],
      fusion: { coinDepth: { 'aa:0': { d: 1, at: 1 } }, fusionTxids: [] },
    });
    expect(setCoinLabelMock).toHaveBeenCalled();
    expect(importFusionDepthStateMock).toHaveBeenCalled();
    expect(stats.labels).toBe(1);
  });

  it('rejects a cold archive from another network before importing metadata', async () => {
    const { importColdArchiveIntoWallet, COLD_EXPORT_FORMAT } = await import(
      '../WalletColdExportService'
    );
    await expect(
      importColdArchiveIntoWallet(5, {
        format: COLD_EXPORT_FORMAT,
        exportedAt: 't',
        walletId: 5,
        network: 'chipnet',
        containsSecrets: false,
        disclaimer: '',
        addresses: [{ address: 'bitcoincash:q1' }],
        utxos: [],
        transactions: [],
        labels: [],
        fusion: { coinDepth: {}, fusionTxids: [] },
      })
    ).rejects.toThrow(/network does not match/);
    expect(setCoinLabelMock).not.toHaveBeenCalled();
    expect(importFusionDepthStateMock).not.toHaveBeenCalled();
  });

  it('requires a non-empty address overlap before importing metadata', async () => {
    const { importColdArchiveIntoWallet, COLD_EXPORT_FORMAT } = await import(
      '../WalletColdExportService'
    );
    await expect(
      importColdArchiveIntoWallet(5, {
        format: COLD_EXPORT_FORMAT,
        exportedAt: 't',
        walletId: 5,
        network: 'mainnet',
        containsSecrets: false,
        disclaimer: '',
        addresses: [{ address: 'bitcoincash:qother' }],
        utxos: [],
        transactions: [],
        labels: [],
        fusion: { coinDepth: {}, fusionTxids: [] },
      })
    ).rejects.toThrow(/addresses do not match/);
    expect(setCoinLabelMock).not.toHaveBeenCalled();
    expect(importFusionDepthStateMock).not.toHaveBeenCalled();
  });

  it('rejects an archive with no addresses instead of bypassing identity checks', async () => {
    const { importColdArchiveIntoWallet, COLD_EXPORT_FORMAT } = await import(
      '../WalletColdExportService'
    );
    await expect(
      importColdArchiveIntoWallet(5, {
        format: COLD_EXPORT_FORMAT,
        exportedAt: 't',
        walletId: 5,
        network: 'mainnet',
        containsSecrets: false,
        disclaimer: '',
        addresses: [],
        utxos: [],
        transactions: [],
        labels: [],
        fusion: { coinDepth: {}, fusionTxids: [] },
      })
    ).rejects.toThrow(/no valid wallet addresses/);
    expect(setCoinLabelMock).not.toHaveBeenCalled();
    expect(importFusionDepthStateMock).not.toHaveBeenCalled();
  });

  it('rejects malformed fusion depth before writing labels', async () => {
    const { importColdArchiveIntoWallet, COLD_EXPORT_FORMAT } = await import(
      '../WalletColdExportService'
    );
    await expect(
      importColdArchiveIntoWallet(5, {
        format: COLD_EXPORT_FORMAT,
        exportedAt: 't',
        walletId: 5,
        network: 'mainnet',
        containsSecrets: false,
        disclaimer: '',
        addresses: [{ address: 'bitcoincash:q1' }],
        utxos: [],
        transactions: [],
        labels: [
          { kind: 'txid', refKey: 'aa', label: 'label', updatedAt: 't' },
        ],
        fusion: { coinDepth: { 'aa:0': { d: -1, at: 1 } }, fusionTxids: [] },
      })
    ).rejects.toThrow(/invalid metadata/);
    expect(setCoinLabelMock).not.toHaveBeenCalled();
    expect(importFusionDepthStateMock).not.toHaveBeenCalled();
  });
});
