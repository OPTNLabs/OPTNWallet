import { beforeEach, describe, expect, it } from 'vitest';

import {
  DESKTOP_CACHE_BUDGET_CHARS,
  Directory,
  Filesystem,
  pruneDesktopCache,
} from '../filesystem';

class MemoryStorage {
  private map = new Map<string, string>();

  get length() {
    return this.map.size;
  }

  key(index: number) {
    return [...this.map.keys()][index] ?? null;
  }

  getItem(key: string) {
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.map.set(key, value);
  }

  removeItem(key: string) {
    this.map.delete(key);
  }
}

function cacheChars(storage: MemoryStorage): number {
  let total = 0;
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith('fs:CACHE:')) continue;
    total += key.length + (storage.getItem(key)?.length ?? 0);
  }
  return total;
}

describe('desktop disposable file cache', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
    (globalThis as { localStorage?: unknown }).localStorage = storage;
  });

  it('trims legacy icon payloads but preserves wallet and Fusion state', () => {
    storage.setItem('wallet-public-setting', 'keep-wallet');
    storage.setItem('optn-fusion-lease-6', 'keep-fusion');
    storage.setItem('fs:CACHE:optn/icons/a', 'a'.repeat(900_000));
    storage.setItem('fs:CACHE:optn/icons/b', 'b'.repeat(900_000));
    storage.setItem('fs:CACHE:optn/icons/c', 'c'.repeat(900_000));

    expect(pruneDesktopCache()).toBeGreaterThan(0);
    expect(cacheChars(storage)).toBeLessThanOrEqual(DESKTOP_CACHE_BUDGET_CHARS);
    expect(storage.getItem('wallet-public-setting')).toBe('keep-wallet');
    expect(storage.getItem('optn-fusion-lease-6')).toBe('keep-fusion');
  });

  it('makes room before persisting a new cache item', async () => {
    storage.setItem('fs:CACHE:optn/icons/a', 'a'.repeat(900_000));
    storage.setItem('fs:CACHE:optn/icons/b', 'b'.repeat(900_000));

    await Filesystem.writeFile({
      path: 'optn/icons/new',
      directory: Directory.Cache,
      data: 'n'.repeat(800_000),
    });

    expect(storage.getItem('fs:CACHE:optn/icons/new')).toHaveLength(800_000);
    expect(cacheChars(storage)).toBeLessThanOrEqual(DESKTOP_CACHE_BUDGET_CHARS);
  });

  it('does not persist one cache item larger than the whole budget', async () => {
    storage.setItem('optn-fusion-lease-6', 'keep-fusion');

    await expect(
      Filesystem.writeFile({
        path: 'optn/icons/huge',
        directory: Directory.Cache,
        data: 'x'.repeat(DESKTOP_CACHE_BUDGET_CHARS + 1),
      })
    ).rejects.toThrow(/cache budget/i);
    expect(storage.getItem('fs:CACHE:optn/icons/huge')).toBeNull();
    expect(storage.getItem('optn-fusion-lease-6')).toBe('keep-fusion');
  });
});
