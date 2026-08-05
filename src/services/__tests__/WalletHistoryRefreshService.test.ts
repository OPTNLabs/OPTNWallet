import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchAndStore = vi.fn();
const ensureDatabaseStarted = vi.fn(async () => {});
const getDatabase = vi.fn();
const { reconnect } = vi.hoisted(() => ({
  reconnect: vi.fn(async () => {}),
}));

vi.mock('../../apis/TransactionManager/TransactionManager', () => ({
  default: () => ({ fetchAndStoreTransactionHistories: fetchAndStore }),
}));
vi.mock('../../apis/DatabaseManager/DatabaseService', () => ({
  default: () => ({ ensureDatabaseStarted, getDatabase }),
}));
vi.mock('../ElectrumService', () => ({
  default: {
    reconnect,
    getTransactionDetails: vi.fn(async () => ({})),
  },
}));
vi.mock('../OutboundTransactionReconciler', () => ({
  reconcileOutboundTransactions: vi.fn(async () => {}),
}));
vi.mock('../QuantumrootTrackingService', () => ({
  default: { listTrackedAddresses: vi.fn(async () => []) },
}));
vi.mock('../../platform/desktop/WalletLedgerService', () => ({
  partitionAddressesByStatus: vi.fn(async (_walletId: number, addresses: string[]) => ({
    dirty: addresses,
    clean: [],
    probed: 0,
  })),
}));

import { refreshWalletTransactionHistory } from '../WalletHistoryRefreshService';

/** Minimal sql.js-shaped stub: address rows, then transaction rows. */
function makeDb(addresses: string[], transactions: string[]) {
  return {
    prepare: (sql: string) => {
      const isAddressQuery = sql.includes('FROM addresses');
      const rows: Record<string, unknown>[] = isAddressQuery
        ? addresses.map((address) => ({ address }))
        : transactions.map((tx_hash) => ({ tx_hash, height: 1 }));
      let index = -1;
      return {
        bind: () => {},
        step: () => {
          index += 1;
          return index < rows.length;
        },
        getAsObject: () => rows[index],
        free: () => {},
      };
    },
  };
}

const dispatch = vi.fn() as never;

describe('wallet history refresh service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchAndStore.mockResolvedValue({ addr1: [], addr2: [] });
    getDatabase.mockReturnValue(makeDb(['addr1', 'addr2'], ['tx1']));
    // The coordinator applies a per-wallet cooldown; use a distinct wallet id
    // per test so one test cannot suppress the next.
  });

  it('scans every address when no skip set is given', async () => {
    const result = await refreshWalletTransactionHistory({
      walletId: 101,
      dispatch,
    });
    expect(fetchAndStore).toHaveBeenCalledWith(
      101,
      ['addr1', 'addr2'],
      undefined,
      expect.any(Function)
    );
    expect(result.refreshed).toBe(true);
  });

  it('does not tear down a healthy Electrum connection before scanning history', async () => {
    const result = await refreshWalletTransactionHistory({
      walletId: 108,
      dispatch,
    });

    expect(result.refreshed).toBe(true);
    expect(fetchAndStore).toHaveBeenCalledWith(
      108,
      ['addr1', 'addr2'],
      undefined,
      expect.any(Function)
    );
    expect(reconnect).not.toHaveBeenCalled();
  });

  it('honours a skip set for an incremental first load', async () => {
    await refreshWalletTransactionHistory({
      walletId: 102,
      dispatch,
      skipAddresses: new Set(['addr1']),
    });
    expect(fetchAndStore).toHaveBeenCalledWith(
      102,
      ['addr2'],
      undefined,
      expect.any(Function)
    );
  });

  it('still refreshes when every address was previously scanned', async () => {
    // The old hook filtered by its scan cache and returned early at zero pending,
    // so a NEW payment on an already-scanned address refreshed nothing. A full
    // pass must not be filtered away.
    await refreshWalletTransactionHistory({ walletId: 103, dispatch });
    expect(fetchAndStore).toHaveBeenCalledWith(
      103,
      ['addr1', 'addr2'],
      undefined,
      expect.any(Function)
    );
  });

  it('publishes the stored transactions to redux', async () => {
    await refreshWalletTransactionHistory({ walletId: 104, dispatch });
    const dispatched = (dispatch as unknown as ReturnType<typeof vi.fn>).mock
      .calls;
    expect(dispatched.length).toBeGreaterThan(0);
  });

  it('reports the addresses it scanned so callers can cache them', async () => {
    fetchAndStore.mockResolvedValue({ addr1: [], addr2: [] });
    const result = await refreshWalletTransactionHistory({
      walletId: 105,
      dispatch,
    });
    expect(result.scannedAddresses).toEqual(['addr1', 'addr2']);
  });

  it('refuses an invalid wallet id without touching the network', async () => {
    const result = await refreshWalletTransactionHistory({
      walletId: 0,
      dispatch,
    });
    expect(result).toEqual({ scannedAddresses: [], refreshed: false });
    expect(fetchAndStore).not.toHaveBeenCalled();
  });

  it('survives an unavailable database without throwing', async () => {
    getDatabase.mockReturnValue(null);
    const result = await refreshWalletTransactionHistory({
      walletId: 106,
      dispatch,
    });
    expect(result.refreshed).toBe(false);
  });

  it('publishes stored history BEFORE the network fetch, like Electron Cash', async () => {
    // The rows were always in the transactions table; nothing read them into
    // redux on open, so the list looked empty until a round trip finished. EC
    // shows the wallet file's history immediately and lets the network update
    // it. A wallet opened offline must still show what it knows.
    const order: string[] = [];
    const dispatchSpy = vi.fn(() => {
      order.push('dispatch');
    }) as never;
    fetchAndStore.mockImplementation(async () => {
      order.push('network');
      return { addr1: [], addr2: [] };
    });

    await refreshWalletTransactionHistory({ walletId: 107, dispatch: dispatchSpy });

    expect(order[0]).toBe('dispatch');
    expect(order).toContain('network');
  });
});
