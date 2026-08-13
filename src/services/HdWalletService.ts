import {
  encodeCashAddress,
  encodeHdPrivateKey,
  decodeHdPublicKey,
  deriveHdPath,
  deriveHdPrivateNodeFromSeed,
  deriveHdPublicNode,
  deriveHdPublicNodeChild,
  encodeHdPublicKey,
  secp256k1,
  sha256,
  validateSecp256k1PrivateKey,
} from '@bitauth/libauth';
import { hash160 } from '@cashscript/utils';
import * as bip39 from 'bip39';
import { Network } from '../state/slices/networkSlice';
import { COIN_TYPE } from '../utils/constants';
import { zeroize } from '../utils/secureMemory';

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
  const raw = hdPublicKey.trim();
  if (!raw) {
    throw new Error('Enter a valid BIP32 public key.');
  }
  const decoded = decodeHdPublicKey(raw);
  if (typeof decoded === 'string') {
    throw new Error('Enter a valid BIP32 public key.');
  }
  const target = getHdKeyNetwork(network);
  if (decoded.network === target) {
    return raw;
  }
  const encoded = encodeHdPublicKey({
    network: target,
    node: decoded.node,
  });
  if (typeof encoded === 'string') {
    throw new Error('Could not re-encode the public key for this network.');
  }
  return encoded.hdPublicKey;
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
  const publicKeyHash = hash160(publicKey);
  if (!publicKeyHash) {
    return null;
  }

  const prefix = network === Network.MAINNET ? 'bitcoincash' : 'bchtest';
  const address = encodeCashAddress({
    payload: publicKeyHash,
    prefix,
    type: 'p2pkh',
  }).address;
  const tokenAddress = encodeCashAddress({
    payload: publicKeyHash,
    prefix,
    type: 'p2pkhWithTokens',
  }).address;

  return {
    publicKey: Uint8Array.from(publicKey),
    publicKeyHash: Uint8Array.from(publicKeyHash),
    address,
    tokenAddress,
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
  const privateKey = await derivePrivateKeyAtPath(
    source.mnemonic,
    source.passphrase,
    path
  );

  try {
    const publicKey = secp256k1.derivePublicKeyCompressed(privateKey);
    if (typeof publicKey === 'string') {
      return null;
    }

    const publicAddress = deriveBchPublicAddress(network, publicKey);
    if (!publicAddress) {
      return null;
    }

    return {
      publicKey: publicAddress.publicKey,
      privateKey: Uint8Array.from(privateKey),
      publicKeyHash: publicAddress.publicKeyHash,
      address: publicAddress.address,
      tokenAddress: publicAddress.tokenAddress,
    };
  } finally {
    zeroize(privateKey);
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

export async function deriveHdPublicKeyAtPath(
  mnemonic: string,
  passphrase: string,
  network: Network,
  path: string
): Promise<string> {
  const seed = Uint8Array.from(
    await bip39.mnemonicToSeed(mnemonic, passphrase)
  );
  const rootNode = deriveHdPrivateNodeFromSeed(seed, { assumeValidity: true });

  try {
    const derived = deriveHdPath(rootNode, path);
    if (typeof derived === 'string') {
      throw new Error(`Failed to derive path ${path}: ${derived}`);
    }

    const publicNode = deriveHdPublicNode(derived);
    const xpub = encodeHdPublicKey({
      network: getHdKeyNetwork(network),
      node: publicNode,
    });

    if (typeof xpub === 'string') {
      throw new Error(`Failed to encode HD public key for ${path}: ${xpub}`);
    }

    zeroize(derived.privateKey);
    return xpub.hdPublicKey;
  } finally {
    zeroize(seed);
    zeroize(rootNode.privateKey);
  }
}

export async function deriveHdPrivateKeyAtPath(
  mnemonic: string,
  passphrase: string,
  network: Network,
  path: string
): Promise<string> {
  const seed = Uint8Array.from(
    await bip39.mnemonicToSeed(mnemonic, passphrase)
  );
  const rootNode = deriveHdPrivateNodeFromSeed(seed, { assumeValidity: true });

  try {
    const derived = deriveHdPath(rootNode, path);
    if (typeof derived === 'string') {
      throw new Error(`Failed to derive HD private key at ${path}: ${derived}`);
    }

    const xprv = encodeHdPrivateKey({
      network: getHdKeyNetwork(network),
      node: derived,
    });
    if (typeof xprv === 'string') {
      throw new Error(`Failed to encode HD private key for ${path}: ${xprv}`);
    }

    zeroize(derived.privateKey);
    return xprv.hdPrivateKey;
  } finally {
    zeroize(seed);
    zeroize(rootNode.privateKey);
  }
}

export async function derivePrivateKeyAtPath(
  mnemonic: string,
  passphrase: string,
  path: string
): Promise<Uint8Array> {
  const seed = Uint8Array.from(
    await bip39.mnemonicToSeed(mnemonic, passphrase)
  );
  const rootNode = deriveHdPrivateNodeFromSeed(seed, { assumeValidity: true });

  try {
    const derived = deriveHdPath(rootNode, path);
    if (typeof derived === 'string') {
      throw new Error(`Failed to derive private key at ${path}: ${derived}`);
    }

    return Uint8Array.from(derived.privateKey);
  } finally {
    zeroize(seed);
    zeroize(rootNode.privateKey);
  }
}

export function derivePublicKeyFromHdPublicKey(
  hdPublicKey: string,
  index: bigint
): Uint8Array {
  const decoded = decodeHdPublicKey(hdPublicKey);
  if (typeof decoded === 'string') {
    throw new Error(`Invalid HD public key: ${decoded}`);
  }

  const child = deriveHdPublicNodeChild(decoded.node, Number(index));
  if (typeof child === 'string') {
    throw new Error(`Failed to derive public key child: ${child}`);
  }

  return Uint8Array.from(child.publicKey);
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
