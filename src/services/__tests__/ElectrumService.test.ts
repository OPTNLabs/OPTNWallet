import { beforeEach, describe, expect, it, vi } from 'vitest';

import ElectrumServer from '../../apis/ElectrumServer/ElectrumServer';
import ElectrumService, {
  invalidateUTXOCache,
  primeUTXOCache,
} from '../ElectrumService';
import DatabaseService from '../../apis/DatabaseManager/DatabaseService';

vi.mock('../../apis/ElectrumServer/ElectrumServer', () => ({
  default: vi.fn(),
}));

vi.mock('../../apis/DatabaseManager/DatabaseService', () => ({
  default: vi.fn(),
}));

vi.mock('../../state/store', () => ({
  store: {
    getState: vi.fn(() => ({
      wallet_id: { currentWalletId: 7 },
      network: { currentNetwork: 'mainnet' },
    })),
  },
}));

// Deterministic scripthash so arbitrary test addresses work without libauth.
vi.mock('../../services/electrum/helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/electrum/helpers')>();
  return {
    ...actual,
    addressToElectrumScripthash: (address: string) =>
      `scripthash:${address.replace(/[^a-z0-9]/gi, '_')}`,
  };
});

describe('ElectrumService', () => {
  const mockedElectrumServer = vi.mocked(ElectrumServer);
  const mockedDatabaseService = vi.mocked(DatabaseService);
  let dbRow: Record<string, unknown> | null;

  beforeEach(() => {
    vi.clearAllMocks();
    invalidateUTXOCache();
    dbRow = null;

    mockedDatabaseService.mockReturnValue({
      ensureDatabaseStarted: vi.fn(async () => {}),
      scheduleDatabaseSave: vi.fn(),
      getDatabase: vi.fn(() => ({
        prepare: vi.fn(() => ({
          bind: vi.fn(),
          step: vi.fn(() => dbRow !== null),
          getAsObject: vi.fn(() => dbRow ?? {}),
          run: vi.fn(),
          free: vi.fn(),
        })),
      })),
    } as never);
  });

  it('getUTXOs maps Electrum rows and uses cache', async () => {
    const server = {
      request: vi.fn(async () => [
        {
          tx_hash: 'a'.repeat(64),
          tx_pos: 0,
          value: 1234,
          height: 100,
          token_data: { category: 'cat', amount: 5 },
        },
      ]),
      subscribe: vi.fn(async () => {}),
      unsubscribe: vi.fn(async () => {}),
      onNotification: vi.fn(() => () => {}),
    };

    mockedElectrumServer.mockReturnValue(server as never);

    const addr = 'bitcoincash:q1';
    const first = await ElectrumService.getUTXOs(addr);
    const second = await ElectrumService.getUTXOs(addr);

    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      address: addr,
      value: 1234,
      amount: 1234,
      token: { category: 'cat', amount: 5, nft: undefined },
      id: `${'a'.repeat(64)}:0`,
    });
    expect(second).toEqual(first);
    expect(server.request).toHaveBeenCalledTimes(1);
  });

  it('getUTXOsMany batches scripthash.listunspent directly (no per-call fallback)', async () => {
    const server = {
      requestMany: vi.fn(async () => [
        [
          {
            tx_hash: 'c'.repeat(64),
            tx_pos: 1,
            value: 546,
            height: 33,
          },
        ],
      ]),
      subscribe: vi.fn(async () => {}),
      unsubscribe: vi.fn(async () => {}),
      onNotification: vi.fn(() => () => {}),
    };

    mockedElectrumServer.mockReturnValue(server as never);

    const address = 'bchtest:qqqsg7fpq3c4xz3pgc6algdm8tjst4x5jygfj4vfyw';
    const result = await ElectrumService.getUTXOsMany([address]);

    expect(result[address]).toEqual([
      expect.objectContaining({
        address,
        tx_hash: 'c'.repeat(64),
        tx_pos: 1,
        value: 546,
        height: 33,
      }),
    ]);
    expect(server.requestMany).toHaveBeenCalledTimes(1);
    expect(server.requestMany.mock.calls[0][0][0].method).toBe(
      'blockchain.scripthash.listunspent'
    );
    expect(server.requestMany.mock.calls[0][0][0].params[0]).toContain('scripthash:');
  });

  it('getUTXOsMany omits addresses that fail without a usable response', async () => {
    const server = {
      requestMany: vi.fn(async () => [new Error('temporary failure')]),
      subscribe: vi.fn(async () => {}),
      unsubscribe: vi.fn(async () => {}),
      onNotification: vi.fn(() => () => {}),
    };

    mockedElectrumServer.mockReturnValue(server as never);

    const address = 'bitcoincash:qfail';
    const result = await ElectrumService.getUTXOsMany([address]);

    expect(result).not.toHaveProperty(address);
    expect(server.requestMany).toHaveBeenCalledTimes(1);
  });

  it('splits a large wallet UTXO scan into bounded Electrum batches', async () => {
    const server = {
      requestMany: vi.fn(async (calls: unknown[]) => calls.map(() => [])),
      subscribe: vi.fn(async () => {}),
      unsubscribe: vi.fn(async () => {}),
      onNotification: vi.fn(() => () => {}),
    };
    mockedElectrumServer.mockReturnValue(server as never);
    const addresses = Array.from(
      { length: 617 },
      (_, index) => `bitcoincash:qbatch${index}`
    );

    const result = await ElectrumService.getUTXOsMany(addresses);

    // Batch size 50 (was 250): 617 = 12×50 + 17. Live error was requestMany(250)@12s.
    // Chunks may complete out of order under concurrency=2 — compare multiset.
    const sizes = server.requestMany.mock.calls
      .map(([calls]) => (calls as unknown[]).length)
      .sort((a, b) => b - a);
    expect(sizes).toEqual([
      50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 17,
    ]);
    expect(server.requestMany).toHaveBeenCalledTimes(13);
    expect(Object.keys(result)).toHaveLength(617);
  });

  it('runs at most two listunspent chunks concurrently', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const server = {
      requestMany: vi.fn(async (calls: unknown[]) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 15));
        inFlight -= 1;
        return (calls as unknown[]).map(() => []);
      }),
      subscribe: vi.fn(async () => {}),
      unsubscribe: vi.fn(async () => {}),
      onNotification: vi.fn(() => () => {}),
    };
    mockedElectrumServer.mockReturnValue(server as never);
    const addresses = Array.from(
      { length: 120 },
      (_, index) => `bitcoincash:qpar${index}`
    );

    await ElectrumService.getUTXOsMany(addresses);

    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
    expect(server.requestMany).toHaveBeenCalledTimes(3); // 50+50+20
  });

  it('deduplicates overlapping wallet-wide scans by address', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = {
      requestMany: vi.fn(async (calls: unknown[]) => {
        await gate;
        return calls.map(() => []);
      }),
      subscribe: vi.fn(async () => {}),
      unsubscribe: vi.fn(async () => {}),
      onNotification: vi.fn(() => () => {}),
    };
    mockedElectrumServer.mockReturnValue(server as never);
    const addresses = Array.from(
      { length: 60 },
      (_, index) => `bitcoincash:qoverlap${index}`
    );

    const first = ElectrumService.getUTXOsMany(addresses);
    await Promise.resolve();
    const second = ElectrumService.getUTXOsMany(addresses);
    await Promise.resolve();
    release();
    await Promise.all([first, second]);

    expect(server.requestMany).toHaveBeenCalledTimes(2); // one 50 + one 10
  });

  it('primeUTXOCache seeds cache used by getUTXOs', async () => {
    const server = {
      request: vi.fn(async () => []),
      subscribe: vi.fn(async () => {}),
      unsubscribe: vi.fn(async () => {}),
      onNotification: vi.fn(() => () => {}),
    };

    mockedElectrumServer.mockReturnValue(server as never);

    primeUTXOCache('bitcoincash:qcached', [
      {
        address: 'bitcoincash:qcached',
        height: 0,
        tx_hash: 'b'.repeat(64),
        tx_pos: 1,
        value: 546,
      },
    ]);

    const res = await ElectrumService.getUTXOs('bitcoincash:qcached');
    expect(res).toHaveLength(1);
    expect(server.request).not.toHaveBeenCalled();
  });

  it('reconnect preserves cached UTXOs so transient failures do not blank the UI', async () => {
    const server = {
      electrumReconnect: vi.fn(async () => undefined),
      request: vi.fn(async () => []),
      subscribe: vi.fn(async () => {}),
      unsubscribe: vi.fn(async () => {}),
      onNotification: vi.fn(() => () => {}),
    };

    mockedElectrumServer.mockReturnValue(server as never);

    primeUTXOCache('bitcoincash:qstable', [
      {
        address: 'bitcoincash:qstable',
        height: 0,
        tx_hash: 'd'.repeat(64),
        tx_pos: 2,
        value: 1000,
      },
    ]);

    await ElectrumService.reconnect();
    const res = await ElectrumService.getUTXOs('bitcoincash:qstable');

    expect(server.electrumReconnect).toHaveBeenCalledTimes(1);
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({
      address: 'bitcoincash:qstable',
      tx_hash: 'd'.repeat(64),
      tx_pos: 2,
      value: 1000,
    });
    expect(server.request).not.toHaveBeenCalled();
  });

  it('refreshes through the current healthy connection without forcing a disconnect', async () => {
    const server = {
      ensureFreshConnection: vi.fn(async () => undefined),
      electrumReconnect: vi.fn(async () => undefined),
    };
    mockedElectrumServer.mockReturnValue(server as never);

    await ElectrumService.ensureFreshConnection();

    expect(server.ensureFreshConnection).toHaveBeenCalledOnce();
    expect(server.electrumReconnect).not.toHaveBeenCalled();
  });

  it('can subscribe to future headers without replaying the current tip', async () => {
    const server = {
      request: vi.fn(async () => ({ height: 100 })),
      subscribe: vi.fn(async () => {}),
      unsubscribe: vi.fn(async () => {}),
      onNotification: vi.fn(() => () => {}),
    };
    mockedElectrumServer.mockReturnValue(server as never);
    const callback = vi.fn();

    await ElectrumService.subscribeBlockHeaders(callback, {
      emitCurrent: false,
    });

    expect(server.subscribe).toHaveBeenCalledWith(
      'blockchain.headers.subscribe'
    );
    expect(server.request).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();

    await ElectrumService.unsubscribeBlockHeaders(callback);
  });

  it('getBalance returns confirmed + unconfirmed and falls back to 0', async () => {
    const server = {
      request: vi
        .fn()
        .mockResolvedValueOnce({ confirmed: 10, unconfirmed: 2 })
        .mockResolvedValueOnce({ wrong: true }),
      subscribe: vi.fn(async () => {}),
      unsubscribe: vi.fn(async () => {}),
      onNotification: vi.fn(() => () => {}),
    };

    mockedElectrumServer.mockReturnValue(server as never);

    await expect(ElectrumService.getBalance('bitcoincash:q1')).resolves.toBe(12);
    await expect(ElectrumService.getBalance('bitcoincash:q1')).resolves.toBe(0);
  });

  it('broadcastTransaction returns txid string or error message fallback', async () => {
    const server = {
      request: vi
        .fn()
        .mockResolvedValueOnce('txid123')
        .mockResolvedValueOnce({ bad: true }),
      subscribe: vi.fn(async () => {}),
      unsubscribe: vi.fn(async () => {}),
      onNotification: vi.fn(() => () => {}),
    };

    mockedElectrumServer.mockReturnValue(server as never);

    await expect(ElectrumService.broadcastTransaction('rawhex')).resolves.toBe('txid123');
    await expect(ElectrumService.broadcastTransaction('rawhex')).resolves.toBe(
      'Invalid transaction hash response'
    );
  });

  it('getTransactionHistory validates response shape', async () => {
    const server = {
      request: vi
        .fn()
        .mockResolvedValueOnce([{ tx_hash: 'abc', height: 10 }])
        .mockResolvedValueOnce({ not: 'array' }),
      subscribe: vi.fn(async () => {}),
      unsubscribe: vi.fn(async () => {}),
      onNotification: vi.fn(() => () => {}),
    };

    mockedElectrumServer.mockReturnValue(server as never);

    await expect(ElectrumService.getTransactionHistory('bitcoincash:q1')).resolves.toEqual([
      { tx_hash: 'abc', height: 10 },
    ]);
    await expect(ElectrumService.getTransactionHistory('bitcoincash:q2')).resolves.toBeNull();
  });

  it('coalesces inflight history requests for the same address', async () => {
    let resolveHistory: ((value: unknown) => void) | null = null;
    const server = {
      request: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveHistory = resolve;
          })
      ),
      subscribe: vi.fn(async () => {}),
      unsubscribe: vi.fn(async () => {}),
      onNotification: vi.fn(() => () => {}),
    };

    mockedElectrumServer.mockReturnValue(server as never);

    const first = ElectrumService.getTransactionHistory('bitcoincash:q1');
    const second = ElectrumService.getTransactionHistory('bitcoincash:q1');
    resolveHistory?.([{ tx_hash: 'abc', height: 10 }]);

    await expect(first).resolves.toEqual([{ tx_hash: 'abc', height: 10 }]);
    await expect(second).resolves.toEqual([{ tx_hash: 'abc', height: 10 }]);
    expect(server.request).toHaveBeenCalledTimes(1);
  });

  it('getTransactionHistoryMany batches uncached address lookups', async () => {
    const server = {
      request: vi.fn(async () => []),
      requestMany: vi.fn(async () => [
        [{ tx_hash: 'abc', height: 10 }],
        [{ tx_hash: 'def', height: 12 }],
      ]),
      subscribe: vi.fn(async () => {}),
      unsubscribe: vi.fn(async () => {}),
      onNotification: vi.fn(() => () => {}),
    };

    mockedElectrumServer.mockReturnValue(server as never);

    const result = await ElectrumService.getTransactionHistoryMany([
      'bitcoincash:q1',
      'bitcoincash:q2',
    ]);

    expect(server.requestMany).toHaveBeenCalledTimes(1);
    expect(server.requestMany.mock.calls[0][0][0].method).toBe(
      'blockchain.scripthash.get_history'
    );
    expect(result['bitcoincash:q1']).toEqual([{ tx_hash: 'abc', height: 10 }]);
    expect(result['bitcoincash:q2']).toEqual([{ tx_hash: 'def', height: 12 }]);
  });

  it('splits a large wallet history scan into bounded Electrum batches', async () => {
    const server = {
      request: vi.fn(async () => []),
      requestMany: vi.fn(async (calls: unknown[]) => calls.map(() => [])),
      subscribe: vi.fn(async () => {}),
      unsubscribe: vi.fn(async () => {}),
      onNotification: vi.fn(() => () => {}),
    };
    mockedElectrumServer.mockReturnValue(server as never);
    const addresses = Array.from(
      { length: 617 },
      (_, index) => `bitcoincash:qhistory${index}`
    );

    const result = await ElectrumService.getTransactionHistoryMany(addresses);

    expect(
      server.requestMany.mock.calls.map(([calls]) => calls.length)
    // Batch size 50 (was 250): 617 = 12×50 + 17. Live error was requestMany(250)@12s.
    ).toEqual([
      50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 17,
    ]);
    expect(Object.keys(result)).toHaveLength(617);
  });

  it('getTransactionVisibility detects seen and missing transactions', async () => {
    const server = {
      request: vi
        .fn()
        .mockResolvedValueOnce({ confirmations: 0, height: 0 })
        .mockResolvedValueOnce({ confirmations: 2, height: 123 })
        .mockRejectedValueOnce(new Error('No such mempool or blockchain transaction')),
      subscribe: vi.fn(async () => {}),
      unsubscribe: vi.fn(async () => {}),
      onNotification: vi.fn(() => () => {}),
    };

    mockedElectrumServer.mockReturnValue(server as never);

    await expect(ElectrumService.getTransactionVisibility('a'.repeat(64))).resolves.toEqual({
      seen: true,
      confirmed: false,
    });
    await expect(ElectrumService.getTransactionVisibility('b'.repeat(64))).resolves.toEqual({
      seen: true,
      confirmed: true,
    });
    await expect(ElectrumService.getTransactionVisibility('c'.repeat(64))).resolves.toEqual({
      seen: false,
      confirmed: false,
    });
  });

  it('coalesces inflight transaction visibility lookups for the same txid', async () => {
    let resolveVisibility: ((value: unknown) => void) | null = null;
    const server = {
      request: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveVisibility = resolve;
          })
      ),
      subscribe: vi.fn(async () => {}),
      unsubscribe: vi.fn(async () => {}),
      onNotification: vi.fn(() => () => {}),
    };

    mockedElectrumServer.mockReturnValue(server as never);

    const txid = 'd'.repeat(64);
    const first = ElectrumService.getTransactionVisibility(txid);
    const second = ElectrumService.getTransactionVisibility(txid);
    resolveVisibility?.({ confirmations: 0, height: 0 });

    await expect(first).resolves.toEqual({ seen: true, confirmed: false });
    await expect(second).resolves.toEqual({ seen: true, confirmed: false });
    expect(server.request).toHaveBeenCalledTimes(1);
  });

  it('getTransactionVisibilityMany batches tx visibility lookups', async () => {
    const server = {
      request: vi.fn(async () => ({})),
      requestMany: vi.fn(async () => [
        { confirmations: 0, height: 0 },
        { confirmations: 3, height: 222 },
      ]),
      subscribe: vi.fn(async () => {}),
      unsubscribe: vi.fn(async () => {}),
      onNotification: vi.fn(() => () => {}),
    };

    mockedElectrumServer.mockReturnValue(server as never);

    const result = await ElectrumService.getTransactionVisibilityMany([
      'a'.repeat(64),
      'b'.repeat(64),
    ]);

    expect(server.requestMany).toHaveBeenCalledTimes(1);
    expect(result['a'.repeat(64)]).toEqual({ seen: true, confirmed: false });
    expect(result['b'.repeat(64)]).toEqual({ seen: true, confirmed: true });
  });

  it('getTransactionDetails resolves timestamp, outputs, and prevout-backed inputs', async () => {
    const server = {
      request: vi.fn(async () => ({
        txid: 'f'.repeat(64),
        confirmations: 3,
        height: 321,
        blocktime: 1_700_000_000,
        vin: [{ txid: 'e'.repeat(64), vout: 1 }],
        vout: [
          {
            n: 0,
            value: 0.001,
            scriptPubKey: { address: 'bitcoincash:qrecipient' },
          },
        ],
      })),
      requestMany: vi.fn(async () => [
        {
          txid: 'e'.repeat(64),
          vout: [
            {
              n: 1,
              value: 0.0011,
              scriptPubKey: { address: 'bitcoincash:qsender' },
            },
          ],
        },
      ]),
      subscribe: vi.fn(async () => {}),
      unsubscribe: vi.fn(async () => {}),
      onNotification: vi.fn(() => () => {}),
    };

    mockedElectrumServer.mockReturnValue(server as never);

    const result = await ElectrumService.getTransactionDetails('f'.repeat(64));

    expect(server.request).toHaveBeenCalledWith(
      'blockchain.transaction.get',
      'f'.repeat(64),
      true
    );
    expect(server.requestMany).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      txid: 'f'.repeat(64),
      confirmations: 3,
      height: 321,
      feeSats: 10000,
      timestamp: '2023-11-14T22:13:20.000Z',
      inputs: [{ address: 'bitcoincash:qsender', amountSats: 110000 }],
      outputs: [
        { address: 'bitcoincash:qrecipient', amountSats: 100000, outputIndex: 0 },
      ],
    });
  });

  it('getTransactionDetails uses persisted details before calling Electrum', async () => {
    dbRow = {
      tx_hash: '1'.repeat(64),
      confirmations: 9,
      height: 555,
      fee_sats: 222,
      timestamp: '2026-03-14T18:00:00.000Z',
      inputs_json: JSON.stringify([{ address: 'bitcoincash:qfrom', amountSats: 1000 }]),
      outputs_json: JSON.stringify([{ address: 'bitcoincash:qto', amountSats: 778 }]),
    };

    const server = {
      request: vi.fn(async () => {
        throw new Error('should not fetch');
      }),
      requestMany: vi.fn(async () => []),
      subscribe: vi.fn(async () => {}),
      unsubscribe: vi.fn(async () => {}),
      onNotification: vi.fn(() => () => {}),
    };

    mockedElectrumServer.mockReturnValue(server as never);

    const result = await ElectrumService.getTransactionDetails('1'.repeat(64));

    expect(server.request).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      txid: '1'.repeat(64),
      confirmations: 9,
      height: 555,
      feeSats: 222,
      inputs: [{ address: 'bitcoincash:qfrom', amountSats: 1000 }],
      outputs: [{ address: 'bitcoincash:qto', amountSats: 778 }],
    });
  });
});
