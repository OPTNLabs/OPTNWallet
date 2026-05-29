import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendTransactionMock = vi.fn();
const addOutputMock = vi.fn();
const trackAttemptMock = vi.fn();
const listActiveMock = vi.fn();
const removeMock = vi.fn();
const retrieveKeysMock = vi.fn();
const requestRefreshMock = vi.fn();

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

vi.mock('../../state/store', () => ({
  store: {
    getState: vi.fn(() => ({ wallet_id: { currentWalletId: 11 } })),
  },
}));

describe('TransactionService.sendTransaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listActiveMock.mockResolvedValue([]);
    retrieveKeysMock.mockResolvedValue([]);
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
    expect(removeMock).toHaveBeenCalledWith('tracked:00aa');
    expect(requestRefreshMock).not.toHaveBeenCalled();
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
