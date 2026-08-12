// src/services/PaperWalletSecretStore.ts

// In-memory only. Never persisted.
const store = new Map<string, Uint8Array>();

const keyOf = (tx_hash: string, tx_pos: number) => `${tx_hash}:${tx_pos}`;

export const PaperWalletSecretStore = {
  set(tx_hash: string, tx_pos: number, privKey: Uint8Array) {
    store.set(keyOf(tx_hash, tx_pos), privKey);
  },

  get(tx_hash: string, tx_pos: number): Uint8Array | undefined {
    return store.get(keyOf(tx_hash, tx_pos));
  },

  del(tx_hash: string, tx_pos: number) {
    store.delete(keyOf(tx_hash, tx_pos));
  },

  clear() {
    store.clear();
  },
};
