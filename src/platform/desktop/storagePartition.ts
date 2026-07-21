// Per-window storage partition — the core of the desktop multi-wallet (Electron
// Cash-style) model. Each window keeps its OWN current-wallet selection and
// preferences by giving redux-persist's localForage store a name unique to the
// window, so opening (or reloading) a wallet in one window can't reset another.
//
// The instance id is taken from the window URL's `?instance=` query, which
// openWalletPickerWindow stamps onto every extra window. Reading it from the URL
// (not from the Tauri window label) makes it reliable at THIS point — the desktop
// entry prelude, which runs before Tauri internals are guaranteed injected and
// before state/store.ts configures localForage — and it survives reloads because
// the URL persists. The resolved key is also cached in sessionStorage (per-window,
// survives reload) so isolation holds even if the query is ever dropped.
//
// The primary window has no `?instance=` and keeps the legacy 'persist' store, so
// an existing user's state is preserved untouched. The shared wallet DB
// (idb-keyval 'OPTNDatabase') is deliberately NOT partitioned — every window reads
// the same wallets (with DatabaseService's anti-clobber guard) and opens a
// different one.

import localForage from 'localforage';

const PARTITION_CACHE_KEY = 'optn-storage-partition';

/** Resolve this window's storage-partition suffix. '' = primary window. */
function resolvePartition(): string {
  // 1) Explicit id from the window URL (extra windows).
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('instance');
    if (fromUrl) {
      try {
        window.sessionStorage.setItem(PARTITION_CACHE_KEY, fromUrl);
      } catch {
        /* sessionStorage unavailable — the URL alone still isolates this window */
      }
      return fromUrl;
    }
  } catch {
    /* no window.location (tests/SSR) */
  }
  // 2) Cached id (a reload where the query was somehow lost).
  try {
    const cached = window.sessionStorage.getItem(PARTITION_CACHE_KEY);
    if (cached) return cached;
  } catch {
    /* ignore */
  }
  // 3) Primary window — legacy store, no suffix.
  return '';
}

const partition = resolvePartition();

if (partition) {
  type ConfigFn = (options?: { storeName?: string; [k: string]: unknown }) => unknown;
  const original = localForage.config.bind(localForage) as ConfigFn;
  const patched: ConfigFn = (options) => {
    if (options && typeof options.storeName === 'string') {
      return original({ ...options, storeName: `${options.storeName}-${partition}` });
    }
    return original(options);
  };
  (localForage as unknown as { config: ConfigFn }).config = patched;
}
