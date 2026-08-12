import { beforeEach, describe, expect, it, vi } from 'vitest';

import UTXOManager from '../UTXOManager';
import DatabaseService from '../../DatabaseManager/DatabaseService';
import { store } from '../../../redux/store';

vi.mock('../../DatabaseManager/DatabaseService', () => ({
  default: vi.fn(),
}));

vi.mock('../../../redux/store', () => ({
  store: {
    getState: vi.fn(),
  },
}));

type Row = Record<string, unknown>;

type MockStmt = {
  bind: ReturnType<typeof vi.fn>;
  step: ReturnType<typeof vi.fn>;
  getAsObject: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
  free: ReturnType<typeof vi.fn>;
};

function makeStmt(rows: Row[] = []): MockStmt {
  let idx = 0;
  return {
    bind: vi.fn(),
    step: vi.fn(() => idx < rows.length),
    getAsObject: vi.fn(() => rows[idx++]),
    run: vi.fn(),
    free: vi.fn(),
  };
}

describe('UTXOManager', () => {
  const mockedDatabaseService = vi.mocked(DatabaseService);
  const mockedStore = vi.mocked(store);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetchUTXOsFromDatabase groups utxos into regular and token maps', async () => {
    const queryStmt = makeStmt([
      {
        wallet_id: 5,
        address: 'bitcoincash:q1',
        token_address: 'simpleledger:q1',
        height: 100,
        tx_hash: 'a'.repeat(64),
        tx_pos: 0,
        value: 1000,
        prefix: 'bitcoincash',
        token: null,
      },
      {
        wallet_id: 5,
        address: 'bitcoincash:q2',
        token_address: 'simpleledger:q2',
        height: 101,
        tx_hash: 'b'.repeat(64),
        tx_pos: 1,
        value: 2000,
        prefix: 'bitcoincash',
        token: '{"category":"cat","amount":1}',
      },
    ]);

    const db = {
      prepare: vi.fn(() => queryStmt),
    };

    mockedDatabaseService.mockReturnValue({
      ensureDatabaseStarted: vi.fn(async () => {}),
      getDatabase: vi.fn(() => db),
    } as never);

    mockedStore.getState.mockReturnValue({
      wallet_id: { currentWalletId: 5 },
    } as never);

    const mgr = UTXOManager();
    const result = await mgr.fetchUTXOsFromDatabase([
      { address: 'bitcoincash:q1' },
      { address: 'bitcoincash:q2' },
      { address: 'bitcoincash:q1' },
    ]);

    expect(Object.keys(result.utxosMap).sort()).toEqual([
      'bitcoincash:q1',
      'bitcoincash:q2',
    ]);
    expect(result.utxosMap['bitcoincash:q1']).toHaveLength(1);
    expect(result.cashTokenUtxosMap['bitcoincash:q2']).toHaveLength(1);
    expect(result.cashTokenUtxosMap['bitcoincash:q2'][0].token).toEqual({
      category: 'cat',
      amount: 1,
    });
  });

  it('fetchUTXOsFromDatabase returns empty maps when wallet id is missing', async () => {
    mockedDatabaseService.mockReturnValue({
      ensureDatabaseStarted: vi.fn(async () => {}),
      getDatabase: vi.fn(() => ({ prepare: vi.fn() })),
    } as never);

    mockedStore.getState.mockReturnValue({
      wallet_id: { currentWalletId: null },
    } as never);

    const mgr = UTXOManager();
    const result = await mgr.fetchUTXOsFromDatabase([{ address: 'bitcoincash:q1' }]);

    expect(result).toEqual({ utxosMap: {}, cashTokenUtxosMap: {} });
  });

  it('storeUTXOs rolls back and rethrows when insert fails', async () => {
    const insertStmt = makeStmt();
    insertStmt.run.mockImplementation(() => {
      throw new Error('insert fail');
    });

    const exec = vi.fn();
    const db = {
      exec,
      prepare: vi.fn(() => insertStmt),
    };

    mockedDatabaseService.mockReturnValue({
      ensureDatabaseStarted: vi.fn(async () => {}),
      getDatabase: vi.fn(() => db),
    } as never);

    const mgr = UTXOManager();

    await expect(
      mgr.storeUTXOs([
        {
          wallet_id: 1,
          address: 'bitcoincash:q1',
          height: 0,
          tx_hash: 'a'.repeat(64),
          tx_pos: 0,
          value: 546,
        },
      ])
    ).rejects.toThrow('insert fail');

    expect(exec).toHaveBeenCalledWith('BEGIN TRANSACTION;');
    expect(exec).toHaveBeenCalledWith('ROLLBACK;');
  });
});
