import { beforeEach, describe, expect, it, vi } from 'vitest';

import DatabaseService from '../../../apis/DatabaseManager/DatabaseService';
import QuantumrootVaultCacheService from '../../../services/QuantumrootVaultCacheService';
import KeyService from '../../../services/KeyService';
import { Network } from '../../../state/slices/networkSlice';
import { log } from '../logger';
import {
  purgeCrossNetworkData,
  switchWalletNetwork,
} from '../DesktopWalletManager';

vi.mock('../../../apis/DatabaseManager/DatabaseService', () => ({
  default: vi.fn(),
}));

vi.mock('../../../services/QuantumrootVaultCacheService', () => ({
  default: {
    clear: vi.fn(),
  },
}));

vi.mock('../../../services/KeyService', () => ({
  default: {
    bootstrapInitialAddressBatch: vi.fn(async () => {}),
  },
}));

vi.mock('../logger', () => ({
  log: {
    info: vi.fn(async () => {}),
  },
}));

function makeCountStatement(count: number) {
  let stepped = false;
  return {
    bind: vi.fn(),
    step: vi.fn(() => {
      if (stepped) return false;
      stepped = true;
      return true;
    }),
    getAsObject: vi.fn(() => ({ c: count })),
    free: vi.fn(),
  };
}

describe('DesktopWalletManager network cleanup', () => {
  const mockedDatabaseService = vi.mocked(DatabaseService);
  const mockedVaultCache = vi.mocked(QuantumrootVaultCacheService);
  const mockedKeyService = vi.mocked(KeyService);
  const mockedLog = vi.mocked(log);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('clears wallet 6 cached vaults before regenerating addresses on a network switch', async () => {
    const db = {
      prepare: vi.fn(() => makeCountStatement(20)),
      run: vi.fn(),
    };
    const dbService = {
      ensureDatabaseStarted: vi.fn(async () => {}),
      getDatabase: vi.fn(() => db),
      scheduleDatabaseSave: vi.fn(),
      flushDatabaseToFile: vi.fn(async () => {}),
    };
    mockedDatabaseService.mockReturnValue(dbService as never);

    await switchWalletNetwork(6, Network.CHIPNET);

    expect(mockedVaultCache.clear).toHaveBeenCalledOnce();
    expect(mockedVaultCache.clear).toHaveBeenCalledWith(6);
    expect(mockedKeyService.bootstrapInitialAddressBatch).toHaveBeenCalledWith(
      6,
      0,
      20
    );
    expect(dbService.scheduleDatabaseSave).not.toHaveBeenCalled();
    expect(dbService.flushDatabaseToFile).toHaveBeenCalledOnce();
    expect(dbService.flushDatabaseToFile).toHaveBeenCalledWith(6);
    expect(mockedVaultCache.clear.mock.invocationCallOrder[0]).toBeLessThan(
      mockedKeyService.bootstrapInitialAddressBatch.mock.invocationCallOrder[0]
    );
    expect(mockedLog.info).toHaveBeenCalledWith(
      'NetworkSwitch',
      'wallet=6 target=chipnet cacheCleared=true addressIndices=20 status=complete'
    );
  });

  it('clears wallet 7 cached vaults when a purge removes zero database rows', async () => {
    const marker = makeCountStatement(0);
    marker.getAsObject.mockReturnValue({
      network_cleanup_version: 0,
      network_cleanup_network: null,
    });
    const db = {
      prepare: vi.fn(() => marker),
      run: vi.fn(),
      getRowsModified: vi.fn(() => 0),
    };
    const dbService = {
      ensureDatabaseStarted: vi.fn(async () => {}),
      getDatabase: vi.fn(() => db),
      scheduleDatabaseSave: vi.fn(),
      flushDatabaseToFile: vi.fn(async () => {}),
    };
    mockedDatabaseService.mockReturnValue(dbService as never);

    await purgeCrossNetworkData(7, Network.CHIPNET);

    expect(mockedVaultCache.clear).toHaveBeenCalledOnce();
    expect(mockedVaultCache.clear).toHaveBeenCalledWith(7);
    expect(db.run).toHaveBeenCalledWith(
      `UPDATE wallets
       SET network_cleanup_version = ?, network_cleanup_network = ?
       WHERE id = ?`,
      [1, Network.CHIPNET, 7]
    );
    // The immediate wallet-scoped flush is the persistence operation. Queuing
    // a generic save first makes performQueuedSave write twice on first unlock.
    expect(dbService.scheduleDatabaseSave).not.toHaveBeenCalled();
    expect(dbService.flushDatabaseToFile).toHaveBeenCalledWith(7);
    expect(mockedLog.info).toHaveBeenCalledWith(
      'NetworkPurge',
      'wallet=7 target=chipnet cacheCleared=true rowsRemoved=0 status=complete'
    );
  });

  it('skips the legacy cleanup scans after this wallet and network are marked complete', async () => {
    const marker = makeCountStatement(0);
    marker.getAsObject.mockReturnValue({
      network_cleanup_version: 1,
      network_cleanup_network: Network.CHIPNET,
    });
    const db = {
      prepare: vi.fn(() => marker),
      run: vi.fn(),
      getRowsModified: vi.fn(() => 0),
    };
    const dbService = {
      ensureDatabaseStarted: vi.fn(async () => {}),
      getDatabase: vi.fn(() => db),
      scheduleDatabaseSave: vi.fn(),
      flushDatabaseToFile: vi.fn(async () => {}),
    };
    mockedDatabaseService.mockReturnValue(dbService as never);

    await purgeCrossNetworkData(7, Network.CHIPNET);

    expect(mockedVaultCache.clear).toHaveBeenCalledWith(7);
    expect(db.run).not.toHaveBeenCalled();
    expect(dbService.scheduleDatabaseSave).not.toHaveBeenCalled();
    expect(dbService.flushDatabaseToFile).not.toHaveBeenCalled();
    expect(mockedLog.info).not.toHaveBeenCalled();
  });
});
