// Opens a second, independent app window at the wallet picker (Electron Cash
// style), so two different wallets can be open side by side.
//
// Each window has its own in-RAM wallet key (WalletKeyCache is per-JS-context)
// and boots to the picker via DesktopAppShell's stale-walletId reset. Windows
// share one IndexedDB origin; DatabaseService serializes writes across WebViews
// and merges only the active wallet's rows into the latest shared snapshot. The
// label must match the `wallet-*` pattern allowed in capabilities/default.json.
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { ROUTE_PATHS } from '../../navigation/routes';

export async function openWalletPickerWindow(): Promise<void> {
  const label = `wallet-${Date.now()}`;
  // Reuse the running window's origin/path so this works in development.
  // and in the packaged app (tauri.localhost) without special-casing either; the
  // hash carries the route because the app uses HashRouter. The ?instance query
  // carries this window's storage-partition id (storagePartition.ts reads it) —
  // it's in the URL rather than derived from the Tauri window label at runtime, so
  // it's reliable at entry-prelude time and survives reloads (keeping each window
  // on its OWN persisted wallet state).
  const base = `${window.location.origin}${window.location.pathname}`;
  const win = new WebviewWindow(label, {
    url: `${base}?instance=${encodeURIComponent(label)}#${ROUTE_PATHS.landing}`,
    title: 'OPTN Wallet',
    width: 460,
    height: 860,
    minWidth: 380,
    minHeight: 640,
    resizable: true,
    center: true,
  });

  await new Promise<void>((resolve, reject) => {
    void win.once('tauri://created', () => resolve());
    void win.once('tauri://error', (e) =>
      reject(
        new Error(
          typeof e.payload === 'string' ? e.payload : 'window creation failed'
        )
      )
    );
  });
}
