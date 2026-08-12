// In-memory cache for the PIN-derived wallet encryption key.
// The key only exists in RAM — it is never serialised or stored anywhere.
// Populated on App Lock unlock or a per-wallet unlock, wiped on lock or app
// close. A key that opens wallet A must never satisfy wallet B's open-state
// invariant merely because both windows share persisted Redux state.

export type CachedWalletKeySnapshot = Readonly<{
  key: CryptoKey;
  ownerWalletId: number | null;
}>;

let _cached: CachedWalletKeySnapshot | null = null;

/**
 * Cache a key and, when known, bind it to the exact wallet row it unlocks.
 * `null` is reserved for provisional/app-gate/extension keys and must not be
 * interpreted as proof that any particular desktop wallet is open.
 */
export function setCachedWalletKey(
  key: CryptoKey,
  ownerWalletId: number | null = null
): void {
  _cached = { key, ownerWalletId };
}

export function getCachedWalletKey(): CryptoKey | null {
  return _cached?.key ?? null;
}

export function getCachedWalletKeyForWallet(walletId: number): CryptoKey | null {
  if (walletId <= 0 || _cached?.ownerWalletId !== walletId) return null;
  return _cached.key;
}

export function getCachedWalletKeySnapshot(): CachedWalletKeySnapshot | null {
  return _cached ? { ..._cached } : null;
}

export function clearCachedWalletKey(): void {
  _cached = null;
  console.log('[WalletKey] Derived key wiped from memory');
}
