import type { QuantumrootVaultRecord } from '../types/types';

const STORAGE_KEY = 'optn_quantumroot_vault_cache_v1';

let memoryCache: Record<number, QuantumrootVaultRecord[]> | null = null;

function readStorage(): Record<number, QuantumrootVaultRecord[]> {
  if (memoryCache) return memoryCache;

  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) {
      memoryCache = {};
      return memoryCache;
    }

    const parsed = JSON.parse(raw) as Record<string, QuantumrootVaultRecord[]>;
    memoryCache = Object.fromEntries(
      Object.entries(parsed).map(([walletId, vaults]) => [Number(walletId), vaults])
    );
    return memoryCache;
  } catch {
    memoryCache = {};
    return memoryCache;
  }
}

function writeStorage(cache: Record<number, QuantumrootVaultRecord[]>): void {
  memoryCache = cache;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // Best-effort persistence; memory cache still survives screen switches.
  }
}

function upsertVault(
  walletId: number,
  vault: QuantumrootVaultRecord
): QuantumrootVaultRecord {
  const cache = readStorage();
  const existing = cache[walletId] ?? [];
  const next = existing.filter(
    (item) =>
      !(
        item.account_index === vault.account_index &&
        item.address_index === vault.address_index
      )
  );
  next.push(vault);
  next.sort((a, b) =>
    a.account_index === b.account_index
      ? a.address_index - b.address_index
      : a.account_index - b.account_index
  );
  cache[walletId] = next;
  writeStorage({ ...cache });
  return vault;
}

const QuantumrootVaultCacheService = {
  list(walletId: number): QuantumrootVaultRecord[] {
    return [...(readStorage()[walletId] ?? [])];
  },

  replace(walletId: number, vaults: QuantumrootVaultRecord[]): void {
    const cache = readStorage();
    cache[walletId] = [...vaults].sort((a, b) =>
      a.account_index === b.account_index
        ? a.address_index - b.address_index
        : a.account_index - b.account_index
    );
    writeStorage({ ...cache });
  },

  upsert: upsertVault,

  clear(walletId?: number): void {
    const cache = readStorage();
    if (typeof walletId === 'number') {
      delete cache[walletId];
    } else {
      memoryCache = {};
    }
    writeStorage({ ...cache });
  },
};

export default QuantumrootVaultCacheService;
