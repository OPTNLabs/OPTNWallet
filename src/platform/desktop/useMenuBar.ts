// Builds the desktop menu bar (File / Wallet / View / Help) on the FRONTEND via
// @tauri-apps/api/menu, because File → Open Wallet must list the actual saved
// wallets, which only the JS side (WASM SQLite DB) knows. The Rust static menu
// is disabled (see lib.rs); this is the single source of truth.
//
// Rebuilt whenever the wallet list or the open wallet changes, so Open Wallet
// stays current and wallet-scoped items grey out on the picker.
import { useEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import { useNavigate, type NavigateFunction } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { Menu, Submenu, MenuItem, PredefinedMenuItem } from '@tauri-apps/api/menu';
import { listen as listenToEvent } from '@tauri-apps/api/event';
import { resyncAfterWalletClosed } from './walletSessionRelease';
import {
  getAllWebviewWindows,
} from '@tauri-apps/api/webviewWindow';
import { appDataDir, join } from '@tauri-apps/api/path';
import { AppDispatch, RootState, store } from '../../state/store';
import { selectWalletId, resetWallet } from '../../state/slices/walletSlice';
import type { UTXO } from '../../types/types';
import { reconcileActiveWalletUtxos } from '../../services/WalletUtxoRefreshService';
import { requestWalletUTXORefresh } from '../../workers/UTXOWorkerService';
import { useTheme } from '../../app/theme/useTheme';
import { ROUTE_PATHS, transactionsRoute } from '../../navigation/routes';
import { OptnKeyManager } from './OptnKeyManager';
import WalletManager from '../../apis/WalletManager/WalletManager';
import { openWalletPickerWindow } from './walletWindow';
import {
  refreshWalletOpenClaim,
  releaseWalletOpen,
  OPEN_CLAIM_HEARTBEAT_MS,
} from './walletOpenRegistry';

// Landing page listens for these.
export const OPEN_WALLET_EVENT = 'optn:open-wallet'; // quick-open a saved DB wallet by id
export const IMPORT_FILE_EVENT = 'optn:import-wallet-file'; // open a parsed .optn file
// Fired after create/import/delete so the menu re-reads the wallet list.
export const WALLETS_CHANGED_EVENT = 'optn:wallets-changed';
export const MENU_ACTION_EVENT = 'optn:menu-action';

function currentWebviewLabel(): string {
  try {
    const instance = new URL(window.location.href).searchParams.get('instance');
    if (instance) return instance;
  } catch {
    // Tests and non-browser callers can omit location entirely.
  }
  return 'main';
}

interface DesktopMenuLike<TWindow> {
  setAsAppMenu: () => Promise<unknown>;
  setAsWindowMenu: (window: TWindow) => Promise<unknown>;
}

interface MenuTargetWindow {
  label: string;
  isFocused: () => Promise<boolean>;
  /**
   * MUST be `emitTo`, never `emit`.
   *
   * Tauri's `emit` "emits an event to ALL targets" — calling it on a window
   * object does not scope the event to that window. Routing the action to the
   * right window and then broadcasting undoes the routing entirely: every
   * window's listener runs the command, so Lock Wallet locked every open wallet
   * and Export Wallet fired in all of them. `emitTo(label, ...)` is the only
   * form that actually targets one window.
   */
  emitTo: (target: string, event: string, payload?: unknown) => Promise<void>;
}

export interface DesktopMenuActionHandlers {
  openPicker: () => void | Promise<void>;
  openWalletFile: () => void | Promise<void>;
  openSavedWallet: (walletId: number) => void | Promise<void>;
  lockWallet: () => void | Promise<void>;
  receive: () => void | Promise<void>;
  send: () => void | Promise<void>;
  history: () => void | Promise<void>;
  exportWallet: () => void | Promise<void>;
  settings: () => void | Promise<void>;
  toggleTheme: () => void | Promise<void>;
  refreshWallet: () => void | Promise<void>;
  showAbout: () => void | Promise<void>;
}

export async function attachDesktopMenu<TWindow>(
  menu: DesktopMenuLike<TWindow>,
  currentWindow: TWindow,
  requiresAppMenu: boolean
): Promise<'app' | 'window'> {
  if (requiresAppMenu) {
    await menu.setAsAppMenu();
    return 'app';
  }
  await menu.setAsWindowMenu(currentWindow);
  return 'window';
}

export async function routeMenuActionToFocusedWindow(
  id: string,
  windows: readonly MenuTargetWindow[],
  originatingLabel?: string
): Promise<string | null> {
  // FOCUS FIRST, on every platform.
  //
  // `originatingLabel` is the label captured by the window that BUILT the menu,
  // and trusting it sent actions to the wrong wallet: clicking Lock in the
  // right-hand window locked the left-hand one. The menu is rebuilt whenever
  // wallet state changes, and the last build wins for the whole app, so the menu
  // you see in one window can carry another window's label. Focus does not have
  // that problem — clicking a window's menu bar focuses that window — so it is
  // the only signal that reflects where the click actually happened.
  let focused: MenuTargetWindow | undefined;
  for (const candidate of windows) {
    try {
      if (await candidate.isFocused()) {
        focused = candidate;
        break;
      }
    } catch {
      // A closing window can disappear between enumeration and focus lookup.
    }
  }

  if (focused) {
    await focused.emitTo(focused.label, MENU_ACTION_EVENT, { id });
    return focused.label;
  }

  // Only when focus is genuinely unknown do we fall back to the originating
  // window, and only if it still exists. Never broadcast: a wallet action that
  // cannot be attributed to one window must not run in all of them.
  if (originatingLabel !== undefined) {
    const origin = windows.find(
      (candidate) => candidate.label === originatingLabel
    );
    if (!origin) return null;
    await origin.emitTo(origin.label, MENU_ACTION_EVENT, { id });
    return origin.label;
  }

  return null;
}

/**
 * Menu action for a keyboard chord, or null when the chord is not ours.
 *
 * The registered menu accelerators never fire: the WebView claims these chords
 * first (Ctrl+R is its reload, Ctrl+N its new window), so the keystroke is
 * consumed before the native menu sees it. Matching here lets the app suppress
 * the WebView default and run the real command — Ctrl+R must refresh the wallet,
 * not reload the WebView, because a reload interrupts in-flight network and
 * Fusion work.
 *
 * Modifier-exact on purpose: Ctrl+Shift+R and Ctrl+Alt+N are different chords and
 * must fall through rather than be silently swallowed.
 */
export function menuActionForKeyboardEvent(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): string | null {
  if (!(event.ctrlKey || event.metaKey)) return null;
  if (event.altKey || event.shiftKey) return null;
  return (
    { n: 'new_wallet', l: 'lock_wallet', r: 'refresh_wallet' }[
      event.key.toLowerCase()
    ] ?? null
  );
}

export async function dispatchDesktopMenuAction(
  id: string,
  handlers: DesktopMenuActionHandlers
): Promise<boolean> {
  const savedWalletMatch = /^open_wallet_(\d+)$/.exec(id);
  if (savedWalletMatch) {
    const walletId = Number(savedWalletMatch[1]);
    if (!Number.isSafeInteger(walletId) || walletId <= 0) return false;
    await handlers.openSavedWallet(walletId);
    return true;
  }

  const action = {
    new_wallet: handlers.openPicker,
    open_wallet_file: handlers.openWalletFile,
    lock_wallet: handlers.lockWallet,
    receive: handlers.receive,
    send: handlers.send,
    history: handlers.history,
    export_wallet: handlers.exportWallet,
    settings: handlers.settings,
    toggle_theme: handlers.toggleTheme,
    refresh_wallet: handlers.refreshWallet,
    about: handlers.showAbout,
  }[id];
  if (!action) return false;

  await action();
  return true;
}

export async function refreshWalletFromMenu(
  walletId: number,
  reconcile: (
    activeWalletId: number
  ) => Promise<Record<string, UTXO[]> | null> = reconcileActiveWalletUtxos,
  requestTrailing: (delayMs?: number) => void = requestWalletUTXORefresh,
  getWalletSession: () => {
    currentWalletId: number;
    sessionGeneration?: number;
  } = () => store.getState().wallet_id
): Promise<boolean> {
  if (!Number.isSafeInteger(walletId) || walletId <= 0) return false;
  const initialSession = getWalletSession();
  if (initialSession.currentWalletId !== walletId) return false;
  const initialGeneration = initialSession.sessionGeneration ?? 0;
  const snapshot = await reconcile(walletId);
  if (snapshot) return true;

  const currentSession = getWalletSession();
  if (
    currentSession.currentWalletId !== walletId ||
    (currentSession.sessionGeneration ?? 0) !== initialGeneration
  ) {
    return false;
  }
  requestTrailing(0);
  return false;
}

export function walletClaimToRelease(
  previousWalletId: number,
  currentWalletId: number
): number | null {
  return previousWalletId > 0 && previousWalletId !== currentWalletId
    ? previousWalletId
    : null;
}

/**
 * Leave the currently open wallet before showing another wallet's password
 * prompt. AppShell only exposes the picker routes while walletId is reset, and
 * the old wallet key must not survive a same-window switch.
 */
export async function openSavedWalletFromMenu(
  walletId: number,
  navigate: NavigateFunction,
  dispatch: AppDispatch,
  lock: () => void = OptnKeyManager.lock,
  flush: (callback: () => void) => void = flushSync,
  currentWalletId = 0,
  windowLabel = currentWebviewLabel(),
  release: typeof releaseWalletOpen = releaseWalletOpen
): Promise<void> {
  if (currentWalletId > 0) {
    await release(currentWalletId, windowLabel);
  }
  lock();
  flush(() => dispatch(resetWallet()));
  // Switching wallets in place leaves the same stale database behind that a
  // lock would, so the wallet being opened next must not inherit it.
  resyncAfterWalletClosed('MenuBar.openSavedWallet');
  navigate(ROUTE_PATHS.landing, { state: { openWalletId: walletId } });
}

async function walletsDir(): Promise<string | undefined> {
  try {
    return await join(await appDataDir(), 'wallets');
  } catch {
    return undefined;
  }
}

// Open the wallet picker to start a new/import/hardware wallet or open an
// existing one. Preferred path: a second independent OS window
// (openWalletPickerWindow) so two wallets can be open side by side; the shared
// IndexedDB blob is guarded against cross-window clobber in DatabaseService.
// Falls back to in-window navigation if window creation is unavailable/fails.
async function openPicker(navigate: (p: string) => void) {
  try {
    await openWalletPickerWindow();
  } catch (err) {
    console.error('[menu] open new window failed, navigating in place:', err);
    navigate(ROUTE_PATHS.landing);
  }
}

async function handleOpenWalletFile(
  navigate: NavigateFunction,
  leaveCurrentWallet: () => void | Promise<void> = () => undefined,
  openWalletId = 0
) {
  try {
    const { pickWalletPackFiles, importColdDataIntoOpenWallet } = await import(
      './WalletPackService'
    );
    const pack = await pickWalletPackFiles(await walletsDir());
    if (!pack) return;

    // Data-only: apply into the currently open wallet.
    if (!pack.keystore && pack.coldText) {
      if (openWalletId <= 0) {
        window.dispatchEvent(
          new CustomEvent('optn:toast', {
            detail: {
              message:
                'Open a wallet first, or select the .optn keystore (data file auto-loads if it sits next to it).',
            },
          })
        );
        return;
      }
      const { resolveWalletPassword } = await import(
        './WalletColdExportService'
      );
      const password = await resolveWalletPassword(
        openWalletId,
        'Password for the encrypted wallet data file (.optn-cold):'
      );
      if (password === null) return;
      const stats = await importColdDataIntoOpenWallet(
        openWalletId,
        pack.coldText,
        password
      );
      window.dispatchEvent(
        new CustomEvent('optn:toast', {
          detail: {
            message: `Imported data: ${stats.labels} labels, ${stats.fusionCoins} fusion depths.`,
          },
        })
      );
      return;
    }

    if (!pack.keystore) {
      window.dispatchEvent(
        new CustomEvent('optn:toast', {
          detail: { message: 'No .optn keystore file in the selection.' },
        })
      );
      return;
    }

    await leaveCurrentWallet();
    navigate(ROUTE_PATHS.landing, {
      state: {
        importWalletFile: pack.keystore,
        importColdText: pack.coldText ?? null,
      },
    });
  } catch (err) {
    console.error('[menu] Open Wallet File failed:', err);
    window.dispatchEvent(
      new CustomEvent('optn:toast', {
        detail: {
          message:
            err instanceof Error
              ? err.message
              : 'That is not a valid OPTN wallet pack.',
        },
      })
    );
  }
}

/**
 * Export Wallet = two files:
 *   1) .optn keystore (encrypted seed)
 *   2) .optn-cold data (encrypted history/labels/fusion/UTXO snapshot)
 * written side-by-side after one Save dialog for the keystore.
 */
async function handleExportWallet(walletId: number) {
  if (!walletId) return;
  try {
    // Password resolved from unlock session / empty-password wallets / prompt.
    const { exportWalletPack } = await import('./WalletPackService');
    const result = await exportWalletPack(walletId, await walletsDir());
    const dataMsg = result.coldPath
      ? `Data: ${result.coldPath}`
      : `Data file skipped: ${result.coldSkippedReason ?? 'unknown'}`;
    window.dispatchEvent(
      new CustomEvent('optn:toast', {
        detail: {
          message: `Exported wallet pack.\nKeys: ${result.keystorePath}\n${dataMsg}`,
        },
      })
    );
  } catch (err) {
    const text = err instanceof Error ? err.message : 'Could not export wallet.';
    if (text.includes('cancelled')) return;
    console.error('[menu] Export Wallet failed:', err);
    window.dispatchEvent(
      new CustomEvent('optn:toast', { detail: { message: text } })
    );
  }
}

export function useMenuBar(): void {
  const navigate = useNavigate();
  const dispatch = useDispatch<AppDispatch>();
  const walletId = useSelector((s: RootState) => selectWalletId(s));
  const previousWalletId = useRef(0);
  const { toggleMode } = useTheme();

  useEffect(() => {
    let disposed = false;
    let unlistenMenuAction: (() => void) | undefined;
    const hasOpenWallet = walletId > 0;
    // Tauri IPC is available in the Linux dev WebView before its metadata
    // object is populated. The URL is already the source of truth for the
    // per-window instance id, so derive the label without reading metadata.
    const currentWindow = { label: currentWebviewLabel() };
    const requiresAppMenu = /Macintosh|Mac OS X/i.test(navigator.userAgent);
    const walletActionEnabled = requiresAppMenu || hasOpenWallet;

    const handlers: DesktopMenuActionHandlers = {
      openPicker: () => openPicker(navigate),
      openWalletFile: () =>
        handleOpenWalletFile(
          navigate,
          async () => {
            if (walletId > 0) {
              await releaseWalletOpen(walletId, currentWindow.label);
            }
            OptnKeyManager.lock();
            flushSync(() => dispatch(resetWallet()));
            resyncAfterWalletClosed('MenuBar.openWalletFile');
          },
          walletId
        ),
      openSavedWallet: (savedWalletId) =>
        openSavedWalletFromMenu(
          savedWalletId,
          navigate,
          dispatch,
          OptnKeyManager.lock,
          flushSync,
          walletId,
          currentWindow.label
        ),
      lockWallet: async () => {
        if (!walletId) return;
        // Hand the wallet back before leaving it, so another window can open it
        // immediately rather than waiting out the claim's TTL.
        await releaseWalletOpen(walletId, currentWindow.label).catch(
          () => undefined
        );
        OptnKeyManager.lock();
        dispatch(resetWallet());
        // Drop Electrum so the next wallet cannot reuse this network's socket
        // (chipnet open after mainnet lock → permanent 0 balance otherwise).
        try {
          const { default: getElectrumAdapter } = await import(
            '../../services/ElectrumAdapter'
          );
          await getElectrumAdapter().disconnect();
        } catch {
          /* best-effort */
        }
        navigate(ROUTE_PATHS.landing);
        resyncAfterWalletClosed('MenuBar.lockWallet');
      },
      receive: () => {
        if (walletId) navigate(ROUTE_PATHS.receive);
      },
      send: () => {
        if (walletId) navigate(ROUTE_PATHS.send);
      },
      history: () => {
        if (walletId) navigate(transactionsRoute(walletId));
      },
      exportWallet: () => (walletId ? handleExportWallet(walletId) : undefined),
      settings: () => {
        if (walletId) navigate(ROUTE_PATHS.settings);
      },
      toggleTheme: toggleMode,
      refreshWallet: async () => {
        if (walletId) await refreshWalletFromMenu(walletId);
      },
      showAbout: () => {
        window.dispatchEvent(new CustomEvent('optn:show-about'));
      },
    };

    const dispatchMenuAction = (id: string) => {
      void dispatchDesktopMenuAction(id, handlers).catch((err) => {
        console.error(`[menu] ${id} failed:`, err);
      });
    };

    // The menu's own accelerators never fire, because the WebView claims these
    // chords first: Ctrl+R is its built-in reload and Ctrl+N its new-window, so
    // the keystroke is consumed before the native menu sees it. Ctrl+R was
    // therefore reloading the whole WebView — the exact behaviour Refresh Wallet
    // replaced, since a reload interrupts in-flight network and Fusion work.
    //
    // Handled here instead, and dispatched straight to this window rather than
    // routed: a keystroke is delivered to the focused window by definition, so
    // the window that received it IS the target.
    const onKeyDown = (event: KeyboardEvent) => {
      const id = menuActionForKeyboardEvent(event);
      if (!id) return;
      // Suppress the WebView default (reload / new window) before acting.
      event.preventDefault();
      dispatchMenuAction(id);
    };
    window.addEventListener('keydown', onKeyDown);

    // Keep this window's claim on its wallet alive. A stopped heartbeat is how a
    // crashed window releases: the claim simply ages out, instead of locking the
    // wallet away until the app restarts.
    let claimTimer: ReturnType<typeof setInterval> | undefined;
    if (walletId > 0) {
      const beat = () => {
        void refreshWalletOpenClaim(walletId, currentWindow.label).catch(
          () => undefined
        );
      };
      beat();
      claimTimer = setInterval(beat, OPEN_CLAIM_HEARTBEAT_MS);
    }

    // Fast path for a cleanly closed window. Not sufficient on its own — the X
    // button and a crash both skip this — which is why opening also checks
    // whether the holding window still exists.
    const releaseOnClose = () => {
      if (walletId > 0) void releaseWalletOpen(walletId, currentWindow.label);
    };
    window.addEventListener('beforeunload', releaseOnClose);

    void listenToEvent<{ id?: unknown }>(
      MENU_ACTION_EVENT,
      (event) => {
        if (typeof event.payload?.id === 'string') {
          dispatchMenuAction(event.payload.id);
        }
      },
      { target: { kind: 'WebviewWindow', label: currentWindow.label } }
    )
      .then((unlisten) => {
        if (disposed) {
          unlisten();
        } else {
          unlistenMenuAction = unlisten;
        }
      })
      .catch((err) => {
        console.error('[menu] could not register menu action listener:', err);
      });

    const routeAction = async (id: string) => {
      await routeMenuActionToFocusedWindow(
        id,
        await getAllWebviewWindows(),
        requiresAppMenu ? undefined : currentWindow.label
      );
    };
    const menuAction = (id: string) => () => {
      void routeAction(id).catch((err) => {
        console.error(`[menu] could not route ${id}:`, err);
      });
    };

    const buildMenu = async () => {
      // Saved wallets for quick-open. Network is a runtime setting, not a fixed
      // wallet property, so it is deliberately NOT shown here.
      let wallets: Array<{ id: number; wallet_name: string }> = [];
      try {
        wallets = (await WalletManager().getAllWallets()) as typeof wallets;
      } catch {
        wallets = [];
      }

      const quickOpenItems = await Promise.all(
        wallets.map((w) =>
          MenuItem.new({
            id: `open_wallet_${w.id}`,
            text: w.wallet_name || `Wallet #${w.id}`,
            action: menuAction(`open_wallet_${w.id}`),
          })
        )
      );

      const openWalletChildren = [
        // Browse the disk for a .optn wallet file (Windows Explorer / native picker).
        await MenuItem.new({
          id: 'open_wallet_file',
          text: 'Open Wallet Pack…',
          action: menuAction('open_wallet_file'),
        }),
        await PredefinedMenuItem.new({ item: 'Separator' }),
        ...(quickOpenItems.length > 0
          ? quickOpenItems
          : [await MenuItem.new({ id: 'open_wallet_none', text: 'No saved wallets', enabled: false })]),
      ];

      const openWalletSubmenu = await Submenu.new({ text: 'Open Wallet', items: openWalletChildren });

      const fileMenu = await Submenu.new({
        text: 'File',
        items: [
          // Opens a NEW independent window at the wallet picker (Electron Cash
          // style), where the user can create, import, connect a hardware
          // wallet, or pick an existing one — isolated from this window.
          await MenuItem.new({
            id: 'new_wallet',
            text: 'Open New Wallet',
            accelerator: 'CmdOrCtrl+N',
            action: menuAction('new_wallet'),
          }),
          openWalletSubmenu,
          await PredefinedMenuItem.new({ item: 'Separator' }),
          await MenuItem.new({
            id: 'lock_wallet',
            text: 'Lock Wallet',
            accelerator: 'CmdOrCtrl+L',
            enabled: walletActionEnabled,
            action: menuAction('lock_wallet'),
          }),
          await PredefinedMenuItem.new({ item: 'Separator' }),
          await PredefinedMenuItem.new({ item: 'Quit', text: 'Quit' }),
        ],
      });

      const walletMenu = await Submenu.new({
        text: 'Wallet',
        items: [
          await MenuItem.new({
            id: 'receive',
            text: 'Receive',
            enabled: walletActionEnabled,
            action: menuAction('receive'),
          }),
          await MenuItem.new({
            id: 'send',
            text: 'Send',
            enabled: walletActionEnabled,
            action: menuAction('send'),
          }),
          await MenuItem.new({
            id: 'history',
            text: 'Transaction History',
            enabled: walletActionEnabled,
            action: menuAction('history'),
          }),
          await MenuItem.new({
            id: 'refresh_wallet',
            text: 'Refresh Wallet',
            accelerator: 'CmdOrCtrl+R',
            enabled: walletActionEnabled,
            action: menuAction('refresh_wallet'),
          }),
          await PredefinedMenuItem.new({ item: 'Separator' }),
          await MenuItem.new({
            id: 'export_wallet',
            text: 'Export Wallet…',
            enabled: walletActionEnabled,
            action: menuAction('export_wallet'),
          }),
          await PredefinedMenuItem.new({ item: 'Separator' }),
          await MenuItem.new({
            id: 'settings',
            text: 'Settings',
            enabled: walletActionEnabled,
            action: menuAction('settings'),
          }),
        ],
      });

      const viewMenu = await Submenu.new({
        text: 'View',
        items: [
          await MenuItem.new({
            id: 'toggle_theme',
            text: 'Toggle Theme',
            action: menuAction('toggle_theme'),
          }),
        ],
      });

      const helpMenu = await Submenu.new({
        text: 'Help',
        items: [
          await MenuItem.new({
            id: 'about',
            text: 'About OPTN Wallet',
            action: menuAction('about'),
          }),
        ],
      });

      const menu = await Menu.new({ items: [fileMenu, walletMenu, viewMenu, helpMenu] });
      if (disposed) return;
      await attachDesktopMenu(menu, currentWindow, requiresAppMenu);
    };

    void buildMenu();

    const rebuild = () => void buildMenu();
    window.addEventListener(WALLETS_CHANGED_EVENT, rebuild);
    return () => {
      disposed = true;
      unlistenMenuAction?.();
      window.removeEventListener(WALLETS_CHANGED_EVENT, rebuild);
      window.removeEventListener('keydown', onKeyDown);
      if (claimTimer) clearInterval(claimTimer);
      window.removeEventListener('beforeunload', releaseOnClose);
    };
  }, [navigate, dispatch, walletId, toggleMode]);

  // Release only on an actual wallet-id transition. Effect cleanup is unsafe:
  // React StrictMode deliberately replays mount effects and would release a
  // claim while the wallet was still open.
  useEffect(() => {
    const walletToRelease = walletClaimToRelease(
      previousWalletId.current,
      walletId
    );
    previousWalletId.current = walletId;
    if (walletToRelease === null) return;
    const windowLabel = currentWebviewLabel();
    void releaseWalletOpen(walletToRelease, windowLabel).catch(() => undefined);
  }, [walletId]);
}
