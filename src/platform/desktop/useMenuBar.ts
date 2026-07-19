// Builds the desktop menu bar (File / Wallet / View / Help) on the FRONTEND via
// @tauri-apps/api/menu, because File → Open Wallet must list the actual saved
// wallets, which only the JS side (WASM SQLite DB) knows. The Rust static menu
// is disabled (see lib.rs); this is the single source of truth.
//
// Rebuilt whenever the wallet list or the open wallet changes, so Open Wallet
// stays current and wallet-scoped items grey out on the picker.
import { useEffect } from 'react';
import { flushSync } from 'react-dom';
import { useNavigate, type NavigateFunction } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { Menu, Submenu, MenuItem, PredefinedMenuItem } from '@tauri-apps/api/menu';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { appDataDir, join } from '@tauri-apps/api/path';
import { AppDispatch, RootState } from '../../state/store';
import { selectWalletId, resetWallet } from '../../state/slices/walletSlice';
import { useTheme } from '../../app/theme/useTheme';
import { ROUTE_PATHS, transactionsRoute } from '../../navigation/routes';
import { EcKeyManager } from './EcKeyManager';
import WalletManager from '../../apis/WalletManager/WalletManager';
import { buildWalletFileContents } from './DesktopWalletManager';
import { parseWalletFile, defaultWalletFileName } from './walletFile';
import { openWalletPickerWindow } from './walletWindow';

// Landing page listens for these.
export const OPEN_WALLET_EVENT = 'optn:open-wallet'; // quick-open a saved DB wallet by id
export const IMPORT_FILE_EVENT = 'optn:import-wallet-file'; // open a parsed .optn file
// Fired after create/import/delete so the menu re-reads the wallet list.
export const WALLETS_CHANGED_EVENT = 'optn:wallets-changed';

/**
 * Leave the currently open wallet before showing another wallet's password
 * prompt. AppShell only exposes the picker routes while walletId is reset, and
 * the old wallet key must not survive a same-window switch.
 */
export function openSavedWalletFromMenu(
  walletId: number,
  navigate: NavigateFunction,
  dispatch: AppDispatch,
  lock: () => void = EcKeyManager.lock,
  flush: (callback: () => void) => void = flushSync
): void {
  lock();
  flush(() => dispatch(resetWallet()));
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

async function handleOpenWalletFile(navigate: (p: string) => void) {
  const picked = await openDialog({
    multiple: false,
    directory: false,
    title: 'Open Wallet File',
    defaultPath: await walletsDir(),
    filters: [{ name: 'OPTN Wallet', extensions: ['optn'] }],
  });
  if (typeof picked !== 'string') return; // cancelled
  try {
    const text = await invoke<string>('read_wallet_file', { path: picked });
    const file = parseWalletFile(text);
    navigate(ROUTE_PATHS.landing);
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent(IMPORT_FILE_EVENT, { detail: { file } }));
    }, 50);
  } catch (err) {
    console.error('[menu] Open Wallet File failed:', err);
    window.dispatchEvent(
      new CustomEvent('optn:toast', { detail: { message: 'That is not a valid OPTN wallet file.' } })
    );
  }
}

async function handleExportWallet(walletId: number) {
  if (!walletId) return;
  const contents = await buildWalletFileContents(walletId);
  if (!contents) {
    window.dispatchEvent(
      new CustomEvent('optn:toast', { detail: { message: 'This wallet cannot be exported.' } })
    );
    return;
  }
  const name = (() => {
    try {
      return (JSON.parse(contents) as { name?: string }).name ?? 'wallet';
    } catch {
      return 'wallet';
    }
  })();
  const dir = await walletsDir();
  const suggested = defaultWalletFileName(walletId, name);
  const dest = await saveDialog({
    title: 'Export Wallet',
    defaultPath: dir ? await join(dir, suggested) : suggested,
    filters: [{ name: 'OPTN Wallet', extensions: ['optn'] }],
  });
  if (typeof dest !== 'string') return; // cancelled
  try {
    await invoke('write_wallet_file', { path: dest, contents });
    window.dispatchEvent(
      new CustomEvent('optn:toast', { detail: { message: 'Wallet exported.' } })
    );
  } catch (err) {
    console.error('[menu] Export Wallet failed:', err);
    window.dispatchEvent(
      new CustomEvent('optn:toast', { detail: { message: 'Could not export the wallet.' } })
    );
  }
}

export function useMenuBar(): void {
  const navigate = useNavigate();
  const dispatch = useDispatch<AppDispatch>();
  const walletId = useSelector((s: RootState) => selectWalletId(s));
  const { toggleMode } = useTheme();

  useEffect(() => {
    let disposed = false;
    const hasOpenWallet = walletId > 0;

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
            action: () => openSavedWalletFromMenu(w.id, navigate, dispatch),
          })
        )
      );

      const openWalletChildren = [
        // Browse the disk for a .optn wallet file (Windows Explorer / native picker).
        await MenuItem.new({
          id: 'open_wallet_file',
          text: 'Open Wallet File…',
          action: () => void handleOpenWalletFile(navigate),
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
            text: 'Import New Wallet',
            accelerator: 'CmdOrCtrl+N',
            action: () => void openPicker(navigate),
          }),
          openWalletSubmenu,
          await PredefinedMenuItem.new({ item: 'Separator' }),
          await MenuItem.new({
            id: 'lock_wallet',
            text: 'Lock Wallet',
            accelerator: 'CmdOrCtrl+L',
            enabled: hasOpenWallet,
            action: () => {
              EcKeyManager.lock();
              dispatch(resetWallet());
              navigate(ROUTE_PATHS.landing);
            },
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
            enabled: hasOpenWallet,
            action: () => navigate(ROUTE_PATHS.receive),
          }),
          await MenuItem.new({
            id: 'send',
            text: 'Send',
            enabled: hasOpenWallet,
            action: () => navigate(ROUTE_PATHS.send),
          }),
          await MenuItem.new({
            id: 'history',
            text: 'Transaction History',
            enabled: hasOpenWallet,
            action: () => navigate(transactionsRoute(walletId || undefined)),
          }),
          await PredefinedMenuItem.new({ item: 'Separator' }),
          await MenuItem.new({
            id: 'export_wallet',
            text: 'Export Wallet…',
            enabled: hasOpenWallet,
            action: () => void handleExportWallet(walletId),
          }),
          await PredefinedMenuItem.new({ item: 'Separator' }),
          await MenuItem.new({
            id: 'settings',
            text: 'Settings',
            enabled: hasOpenWallet,
            action: () => navigate(ROUTE_PATHS.settings),
          }),
        ],
      });

      const viewMenu = await Submenu.new({
        text: 'View',
        items: [
          await MenuItem.new({ id: 'toggle_theme', text: 'Toggle Theme', action: () => toggleMode() }),
          await MenuItem.new({
            id: 'reload',
            text: 'Reload',
            accelerator: 'CmdOrCtrl+R',
            action: () => window.location.reload(),
          }),
        ],
      });

      const helpMenu = await Submenu.new({
        text: 'Help',
        items: [
          await MenuItem.new({
            id: 'about',
            text: 'About OPTN Wallet',
            action: () => window.dispatchEvent(new CustomEvent('optn:show-about')),
          }),
        ],
      });

      const menu = await Menu.new({ items: [fileMenu, walletMenu, viewMenu, helpMenu] });
      if (disposed) return;
      await menu.setAsAppMenu();
    };

    void buildMenu();

    const rebuild = () => void buildMenu();
    window.addEventListener(WALLETS_CHANGED_EVENT, rebuild);
    return () => {
      disposed = true;
      window.removeEventListener(WALLETS_CHANGED_EVENT, rebuild);
    };
  }, [navigate, dispatch, walletId, toggleMode]);
}
