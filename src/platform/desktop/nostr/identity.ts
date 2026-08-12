// Nostr identity for the wallet — Phase 2 foundation.
//
// Derives a Nostr keypair from the wallet's BIP39 mnemonic per NIP-06
// (path m/44'/1237'/0'/0/0), reusing the wallet's existing HD derivation. This
// is the identity both the chat (Phase 3) and the P2P-CashFusion transport
// (Phase 4) sign/encrypt under. The private key stays a Uint8Array in memory —
// it is never persisted or logged (it is as sensitive as the wallet seed).
//
// Nostr is network-agnostic: the same identity is used on mainnet and chipnet,
// so the derivation takes no network parameter.

import { getPublicKey, nip19 } from 'nostr-tools';
import { derivePrivateKeyAtPath } from '../../../services/HdWalletService';

/** NIP-06 derivation path for a Nostr key. */
export const NOSTR_DERIVATION_PATH = "m/44'/1237'/0'/0/0";

export interface NostrIdentity {
  /** 32-byte secret key. In-memory only — never persist or log. */
  secretKey: Uint8Array;
  /** 32-byte public key, lowercase hex (Nostr's canonical pubkey form). */
  pubkey: string;
  /** bech32 npub encoding of the public key. */
  npub: string;
}

/**
 * Derive the wallet's Nostr identity from its mnemonic (NIP-06). Requires the
 * decrypted mnemonic, so callers fetch it from the unlocked wallet just as they
 * would for any signing operation.
 */
export async function deriveNostrIdentity(
  mnemonic: string,
  passphrase = ''
): Promise<NostrIdentity> {
  const secretKey = await derivePrivateKeyAtPath(mnemonic, passphrase, NOSTR_DERIVATION_PATH);
  const pubkey = getPublicKey(secretKey);
  const npub = nip19.npubEncode(pubkey);
  return { secretKey, pubkey, npub };
}

/** Overwrite the secret key bytes once the identity is no longer needed. */
export function wipeNostrIdentity(identity: NostrIdentity): void {
  identity.secretKey.fill(0);
}
