import { describe, expect, it, vi } from 'vitest';

import { ROUTE_PATHS } from '../../../navigation/routes';
import { resetWallet } from '../../../state/slices/walletSlice';
import { openSavedWalletFromMenu } from '../useMenuBar';

describe('openSavedWalletFromMenu', () => {
  it('locks the current wallet before resetting state and routing to wallet 5', () => {
    const lock = vi.fn();
    const dispatch = vi.fn();
    const navigate = vi.fn();
    const flush = vi.fn((callback: () => void) => callback());

    openSavedWalletFromMenu(
      5,
      navigate as never,
      dispatch as never,
      lock,
      flush
    );

    expect(lock).toHaveBeenCalledOnce();
    expect(flush).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith(resetWallet());
    expect(navigate).toHaveBeenCalledWith(ROUTE_PATHS.landing, {
      state: { openWalletId: 5 },
    });
    expect(lock.mock.invocationCallOrder[0]).toBeLessThan(
      dispatch.mock.invocationCallOrder[0]
    );
    expect(dispatch.mock.invocationCallOrder[0]).toBeLessThan(
      navigate.mock.invocationCallOrder[0]
    );
  });
});
