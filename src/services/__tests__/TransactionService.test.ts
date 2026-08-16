import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendTransactionMock = vi.fn();
const addOutputMock = vi.fn();
const trackAttemptMock = vi.fn();
const listActiveMock = vi.fn();
const removeMock = vi.fn();
const retrieveKeysMock = vi.fn();
const requestRefreshMock = vi.fn();
const reservedFusionOutpointsMock = vi.fn();

vi.mock('../../apis/TransactionManager/TransactionManager', () => ({
  default: () => ({
    sendTransaction: sendTransactionMock,
    buildTransaction: vi.fn(),
    addOutput: addOutputMock,
  }),
}));

vi.mock('../OutboundTransactionTracker', () => ({
  default: {
    listActive: listActiveMock,
    trackAttempt: trackAttemptMock,
    remove: removeMock,
  },
  deriveTrackedTxid: vi.fn((rawTx: string) => `tracked:${rawTx}`),
}));

vi.mock('../../apis/DatabaseManager/DatabaseService', () => ({
  default: vi.fn(),
}));

vi.mock('../KeyService', () => ({
  default: {
    retrieveKeys: retrieveKeysMock,
  },
}));

vi.mock('../../workers/UTXOWorkerService', () => ({
  optimisticRemoveSpentByOutpoints: vi.fn(),
  requestUTXORefreshForMany: requestRefreshMock,
}));

vi.mock('../WalletBackendSyncService', () => ({
  default: { observeTransaction: vi.fn() },
}));

vi.mock('../../platform/desktop/fusionRoundState', () => ({
  reservedOutpoints: (...args: unknown[]) =>
    reservedFusionOutpointsMock(...args),
}));

vi.mock('../../state/store', () => ({
  store: {
    getState: vi.fn(() => ({ wallet_id: { currentWalletId: 11 } })),
  },
}));

describe('TransactionService.sendTransaction', () => {
  beforeEach(async () => {
    // sendTransaction kicks off tracker and refresh work without awaiting it, so
    // the previous test's calls can still be in flight. Clearing the mocks first
    // lets a stray call land inside THIS test, and the assertions here are
    // negative — not.toHaveBeenCalled() — so a late arrival fails a test that
    // never triggered it. Red only under parallel load, green in isolation.
    // Let the detached work settle before resetting the counters.
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.clearAllMocks();
    listActiveMock.mockResolvedValue([]);
    retrieveKeysMock.mockResolvedValue([]);
    reservedFusionOutpointsMock.mockReturnValue(new Set());
  });

  it('clears any pending outbound record when broadcast returns an error', async () => {
    sendTransactionMock.mockResolvedValue({
      txid: 'deadbeef',
      errorMessage: 'Error sending transaction: mandatory-script-verify-flag-failed',
    });

    const { default: TransactionService } = await import('../TransactionService');

    const result = await TransactionService.sendTransaction('00aa');

    expect(result.errorMessage).toContain('mandatory-script-verify-flag-failed');
    expect(trackAttemptMock).not.toHaveBeenCalled();
    expect(removeMock).toHaveBeenCalledWith('tracked:00aa', 11);
    expect(requestRefreshMock).not.toHaveBeenCalled();
  });

  it('allows a new send when the syncing transaction reserved different inputs', async () => {
    listActiveMock.mockResolvedValue([
      {
        txid: 'old',
        spentOutpoints: [{ tx_hash: 'old-input', tx_pos: 0 }],
      },
    ]);
    sendTransactionMock.mockResolvedValue({
      txid: 'new-txid',
      errorMessage: null,
      broadcastState: 'broadcasted',
    });

    const { default: TransactionService } = await import('../TransactionService');
    const result = await TransactionService.sendTransaction(
      '00bb',
      [
        {
          tx_hash: 'new-input',
          tx_pos: 1,
          address: 'bchtest:qnew',
          value: 50_000,
        } as never,
      ]
    );

    expect(result.txid).toBe('new-txid');
    expect(sendTransactionMock).toHaveBeenCalledWith('00bb');
  });

  it('keeps the send lock when the new transaction reuses a reserved input', async () => {
    listActiveMock.mockResolvedValue([
      {
        txid: 'old',
        spentOutpoints: [{ tx_hash: 'same-input', tx_pos: 2 }],
      },
    ]);

    const { default: TransactionService } = await import('../TransactionService');
    const result = await TransactionService.sendTransaction(
      '00cc',
      [
        {
          tx_hash: 'same-input',
          tx_pos: 2,
          address: 'bchtest:qsame',
          value: 50_000,
        } as never,
      ]
    );

    expect(result.errorMessage).toContain('already using one of these UTXOs');
    expect(sendTransactionMock).not.toHaveBeenCalled();
  });

  it('does not broadcast an input reserved by an in-flight Fusion round', async () => {
    reservedFusionOutpointsMock.mockReturnValue(
      new Set(['fusion-input:3'])
    );

    const { default: TransactionService } = await import('../TransactionService');
    const result = await TransactionService.sendTransaction(
      '00dd',
      [
        {
          tx_hash: 'fusion-input',
          tx_pos: 3,
          address: 'bchtest:qfusion',
          value: 50_000,
        } as never,
      ]
    );

    expect(result.errorMessage).toContain('Fusion round');
    expect(sendTransactionMock).not.toHaveBeenCalled();
  });
});

describe('TransactionService.addOutput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('initializes the transaction manager before adding an output', async () => {
    addOutputMock.mockReturnValue({
      recipientAddress: 'bitcoincash:qrecipient',
      amount: 1000,
    });

    const { default: TransactionService } = await import('../TransactionService');

    const result = TransactionService.addOutput(
      'bitcoincash:qrecipient',
      1000,
      0,
      '',
      [],
      []
    );

    expect(result).toEqual({
      recipientAddress: 'bitcoincash:qrecipient',
      amount: 1000,
    });
    expect(addOutputMock).toHaveBeenCalledWith(
      'bitcoincash:qrecipient',
      1000,
      0,
      '',
      [],
      [],
      undefined,
      undefined
    );
  });
});
