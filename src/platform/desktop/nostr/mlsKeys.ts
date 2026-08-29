// MLS keys from the Nostr account seed (identity.ts).
//
//   Nostr: m/44'/1237'/0'/0/0  -> secp256k1 npub
//   MLS:   m/44'/1237'/0'/0/1  -> Ed25519 (device 0; +n for extra leaves)
//
// HPKE IKMs are HKDF from the BIP39 seed with Paytaca's info strings so a
// restored wallet publishes the same KeyPackage.

import { mnemonicToSeed } from 'bip39';
// noble v2 exports `./ed25519.js` only; TypeScript still loads ed25519.d.ts.
import { ed25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';
import {
  nip06AccountSeed,
  nip06DerivationPath,
  nostrAccountSecretAt,
  type NostrAccountSeed,
} from './identity';

export const MLS_DERIVATION_PATH = nip06DerivationPath(0, 1);

/** Device 0 = Paytaca-compatible /0/1. Extra devices are /0/2, /0/3, … (one MLS leaf each). */
export function mlsDerivationPath(deviceIndex = 0): string {
  return nip06DerivationPath(0, mlsIndex(deviceIndex));
}

export function mlsIndex(deviceIndex = 0): number {
  return 1 + deviceIndex;
}

export type MlsKeys = {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
  publicKeyHex: string;
};

export async function deriveMlsKeysFromSeed(
  seed: NostrAccountSeed,
  deviceIndex = 0
): Promise<MlsKeys> {
  const privateKey = await nostrAccountSecretAt(seed, mlsIndex(deviceIndex));
  const publicKey = ed25519.getPublicKey(privateKey);
  return {
    publicKey,
    privateKey,
    publicKeyHex: bytesToHex(publicKey),
  };
}

export async function deriveMlsKeys(
  mnemonic: string,
  passphrase = '',
  deviceIndex = 0
): Promise<MlsKeys> {
  return deriveMlsKeysFromSeed(
    nip06AccountSeed(mnemonic, passphrase),
    deviceIndex
  );
}

export async function deriveMlsHpkeIkms(mnemonic: string, passphrase = '') {
  const seed = new Uint8Array(await mnemonicToSeed(mnemonic, passphrase));
  const initIkm = hkdf(
    sha256,
    seed,
    undefined,
    new TextEncoder().encode('paytaca-mls-init-key'),
    32
  );
  const hpkeIkm = hkdf(
    sha256,
    seed,
    undefined,
    new TextEncoder().encode('paytaca-mls-hpke-key'),
    32
  );
  return { initIkm, hpkeIkm };
}
