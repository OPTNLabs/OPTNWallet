// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { refreshWalletTransactionHistory } = vi.hoisted(() => ({
  refreshWalletTransactionHistory: vi.fn(),
}));

vi.mock('../../../services/WalletHistoryRefreshService', () => ({
  refreshWalletTransactionHistory,
}));

import { useTransactionHistoryFetch } from '../useTransactionHistoryFetch';

describe('useTransactionHistoryFetch', () => {
  beforeEach(() => {
    refreshWalletTransactionHistory.mockReset();
    refreshWalletTransactionHistory.mockResolvedValue({
      scannedAddresses: [],
      refreshed: true,
    });
  });

  it('bypasses status-hash reuse for a manual full refresh', async () => {
    const { result } = renderHook(() =>
      useTransactionHistoryFetch({
        walletIdParam: '42',
        isInitialized: false,
        transactionCount: 1,
        sessionGeneration: 7,
        dispatch: vi.fn() as never,
      })
    );

    await act(async () => {
      await result.current.fetchTransactionHistory();
    });

    expect(refreshWalletTransactionHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        walletId: 42,
        force: true,
        skipAddresses: undefined,
      })
    );
  });

  it('exposes a failed history refresh and clears it when retry starts', async () => {
    refreshWalletTransactionHistory.mockRejectedValueOnce(new Error('offline'));
    const { result } = renderHook(() =>
      useTransactionHistoryFetch({
        walletIdParam: '42',
        isInitialized: false,
        transactionCount: 0,
        sessionGeneration: 7,
        dispatch: vi.fn() as never,
      })
    );

    await act(async () => {
      await result.current.fetchTransactionHistory();
    });
    expect(result.current.error).toBe(true);

    await act(async () => {
      await result.current.fetchTransactionHistory();
    });
    expect(result.current.error).toBe(false);
    expect(refreshWalletTransactionHistory).toHaveBeenCalledTimes(2);
  });
});
