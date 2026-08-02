import { describe, expect, it, vi } from 'vitest';

import { ROUTE_PATHS } from '../../../navigation/routes';
import { resetWallet } from '../../../state/slices/walletSlice';
import {
  MENU_ACTION_EVENT,
  menuActionForKeyboardEvent,
  attachDesktopMenu,
  dispatchDesktopMenuAction,
  openSavedWalletFromMenu,
  refreshWalletFromMenu,
  walletClaimToRelease,
  routeMenuActionToFocusedWindow,
} from '../useMenuBar';

describe('wallet ownership lifecycle', () => {
  it('keeps the claim through a StrictMode effect replay', () => {
    expect(walletClaimToRelease(5, 5)).toBeNull();
  });

  it('releases only when this window actually leaves the wallet', () => {
    expect(walletClaimToRelease(5, 0)).toBe(5);
    expect(walletClaimToRelease(5, 6)).toBe(5);
    expect(walletClaimToRelease(0, 6)).toBeNull();
  });
});

describe('openSavedWalletFromMenu', () => {
  it('releases and locks the current wallet before routing to wallet 5', async () => {
    const lock = vi.fn();
    const dispatch = vi.fn();
    const navigate = vi.fn();
    const flush = vi.fn((callback: () => void) => callback());
    const release = vi.fn(async () => undefined);

    await openSavedWalletFromMenu(
      5,
      navigate as never,
      dispatch as never,
      lock,
      flush,
      4,
      'wallet-window-a',
      release
    );

    expect(release).toHaveBeenCalledWith(4, 'wallet-window-a');
    expect(lock).toHaveBeenCalledOnce();
    expect(flush).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith(resetWallet());
    expect(navigate).toHaveBeenCalledWith(ROUTE_PATHS.landing, {
      state: { openWalletId: 5 },
    });
    expect(release.mock.invocationCallOrder[0]).toBeLessThan(
      lock.mock.invocationCallOrder[0]
    );
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
        emitTo: async (target: string, event: string, payload: unknown) => {
          emitted.push({ label: target, event, payload });
        },
      },
      {
        label: 'wallet-6',
        isFocused: async () => true,
        emitTo: async (target: string, event: string, payload: unknown) => {
          emitted.push({ label: target, event, payload });
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
        emitTo: async (target: string) => {
          emitted.push(target);
        },
      },
      {
        label: 'wallet-7',
        isFocused: async () => {
          throw new Error('focus unavailable');
        },
        emitTo: async (target: string) => {
          emitted.push(target);
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

  it('prefers the FOCUSED window over a stale originating label', async () => {
    // Observed in the running app: clicking Lock in the right-hand window locked
    // the left-hand wallet. `originatingLabel` is captured by whichever window
    // BUILT the menu, and the menu is rebuilt on wallet-state changes, so the
    // menu on screen can carry another window's label. Focus reflects where the
    // click actually happened; the builder's label does not.
    const emitted: string[] = [];
    const windows = [
      {
        label: 'wallet-5',
        isFocused: async () => true,
        emitTo: async (target: string) => {
          emitted.push(target);
        },
      },
      {
        label: 'wallet-7',
        isFocused: async () => false,
        emitTo: async (target: string) => {
          emitted.push(target);
        },
      },
    ];

    const target = await routeMenuActionToFocusedWindow(
      'lock_wallet',
      windows,
      'wallet-7'
    );

    expect(target).toBe('wallet-5');
    expect(emitted).toEqual(['wallet-5']);
  });

  it('targets ONE window: a menu action must never reach the others', async () => {
    // Regression: routing computed the correct window and then called
    // window.emit(), which Tauri documents as "emits an event to ALL targets".
    // Every window's listener ran the command, so Lock Wallet locked every open
    // wallet. Asserting the requested TARGET (not merely that some emit fired)
    // is what distinguishes routing from broadcasting.
    const delivered: string[] = [];
    const windows = ['wallet-5', 'wallet-6', 'wallet-7'].map((label) => ({
      label,
      isFocused: async () => false,
      emitTo: async (target: string) => {
        delivered.push(target);
      },
    }));

    await routeMenuActionToFocusedWindow('lock_wallet', windows, 'wallet-6');

    expect(delivered).toEqual(['wallet-6']);
    expect(delivered).not.toContain('wallet-5');
    expect(delivered).not.toContain('wallet-7');
  });

  it('fails closed for an app-menu action when no focused window is known', async () => {
    const emitTo = vi.fn(async () => {});
    const windows = [
      {
        label: 'wallet-5',
        isFocused: async () => false,
        emitTo,
      },
      {
        label: 'wallet-6',
        isFocused: async () => {
          throw new Error('focus unavailable');
        },
        emitTo,
      },
    ];

    const target = await routeMenuActionToFocusedWindow(
      'export_wallet',
      windows
    );

    expect(target).toBeNull();
    expect(emitTo).not.toHaveBeenCalled();
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

describe('keyboard accelerators', () => {
  const chord = (over: Partial<Parameters<typeof menuActionForKeyboardEvent>[0]>) =>
    menuActionForKeyboardEvent({
      key: 'r',
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      ...over,
    });

  it('maps the wallet chords the WebView would otherwise swallow', () => {
    // Registered menu accelerators never fire: WebView2 claims Ctrl+R (reload)
    // and Ctrl+N (new window) before the native menu sees them, so Ctrl+R was
    // reloading the WebView instead of refreshing the wallet.
    expect(chord({ key: 'r' })).toBe('refresh_wallet');
    expect(chord({ key: 'n' })).toBe('new_wallet');
    expect(chord({ key: 'l' })).toBe('lock_wallet');
  });

  it('accepts Cmd on macOS as well as Ctrl', () => {
    expect(chord({ key: 'r', ctrlKey: false, metaKey: true })).toBe('refresh_wallet');
  });

  it('is case-insensitive, so caps lock does not break it', () => {
    expect(chord({ key: 'R' })).toBe('refresh_wallet');
  });

  it('ignores a bare key with no modifier', () => {
    expect(chord({ key: 'r', ctrlKey: false })).toBeNull();
  });

  it('leaves other chords alone rather than swallowing them', () => {
    // Ctrl+Shift+R is a different chord; claiming it would break the browser
    // hard-reload users expect while developing, and it is not our command.
    expect(chord({ key: 'r', shiftKey: true })).toBeNull();
    expect(chord({ key: 'n', altKey: true })).toBeNull();
    expect(chord({ key: 'q' })).toBeNull();
  });
});
