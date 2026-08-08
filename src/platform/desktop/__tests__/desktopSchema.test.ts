import { beforeEach, describe, expect, it, vi } from 'vitest';

const { ensureDatabaseStarted, getDatabase, logError } = vi.hoisted(() => ({
  ensureDatabaseStarted: vi.fn(async () => {}),
  getDatabase: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('../../../apis/DatabaseManager/DatabaseService', () => ({
  default: () => ({ ensureDatabaseStarted, getDatabase }),
}));

vi.mock('../../../utils/errorHandling', () => ({ logError }));

import {
  ensureDesktopWalletColumns,
  resetDesktopWalletColumnsCache,
} from '../desktopSchema';

describe('ensureDesktopWalletColumns', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDesktopWalletColumnsCache();
  });

  it('treats a concurrent duplicate-column result as a successful migration', async () => {
    const tableInfo = {
      step: vi.fn(() => false),
      getAsObject: vi.fn(),
      free: vi.fn(),
    };
    const run = vi.fn((sql: string) => {
      if (sql.includes('master_fingerprint')) {
        throw new Error('duplicate column name: master_fingerprint');
      }
    });
    getDatabase.mockReturnValue({ prepare: vi.fn(() => tableInfo), run });

    await expect(ensureDesktopWalletColumns()).resolves.toBeUndefined();

    expect(run).toHaveBeenCalledTimes(4);
    expect(logError).not.toHaveBeenCalled();

    await ensureDesktopWalletColumns();
    expect(run).toHaveBeenCalledTimes(4);
  });
});
