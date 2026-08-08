import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Network } from '../../../state/slices/networkSlice';
import WalletManager from '../WalletManager';
import DatabaseService from '../../DatabaseManager/DatabaseService';
import { WalletType } from '../../../types/wallet';
import SecretCryptoService from '../../../services/SecretCryptoService';

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

  it('reads wallet-open metadata without decrypting the mnemonic or passphrase', async () => {
    const metadataStmt = makeStmt([
      {
        id: 7,
        wallet_name: 'wallet7',
        networkType: Network.CHIPNET,
        walletType: WalletType.STANDARD,
        balance: 123,
        derivation_path: "m/44'/145'/0'",
        derivation_path_source: 'default',
      },
    ]);
    const db = { prepare: vi.fn(() => metadataStmt) };
    mockedDatabaseService.mockImplementation(
      () =>
        ({
          ensureDatabaseStarted: vi.fn(async () => {}),
          getDatabase: vi.fn(() => db),
        }) as never
    );

    const metadata = await WalletManager().getWalletMetadata(7);

    expect(metadata).toMatchObject({
      id: 7,
      wallet_name: 'wallet7',
      networkType: Network.CHIPNET,
      derivation_path: "m/44'/145'/0'",
    });
    expect(db.prepare).toHaveBeenCalledWith(expect.not.stringContaining('mnemonic'));
    expect(vi.mocked(SecretCryptoService).decryptText).not.toHaveBeenCalled();
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
      ensureDatabaseStarted: vi.fn(async () => {}),
      getDatabase: vi.fn(() => db),
      persistNewWalletToFile: vi.fn(async (walletId: number) => walletId),
    };

    mockedDatabaseService.mockImplementation(() => dbService as never);

    const wm = WalletManager();
    const created = await wm.createWallet('name', 'mnemonic', 'pass', Network.CHIPNET);

    expect(created).toBe(false);
    expect(insertStmt.run).not.toHaveBeenCalled();
    expect(dbService.persistNewWalletToFile).not.toHaveBeenCalled();
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
      exec: vi.fn(() => [{ values: [[7]] }]),
    };

    const dbService = {
      ensureDatabaseStarted: vi.fn(async () => {}),
      getDatabase: vi.fn(() => db),
      persistNewWalletToFile: vi.fn(async (walletId: number) => walletId),
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
      "m/44'/145'/0'",
      'default',
    ]);
    expect(dbService.persistNewWalletToFile).toHaveBeenCalledWith(7);
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
          ensureDatabaseStarted: vi.fn(async () => {}),
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

  it('setWalletId ignores wallets on a different network when lookup is provided', async () => {
    const selectStmt = makeStmt([
      {
        id: '21',
        mnemonic: 'enc:mnemonic',
        passphrase: 'enc:pass',
        networkType: Network.CHIPNET,
        walletType: WalletType.STANDARD,
      },
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
          ensureDatabaseStarted: vi.fn(async () => {}),
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
      exec: vi.fn(() => [{ values: [[8]] }]),
    };

    const dbService = {
      ensureDatabaseStarted: vi.fn(async () => {}),
      getDatabase: vi.fn(() => db),
      persistNewWalletToFile: vi.fn(async (walletId: number) => walletId),
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
      exec: vi.fn(() => [{ values: [[9]] }]),
    };

    const dbService = {
      ensureDatabaseStarted: vi.fn(async () => {}),
      getDatabase: vi.fn(() => db),
      persistNewWalletToFile: vi.fn(async (walletId: number) => walletId),
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
