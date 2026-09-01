// Watch-only multisig policy: cosigner set, address derivation, and the
// Paytaca wallet interchange format.
//
// Matched to paytaca-app `src/lib/multisig/wallet.js`, which is the reference
// for BCH multisig here:
//
//   * A wallet is `{ name, m, signers: [{ xpub, name }] }` (`createWallet`).
//   * Addresses derive each signer's public key at a *relative* path like
//     `0/3`, sort those keys BIP-67 by hex, and lock to P2SH20 of
//     `OP_m <keys> OP_n OP_CHECKMULTISIG` (`derivePublicKeys` + the
//     `lockingType: 'p2sh20'` template).
//   * The sort happens per address, on the derived keys — not once on the
//     xPubs. Two cosigners can swap order between index 3 and index 4, so
//     sorting the xPubs up front would produce a different address set.
//   * Files are named `<name>.pmwif` (`generateFilename`).
//
// One addition Paytaca does not need: a master fingerprint per cosigner.
// Paytaca computes its own from the local mnemonic (`getMasterFingerprint`),
// but a watch-only wallet has no mnemonic for anybody, and every offline
// signer claims its inputs by matching the fingerprint in the PSBT's BIP32
// derivation records. So fingerprints are carried alongside and, because the
// .pmwif format has no field for them, they survive a Paytaca round trip only
// as an OPTN-specific extra.

import {
  binToHex,
  decodeHdPublicKey,
  deriveHdPathRelative,
} from '@bitauth/libauth';

import { Network } from '../../state/slices/networkSlice';
import {
  alignHdPublicKeyNetwork,
  getBchAccountPath,
  normalizeBchAccountPath,
} from '../HdWalletService';
import { sha256 } from '../../utils/hash';

import {
  buildMultisigRedeemScript,
  p2shLockingBytecodeFor,
} from './psbtMultisig';

/** Paytaca's file extension for an exported multisig wallet. */
export const PMWIF_EXTENSION = '.pmwif';

/** Upper bound from OP_CHECKMULTISIG itself. */
/**
 * P2SH pushes the redeem script as one element and BCH enforces the 520-byte
 * script-element limit. With compressed public keys that limits us to 15
 * cosigners, even though OP_CHECKMULTISIG itself can encode more.
 */
export const MAX_COSIGNERS = 15;

export interface MultisigCosigner {
  /** Display name, e.g. "Alice's SeedCash". */
  name: string;
  /** Account-level xPub at m/44'/145'/account'. */
  xpub: string;
  /**
   * 8 hex characters shown on that cosigner's signing device. Optional
   * because a wallet imported from Paytaca has no fingerprints in it, but a
   * send cannot be built until every cosigner has one.
   */
  masterFingerprintHex?: string;
  /** Account path this xPub was exported at. */
  accountPath?: string;
  /** Stable public cosigner identifier used across derived-key reorderings. */
  id?: string;
  /** New descriptor-facing label; `name` remains for .pmwif compatibility. */
  label?: string;
}

export interface MultisigPolicy {
  name: string;
  /** Signatures required. */
  m: number;
  /** Descriptor-facing alias for `m`; legacy policies use only `m`. */
  threshold?: number;
  signers: MultisigCosigner[];
  /** Shared descriptor schema version. Legacy .pmwif policies omit this. */
  schemaVersion?: 1;
  /** BCH network for canonical descriptor generation. */
  network?: Network;
  /** Shared account path; signer paths must match when present. */
  accountPath?: string;
  /** Descriptor policy revision. Address rotation does not change it. */
  policyRevision?: number;
}

const FINGERPRINT_PATTERN = /^[0-9a-fA-F]{8}$/;

/** Signatures required out of how many, as `2-of-3`. */
export function describePolicy(policy: MultisigPolicy): string {
  return `${policy.m}-of-${policy.signers.length}`;
}

/**
 * Reject a policy that cannot produce addresses, with a message aimed at the
 * person assembling the wallet rather than at a developer.
 */
export function validateMultisigPolicy(policy: MultisigPolicy): void {
  const n = policy.signers.length;
  if (n < 2) {
    throw new Error('A multisig wallet needs at least two cosigners.');
  }
  if (n > MAX_COSIGNERS) {
    throw new Error(
      `A multisig wallet cannot have more than ${MAX_COSIGNERS} cosigners.`
    );
  }
  if (!Number.isInteger(policy.m) || policy.m < 1 || policy.m > n) {
    throw new Error(
      `Signatures required must be between 1 and ${n} (got ${policy.m}).`
    );
  }
  if (policy.threshold !== undefined && policy.threshold !== policy.m) {
    throw new Error(
      'Multisig threshold and required signature count disagree.'
    );
  }
  if (
    policy.policyRevision !== undefined &&
    (!Number.isSafeInteger(policy.policyRevision) || policy.policyRevision < 0)
  ) {
    throw new Error('Multisig policy revision must be a non-negative integer.');
  }
  const seen = new Set<string>();
  const seenIds = new Set<string>();
  policy.signers.forEach((signer, index) => {
    const xpub = signer.xpub.trim();
    if (!xpub) throw new Error(`Cosigner ${index + 1} has no xPub.`);
    if (seen.has(xpub)) {
      throw new Error(
        `Cosigner ${index + 1} repeats an xPub already in this wallet. Each ` +
          'cosigner must be a different key, or the threshold is a fiction.'
      );
    }
    seen.add(xpub);
    if (signer.id) {
      const id = signer.id.trim();
      if (!id) throw new Error(`Cosigner ${index + 1} has an empty ID.`);
      if (seenIds.has(id)) {
        throw new Error(`Cosigner ${index + 1} repeats a cosigner ID.`);
      }
      seenIds.add(id);
    }
    if (typeof decodeHdPublicKey(xpub) === 'string') {
      throw new Error(`Cosigner ${index + 1} has an xPub that cannot be read.`);
    }
    if (
      signer.masterFingerprintHex &&
      !FINGERPRINT_PATTERN.test(signer.masterFingerprintHex)
    ) {
      throw new Error(
        `Cosigner ${index + 1} has a master fingerprint that is not 8 hex ` +
          'characters.'
      );
    }
  });
}

export function stableCosignerId(xpub: string): string {
  return `xpub:${sha256.text(xpub).slice(0, 16)}`;
}

/**
 * Convert legacy Paytaca/desktop policy data into the strict descriptor model.
 * Missing fingerprints remain a hard error because a descriptor exported to a
 * signer must identify the master key origin unambiguously.
 */
export function normalizeMultisigPolicy(
  policy: MultisigPolicy,
  network: Network = policy.network ?? Network.MAINNET
): CanonicalMultisigPolicy {
  validateMultisigPolicy(policy);
  const accountPath = normalizeBchAccountPath(
    policy.accountPath ??
      policy.signers.find((signer) => signer.accountPath)?.accountPath ??
      getBchAccountPath(network)
  );
  const alignedXpubs = new Set<string>();
  const cosigners = policy.signers.map((signer, index) => {
    const xpub = alignHdPublicKeyNetwork(network, signer.xpub.trim());
    if (alignedXpubs.has(xpub)) {
      throw new Error(
        `Cosigner ${index + 1} duplicates another xPub after network normalization.`
      );
    }
    alignedXpubs.add(xpub);
    const decoded = decodeHdPublicKey(xpub);
    if (typeof decoded === 'string') {
      throw new Error(`Cosigner ${index + 1} has an unreadable xPub.`);
    }
    if (decoded.node.depth !== 3) {
      throw new Error(
        `Cosigner ${index + 1} must provide an account-level xPub at ${accountPath}.`
      );
    }
    const signerPath = normalizeBchAccountPath(
      signer.accountPath ?? accountPath
    );
    if (signerPath !== accountPath) {
      throw new Error(
        `Cosigner ${index + 1} uses ${signerPath}; all cosigners must use ${accountPath}.`
      );
    }
    const fingerprint = signer.masterFingerprintHex?.trim().toLowerCase();
    if (!fingerprint || !FINGERPRINT_PATTERN.test(fingerprint)) {
      throw new Error(
        `Cosigner ${index + 1} needs an 8-character master fingerprint before descriptor export.`
      );
    }
    return {
      id: signer.id?.trim() || stableCosignerId(xpub),
      label:
        signer.label?.trim() || signer.name.trim() || `Cosigner ${index + 1}`,
      xpub,
      masterFingerprintHex: fingerprint,
      accountPath,
    };
  });
  const ids = new Set<string>();
  for (const cosigner of cosigners) {
    if (ids.has(cosigner.id)) throw new Error('Cosigner IDs must be unique.');
    ids.add(cosigner.id);
  }
  return {
    schemaVersion: 1,
    name: policy.name.trim(),
    network,
    threshold: policy.m,
    accountPath,
    policyRevision: policy.policyRevision ?? 0,
    cosigners,
  };
}

function descriptorKeyOrigin(cosigner: CanonicalMultisigCosigner): string {
  return `[${cosigner.masterFingerprintHex}/${cosigner.accountPath.slice(2)}]${cosigner.xpub}`;
}

function descriptorBody(
  policy: CanonicalMultisigPolicy,
  branch: 0 | 1
): string {
  const keys = [...policy.cosigners]
    .sort((a, b) => {
      const left = `${a.masterFingerprintHex}${a.xpub}`;
      const right = `${b.masterFingerprintHex}${b.xpub}`;
      return left < right ? -1 : left > right ? 1 : 0;
    })
    .map((cosigner) => `${descriptorKeyOrigin(cosigner)}/${branch}/*`);
  return `sh(sortedmulti(${policy.threshold},${keys.join(',')}))`;
}

/** Generate canonical BIP-380/BIP-383 receive and change descriptors. */
export function createMultisigDescriptorSet(
  policy: MultisigPolicy,
  network: Network = policy.network ?? Network.MAINNET
): MultisigDescriptorSet {
  const canonical = normalizeMultisigPolicy(policy, network);
  const receiveBody = descriptorBody(canonical, 0);
  const changeBody = descriptorBody(canonical, 1);
  const receive = addDescriptorChecksum(receiveBody);
  const change = addDescriptorChecksum(changeBody);
  const policyMaterial = JSON.stringify({
    descriptorFormat: 'bip380+bip383',
    network: canonical.network,
    threshold: canonical.threshold,
    accountPath: canonical.accountPath,
    receive: receiveBody,
    change: changeBody,
    policyRevision: canonical.policyRevision,
  });
  return {
    receive,
    change,
    policyId: binToHex(sha256.hash(new TextEncoder().encode(policyMaterial))),
  };
}

/**
 * Expand one concrete child index for BCHN's current descriptor parser. BCHN
 * supports `multi` but not `sortedmulti` or descriptor checksums, so concrete
 * public keys are already sorted before this string is emitted.
 */
export function createBchnScanDescriptor(
  policy: MultisigPolicy,
  branch: 0 | 1,
  addressIndex: number,
  network: Network = policy.network ?? Network.MAINNET
): string {
  if (!Number.isSafeInteger(addressIndex) || addressIndex < 0) {
    throw new Error('BCHN scan address index must be a non-negative integer.');
  }
  const canonical = normalizeMultisigPolicy(policy, network);
  const derived = deriveMultisigAddress(
    { ...policy, network, accountPath: canonical.accountPath },
    branch,
    addressIndex
  );
  return `sh(multi(${canonical.threshold},${derived.sortedPublicKeys
    .map(binToHex)
    .join(',')}))`;
}

/** Cosigners still missing the fingerprint a signer needs to claim inputs. */
export function cosignersMissingFingerprint(
  policy: MultisigPolicy
): MultisigCosigner[] {
  return policy.signers.filter(
    (signer) =>
      !signer.masterFingerprintHex ||
      !FINGERPRINT_PATTERN.test(signer.masterFingerprintHex)
  );
}

export interface MultisigAddress {
  /** BIP-67-sorted redeem script for this address. */
  redeemScript: Uint8Array;
  /** P2SH20 locking bytecode. */
  lockingBytecode: Uint8Array;
  /** Each cosigner's key at this path, in redeem-script order. */
  sortedPublicKeys: Uint8Array[];
  /** Derived cosigners with their authoritative redeem-script positions. */
  derivedCosigners: MultisigDerivedCosigner[];
  /** Relative path used, e.g. `0/3`. */
  relativePath: string;
}

export interface MultisigDerivedCosigner {
  cosignerId: string;
  publicKey: Uint8Array;
  sortedPosition: number;
  derivationPath: string;
}

export interface CanonicalMultisigCosigner {
  id: string;
  label: string;
  xpub: string;
  masterFingerprintHex: string;
  accountPath: string;
}

export interface CanonicalMultisigPolicy {
  schemaVersion: 1;
  name: string;
  network: Network;
  threshold: number;
  accountPath: string;
  policyRevision: number;
  cosigners: CanonicalMultisigCosigner[];
}

export interface MultisigDescriptorSet {
  receive: string;
  change: string;
  policyId: string;
}

export interface MultisigManifest {
  format: 'optn-multisig-manifest';
  schemaVersion: 1;
  policy: CanonicalMultisigPolicy;
  descriptors: MultisigDescriptorSet;
}

const DESCRIPTOR_INPUT_CHARSET =
  `0123456789()[],'/*abcdefgh@:$%{}IJKLMNOPQRSTUVWXYZ&+-.;<=>?!^_|~` +
  'ijklmnopqrstuvwxyzABCDEFGH`#"\\ ';
const DESCRIPTOR_CHECKSUM_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const DESCRIPTOR_GENERATOR = [
  0xf5dee51989n,
  0xa9fdca3312n,
  0x1bab10e32dn,
  0x3706b1677an,
  0x644d626ffdn,
] as const;

function descriptorPolymod(symbols: number[]): bigint {
  let checksum = 1n;
  for (const value of symbols) {
    const top = checksum >> 35n;
    checksum = ((checksum & 0x7ffffffffn) << 5n) ^ BigInt(value);
    for (let i = 0; i < 5; i += 1) {
      if (((top >> BigInt(i)) & 1n) !== 0n) {
        checksum ^= DESCRIPTOR_GENERATOR[i];
      }
    }
  }
  return checksum;
}

function descriptorExpand(payload: string): number[] {
  const groups: number[] = [];
  const symbols: number[] = [];
  for (const character of payload) {
    const value = DESCRIPTOR_INPUT_CHARSET.indexOf(character);
    if (value < 0) throw new Error('Descriptor contains an invalid character.');
    symbols.push(value & 31);
    groups.push(value >> 5);
    if (groups.length === 3) {
      symbols.push(groups[0] * 9 + groups[1] * 3 + groups[2]);
      groups.length = 0;
    }
  }
  if (groups.length === 1) symbols.push(groups[0]);
  if (groups.length === 2) symbols.push(groups[0] * 3 + groups[1]);
  return symbols;
}

/** BIP-380 descriptor checksum, exported for manifest and QR validation. */
export function addDescriptorChecksum(payload: string): string {
  const checksum =
    descriptorPolymod([...descriptorExpand(payload), 0, 0, 0, 0, 0, 0, 0, 0]) ^
    1n;
  let encoded = '';
  for (let i = 0; i < 8; i += 1) {
    encoded +=
      DESCRIPTOR_CHECKSUM_CHARSET[
        Number((checksum >> BigInt(5 * (7 - i))) & 31n)
      ];
  }
  return `${payload}#${encoded}`;
}

export function verifyDescriptorChecksum(descriptor: string): boolean {
  const separator = descriptor.lastIndexOf('#');
  if (separator < 0 || descriptor.length - separator !== 9) return false;
  const payload = descriptor.slice(0, separator);
  const checksum = descriptor.slice(separator + 1);
  if (
    !checksum.split('').every((c) => DESCRIPTOR_CHECKSUM_CHARSET.includes(c))
  ) {
    return false;
  }
  const symbols = [
    ...descriptorExpand(payload),
    ...checksum.split('').map((c) => DESCRIPTOR_CHECKSUM_CHARSET.indexOf(c)),
  ];
  return descriptorPolymod(symbols) === 1n;
}

function canonicalPolicyToLegacy(
  canonical: CanonicalMultisigPolicy
): MultisigPolicy {
  return {
    schemaVersion: 1,
    name: canonical.name,
    m: canonical.threshold,
    threshold: canonical.threshold,
    network: canonical.network,
    accountPath: canonical.accountPath,
    policyRevision: canonical.policyRevision,
    signers: canonical.cosigners.map((cosigner) => ({
      id: cosigner.id,
      label: cosigner.label,
      name: cosigner.label,
      xpub: cosigner.xpub,
      masterFingerprintHex: cosigner.masterFingerprintHex,
      accountPath: cosigner.accountPath,
    })),
  };
}

/** Export one self-contained manifest for QR, file, or manual text exchange. */
export function serializeMultisigManifest(policy: MultisigPolicy): string {
  const canonical = normalizeMultisigPolicy(
    policy,
    policy.network ?? Network.MAINNET
  );
  const descriptors = createMultisigDescriptorSet(policy, canonical.network);
  const manifest: MultisigManifest = {
    format: 'optn-multisig-manifest',
    schemaVersion: 1,
    policy: canonical,
    descriptors,
  };
  return JSON.stringify(manifest);
}

/** Import and cryptographically cross-check a complete descriptor manifest. */
export function parseMultisigManifest(
  serialized: string,
  expectedNetwork?: Network
): MultisigPolicy {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error('The multisig manifest is not valid JSON.');
  }
  if (!value || typeof value !== 'object') {
    throw new Error('The multisig manifest must be a JSON object.');
  }
  const manifest = value as Partial<MultisigManifest>;
  if (
    manifest.format !== 'optn-multisig-manifest' ||
    manifest.schemaVersion !== 1
  ) {
    throw new Error('Unsupported multisig manifest format or schema version.');
  }
  if (!manifest.policy || !manifest.descriptors) {
    throw new Error(
      'The multisig manifest is missing its policy or descriptors.'
    );
  }
  if (
    expectedNetwork !== undefined &&
    manifest.policy.network !== expectedNetwork
  ) {
    throw new Error('The multisig manifest belongs to a different network.');
  }
  const policy = canonicalPolicyToLegacy(manifest.policy);
  const regenerated = createMultisigDescriptorSet(
    policy,
    manifest.policy.network
  );
  if (
    manifest.descriptors.receive !== regenerated.receive ||
    manifest.descriptors.change !== regenerated.change ||
    manifest.descriptors.policyId !== regenerated.policyId
  ) {
    throw new Error(
      'The multisig manifest policy and descriptors do not agree.'
    );
  }
  return policy;
}

/**
 * Derive the multisig address at `branch/index`.
 *
 * Mirrors Paytaca's `derivePublicKeys` -> BIP-67 sort -> p2sh20 lock. The sort
 * is on the derived keys at this exact path, which is why this cannot be
 * hoisted out of the per-address loop.
 */
export function deriveMultisigAddress(
  policy: MultisigPolicy,
  branchIndex: 0 | 1,
  addressIndex: number
): MultisigAddress {
  validateMultisigPolicy(policy);
  const relativePath = `${branchIndex}/${addressIndex}`;

  const derivedCosigners = policy.signers.map((signer, index) => {
    const decoded = decodeHdPublicKey(signer.xpub.trim());
    if (typeof decoded === 'string') {
      throw new Error(`Cosigner ${index + 1} has an xPub that cannot be read.`);
    }
    const child = deriveHdPathRelative(decoded.node, relativePath);
    if (typeof child === 'string') {
      throw new Error(
        `Could not derive ${relativePath} for cosigner ${index + 1}.`
      );
    }
    return {
      cosignerId: signer.id?.trim() || stableCosignerId(signer.xpub.trim()),
      publicKey: Uint8Array.from(child.publicKey),
      sortedPosition: -1,
      derivationPath: policy.accountPath
        ? `${normalizeBchAccountPath(policy.accountPath)}/${relativePath}`
        : `m/${relativePath}`,
    };
  });

  const sortedCosigners = [...derivedCosigners].sort((a, b) => {
    const length = Math.min(a.publicKey.length, b.publicKey.length);
    for (let i = 0; i < length; i += 1) {
      if (a.publicKey[i] !== b.publicKey[i]) {
        return a.publicKey[i] - b.publicKey[i];
      }
    }
    return a.publicKey.length - b.publicKey.length;
  });
  sortedCosigners.forEach((cosigner, position) => {
    cosigner.sortedPosition = position;
  });
  const sortedPublicKeys = sortedCosigners.map(
    (cosigner) => cosigner.publicKey
  );
  const redeemScript = buildMultisigRedeemScript(sortedPublicKeys, policy.m);
  return {
    redeemScript,
    lockingBytecode: p2shLockingBytecodeFor(redeemScript),
    sortedPublicKeys,
    derivedCosigners: sortedCosigners,
    relativePath,
  };
}

/* -------------------------------------------------------------------------
 * Paytaca .pmwif interchange
 * ---------------------------------------------------------------------- */

/** Filename Paytaca would give this wallet. */
export function pmwifFilename(policy: MultisigPolicy): string {
  if (policy.name.trim()) {
    return `${policy.name.trim()}${PMWIF_EXTENSION}`;
  }
  return `${describePolicy(policy)}-multisig-wallet${PMWIF_EXTENSION}`;
}

/**
 * Serialize to Paytaca's wallet shape.
 *
 * `name`, `m` and `signers` are exactly what Paytaca's `createWallet` returns,
 * so its importer accepts this unchanged. Fingerprints ride along in a
 * namespaced field: Paytaca ignores keys it does not know, and dropping them
 * would make an OPTN -> Paytaca -> OPTN trip lose the data a signer needs.
 */
export function serializePmwif(policy: MultisigPolicy): string {
  validateMultisigPolicy(policy);
  return JSON.stringify(
    {
      name: policy.name.trim(),
      m: policy.m,
      n: policy.signers.length,
      signers: policy.signers.map((signer) => ({
        name: signer.name.trim(),
        xpub: signer.xpub.trim(),
      })),
      optn: {
        cosigners: policy.signers.map((signer) => ({
          xpub: signer.xpub.trim(),
          masterFingerprint: signer.masterFingerprintHex ?? null,
          accountPath: signer.accountPath ?? null,
        })),
      },
    },
    null,
    2
  );
}

/**
 * Parse a Paytaca `.pmwif`.
 *
 * Tolerant of a file that came straight from Paytaca — no `n`, no
 * fingerprints — because that is the common case when another cosigner sends
 * theirs. Anything genuinely unusable throws with what is wrong.
 */
export function parsePmwif(text: string): MultisigPolicy {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('That file is not valid JSON, so it is not a wallet file.');
  }
  if (!raw || typeof raw !== 'object') {
    throw new Error('That wallet file is empty or malformed.');
  }
  const record = raw as Record<string, unknown>;

  const m = Number(record.m);
  if (!Number.isInteger(m) || m < 1) {
    throw new Error('That wallet file has no valid "m" (signatures required).');
  }
  if (!Array.isArray(record.signers) || record.signers.length === 0) {
    throw new Error('That wallet file lists no cosigners.');
  }

  // Fingerprints, when the file came from OPTN, are keyed by xpub so they
  // survive a reordering of the signer list.
  const fingerprintByXpub = new Map<string, string>();
  const accountPathByXpub = new Map<string, string>();
  const optn = record.optn as { cosigners?: unknown } | undefined;
  if (optn && Array.isArray(optn.cosigners)) {
    for (const entry of optn.cosigners) {
      if (!entry || typeof entry !== 'object') continue;
      const cosigner = entry as Record<string, unknown>;
      const xpub =
        typeof cosigner.xpub === 'string' ? cosigner.xpub.trim() : '';
      if (!xpub) continue;
      if (
        typeof cosigner.masterFingerprint === 'string' &&
        FINGERPRINT_PATTERN.test(cosigner.masterFingerprint)
      ) {
        fingerprintByXpub.set(xpub, cosigner.masterFingerprint.toLowerCase());
      }
      if (typeof cosigner.accountPath === 'string' && cosigner.accountPath) {
        accountPathByXpub.set(xpub, cosigner.accountPath);
      }
    }
  }

  const signers: MultisigCosigner[] = record.signers.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`Cosigner ${index + 1} in that file is malformed.`);
    }
    const signer = entry as Record<string, unknown>;
    const xpub = typeof signer.xpub === 'string' ? signer.xpub.trim() : '';
    if (!xpub) {
      throw new Error(`Cosigner ${index + 1} in that file has no xPub.`);
    }
    return {
      name:
        typeof signer.name === 'string' && signer.name.trim()
          ? signer.name.trim()
          : `Cosigner ${index + 1}`,
      xpub,
      masterFingerprintHex: fingerprintByXpub.get(xpub),
      accountPath: accountPathByXpub.get(xpub),
    };
  });

  const policy: MultisigPolicy = {
    name:
      typeof record.name === 'string' && record.name.trim()
        ? record.name.trim()
        : `${m}-of-${signers.length} Multisig`,
    m,
    signers,
  };
  validateMultisigPolicy(policy);
  return policy;
}

/**
 * A stable identifier for a policy: the locking bytecode at 0/0, hex.
 *
 * Paytaca's `getWalletUUID` uses exactly this, so two wallets assembled in
 * either app can be compared without trusting names or signer order.
 */
export function multisigWalletUuid(policy: MultisigPolicy): string {
  return binToHex(deriveMultisigAddress(policy, 0, 0).lockingBytecode);
}
