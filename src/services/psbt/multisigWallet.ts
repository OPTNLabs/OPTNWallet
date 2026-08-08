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

import {
  buildMultisigRedeemScript,
  p2shLockingBytecodeFor,
  sortPublicKeysBip67,
} from './psbtMultisig';

/** Paytaca's file extension for an exported multisig wallet. */
export const PMWIF_EXTENSION = '.pmwif';

/** Upper bound from OP_CHECKMULTISIG itself. */
export const MAX_COSIGNERS = 20;

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
}

export interface MultisigPolicy {
  name: string;
  /** Signatures required. */
  m: number;
  signers: MultisigCosigner[];
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
  const seen = new Set<string>();
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
  /** Relative path used, e.g. `0/3`. */
  relativePath: string;
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

  const publicKeys = policy.signers.map((signer, index) => {
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
    return child.publicKey;
  });

  const sortedPublicKeys = sortPublicKeysBip67(publicKeys);
  const redeemScript = buildMultisigRedeemScript(sortedPublicKeys, policy.m);
  return {
    redeemScript,
    lockingBytecode: p2shLockingBytecodeFor(redeemScript),
    sortedPublicKeys,
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
