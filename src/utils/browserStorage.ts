export type BrowserStorageLike = Pick<
  Storage,
  'getItem' | 'setItem' | 'removeItem'
>;

export function getLocalStorage(): BrowserStorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function getSessionStorage(): BrowserStorageLike | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

export function getPreferredStorage(): BrowserStorageLike | null {
  return getLocalStorage() ?? getSessionStorage();
}

export function readStorageItem(
  storage: BrowserStorageLike | null | undefined,
  key: string
): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeStorageItem(
  storage: BrowserStorageLike | null | undefined,
  key: string,
  value: string
): void {
  try {
    storage?.setItem(key, value);
  } catch {
    // best effort
  }
}
