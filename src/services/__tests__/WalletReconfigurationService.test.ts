import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Network } from '../../state/slices/networkSlice';
import {
  reconfigureActiveWallet,
  reloadActiveWallet,
} from '../WalletReconfigurationService';
import {
  beginWalletReconfiguration,
  completeWalletReconfiguration,
  setWalletReconfigurationStage,
} from '../../state/slices/walletReconfigurationSlice';

const {
  dispatchMock,
  dbRunMock,
  stopWorkerMock,
  startWorkerMock,
  historyRefreshMock,
} = vi.hoisted(() => ({
  dispatchMock: vi.fn(),
  dbRunMock: vi.fn(),
  stopWorkerMock: vi.fn(async () => {}),
  startWorkerMock: vi.fn(async () => {}),
  historyRefreshMock: vi.fn(async () => ({
    scannedAddresses: [],
    refreshed: true,
  })),
}));

vi.mock('../../apis/DatabaseManager/DatabaseService', () => ({
  default: vi.fn(() => ({
    ensureDatabaseStarted: vi.fn(async () => {}),
    getDatabase: vi.fn(() => ({ run: dbRunMock })),
    scheduleDatabaseSave: vi.fn(),
    flushDatabaseToFile: vi.fn(async () => {}),
  })),
}));

vi.mock('../../apis/ElectrumServer/ElectrumServer', () => ({
  default: vi.fn(() => ({ electrumDisconnect: vi.fn(async () => true) })),
}));

vi.mock('../KeyService', () => ({
  default: { bootstrapInitialAddressBatch: vi.fn(async () => {}) },
}));

vi.mock('../WalletDiscoveryService', () => ({
  default: {
    waitForIdle: vi.fn(async () => {}),
    clear: vi.fn(),
  },
}));

vi.mock('../QuantumrootVaultCacheService', () => ({
  default: { clear: vi.fn() },
}));

vi.mock('../ElectrumService', () => ({
  invalidateUTXOCache: vi.fn(),
}));

vi.mock('../WalletHistoryRefreshService', () => ({
  refreshWalletTransactionHistory: historyRefreshMock,
}));

vi.mock('../../workers/UTXOWorkerService', () => ({
  stopUTXOWorker: stopWorkerMock,
  startUTXOWorker: startWorkerMock,
}));

vi.mock('../../state/store', () => ({
  store: { dispatch: dispatchMock },
}));

describe('WalletReconfigurationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stops the worker, clears derived records, writes the new path, and resyncs', async () => {
    await reconfigureActiveWallet({
      walletId: 4,
      network: Network.CHIPNET,
      derivationPath: "m/44'/1'/2'",
      derivationPathSource: 'custom',
    });

    expect(stopWorkerMock).toHaveBeenCalledOnce();
    expect(dbRunMock).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE wallets SET networkType'),
      [Network.CHIPNET, "m/44'/1'/2'", 'custom', 4]
    );
    expect(startWorkerMock).toHaveBeenCalledOnce();
    expect(historyRefreshMock).toHaveBeenCalledWith(
      expect.objectContaining({ walletId: 4 })
    );
    expect(stopWorkerMock.mock.invocationCallOrder[0]).toBeLessThan(
      dbRunMock.mock.invocationCallOrder.find(
        (order) => order > stopWorkerMock.mock.invocationCallOrder[0]
      ) ?? Number.POSITIVE_INFINITY
    );
    expect(dispatchMock).toHaveBeenCalledWith(
      beginWalletReconfiguration({
        kind: 'network-switch',
        targetNetwork: Network.CHIPNET,
      })
    );
    expect(dispatchMock).toHaveBeenCalledWith(
      setWalletReconfigurationStage('clearing')
    );
    expect(dispatchMock).toHaveBeenCalledWith(
      setWalletReconfigurationStage('deriving')
    );
    expect(dispatchMock).toHaveBeenCalledWith(
      setWalletReconfigurationStage('syncing')
    );
    expect(dispatchMock).toHaveBeenCalledWith(completeWalletReconfiguration());
  });

  it('reloads without deleting the active derived records', async () => {
    await reloadActiveWallet(9);

    expect(stopWorkerMock).toHaveBeenCalledOnce();
    expect(dbRunMock).not.toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM keys'),
      expect.anything()
    );
    expect(startWorkerMock).toHaveBeenCalledOnce();
    expect(historyRefreshMock).toHaveBeenCalledWith(
      expect.objectContaining({ walletId: 9 })
    );
  });
});
