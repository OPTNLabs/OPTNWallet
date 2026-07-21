// Per-window storage partition — the core of the desktop multi-wallet (Electron
// Cash-style) model. Each window keeps its OWN current-wallet selection and
// preferences by giving redux-persist's localForage store a name unique to the
// window, so opening a wallet in one window can't kick another window to landing.
//
// The shared wallet DB (idb-keyval key 'OPTNDatabase') is deliberately NOT
// partitioned: every window reads the same set of wallets — with
// DatabaseService's anti-clobber guard — and simply opens a different one, exactly
// like Electron Cash's one-process / many-windows model.
//
// This module is loaded FIRST in the desktop entry prelude (vite.desktop.config)
// so it patches localForage.config before state/store.ts configures the persist
// store. The main window keeps the original 'persist' store name (so existing
// state is preserved); every extra window gets 'persist-<label>'.

import localForage from 'localforage';
import { getCurrentWindow } from '@tauri-apps/api/window';

function currentWindowLabel(): string {
  try {
    return getCurrentWindow().label || 'main';
  } catch {
    // Not in a Tauri window (tests/SSR) — behave like the primary window.
    return 'main';
  }
}

const label = currentWindowLabel();

// Only extra windows are namespaced; the primary window ('main') keeps 'persist'
// so a user's existing persisted state survives this change untouched.
if (label !== 'main') {
  type ConfigFn = (options?: { storeName?: string; [k: string]: unknown }) => unknown;
  const original = localForage.config.bind(localForage) as ConfigFn;
  const patched: ConfigFn = (options) => {
    if (options && typeof options.storeName === 'string') {
      return original({ ...options, storeName: `${options.storeName}-${label}` });
    }
    return original(options);
  };
  (localForage as unknown as { config: ConfigFn }).config = patched;
}
