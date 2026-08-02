import { beforeEach, describe, expect, it, vi } from 'vitest';

const listActiveMock = vi.fn();
const removeMock = vi.fn();
const markStaleMock = vi.fn();
const markStateMock = vi.fn();
const shouldRebroadcastMock = vi.fn();
const reconnectMock = vi.fn();
const visibilityMock = vi.fn();
const sendTransactionMock = vi.fn();
const fetchHistoriesMock = vi.fn();
const prepareMock = vi.fn();

vi.mock('../OutboundTransactionTracker', () => ({
  default: {
    listActive: listActiveMock,
    remove: removeMock,
    markStaleBroadcastingAsSubmitted: markStaleMock,
    markState: markStateMock,
    shouldRebroadcast: shouldRebroadcastMock,
  },
}));

vi.mock('../ElectrumService', () => ({
  default: {
    reconnect: reconnectMock,
    getTransactionVisibilityMany: visibilityMock,
  },
}));

vi.mock('../../apis/TransactionManager/TransactionManager', () => ({
  default: vi.fn(() => ({
    sendTransaction: sendTransactionMock,
    fetchAndStoreTransactionHistories: fetchHistoriesMock,
  })),
}));

vi.mock('../../apis/DatabaseManager/DatabaseService', () => ({
  default: vi.fn(() => ({
    ensureDatabaseStarted: vi.fn(async () => undefined),
    getDatabase: vi.fn(() => ({ prepare: prepareMock })),
  })),
}));

const torOnlyRecord = {
  txid: 'a'.repeat(64),
  rawTx: '00',
  walletId: 5,
  source: 'server-fusion',
  privacyRoute: 'tor-only' as const,
  state: 'broadcasted' as const,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  spentOutpoints: [],
};

const ordinaryRecord = {
  ...torOnlyRecord,
  txid: 'b'.repeat(64),
  source: 'send' as const,
  privacyRoute: 'standard' as const,
};

describe('OutboundTransactionReconciler privacy routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listActiveMock.mockResolvedValue([torOnlyRecord]);
    markStaleMock.mockResolvedValue(torOnlyRecord);
    prepareMock.mockReturnValue({
      bind: vi.fn(),
      step: vi.fn(() => false),
      getAsObject: vi.fn(() => ({})),
      free: vi.fn(),
    });
  });

  it('never queries or rebroadcasts a Tor-only Fusion record over ordinary services', async () => {
    const { reconcileOutboundTransactions } = await import(
      '../OutboundTransactionReconciler'
    );

    await expect(reconcileOutboundTransactions(5)).resolves.toEqual([
      torOnlyRecord,
    ]);

    expect(reconnectMock).not.toHaveBeenCalled();
    expect(visibilityMock).not.toHaveBeenCalled();
    expect(sendTransactionMock).not.toHaveBeenCalled();
    expect(fetchHistoriesMock).not.toHaveBeenCalled();
  });

  it('marks a Tor-only record seen from local wallet history without network access', async () => {
    let active = [torOnlyRecord];
    listActiveMock.mockImplementation(async () => active);
    markStateMock.mockImplementation(async () => {
      active = [];
      return { ...torOnlyRecord, state: 'seen' };
    });
    let stepped = false;
    prepareMock.mockReturnValue({
      bind: vi.fn(),
      step: vi.fn(() => {
        if (stepped) return false;
        stepped = true;
        return true;
      }),
      getAsObject: vi.fn(() => ({ tx_hash: torOnlyRecord.txid })),
      free: vi.fn(),
    });

    const { reconcileOutboundTransactions } = await import(
      '../OutboundTransactionReconciler'
    );

    await expect(reconcileOutboundTransactions(5)).resolves.toEqual([]);
    expect(markStateMock).toHaveBeenCalledWith(
      torOnlyRecord.txid,
      'seen',
      null,
      5
    );
    expect(reconnectMock).not.toHaveBeenCalled();
    expect(sendTransactionMock).not.toHaveBeenCalled();
  });

  it('checks an ordinary transaction without tearing down the shared Electrum connection', async () => {
    let active = [ordinaryRecord];
    listActiveMock.mockImplementation(async () => active);
    visibilityMock.mockResolvedValue({
      [ordinaryRecord.txid]: { seen: true, confirmed: false },
    });
    markStateMock.mockImplementation(async () => {
      active = [];
      return { ...ordinaryRecord, state: 'seen' };
    });
    prepareMock.mockImplementation((sql: string) => {
      const isKeysQuery = sql.includes('FROM keys');
      let stepped = false;
      return {
        bind: vi.fn(),
        step: vi.fn(() => {
          if (!isKeysQuery || stepped) return false;
          stepped = true;
          return true;
        }),
        getAsObject: vi.fn(() => ({ address: 'bitcoincash:qtest' })),
        free: vi.fn(),
      };
    });

    const { reconcileOutboundTransactions } = await import(
      '../OutboundTransactionReconciler'
    );

    await expect(reconcileOutboundTransactions(5)).resolves.toEqual([]);
    expect(visibilityMock).toHaveBeenCalledWith([ordinaryRecord.txid]);
    expect(reconnectMock).not.toHaveBeenCalled();
  });
});
