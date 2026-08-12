import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Network } from '../../../redux/networkSlice';
import WalletManager from '../WalletManager';
import DatabaseService from '../../DatabaseManager/DatabaseService';

vi.mock('../../DatabaseManager/DatabaseService', () => ({
  default: vi.fn(),
}));

vi.mock('../../../utils/schema/schema', () => ({
  createTables: vi.fn(),
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
    const existsStmt = makeStmt([{ count: 1 }]);
    const insertStmt = makeStmt();

    const db = {
      prepare: vi
        .fn()
        .mockReturnValueOnce(existsStmt)
        .mockReturnValueOnce(insertStmt),
    };

    const dbService = {
      getDatabase: vi.fn(() => db),
      saveDatabaseToFile: vi.fn(async () => {}),
    };

    mockedDatabaseService.mockReturnValue(dbService as never);

    const wm = WalletManager();
    const created = await wm.createWallet('name', 'mnemonic', 'pass', Network.CHIPNET);

    expect(created).toBe(false);
    expect(insertStmt.run).not.toHaveBeenCalled();
    expect(dbService.saveDatabaseToFile).not.toHaveBeenCalled();
  });

  it('createWallet inserts and persists when wallet does not exist', async () => {
    const existsStmt = makeStmt([{ count: 0 }]);
    const insertStmt = makeStmt();

    const db = {
      prepare: vi
        .fn()
        .mockReturnValueOnce(existsStmt)
        .mockReturnValueOnce(insertStmt),
    };

    const dbService = {
      getDatabase: vi.fn(() => db),
      saveDatabaseToFile: vi.fn(async () => {}),
    };

    mockedDatabaseService.mockReturnValue(dbService as never);

    const wm = WalletManager();
    const created = await wm.createWallet('name', 'mnemonic', 'pass', Network.MAINNET);

    expect(created).toBe(true);
    expect(insertStmt.run).toHaveBeenCalledWith([
      'name',
      'mnemonic',
      'pass',
      Network.MAINNET,
      0,
    ]);
    expect(dbService.saveDatabaseToFile).toHaveBeenCalledTimes(1);
  });

  it('setWalletId resolves wallet id as number', async () => {
    const selectStmt = makeStmt([{ id: '42' }]);
    const db = {
      prepare: vi.fn(() => selectStmt),
    };

    mockedDatabaseService.mockReturnValue({
      getDatabase: vi.fn(() => db),
    } as never);

    const wm = WalletManager();
    const walletId = await wm.setWalletId('mnemonic', 'pass');

    expect(walletId).toBe(42);
  });
});
