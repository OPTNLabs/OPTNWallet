import type { UTXO } from '../types/types';

type Snapshot = Record<string, UTXO[]>;

type CacheEntry = {
  snapshot: Snapshot;
  updatedAt: number;
};

// Keep a small number of wallet snapshots in memory. SQL remains the durable
// source of truth; this cache prevents a wallet remount or a background refresh
// from painting an empty snapshot while the next network pass is in flight.
const MAX_WALLET_SNAPSHOTS = 16;
const snapshots = new Map<number, CacheEntry>();

function cloneSnapshot(snapshot: Record<string, readonly UTXO[]>): Snapshot {
  return Object.fromEntries(
    Object.entries(snapshot).map(([address, utxos]) => [address, [...utxos]])
  );
}

function isValidWalletId(walletId: number): boolean {
  return Number.isSafeInteger(walletId) && walletId > 0;
}

function evictOldestSnapshots(): void {
  while (snapshots.size > MAX_WALLET_SNAPSHOTS) {
    const oldest = [...snapshots.entries()].reduce((oldestEntry, entry) =>
      entry[1].updatedAt < oldestEntry[1].updatedAt ? entry : oldestEntry
    );
    snapshots.delete(oldest[0]);
  }
}

export function cacheWalletUtxoSnapshot(
  walletId: number,
  snapshot: Record<string, readonly UTXO[]>
): void {
  if (!isValidWalletId(walletId)) return;
  snapshots.set(walletId, {
    snapshot: cloneSnapshot(snapshot),
    updatedAt: Date.now(),
  });
  evictOldestSnapshots();
}

export function getCachedWalletUtxoSnapshot(walletId: number): Snapshot | null {
  if (!isValidWalletId(walletId)) return null;
  const entry = snapshots.get(walletId);
  if (!entry) return null;

  // Reading a snapshot makes it the least likely entry to be evicted.
  entry.updatedAt = Date.now();
  return cloneSnapshot(entry.snapshot);
}

export function updateCachedWalletUtxoAddress(
  walletId: number,
  address: string,
  utxos: readonly UTXO[]
): void {
  if (!isValidWalletId(walletId) || !address) return;
  const current = getCachedWalletUtxoSnapshot(walletId) ?? {};
  current[address] = [...utxos];
  cacheWalletUtxoSnapshot(walletId, current);
}

export function clearCachedWalletUtxoSnapshot(walletId?: number): void {
  if (walletId === undefined) {
    snapshots.clear();
    return;
  }
  if (isValidWalletId(walletId)) snapshots.delete(walletId);
}
