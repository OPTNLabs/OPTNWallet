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
import { Network } from '../redux/networkSlice';
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
} as const;

export type BchStandardBranchName = keyof typeof BCH_STANDARD_BRANCH_INDEX;

export function getBchCoinType(network: Network): number {
  return network === Network.MAINNET ? COIN_TYPE.bitcoincash : COIN_TYPE.testnet;
}

export function getHdKeyNetwork(network: Network): 'mainnet' | 'testnet' {
  return network === Network.MAINNET ? 'mainnet' : 'testnet';
}

export function getBchAccountPath(
  network: Network,
  accountIndex = 0
): string {
  return `m/44'/${getBchCoinType(network)}'/${accountIndex}'`;
}

export function getBchBranchPath(
  network: Network,
  accountIndex: number,
  branchIndex: number
): string {
  return `${getBchAccountPath(network, accountIndex)}/${branchIndex}`;
}

export function getBchStandardBranchPath(
  network: Network,
  accountIndex: number,
  branchName: BchStandardBranchName
): string {
  return getBchBranchPath(network, accountIndex, BCH_STANDARD_BRANCH_INDEX[branchName]);
}

export function getBchAddressPath(
  network: Network,
  accountIndex: number,
  branchIndex: number,
  addressIndex: number | bigint
): string {
  return `${getBchBranchPath(network, accountIndex, branchIndex)}/${addressIndex.toString()}`;
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
    addressIndex
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
  addressIndex: number
): Promise<DerivedBchKeyMaterial | null> {
  const derived = await deriveBchChild(
    network,
    {
      mnemonic,
      passphrase,
      accountIndex,
      branchIndex,
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
  branchIndex: number
): Promise<string> {
  return deriveHdPublicKeyAtPath(
    mnemonic,
    passphrase,
    network,
    getBchBranchPath(network, accountIndex, branchIndex)
  );
}

export async function deriveBchStandardXpubs(
  network: Network,
  mnemonic: string,
  passphrase: string,
  accountIndex = 0
): Promise<Record<BchStandardBranchName, string>> {
  return {
    receive: await deriveBchXpubAtBranch(
      network,
      mnemonic,
      passphrase,
      accountIndex,
      BCH_STANDARD_BRANCH_INDEX.receive
    ),
    change: await deriveBchXpubAtBranch(
      network,
      mnemonic,
      passphrase,
      accountIndex,
      BCH_STANDARD_BRANCH_INDEX.change
    ),
    defi: await deriveBchXpubAtBranch(
      network,
      mnemonic,
      passphrase,
      accountIndex,
      BCH_STANDARD_BRANCH_INDEX.defi
    ),
  };
}

export async function deriveHdPublicKeyAtPath(
  mnemonic: string,
  passphrase: string,
  network: Network,
  path: string
): Promise<string> {
  const seed = Uint8Array.from(await bip39.mnemonicToSeed(mnemonic, passphrase));
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
  const seed = Uint8Array.from(await bip39.mnemonicToSeed(mnemonic, passphrase));
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
  const seed = Uint8Array.from(await bip39.mnemonicToSeed(mnemonic, passphrase));
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
