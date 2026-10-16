import {
  hexToBin,
  sha256,
  validateSecp256k1PrivateKey,
} from '@bitauth/libauth';
import { Network } from '../state/slices/networkSlice';
import { COIN_TYPE } from '../utils/constants';
import { zeroize } from '../utils/secureMemory';
// Seeds, BIP32 and addresses are derived by crates/optn-core (src/hd.rs), the
// same code the CLI and the desktop runtime use. This file keeps the wallet's
// path conventions and hands the cryptography to it.
import {
  bchP2pkhAddresses as coreBchP2pkhAddresses,
  ensureOptnCore,
  hdAlignPublicKeyNetwork as coreAlignPublicKeyNetwork,
  hdExtendedPrivateKeyAtPath as coreExtendedPrivateKeyAtPath,
  hdKeyPairAtPath as coreKeyPairAtPath,
  hdMasterFingerprint as coreMasterFingerprint,
  hdPrivateKeyAtPath as corePrivateKeyAtPath,
  hdPublicKeyAtPath as corePublicKeyAtPath,
  hdPublicKeyChild as corePublicKeyChild,
} from '../wasm/optn-core';

/** The core takes the network as a string; this is the only mapping needed. */
function coreNetwork(network: Network): string {
  return network === Network.MAINNET ? 'mainnet' : 'chipnet';
}

/**
 * BIP39 hashes the NFKD form of the phrase and the passphrase. bip39.js did
 * that itself; the core leaves Unicode to JS, which has it built in.
 */
function nfkd(text: string | undefined): string {
  return (text ?? '').normalize('NFKD');
}

/** Call the core, turning the string it throws into an Error. */
function callCore<T>(call: () => T): T {
  ensureOptnCore();
  try {
    return call();
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
}

export type DerivedBchKeyMaterial = {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
  publicKeyHash: Uint8Array;
  address: string;
  tokenAddress: string;
};

export type DerivedBchPublicAddress = {
  publicKey: Uint8Array;
  publicKeyHash: Uint8Array;
  address: string;
  tokenAddress: string;
};

export type BchSeedDerivationSource = {
  kind?: 'seed';
  mnemonic: string;
  passphrase: string;
  accountIndex: number;
  branchIndex: number;
  accountPath?: string;
};

export type BchXpubDerivationSource = {
  kind: 'xpub';
  hdPublicKey: string;
};

export type BchChildDerivationSource =
  | BchSeedDerivationSource
  | BchXpubDerivationSource;

export type DerivedBchChild = DerivedBchKeyMaterial | DerivedBchPublicAddress;

export const BCH_STANDARD_BRANCH_INDEX = {
  receive: 0,
  change: 1,
  defi: 7,
  // Reusable Payment Addresses (RPA): rides on the wallet's normal BIP44
  // account as a third unhardened chain, sibling to receive(0)/change(1),
  // matching the Electron Cash reference implementation.
  // scan pubkey  = m/44'/coinType'/account'/3/0
  // spend pubkey = m/44'/coinType'/account'/3/1
  rpa: 3,
} as const;

export type BchStandardBranchName = keyof typeof BCH_STANDARD_BRANCH_INDEX;

// These branches use ordinary BCH address derivation and therefore belong in
// the wallet-wide history/UTXO scan. RPA branch 3 is a key gate (scan/spend
// keys at child indexes 0 and 1), not a normal sequence of BCH addresses; it
// is handled by RpaService instead.
export const BCH_WALLET_SCAN_BRANCH_NAMES: readonly BchStandardBranchName[] = [
  'receive',
  'change',
  'defi',
];

/**
 * SLIP-44 coin type for BCH account paths.
 *
 * Mainnet uses BCH's registered coin type 145. Every test network defaults to
 * BIP44's coin type 1 ("Testnet (all coins)"); 145 remains a valid custom path
 * for restoring wallets created by BCH tooling that uses the mainnet coin type
 * on a test net.
 *
 * Mainnet is the special case, not chipnet. `candidateAccountPaths` in
 * DerivationPathDiscovery keys off mainnet the same way, so a network added
 * later cannot inherit 145 here while being probed as a test net there.
 */
export function getBchCoinType(network: Network = Network.MAINNET): number {
  return network === Network.MAINNET
    ? COIN_TYPE.bitcoincash
    : COIN_TYPE.testnet;
}

export const MAX_BIP44_INDEX = 0x7fffffff;

export type BchAccountPathParts = {
  coinType: number;
  accountIndex: number;
};

/**
 * Validate and canonicalize the only custom path shape supported by OPTN:
 * BIP44 account paths. Branch and address components are owned by the wallet
 * implementation and must not be supplied by callers.
 */
export function normalizeBchAccountPath(path: string): string {
  const match = /^m\/44'\/(\d+)'\/(\d+)'$/.exec(path.trim());
  if (!match) {
    throw new Error(
      "Derivation path must match m/44'/coinType'/accountIndex'."
    );
  }

  const coinType = Number(match[1]);
  const accountIndex = Number(match[2]);
  if (
    !Number.isSafeInteger(coinType) ||
    coinType < 0 ||
    coinType > MAX_BIP44_INDEX ||
    !Number.isSafeInteger(accountIndex) ||
    accountIndex < 0 ||
    accountIndex > MAX_BIP44_INDEX
  ) {
    throw new Error(
      'Derivation path indexes must be hardened 31-bit integers.'
    );
  }

  return `m/44'/${coinType}'/${accountIndex}'`;
}

export function parseBchAccountPath(path: string): BchAccountPathParts {
  const normalized = normalizeBchAccountPath(path);
  const match = /^m\/44'\/(\d+)'\/(\d+)'$/.exec(normalized);
  if (!match) {
    throw new Error(
      "Derivation path must match m/44'/coinType'/accountIndex'."
    );
  }

  return {
    coinType: Number(match[1]),
    accountIndex: Number(match[2]),
  };
}

export function buildBchAccountPath(parts: BchAccountPathParts): string {
  return normalizeBchAccountPath(
    `m/44'/${parts.coinType}'/${parts.accountIndex}'`
  );
}

export function getHdKeyNetwork(network: Network): 'mainnet' | 'testnet' {
  return network === Network.MAINNET ? 'mainnet' : 'testnet';
}

/**
 * Re-serialize a BIP32 public key with the version bytes for `network`.
 *
 * The HD node (depth, child index, chain code, pubkey) is unchanged — only the
 * base58 version prefix (xpub vs tpub) is aligned. Trezor often returns a tpub
 * when GetPublicKey used "Bcash Testnet" (or a chipnet export was later opened
 * as mainnet). Address derivation needs matching version bytes for libauth;
 * the on-chain keys are identical either way.
 *
 * Electron Cash stores the key material and uses network for address encoding;
 * this mirrors that separation.
 */
export function alignHdPublicKeyNetwork(
  network: Network,
  hdPublicKey: string
): string {
  return callCore(() =>
    coreAlignPublicKeyNetwork(coreNetwork(network), hdPublicKey)
  );
}

export function getBchAccountPath(
  network: Network,
  accountIndex = 0,
  accountPath?: string
): string {
  return accountPath
    ? normalizeBchAccountPath(accountPath)
    : `m/44'/${getBchCoinType(network)}'/${accountIndex}'`;
}

function resolveBchAccountPath(
  network: Network,
  accountIndex: number,
  accountPath?: string
): string {
  return getBchAccountPath(network, accountIndex, accountPath);
}

export function getBchBranchPath(
  network: Network,
  accountIndex: number,
  branchIndex: number,
  accountPath?: string
): string {
  return `${resolveBchAccountPath(network, accountIndex, accountPath)}/${branchIndex}`;
}

export function getBchStandardBranchPath(
  network: Network,
  accountIndex: number,
  branchName: BchStandardBranchName,
  accountPath?: string
): string {
  return getBchBranchPath(
    network,
    accountIndex,
    BCH_STANDARD_BRANCH_INDEX[branchName],
    accountPath
  );
}

export function getBchAddressPath(
  network: Network,
  accountIndex: number,
  branchIndex: number,
  addressIndex: number | bigint,
  accountPath?: string
): string {
  return `${getBchBranchPath(network, accountIndex, branchIndex, accountPath)}/${addressIndex.toString()}`;
}

export function deriveBchPublicAddress(
  network: Network,
  publicKey: Uint8Array
): DerivedBchPublicAddress | null {
  // Compressed or uncompressed SEC1; anything else has no P2PKH address.
  if (publicKey.length !== 33 && publicKey.length !== 65) {
    return null;
  }
  const derived = JSON.parse(
    callCore(() => coreBchP2pkhAddresses(coreNetwork(network), publicKey))
  ) as { publicKeyHash: string; address: string; tokenAddress: string };

  return {
    publicKey: Uint8Array.from(publicKey),
    publicKeyHash: hexToBin(derived.publicKeyHash),
    address: derived.address,
    tokenAddress: derived.tokenAddress,
  };
}

function isBchXpubDerivationSource(
  source: BchChildDerivationSource
): source is BchXpubDerivationSource {
  return source.kind === 'xpub';
}

export async function deriveBchChild(
  network: Network,
  source: BchChildDerivationSource,
  addressIndex: number | bigint
): Promise<DerivedBchChild | null> {
  if (isBchXpubDerivationSource(source)) {
    return deriveBchAddressFromHdPublicKey(
      network,
      source.hdPublicKey,
      BigInt(addressIndex)
    );
  }

  const path = getBchAddressPath(
    network,
    source.accountIndex,
    source.branchIndex,
    addressIndex,
    source.accountPath
  );
  // private(32) || compressed public(33), from one derivation in the core.
  const keyPair = callCore(() =>
    coreKeyPairAtPath(nfkd(source.mnemonic), nfkd(source.passphrase), path)
  );

  try {
    if (keyPair.length !== 65) {
      throw new Error(
        `optn-core returned ${keyPair.length} bytes of key pair, expected 65`
      );
    }
    const publicAddress = deriveBchPublicAddress(network, keyPair.subarray(32));
    if (!publicAddress) {
      return null;
    }

    return {
      publicKey: publicAddress.publicKey,
      privateKey: keyPair.slice(0, 32),
      publicKeyHash: publicAddress.publicKeyHash,
      address: publicAddress.address,
      tokenAddress: publicAddress.tokenAddress,
    };
  } finally {
    zeroize(keyPair);
  }
}

export async function deriveBchKeyMaterial(
  network: Network,
  mnemonic: string,
  passphrase: string,
  accountIndex: number,
  branchIndex: number,
  addressIndex: number,
  accountPath?: string
): Promise<DerivedBchKeyMaterial | null> {
  const derived = await deriveBchChild(
    network,
    {
      mnemonic,
      passphrase,
      accountIndex,
      branchIndex,
      accountPath,
    },
    addressIndex
  );

  return derived && 'privateKey' in derived ? derived : null;
}

export async function deriveBchXpubAtBranch(
  network: Network,
  mnemonic: string,
  passphrase: string,
  accountIndex: number,
  branchIndex: number,
  accountPath?: string
): Promise<string> {
  return deriveHdPublicKeyAtPath(
    mnemonic,
    passphrase,
    network,
    getBchBranchPath(network, accountIndex, branchIndex, accountPath)
  );
}

export async function deriveBchStandardXpubs(
  network: Network,
  mnemonic: string,
  passphrase: string,
  accountIndex = 0,
  accountPath?: string
): Promise<Record<BchStandardBranchName, string>> {
  return {
    receive: await deriveBchXpubAtBranch(
      network,
      mnemonic,
      passphrase,
      accountIndex,
      BCH_STANDARD_BRANCH_INDEX.receive,
      accountPath
    ),
    change: await deriveBchXpubAtBranch(
      network,
      mnemonic,
      passphrase,
      accountIndex,
      BCH_STANDARD_BRANCH_INDEX.change,
      accountPath
    ),
    defi: await deriveBchXpubAtBranch(
      network,
      mnemonic,
      passphrase,
      accountIndex,
      BCH_STANDARD_BRANCH_INDEX.defi,
      accountPath
    ),
    rpa: await deriveBchXpubAtBranch(
      network,
      mnemonic,
      passphrase,
      accountIndex,
      BCH_STANDARD_BRANCH_INDEX.rpa,
      accountPath
    ),
  };
}

// These stay async: callers await them, and bip39.js's seed was async.

/** The extended public key at a path: xpub on mainnet, tpub otherwise. */
export async function deriveHdPublicKeyAtPath(
  mnemonic: string,
  passphrase: string,
  network: Network,
  path: string
): Promise<string> {
  return callCore(() =>
    corePublicKeyAtPath(
      nfkd(mnemonic),
      nfkd(passphrase),
      coreNetwork(network),
      path
    )
  );
}

/** Derive the BIP32 master fingerprint without exposing the root key. */
export async function deriveMasterFingerprint(
  mnemonic: string,
  passphrase: string
): Promise<Uint8Array> {
  return Uint8Array.from(
    callCore(() => coreMasterFingerprint(nfkd(mnemonic), nfkd(passphrase)))
  );
}

/** The extended private key at a path: xprv on mainnet, tprv otherwise. */
export async function deriveHdPrivateKeyAtPath(
  mnemonic: string,
  passphrase: string,
  network: Network,
  path: string
): Promise<string> {
  return callCore(() =>
    coreExtendedPrivateKeyAtPath(
      nfkd(mnemonic),
      nfkd(passphrase),
      coreNetwork(network),
      path
    )
  );
}

/** The 32-byte private key at a path. The caller wipes it after use. */
export async function derivePrivateKeyAtPath(
  mnemonic: string,
  passphrase: string,
  path: string
): Promise<Uint8Array> {
  return callCore(() =>
    corePrivateKeyAtPath(nfkd(mnemonic), nfkd(passphrase), path)
  );
}

export function derivePublicKeyFromHdPublicKey(
  hdPublicKey: string,
  index: bigint
): Uint8Array {
  // Checked here because the boundary takes a u32 and would wrap a larger
  // number rather than refuse it. Hardened children need the private key.
  if (index < 0n || index > BigInt(MAX_BIP44_INDEX)) {
    throw new Error(
      `Failed to derive public key child: index ${index} is not a non-hardened index`
    );
  }
  return Uint8Array.from(
    callCore(() => corePublicKeyChild(hdPublicKey, Number(index)))
  );
}

export function deriveBchAddressFromHdPublicKey(
  network: Network,
  hdPublicKey: string,
  index: bigint
): DerivedBchPublicAddress | null {
  const publicKey = derivePublicKeyFromHdPublicKey(hdPublicKey, index);
  return deriveBchPublicAddress(network, publicKey);
}

export function createDeterministicRuntimePrivateKey(
  scope: string,
  id: string,
  extra: string
): Uint8Array {
  const encoder = new TextEncoder();

  for (let counter = 0; counter < 1024; counter += 1) {
    const material = encoder.encode(`${scope}:${id}:${extra}:${counter}`);
    const candidate = sha256.hash(material);
    if (validateSecp256k1PrivateKey(candidate)) {
      return Uint8Array.from(candidate);
    }
  }

  for (let counter = 0; counter < 1024; counter += 1) {
    const candidate = crypto.getRandomValues(new Uint8Array(32));
    if (validateSecp256k1PrivateKey(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Failed to generate deterministic private key for ${scope}`);
}
