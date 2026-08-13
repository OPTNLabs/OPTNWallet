import { beforeEach, describe, expect, it, vi } from 'vitest';

import AddressManager from '../AddressManager';
import DatabaseService from '../../DatabaseManager/DatabaseService';

vi.mock('../../DatabaseManager/DatabaseService', () => ({
  default: vi.fn(),
}));

describe('AddressManager', () => {
  const mockedDatabaseService = vi.mocked(DatabaseService);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registerAddress inserts address row when DB is available', async () => {
    const stmt = {
      run: vi.fn(),
      free: vi.fn(),
    };
    const db = {
      prepare: vi.fn(() => stmt),
    };

    mockedDatabaseService.mockReturnValue({
      ensureDatabaseStarted: vi.fn(async () => {}),
      getDatabase: vi.fn(() => db),
    } as never);

    const mgr = AddressManager();
    await mgr.registerAddress({
      wallet_id: 3,
      address: 'bitcoincash:qaddr',
      balance: 0,
      hd_index: 5,
      change_index: 0,
      prefix: 'bitcoincash',
    });

    expect(stmt.run).toHaveBeenCalledWith([
      3,
      'bitcoincash:qaddr',
      0,
      5,
      0,
      'bitcoincash',
    ]);
    expect(stmt.free).toHaveBeenCalledTimes(1);
  });

  it('fetchTokenAddress returns token address when found', async () => {
    const stmt = {
      getAsObject: vi.fn(() => ({ token_address: 'simpleledger:qtoken' })),
      free: vi.fn(),
    };
    const db = {
      prepare: vi.fn(() => stmt),
    };

    mockedDatabaseService.mockReturnValue({
      ensureDatabaseStarted: vi.fn(async () => {}),
      getDatabase: vi.fn(() => db),
    } as never);

    const mgr = AddressManager();
    await expect(mgr.fetchTokenAddress(3, 'bitcoincash:qaddr')).resolves.toBe(
      'simpleledger:qtoken'
    );
  });

  it('fetchTokenAddress returns null when DB is unavailable', async () => {
    mockedDatabaseService.mockReturnValue({
      ensureDatabaseStarted: vi.fn(async () => {}),
      getDatabase: vi.fn(() => null),
    } as never);

    const mgr = AddressManager();
    await expect(mgr.fetchTokenAddress(3, 'bitcoincash:qaddr')).resolves.toBeNull();
  });
});
