// In-memory cache for the PIN-derived wallet encryption key.
// The key only exists in RAM — it is never serialised or stored anywhere.
// Populated on App Lock unlock, wiped on lock or app close.

let _key: CryptoKey | null = null;

export function setCachedWalletKey(key: CryptoKey): void {
  _key = key;
}

export function getCachedWalletKey(): CryptoKey | null {
  return _key;
}

export function clearCachedWalletKey(): void {
  _key = null;
  console.log('[WalletKey] Derived key wiped from memory');
}
