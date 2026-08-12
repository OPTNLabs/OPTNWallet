import { beforeEach, describe, expect, it, vi } from 'vitest';

const records = new Map<string, unknown>();

vi.mock('localforage', () => ({
  default: {
    createInstance: vi.fn(() => ({
      getItem: vi.fn(async (key: string) => records.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: unknown) => {
        records.set(key, value);
        return value;
      }),
      removeItem: vi.fn(async (key: string) => {
        records.delete(key);
      }),
      iterate: vi.fn(),
    })),
  },
}));

describe('OutboundTransactionTracker Fusion completion', () => {
  beforeEach(() => {
    records.clear();
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
});
