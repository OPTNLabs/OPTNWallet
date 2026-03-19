import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Network } from '../../../redux/networkSlice';
import WalletManager from '../WalletManager';
import DatabaseService from '../../DatabaseManager/DatabaseService';
import { WalletType } from '../../../types/wallet';

vi.mock('../../DatabaseManager/DatabaseService', () => ({
  default: vi.fn(),
}));

vi.mock('../../../utils/schema/schema', () => ({
  createTables: vi.fn(),
}));

vi.mock('../../../services/SecretCryptoService', () => ({
  default: {
    encryptText: vi.fn(async (v: string) => `enc:${v}`),
    decryptText: vi.fn(async (v: string) =>
      typeof v === 'string' && v.startsWith('enc:') ? v.slice(4) : v
    ),
  },
}));

type MockStmt = {
  bind: ReturnType<typeof vi.fn>;
  step: ReturnType<typeof vi.fn>;
  getAsObject: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
  free: ReturnType<typeof vi.fn>;
};

function makeStmt(rows: Array<Record<string, unknown>> = []): MockStmt {
  let idx = 0;
  return {
    bind: vi.fn(),
    step: vi.fn(() => idx < rows.length),
    getAsObject: vi.fn(() => rows[idx++]),
    run: vi.fn(),
    free: vi.fn(),
  };
}

describe('WalletManager', () => {
  const mockedDatabaseService = vi.mocked(DatabaseService);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('createWallet returns false if wallet already exists', async () => {
    const existsStmt = makeStmt([
      {
        mnemonic: 'enc:mnemonic',
        passphrase: 'enc:pass',
        networkType: Network.CHIPNET,
        walletType: WalletType.STANDARD,
      },
    ]);
    const insertStmt = makeStmt();

    const db = {
      prepare: vi
        .fn()
        .mockReturnValueOnce(existsStmt)
        .mockReturnValueOnce(insertStmt),
    };

    const dbService = {
      getDatabase: vi.fn(() => db),
      flushDatabaseToFile: vi.fn(async () => {}),
    };

    mockedDatabaseService.mockImplementation(() => dbService as never);

    const wm = WalletManager();
    const created = await wm.createWallet('name', 'mnemonic', 'pass', Network.CHIPNET);

    expect(created).toBe(false);
    expect(insertStmt.run).not.toHaveBeenCalled();
    expect(dbService.flushDatabaseToFile).not.toHaveBeenCalled();
  });

  it('createWallet inserts and persists when wallet does not exist', async () => {
    const existsStmt = makeStmt([
      {
        mnemonic: 'enc:other',
        passphrase: 'enc:other-pass',
        networkType: Network.CHIPNET,
        walletType: WalletType.STANDARD,
      },
    ]);
    const insertStmt = makeStmt();

    const db = {
      prepare: vi
        .fn()
        .mockReturnValueOnce(existsStmt)
        .mockReturnValueOnce(insertStmt),
    };

    const dbService = {
      getDatabase: vi.fn(() => db),
      flushDatabaseToFile: vi.fn(async () => {}),
    };

    mockedDatabaseService.mockImplementation(() => dbService as never);

    const wm = WalletManager();
    const created = await wm.createWallet('name', 'mnemonic', 'pass', Network.MAINNET);

    expect(created).toBe(true);
    expect(insertStmt.run).toHaveBeenCalledWith([
      'name',
      'enc:mnemonic',
      'enc:pass',
      Network.MAINNET,
      WalletType.STANDARD,
      0,
    ]);
    expect(dbService.flushDatabaseToFile).toHaveBeenCalledTimes(1);
  });

  it('setWalletId resolves wallet id as number', async () => {
    const selectStmt = makeStmt([
      {
        id: '42',
        mnemonic: 'enc:mnemonic',
        passphrase: 'enc:pass',
        networkType: Network.MAINNET,
        walletType: WalletType.STANDARD,
      },
    ]);
    const db = {
      prepare: vi.fn(() => selectStmt),
    };

    mockedDatabaseService.mockImplementation(
      () =>
        ({
          getDatabase: vi.fn(() => db),
        }) as never
    );

    const wm = WalletManager();
    const walletId = await wm.setWalletId('mnemonic', 'pass', {
      networkType: Network.MAINNET,
      walletType: WalletType.STANDARD,
    });

    expect(walletId).toBe(42);
  });

  it('allows the same mnemonic on a different network', async () => {
    const existsStmt = makeStmt([
      {
        mnemonic: 'enc:mnemonic',
        passphrase: 'enc:pass',
        networkType: Network.CHIPNET,
        walletType: WalletType.STANDARD,
      },
    ]);
    const insertStmt = makeStmt();

    const db = {
      prepare: vi
        .fn()
        .mockReturnValueOnce(existsStmt)
        .mockReturnValueOnce(insertStmt),
    };

    const dbService = {
      getDatabase: vi.fn(() => db),
      flushDatabaseToFile: vi.fn(async () => {}),
    };

    mockedDatabaseService.mockImplementation(() => dbService as never);

    const wm = WalletManager();
    const created = await wm.createWallet(
      'name',
      'mnemonic',
      'pass',
      Network.MAINNET
    );

    expect(created).toBe(true);
    expect(insertStmt.run).toHaveBeenCalledTimes(1);
  });

  it('allows the same mnemonic and network for a different wallet type', async () => {
    const existsStmt = makeStmt([
      {
        mnemonic: 'enc:mnemonic',
        passphrase: 'enc:pass',
        networkType: Network.MAINNET,
        walletType: WalletType.STANDARD,
      },
    ]);
    const insertStmt = makeStmt();

    const db = {
      prepare: vi
        .fn()
        .mockReturnValueOnce(existsStmt)
        .mockReturnValueOnce(insertStmt),
    };

    const dbService = {
      getDatabase: vi.fn(() => db),
      flushDatabaseToFile: vi.fn(async () => {}),
    };

    mockedDatabaseService.mockImplementation(() => dbService as never);

    const wm = WalletManager();
    const created = await wm.createWallet(
      'name',
      'mnemonic',
      'pass',
      Network.MAINNET,
      WalletType.QUANTUMROOT
    );

    expect(created).toBe(true);
    expect(insertStmt.run).toHaveBeenCalledTimes(1);
  });
});
