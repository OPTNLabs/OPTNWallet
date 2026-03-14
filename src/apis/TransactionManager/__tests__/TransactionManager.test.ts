import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TransactionHistoryItem, UTXO } from '../../../types/types';
import TransactionManager from '../TransactionManager';
import DatabaseService from '../../DatabaseManager/DatabaseService';
import ElectrumService from '../../../services/ElectrumService';
import TransactionBuilderHelper from '../TransactionBuilderHelper';
import { store } from '../../../redux/store';
import { TOKEN_OUTPUT_SATS } from '../../../utils/constants';

vi.mock('../../DatabaseManager/DatabaseService', () => ({
  default: vi.fn(),
}));

vi.mock('../../../services/ElectrumService', () => ({
  default: {
    getTransactionHistory: vi.fn(),
  },
}));

vi.mock('../TransactionBuilderHelper', () => ({
  default: vi.fn(),
}));

vi.mock('../../../redux/store', () => ({
  store: {
    dispatch: vi.fn(),
    getState: vi.fn(() => ({})),
  },
}));

describe('TransactionManager', () => {
  const mockedDatabaseService = vi.mocked(DatabaseService);
  const mockedElectrumService = vi.mocked(ElectrumService);
  const mockedTxBuilderHelper = vi.mocked(TransactionBuilderHelper);
  const mockedStore = vi.mocked(store);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetchAndStoreTransactionHistory upserts fetched history in a transaction', async () => {
    const history: TransactionHistoryItem[] = [
      { tx_hash: 'a'.repeat(64), height: 100 },
      { tx_hash: 'b'.repeat(64), height: 101 },
    ];

    mockedElectrumService.getTransactionHistory.mockResolvedValue(history as never);

    const upsertStmt = {
      run: vi.fn(),
      free: vi.fn(),
    };

    const db = {
      exec: vi.fn(),
      prepare: vi.fn(() => upsertStmt),
    };

    mockedDatabaseService.mockReturnValue({
      getDatabase: vi.fn(() => db),
    } as never);

    const tm = TransactionManager();
    const result = await tm.fetchAndStoreTransactionHistory(7, 'bitcoincash:q1');

    expect(result).toEqual(history);
    expect(db.exec).toHaveBeenCalledWith('BEGIN TRANSACTION');
    expect(db.exec).toHaveBeenCalledWith('COMMIT');
    expect(upsertStmt.run).toHaveBeenCalledTimes(2);
    expect(upsertStmt.free).toHaveBeenCalledTimes(1);
  });

  it('sendTransaction returns txid on success and errorMessage on failure', async () => {
    const sendTransaction = vi
      .fn()
      .mockResolvedValueOnce('txid-ok')
      .mockRejectedValueOnce(new Error('broadcast failed'));

    mockedTxBuilderHelper.mockReturnValue({
      sendTransaction,
      buildTransaction: vi.fn(),
    } as never);

    const tm = TransactionManager();

    await expect(tm.sendTransaction('00aa')).resolves.toEqual({
      txid: 'txid-ok',
      errorMessage: null,
    });

    const fail = await tm.sendTransaction('00bb');
    expect(fail.txid).toBeNull();
    expect(fail.errorMessage).toContain('broadcast failed');
  });

  it('sendTransaction returns derived txid on ambiguous broadcast failure and does not rebroadcast same raw tx', async () => {
    const sendTransaction = vi
      .fn()
      .mockRejectedValueOnce(new Error('request(blockchain.transaction.broadcast) timed out after 12000ms'));

    mockedTxBuilderHelper.mockReturnValue({
      sendTransaction,
      buildTransaction: vi.fn(),
    } as never);

    const tm = TransactionManager();
    const rawTx = '01000000000100';

    const first = await tm.sendTransaction(rawTx);
    expect(first.txid).toMatch(/^[0-9a-f]{64}$/);
    expect(first.errorMessage).toBeNull();

    const second = await tm.sendTransaction(rawTx);
    expect(second).toEqual(first);
    expect(sendTransaction).toHaveBeenCalledTimes(1);
  });

  it('addOutput builds token output from existing token UTXO and dispatches it', () => {
    const tm = TransactionManager();

    const selectedUtxos: UTXO[] = [
      {
        address: 'bitcoincash:qsource',
        height: 0,
        tx_hash: 'c'.repeat(64),
        tx_pos: 1,
        value: 2000,
        token: { category: 'cat1', amount: 100 },
      },
    ];

    const out = tm.addOutput(
      'bitcoincash:qrecipient',
      1,
      50,
      'cat1',
      selectedUtxos,
      [
        {
          address: 'bitcoincash:qrecipient',
          tokenAddress: 'simpleledger:qrecipient',
        },
      ]
    );

    expect(out).toBeDefined();
    expect(out?.recipientAddress).toBe('simpleledger:qrecipient');
    expect(out?.token).toEqual({ category: 'cat1', amount: 50 });
    expect(Number(out?.amount)).toBeGreaterThanOrEqual(TOKEN_OUTPUT_SATS);

    expect(mockedStore.dispatch).toHaveBeenCalledTimes(1);
  });

  it('buildTransaction auto-adds change output when possible', async () => {
    const buildTransaction = vi
      .fn()
      .mockResolvedValueOnce('00'.repeat(100)) // no-change estimate: 100 bytes
      .mockResolvedValueOnce('00'.repeat(110)) // with placeholder: 110 bytes
      .mockResolvedValueOnce('00'.repeat(110)); // final

    mockedTxBuilderHelper.mockReturnValue({
      buildTransaction,
      sendTransaction: vi.fn(),
    } as never);

    const tm = TransactionManager();

    const selectedUtxos: UTXO[] = [
      {
        address: 'bitcoincash:qsource',
        height: 0,
        tx_hash: 'd'.repeat(64),
        tx_pos: 0,
        value: 2000,
      },
    ];

    const outputs = [
      {
        recipientAddress: 'bitcoincash:qdest',
        amount: 1000,
      },
    ];

    const res = await tm.buildTransaction(
      outputs,
      null,
      'bitcoincash:qchange',
      selectedUtxos
    );

    expect(res.errorMsg).toBe('');
    expect(res.finalTransaction).toBe('00'.repeat(110));
    expect(res.finalOutputs).toHaveLength(2);
    expect(res.finalOutputs?.[1]).toMatchObject({
      recipientAddress: 'bitcoincash:qchange',
      amount: 890,
    });
  });

  it('buildTransaction returns error when no inputs are selected', async () => {
    mockedTxBuilderHelper.mockReturnValue({
      buildTransaction: vi.fn(),
      sendTransaction: vi.fn(),
    } as never);

    const tm = TransactionManager();
    const res = await tm.buildTransaction(
      [{ recipientAddress: 'bitcoincash:qdest', amount: 1000 }],
      null,
      'bitcoincash:qchange',
      []
    );

    expect(res.finalTransaction).toBe('');
    expect(res.finalOutputs).toEqual([
      { recipientAddress: 'bitcoincash:qdest', amount: 1000 },
    ]);
    expect(res.errorMsg).toContain('No inputs selected.');
  });
});
