// Desktop shim for @capacitor/filesystem
// Used by BcmrService for caching token metadata.
// On desktop: uses localStorage as a simple persistent cache.

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
    localStorage.setItem(storageKey(path, directory), data);
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
    return { type: 'file', size: val.length, ctime: 0, mtime: 0, uri: `local://${path}` };
  },
  copy: async () => {},
  rename: async () => {},
  checkPermissions: async () => ({ publicStorage: 'granted' as const }),
  requestPermissions: async () => ({ publicStorage: 'granted' as const }),
};
