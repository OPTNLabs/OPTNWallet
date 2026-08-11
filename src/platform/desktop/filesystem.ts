// Desktop shim for @capacitor/filesystem
// Used by BcmrService for caching token metadata.
// On desktop: uses localStorage as a simple persistent cache.
//
// WebView localStorage is also where small cross-window safety records live.
// Token icons are disposable and can be hundreds of kilobytes each, so they
// must never be allowed to consume the origin's ~5 MiB quota and starve wallet
// leases/cooldowns. Keep a deliberately small cache budget and evict the
// largest payloads first (preserving more small icons for the same space).

const CACHE_KEY_PREFIX = 'fs:CACHE:';
export const DESKTOP_CACHE_BUDGET_CHARS = 1_500_000;

export const Directory = {
  Data: 'DATA',
  Cache: 'CACHE',
  External: 'EXTERNAL',
  ExternalCache: 'EXTERNAL_CACHE',
  ExternalStorage: 'EXTERNAL_STORAGE',
  Documents: 'DOCUMENTS',
  Library: 'LIBRARY',
} as const;

export const Encoding = {
  UTF8: 'utf8',
  ASCII: 'ascii',
  UTF16: 'utf16',
} as const;

function storageKey(path: string, directory?: string) {
  return `fs:${directory ?? 'DATA'}:${path}`;
}

type CacheEntry = { key: string; chars: number };

function cacheEntries(excludeKey?: string): CacheEntry[] {
  const entries: CacheEntry[] = [];
  let storage: Storage;
  try {
    storage = globalThis.localStorage;
  } catch {
    return entries;
  }
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(CACHE_KEY_PREFIX) || key === excludeKey) continue;
    const value = storage.getItem(key);
    if (value === null) continue;
    entries.push({ key, chars: key.length + value.length });
  }
  return entries;
}

/** Remove only disposable desktop cache entries until they fit `maxChars`. */
export function pruneDesktopCache(
  maxChars = DESKTOP_CACHE_BUDGET_CHARS,
  excludeKey?: string
): number {
  const entries = cacheEntries(excludeKey).sort((a, b) => b.chars - a.chars);
  let total = entries.reduce((sum, entry) => sum + entry.chars, 0);
  let removed = 0;
  for (const entry of entries) {
    if (total <= Math.max(0, maxChars)) break;
    try {
      globalThis.localStorage.removeItem(entry.key);
      total -= entry.chars;
      removed += 1;
    } catch {
      break;
    }
  }
  return removed;
}

export const Filesystem = {
  writeFile: async ({
    path,
    data,
    directory,
  }: {
    path: string;
    data: string;
    directory?: string;
    encoding?: string;
    recursive?: boolean;
  }) => {
    const key = storageKey(path, directory);
    if (directory === Directory.Cache) {
      const incomingChars = key.length + data.length;
      if (incomingChars > DESKTOP_CACHE_BUDGET_CHARS) {
        throw new Error('Cached file exceeds the desktop cache budget.');
      }
      // Account for this replacement separately, then leave exactly enough
      // room for it. Wallet/Fusion keys are never candidates for deletion.
      pruneDesktopCache(DESKTOP_CACHE_BUDGET_CHARS - incomingChars, key);
    }
    localStorage.setItem(key, data);
    return { uri: `local://${path}` };
  },

  readFile: async ({
    path,
    directory,
  }: {
    path: string;
    directory?: string;
    encoding?: string;
  }): Promise<{ data: string }> => {
    const val = localStorage.getItem(storageKey(path, directory));
    if (val === null) throw new Error(`File not found: ${path}`);
    return { data: val };
  },

  deleteFile: async ({
    path,
    directory,
  }: {
    path: string;
    directory?: string;
  }) => {
    localStorage.removeItem(storageKey(path, directory));
  },

  mkdir: async () => {},
  rmdir: async () => {},
  readdir: async () => ({ files: [] }),
  getUri: async ({ path }: { path: string }) => ({ uri: `local://${path}` }),
  stat: async ({ path, directory }: { path: string; directory?: string }) => {
    const val = localStorage.getItem(storageKey(path, directory));
    if (val === null) throw new Error(`File not found: ${path}`);
    return {
      type: 'file',
      size: val.length,
      ctime: 0,
      mtime: 0,
      uri: `local://${path}`,
    };
  },
  copy: async () => {},
  rename: async () => {},
  checkPermissions: async () => ({ publicStorage: 'granted' as const }),
  requestPermissions: async () => ({ publicStorage: 'granted' as const }),
};
