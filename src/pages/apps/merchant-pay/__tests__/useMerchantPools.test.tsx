/** @vitest-environment jsdom */

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchNormalizedCauldronPools } = vi.hoisted(() => ({
  fetchNormalizedCauldronPools: vi.fn(),
}));
const apiClient = {} as never;

vi.mock('../../../../services/cauldron/planner', () => ({
  fetchNormalizedCauldronPools,
}));

import { Network } from '../../../../state/slices/networkSlice';
import { useMerchantPools } from '../useMerchantPools';

describe('useMerchantPools', () => {
  beforeEach(() => {
    fetchNormalizedCauldronPools.mockReset();
  });

  it('shows a recoverable error and retries pool loading on request', async () => {
    let finishRetry: (pools: never[]) => void = () => undefined;
    fetchNormalizedCauldronPools
      .mockRejectedValueOnce(new Error('provider unavailable'))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishRetry = resolve;
          })
      );

    const { result } = renderHook(() =>
      useMerchantPools({
        network: Network.MAINNET,
        apiClient,
        tokenId: 'aa'.repeat(32),
      })
    );

    await waitFor(() => {
      expect(result.current.error).toBe(
        'Unable to load merchant pools right now. Try again in a moment.'
      );
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.pools).toEqual([]);

    act(() => result.current.retry());

    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBeNull();
    expect(fetchNormalizedCauldronPools).toHaveBeenCalledTimes(2);
    await act(async () => finishRetry([]));

    await waitFor(() => {
      expect(result.current.error).toBeNull();
      expect(result.current.loading).toBe(false);
    });
  });

  it('clears pool state when no stablecoin is selected', async () => {
    const { result } = renderHook(() =>
      useMerchantPools({
        network: Network.MAINNET,
        apiClient,
      })
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.pools).toEqual([]);
    expect(result.current.error).toBeNull();
    expect(fetchNormalizedCauldronPools).not.toHaveBeenCalled();
  });
});
