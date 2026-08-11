import { beforeEach, describe, expect, it, vi } from 'vitest';

const records = new Map<string, unknown>();
const getItemMock = vi.fn(async (key: string) => records.get(key) ?? null);
const setItemMock = vi.fn(async (key: string, value: unknown) => {
  records.set(key, value);
  return value;
});
const removeItemMock = vi.fn(async (key: string) => {
  records.delete(key);
});
const iterateMock = vi.fn(
  async (callback: (value: unknown, key: string) => void): Promise<void> => {
    for (const [key, value] of records) callback(value, key);
  }
);

vi.mock('localforage', () => ({
  default: {
    createInstance: vi.fn(() => ({
      getItem: getItemMock,
      setItem: setItemMock,
      removeItem: removeItemMock,
      iterate: iterateMock,
    })),
  },
}));

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
}

describe('OutboundTransactionTracker Fusion completion', () => {
  beforeEach(() => {
    records.clear();
    (globalThis as { localStorage?: unknown }).localStorage =
      new MemoryStorage();
    getItemMock.mockClear();
    setItemMock.mockClear();
    setItemMock.mockImplementation(async (key: string, value: unknown) => {
      records.set(key, value);
      return value;
    });
    removeItemMock.mockClear();
    iterateMock.mockClear();
  });

  it('atomically records a verified broadcast as broadcasted with its spent inputs', async () => {
    const { default: OutboundTransactionTracker } = await import(
      '../OutboundTransactionTracker'
    );
    const txid =
      '9a538906e6466ebd2617d321f71bc94e56056ce213d366773699e28158e00614';

    const result = await OutboundTransactionTracker.recordBroadcast({
      rawTx: '00',
      expectedTxid: txid,
      walletId: 5,
      source: 'p2p-fusion',
      sourceLabel: 'P2P Fusion',
      spentInputs: [
        {
          tx_hash: 'a'.repeat(64),
          tx_pos: 1,
          address: 'bchtest:qinput',
          value: 150_000,
          height: 1,
        },
      ],
    });

    expect(result).toEqual(
      expect.objectContaining({
        txid,
        walletId: 5,
        source: 'p2p-fusion',
        state: 'broadcasted',
        spentOutpoints: [
          {
            tx_hash: 'a'.repeat(64),
            tx_pos: 1,
          },
        ],
      })
    );
    await expect(
      OutboundTransactionTracker.getByTxid(txid, 5)
    ).resolves.toEqual(result);
  });

  it('keeps the same Fusion transaction separate for each local wallet', async () => {
    const { default: OutboundTransactionTracker } = await import(
      '../OutboundTransactionTracker'
    );
    const txid =
      '9a538906e6466ebd2617d321f71bc94e56056ce213d366773699e28158e00614';

    await OutboundTransactionTracker.recordBroadcast({
      rawTx: '00',
      expectedTxid: txid,
      walletId: 5,
      source: 'p2p-fusion',
      spentInputs: [
        {
          tx_hash: 'a'.repeat(64),
          tx_pos: 0,
          address: 'bchtest:q5',
          value: 100_000,
          height: 1,
        },
      ],
    });
    await OutboundTransactionTracker.recordBroadcast({
      rawTx: '00',
      expectedTxid: txid,
      walletId: 6,
      source: 'p2p-fusion',
      spentInputs: [
        {
          tx_hash: 'b'.repeat(64),
          tx_pos: 1,
          address: 'bchtest:q6',
          value: 200_000,
          height: 1,
        },
      ],
    });

    await expect(
      OutboundTransactionTracker.getByTxid(txid, 5)
    ).resolves.toEqual(
      expect.objectContaining({
        walletId: 5,
        spentOutpoints: [{ tx_hash: 'a'.repeat(64), tx_pos: 0 }],
      })
    );
    await expect(
      OutboundTransactionTracker.getByTxid(txid, 6)
    ).resolves.toEqual(
      expect.objectContaining({
        walletId: 6,
        spentOutpoints: [{ tx_hash: 'b'.repeat(64), tx_pos: 1 }],
      })
    );
  });

  it('persists the Tor-only route on server Fusion records', async () => {
    const { default: OutboundTransactionTracker } = await import(
      '../OutboundTransactionTracker'
    );
    const txid =
      '9a538906e6466ebd2617d321f71bc94e56056ce213d366773699e28158e00614';

    const result = await OutboundTransactionTracker.recordBroadcast({
      rawTx: '00',
      expectedTxid: txid,
      walletId: 5,
      source: 'server-fusion',
      sourceLabel: 'CashFusion server',
      privacyRoute: 'tor-only',
      spentInputs: [],
    });

    expect(result).toEqual(
      expect.objectContaining({
        source: 'server-fusion',
        privacyRoute: 'tor-only',
        state: 'broadcasted',
      })
    );
    expect(
      OutboundTransactionTracker.shouldRebroadcast({
        ...result,
        state: 'submitted',
        lastCheckedAt: new Date(0).toISOString(),
      })
    ).toBe(false);
  });

  it('keeps an ambiguous Fusion spend locked until wallet evidence resolves it', async () => {
    const { default: OutboundTransactionTracker } = await import(
      '../OutboundTransactionTracker'
    );
    const txid =
      '9a538906e6466ebd2617d321f71bc94e56056ce213d366773699e28158e00614';
    await OutboundTransactionTracker.trackAttempt({
      rawTx: '00',
      walletId: 5,
      source: 'p2p-fusion',
      privacyRoute: 'tor-only',
      spentInputs: [],
    });

    const pending = await OutboundTransactionTracker.markVerificationPending(
      txid,
      'Awaiting independent network visibility.',
      5
    );

    expect(pending).toMatchObject({
      state: 'submitted',
      verificationPending: true,
      lastError: null,
    });
    expect(OutboundTransactionTracker.canClear(pending!)).toBe(false);
    expect(OutboundTransactionTracker.canRelease(pending!)).toBe(false);
    await expect(
      OutboundTransactionTracker.findFusionVerificationPending(5)
    ).resolves.toMatchObject({ txid, verificationPending: true });

    const seen = await OutboundTransactionTracker.markState(
      txid,
      'seen',
      null,
      5
    );
    expect(seen).toMatchObject({
      state: 'seen',
      verificationPending: false,
    });
    await expect(
      OutboundTransactionTracker.findFusionVerificationPending(5)
    ).resolves.toBeNull();
  });

  it('durably reserves spent inputs when IndexedDB is temporarily unavailable', async () => {
    setItemMock.mockRejectedValue(new Error('IndexedDB unavailable'));
    const { default: OutboundTransactionTracker } = await import(
      '../OutboundTransactionTracker'
    );
    const txid =
      '9a538906e6466ebd2617d321f71bc94e56056ce213d366773699e28158e00614';

    const result = await OutboundTransactionTracker.recordBroadcast({
      rawTx: '00',
      expectedTxid: txid,
      walletId: 5,
      source: 'p2p-fusion',
      spentInputs: [
        {
          tx_hash: 'c'.repeat(64),
          tx_pos: 2,
          address: 'bchtest:qfallback',
          value: 80_000,
          height: 1,
        },
      ],
    });

    expect(result.state).toBe('broadcasted');
    await expect(
      OutboundTransactionTracker.getByTxid(txid, 5)
    ).resolves.toEqual(result);
    await expect(
      OutboundTransactionTracker.listReservedOutpoints(5)
    ).resolves.toEqual([{ tx_hash: 'c'.repeat(64), tx_pos: 2 }]);

    // Recovery is self-healing: the next successful store access migrates the
    // shadow record back into IndexedDB and keeps the same reservation.
    setItemMock.mockImplementation(async (key: string, value: unknown) => {
      records.set(key, value);
      return value;
    });
    await expect(
      OutboundTransactionTracker.listReservedOutpoints(5)
    ).resolves.toEqual([{ tx_hash: 'c'.repeat(64), tx_pos: 2 }]);
    expect(records.size).toBeGreaterThan(0);
  });
});
