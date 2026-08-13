import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  sendTransactionMock,
  sendTransactionBatchMock,
  fetchWalletAddressesMock,
} = vi.hoisted(() => ({
  sendTransactionMock: vi.fn(),
  sendTransactionBatchMock: vi.fn(),
  fetchWalletAddressesMock: vi.fn(),
}));

vi.mock('../../../services/TransactionService', () => ({
  default: {
    sendTransaction: sendTransactionMock,
    sendTransactionBatch: sendTransactionBatchMock,
    fetchWalletAddresses: fetchWalletAddressesMock,
  },
}));

import TransactionService, {
  EXTENSION_VIEWER_BROADCAST_ERROR,
} from '../TransactionService';

describe('extension TransactionService', () => {
  beforeEach(() => {
    sendTransactionMock.mockReset();
    sendTransactionBatchMock.mockReset();
    fetchWalletAddressesMock.mockReset();
  });

  it('fails closed instead of broadcasting one transaction', async () => {
    await expect(TransactionService.sendTransaction('00')).resolves.toEqual({
      txid: null,
      errorMessage: EXTENSION_VIEWER_BROADCAST_ERROR,
    });
    expect(sendTransactionMock).not.toHaveBeenCalled();
  });

  it('fails closed instead of broadcasting a transaction batch', async () => {
    await expect(
      TransactionService.sendTransactionBatch([{ rawTX: '00' }])
    ).resolves.toEqual([
      {
        txid: null,
        errorMessage: EXTENSION_VIEWER_BROADCAST_ERROR,
      },
    ]);
    expect(sendTransactionBatchMock).not.toHaveBeenCalled();
  });

  it('preserves read-only wallet methods with their original receiver', async () => {
    fetchWalletAddressesMock.mockResolvedValue({
      addresses: [],
      defaultChangeAddress: '',
    });

    await expect(TransactionService.fetchWalletAddresses(7)).resolves.toEqual({
      addresses: [],
      defaultChangeAddress: '',
    });
    expect(fetchWalletAddressesMock).toHaveBeenCalledWith(7);
  });
});
