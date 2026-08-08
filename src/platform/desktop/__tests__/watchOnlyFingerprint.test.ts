import { beforeEach, describe, expect, it, vi } from 'vitest';

import DatabaseService from '../../../apis/DatabaseManager/DatabaseService';
import {
  normalizeMasterFingerprint,
  saveWatchOnlyMasterFingerprint,
  watchOnlyMasterFingerprint,
} from '../onboarding/watchOnlyWallet';

vi.mock('../../../apis/DatabaseManager/DatabaseService', () => ({
  default: vi.fn(),
}));

describe('watch-only master fingerprint persistence', () => {
  const mockedDatabaseService = vi.mocked(DatabaseService);

  const makeStatement = (overrides: Record<string, unknown> = {}) =>
    ({
      run: vi.fn(),
      bind: vi.fn(),
      step: vi.fn(() => false),
      getAsObject: vi.fn(() => ({})),
      free: vi.fn(),
      ...overrides,
    }) as never;

  beforeEach(() => {
    vi.clearAllMocks();
    mockedDatabaseService.mockReturnValue({
      ensureDatabaseStarted: vi.fn(async () => {}),
      getDatabase: vi.fn(() => ({})),
      flushDatabaseToFile: vi.fn(async () => {}),
    } as never);
  });

  it('normalizes a fingerprint to 8 lowercase hex chars', () => {
    expect(normalizeMasterFingerprint('DEADbeef')).toBe('deadbeef');
    expect(normalizeMasterFingerprint(' 4C9A1F7B ')).toBe('4c9a1f7b');
  });

  it('rejects malformed fingerprints with a user-facing message', () => {
    for (const bad of ['1234567', '123456789', 'zzzzzzzz', '12 34 56 78']) {
      expect(() => normalizeMasterFingerprint(bad)).toThrow(/fingerprint/i);
    }
  });

  it('writes the fingerprint only for watch-only wallets', async () => {
    const run = vi.fn();
    const statement = makeStatement({ run });
    const db = { prepare: vi.fn(() => statement) };
    mockedDatabaseService().getDatabase = vi.fn(() => db);

    await saveWatchOnlyMasterFingerprint(9, '4C9A1F7B');

    expect(db.prepare).toHaveBeenCalledWith(
      'UPDATE wallets SET master_fingerprint = ? WHERE id = ? AND walletType = ?'
    );
    expect(run).toHaveBeenCalledWith(['4c9a1f7b', 9, 'watch-only']);
    expect(statement.free).toHaveBeenCalled();
    expect(mockedDatabaseService().flushDatabaseToFile).toHaveBeenCalledWith(9);
  });

  it('rejects saving a malformed fingerprint without touching the database', async () => {
    await expect(
      saveWatchOnlyMasterFingerprint(9, 'not-hex')
    ).rejects.toThrow(/fingerprint/i);
    expect(mockedDatabaseService().getDatabase).not.toHaveBeenCalled();
  });

  it('reports null when no fingerprint is stored', async () => {
    const statement = makeStatement();
    mockedDatabaseService().getDatabase = vi.fn(() => ({
      prepare: vi.fn(() => statement),
    })) as never;

    const value = await watchOnlyMasterFingerprint(9);

    expect(value).toBeNull();
    expect(statement.bind).toHaveBeenCalledWith([9, 'watch-only']);
    expect(statement.free).toHaveBeenCalled();
  });

  it('returns the stored fingerprint', async () => {
    const statement = makeStatement({
      step: vi.fn(() => true),
      getAsObject: vi.fn(() => ({ master_fingerprint: '4c9a1f7b' })),
    });
    mockedDatabaseService().getDatabase = vi.fn(() => ({
      prepare: vi.fn(() => statement),
    })) as never;

    const value = await watchOnlyMasterFingerprint(9);

    expect(value).toBe('4c9a1f7b');
  });
});
