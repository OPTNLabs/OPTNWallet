// Nostr account identity.
//
// Live scheme is NIP-06 (https://nips.nostr.com/06): secp256k1 from the wallet
// BIP39 mnemonic at m/44'/1237'/{account}'/0/{index}. Index 0 is npub. MLS
// device n is index 1+n (mlsKeys.ts). Chat, MLS, and fusion-isolation tests
// go through this module so a later scheme (imported nsec, another NIP, a
// migrated wallet) is a new union member + loadNostrAccountSeed branch, not
// a hunt through callers. The secret stays a Uint8Array in memory.

import { getPublicKey, nip19 } from 'nostr-tools';
import { derivePrivateKeyAtPath } from '../../../services/HdWalletService';
import WalletManager from '../../../apis/WalletManager/WalletManager';

export const NOSTR_ACCOUNT_SCHEME_NIP06 = 'nip06-bip39' as const;
export type NostrAccountScheme = typeof NOSTR_ACCOUNT_SCHEME_NIP06;

/** NIP-06 coin type (Nostr). */
export const NIP06_COIN_TYPE = 1237;
export const NIP06_DEFAULT_ACCOUNT = 0;
/** Address index 0 = identity (npub / nsec). */
export const NIP06_IDENTITY_INDEX = 0;

export function nip06DerivationPath(
  account = NIP06_DEFAULT_ACCOUNT,
  index = NIP06_IDENTITY_INDEX
): string {
  return `m/44'/${NIP06_COIN_TYPE}'/${account}'/0/${index}`;
}

/** NIP-06 identity path — account 0, index 0. */
export const NOSTR_DERIVATION_PATH = nip06DerivationPath();

export type Nip06AccountSeed = {
  scheme: typeof NOSTR_ACCOUNT_SCHEME_NIP06;
  mnemonic: string;
  passphrase: string;
  account: number;
};

/** How this wallet produces Nostr keys. Add a union member when a migration exists. */
export type NostrAccountSeed = Nip06AccountSeed;

export interface NostrIdentity {
  /** 32-byte secret key. In-memory only — never persist or log. */
  secretKey: Uint8Array;
  /** 32-byte public key, lowercase hex (Nostr's canonical pubkey form). */
  pubkey: string;
  /** bech32 npub encoding of the public key. */
  npub: string;
}

export function nip06AccountSeed(
  mnemonic: string,
  passphrase = '',
  account = NIP06_DEFAULT_ACCOUNT
): Nip06AccountSeed {
  return {
    scheme: NOSTR_ACCOUNT_SCHEME_NIP06,
    mnemonic,
    passphrase,
    account,
  };
}

export function nostrDerivationPath(seed: NostrAccountSeed, index: number): string {
  switch (seed.scheme) {
    case NOSTR_ACCOUNT_SCHEME_NIP06:
      return nip06DerivationPath(seed.account, index);
    default: {
      const _never: never = seed.scheme;
      throw new Error(`unsupported nostr account scheme: ${String(_never)}`);
    }
  }
}

/** Non-secret label for the account root (no mnemonic). */
export function nostrAccountDescriptor(seed: NostrAccountSeed): string {
  switch (seed.scheme) {
    case NOSTR_ACCOUNT_SCHEME_NIP06:
      return `${seed.scheme}:m/44'/${NIP06_COIN_TYPE}'/${seed.account}'/0`;
    default: {
      const _never: never = seed.scheme;
      throw new Error(`unsupported nostr account scheme: ${String(_never)}`);
    }
  }
}

export async function nostrAccountSecretAt(
  seed: NostrAccountSeed,
  index: number
): Promise<Uint8Array> {
  switch (seed.scheme) {
    case NOSTR_ACCOUNT_SCHEME_NIP06:
      return derivePrivateKeyAtPath(
        seed.mnemonic,
        seed.passphrase,
        nostrDerivationPath(seed, index)
      );
    default: {
      const _never: never = seed.scheme;
      throw new Error(`unsupported nostr account scheme: ${String(_never)}`);
    }
  }
}

export async function deriveNostrIdentityFromSeed(
  seed: NostrAccountSeed
): Promise<NostrIdentity> {
  const secretKey = await nostrAccountSecretAt(seed, NIP06_IDENTITY_INDEX);
  const pubkey = getPublicKey(secretKey);
  const npub = nip19.npubEncode(pubkey);
  return { secretKey, pubkey, npub };
}

export async function deriveNostrIdentity(
  mnemonic: string,
  passphrase = ''
): Promise<NostrIdentity> {
  return deriveNostrIdentityFromSeed(nip06AccountSeed(mnemonic, passphrase));
}

/** Wallet hook: today BIP39 from WalletManager. Swap here on a new wallet/NIP. */
export async function loadNostrAccountSeed(
  walletId: number
): Promise<NostrAccountSeed> {
  const info = await WalletManager().getWalletInfo(walletId);
  const mnemonic = typeof info?.mnemonic === 'string' ? info.mnemonic : '';
  if (!mnemonic) {
    throw new Error('Wallet mnemonic unavailable — unlock the wallet first.');
  }
  const passphrase = typeof info?.passphrase === 'string' ? info.passphrase : '';
  return nip06AccountSeed(mnemonic, passphrase);
}

export function wipeNostrIdentity(identity: NostrIdentity): void {
  identity.secretKey.fill(0);
}
