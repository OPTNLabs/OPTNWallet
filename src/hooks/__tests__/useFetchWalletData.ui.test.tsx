import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { fetchAddressesAndUTXOs } = vi.hoisted(() => ({
  fetchAddressesAndUTXOs: vi.fn(),
}));
vi.mock('../../services/TransactionService', () => ({
  default: { fetchAddressesAndUTXOs },
}));

import useFetchWalletData from '../useFetchWalletData';

describe('useFetchWalletData retry', () => {
  afterEach(() => vi.restoreAllMocks());

  it('clears the old error and retries the same wallet read when the retry key changes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fetchAddressesAndUTXOs
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce({
        addresses: [],
        utxos: [],
        contractAddresses: [],
      });

    const setAddresses = vi.fn();
    const setContractAddresses = vi.fn();
    const setUtxos = vi.fn();
    const setContractUtxos = vi.fn();
    const setChangeAddress = vi.fn();
    const setErrorMessage = vi.fn();
    const { rerender } = renderHook(
      ({ retryKey }) =>
        useFetchWalletData(
          17,
          setAddresses,
          setContractAddresses,
          setUtxos,
          setContractUtxos,
          setChangeAddress,
          setErrorMessage,
          { retryKey }
        ),
      { initialProps: { retryKey: 0 } }
    );

    await waitFor(() => {
      expect(setErrorMessage).toHaveBeenCalledWith(
        'Error fetching addresses and UTXOs: database unavailable'
      );
    });

    rerender({ retryKey: 1 });
    await waitFor(() => {
      expect(fetchAddressesAndUTXOs).toHaveBeenCalledTimes(2);
      expect(setErrorMessage).toHaveBeenLastCalledWith(null);
    });
    expect(fetchAddressesAndUTXOs).toHaveBeenLastCalledWith(17);
    expect(setAddresses).toHaveBeenCalledWith([]);
    expect(setUtxos).toHaveBeenCalledWith([]);
  });
});
