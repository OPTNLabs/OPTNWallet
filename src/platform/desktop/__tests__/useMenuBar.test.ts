import { describe, expect, it, vi } from 'vitest';

import { ROUTE_PATHS } from '../../../navigation/routes';
import { resetWallet } from '../../../state/slices/walletSlice';
import {
  MENU_ACTION_EVENT,
  attachDesktopMenu,
  dispatchDesktopMenuAction,
  openSavedWalletFromMenu,
  refreshWalletFromMenu,
  routeMenuActionToFocusedWindow,
} from '../useMenuBar';

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

describe('desktop menu window isolation', () => {
  it('attaches the menu to only the current window on Windows and Linux', async () => {
    const menu = {
      setAsWindowMenu: vi.fn(async () => null),
      setAsAppMenu: vi.fn(async () => null),
    };
    const currentWindow = { label: 'wallet-6' };

    const scope = await attachDesktopMenu(menu, currentWindow, false);

    expect(scope).toBe('window');
    expect(menu.setAsWindowMenu).toHaveBeenCalledWith(currentWindow);
    expect(menu.setAsAppMenu).not.toHaveBeenCalled();
  });

  it('uses the required app menu on macOS', async () => {
    const menu = {
      setAsWindowMenu: vi.fn(async () => null),
      setAsAppMenu: vi.fn(async () => null),
    };

    const scope = await attachDesktopMenu(menu, { label: 'wallet-7' }, true);

    expect(scope).toBe('app');
    expect(menu.setAsAppMenu).toHaveBeenCalledOnce();
    expect(menu.setAsWindowMenu).not.toHaveBeenCalled();
  });

  it('routes an app-menu action to the focused wallet window', async () => {
    const emitted: Array<{ label: string; event: string; payload: unknown }> = [];
    const windows = [
      {
        label: 'wallet-5',
        isFocused: async () => false,
        emit: async (event: string, payload: unknown) => {
          emitted.push({ label: 'wallet-5', event, payload });
        },
      },
      {
        label: 'wallet-6',
        isFocused: async () => true,
        emit: async (event: string, payload: unknown) => {
          emitted.push({ label: 'wallet-6', event, payload });
        },
      },
    ];

    const target = await routeMenuActionToFocusedWindow(
      'export_wallet',
      windows
    );

    expect(target).toBe('wallet-6');
    expect(emitted).toEqual([
      {
        label: 'wallet-6',
        event: MENU_ACTION_EVENT,
        payload: { id: 'export_wallet' },
      },
    ]);
  });

  it('falls back to the originating window when focus cannot be resolved', async () => {
    const emitted: string[] = [];
    const windows = [
      {
        label: 'wallet-5',
        isFocused: async () => false,
        emit: async () => {
          emitted.push('wallet-5');
        },
      },
      {
        label: 'wallet-7',
        isFocused: async () => {
          throw new Error('focus unavailable');
        },
        emit: async () => {
          emitted.push('wallet-7');
        },
      },
    ];

    const target = await routeMenuActionToFocusedWindow(
      'lock_wallet',
      windows,
      'wallet-7'
    );

    expect(target).toBe('wallet-7');
    expect(emitted).toEqual(['wallet-7']);
  });

  it('keeps a per-window menu action bound to its originating window', async () => {
    const emitted: string[] = [];
    const windows = [
      {
        label: 'wallet-5',
        isFocused: async () => true,
        emit: async () => {
          emitted.push('wallet-5');
        },
      },
      {
        label: 'wallet-7',
        isFocused: async () => false,
        emit: async () => {
          emitted.push('wallet-7');
        },
      },
    ];

    const target = await routeMenuActionToFocusedWindow(
      'lock_wallet',
      windows,
      'wallet-7'
    );

    expect(target).toBe('wallet-7');
    expect(emitted).toEqual(['wallet-7']);
  });

  it('fails closed for an app-menu action when no focused window is known', async () => {
    const emit = vi.fn(async () => {});
    const windows = [
      {
        label: 'wallet-5',
        isFocused: async () => false,
        emit,
      },
      {
        label: 'wallet-6',
        isFocused: async () => {
          throw new Error('focus unavailable');
        },
        emit,
      },
    ];

    const target = await routeMenuActionToFocusedWindow(
      'export_wallet',
      windows
    );

    expect(target).toBeNull();
    expect(emit).not.toHaveBeenCalled();
  });
});

describe('desktop menu action dispatch', () => {
  const actions = () => ({
    openPicker: vi.fn(async () => {}),
    openWalletFile: vi.fn(async () => {}),
    openSavedWallet: vi.fn(),
    lockWallet: vi.fn(),
    receive: vi.fn(),
    send: vi.fn(),
    history: vi.fn(),
    exportWallet: vi.fn(async () => {}),
    settings: vi.fn(),
    toggleTheme: vi.fn(),
    refreshWallet: vi.fn(async () => {}),
    showAbout: vi.fn(),
  });

  it('opens the selected saved wallet in the focused window', async () => {
    const handlers = actions();

    const handled = await dispatchDesktopMenuAction(
      'open_wallet_7',
      handlers
    );

    expect(handled).toBe(true);
    expect(handlers.openSavedWallet).toHaveBeenCalledWith(7);
  });

  it('maps Refresh Wallet to a real wallet sync action', async () => {
    const handlers = actions();

    const handled = await dispatchDesktopMenuAction(
      'refresh_wallet',
      handlers
    );

    expect(handled).toBe(true);
    expect(handlers.refreshWallet).toHaveBeenCalledOnce();
  });

  it('rejects malformed and unknown menu ids', async () => {
    const handlers = actions();

    await expect(
      dispatchDesktopMenuAction('open_wallet_not-a-number', handlers)
    ).resolves.toBe(false);
    await expect(
      dispatchDesktopMenuAction('unknown_action', handlers)
    ).resolves.toBe(false);
    expect(handlers.openSavedWallet).not.toHaveBeenCalled();
  });
});

describe('refreshWalletFromMenu', () => {
  it('uses a fresh wallet-wide reconciliation instead of reloading the WebView', async () => {
    const snapshot = { 'bchtest:qwallet': [] };
    const reconcile = vi.fn(async () => snapshot);
    const requestTrailing = vi.fn();

    const refreshed = await refreshWalletFromMenu(
      5,
      reconcile,
      requestTrailing,
      () => ({ currentWalletId: 5, sessionGeneration: 2 })
    );

    expect(refreshed).toBe(true);
    expect(reconcile).toHaveBeenCalledWith(5);
    expect(requestTrailing).not.toHaveBeenCalled();
  });

  it('queues one trailing refresh when an older reconciliation was joined', async () => {
    const reconcile = vi.fn(async () => null);
    const requestTrailing = vi.fn();

    const refreshed = await refreshWalletFromMenu(
      6,
      reconcile,
      requestTrailing,
      () => ({ currentWalletId: 6, sessionGeneration: 4 })
    );

    expect(refreshed).toBe(false);
    expect(requestTrailing).toHaveBeenCalledWith(0);
  });

  it('does nothing when no wallet is open', async () => {
    const reconcile = vi.fn(async () => ({}));
    const requestTrailing = vi.fn();

    const refreshed = await refreshWalletFromMenu(
      0,
      reconcile,
      requestTrailing,
      () => ({ currentWalletId: 0, sessionGeneration: 1 })
    );

    expect(refreshed).toBe(false);
    expect(reconcile).not.toHaveBeenCalled();
    expect(requestTrailing).not.toHaveBeenCalled();
  });

  it('does not queue a trailing refresh after the wallet session changes', async () => {
    const reconcile = vi.fn(async () => null);
    const requestTrailing = vi.fn();
    const getWalletSession = vi
      .fn()
      .mockReturnValueOnce({ currentWalletId: 5, sessionGeneration: 9 })
      .mockReturnValueOnce({ currentWalletId: 6, sessionGeneration: 10 });

    const refreshed = await refreshWalletFromMenu(
      5,
      reconcile,
      requestTrailing,
      getWalletSession
    );

    expect(refreshed).toBe(false);
    expect(requestTrailing).not.toHaveBeenCalled();
  });
});
