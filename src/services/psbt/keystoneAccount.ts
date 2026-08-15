// Read a Keystone account export (ur:crypto-hdkey / crypto-account /
// crypto-multi-accounts) into the fields a watch-only wallet needs.
//
// This is the one place where Keystone and SeedCash genuinely differ, and it
// is why they deserve to be separate options rather than one "air-gap" path:
//
//   SeedCash's "Export Xpub" emits the bare base58 xPub and nothing else
//   (`wallet_views.py` -> `SeedCashQRView(address=self.wallet._xpub)`), so the
//   master fingerprint has to be read off the device screen by hand and the
//   account path has to be assumed.
//
//   Keystone emits a BC-UR structure that carries the key AND its origin:
//   `CryptoHDKey.getOrigin()` returns a `CryptoKeypath` whose
//   `getSourceFingerprint()` is the MASTER fingerprint and whose components
//   are the full derivation path. Nothing has to be typed, and nothing has to
//   be assumed.
//
// Scope: this reads an account export. It says nothing about whether a
// Keystone will sign a BCH PSBT this wallet produces — that is a separate
// question that needs a physical device, and is deliberately not implied here.

import { URRegistryDecoder } from '@keystonehq/bc-ur-registry';
import type { CryptoHDKey } from '@keystonehq/bc-ur-registry';

export interface KeystoneAccount {
  /** Account-level xPub, base58. */
  xpub: string;
  /** 8 lowercase hex characters, from the key's origin. */
  masterFingerprintHex: string;
  /** Full account path, e.g. `m/44'/145'/0'`. */
  accountPath: string;
}

const HARDENED = 0x80000000;

/**
 * The account path this key was exported at, as `m/44'/145'/0'`.
 *
 * `CryptoKeypath.getPath()` is the registry's own formatter and returns the
 * levels without a leading `m/`, so only the prefix is added here — formatting
 * the components by hand would be a second implementation to keep in step.
 */
function formatOrigin(hdKey: CryptoHDKey): string | null {
  const path = hdKey.getOrigin?.()?.getPath?.();
  return path ? `m/${path}` : null;
}

function fingerprintFrom(hdKey: CryptoHDKey): string | null {
  // The origin's SOURCE fingerprint is the master key's — the whole point of
  // reading it here. `getParentFingerprint()` is the immediate parent's and
  // would silently produce a value a signer never matches against.
  const source = hdKey.getOrigin?.()?.getSourceFingerprint?.();
  if (source && source.length === 4) return source.toString('hex').toLowerCase();
  return null;
}

/** Pull the first BCH-shaped HD key out of whatever the device exported. */
function firstHdKey(decoded: unknown): CryptoHDKey | null {
  const candidate = decoded as {
    getKeys?: () => CryptoHDKey[];
    getOutputDescriptors?: () => { getHDKey?: () => CryptoHDKey }[];
    getBip32Key?: () => string;
  };

  // crypto-multi-accounts: several keys, one per account/coin.
  if (typeof candidate.getKeys === 'function') {
    const keys = candidate.getKeys();
    if (keys?.length) return keys[0];
  }
  // crypto-account: wrapped in output descriptors.
  if (typeof candidate.getOutputDescriptors === 'function') {
    for (const descriptor of candidate.getOutputDescriptors() ?? []) {
      const key = descriptor.getHDKey?.();
      if (key) return key;
    }
  }
  // crypto-hdkey: already the key.
  if (typeof candidate.getBip32Key === 'function') {
    return candidate as CryptoHDKey;
  }
  return null;
}

/**
 * Decode one or more `ur:` frames from a Keystone account export.
 *
 * Throws with a message aimed at the person holding the device rather than at
 * a developer, because every failure here happens while someone is standing in
 * front of a QR that will not go in.
 */
export function parseKeystoneAccount(frames: string[]): KeystoneAccount {
  const cleaned = frames
    .map((frame) => frame.trim())
    .filter((frame) => frame.length > 0);
  if (cleaned.length === 0) {
    throw new Error('Nothing was scanned yet.');
  }

  const decoder = new URRegistryDecoder();
  for (const frame of cleaned) {
    if (!/^ur:/i.test(frame)) {
      throw new Error(
        'That QR is not a Keystone account export. On the device choose the ' +
          'Bitcoin Cash account and show its export QR.'
      );
    }
    decoder.receivePart(frame);
    if (decoder.isComplete()) break;
  }
  if (!decoder.isComplete()) {
    throw new Error(
      'Only part of the animated QR was captured. Hold the camera steady until ' +
        'it completes — the code loops.'
    );
  }

  let decoded: unknown;
  try {
    decoded = decoder.resultRegistryType();
  } catch {
    throw new Error('That QR could not be read as a Keystone export.');
  }

  const hdKey = firstHdKey(decoded);
  if (!hdKey) {
    throw new Error(
      'That export contains no extended public key. Export the account, not a ' +
        'single address or a signature.'
    );
  }

  let xpub: string;
  try {
    xpub = hdKey.getBip32Key();
  } catch {
    throw new Error('That export does not contain a usable account xPub.');
  }
  if (!xpub) {
    throw new Error('That export does not contain a usable account xPub.');
  }

  const masterFingerprintHex = fingerprintFrom(hdKey);
  if (!masterFingerprintHex) {
    throw new Error(
      'That export has no master fingerprint. Export the account from the ' +
        'device rather than re-sharing a key from somewhere else.'
    );
  }

  const accountPath = formatOrigin(hdKey);
  if (!accountPath) {
    throw new Error('That export does not say which account path it came from.');
  }

  return { xpub, masterFingerprintHex, accountPath };
}

/** Is this the BCH account path a watch-only wallet here expects? */
export function isBchAccountPath(path: string): boolean {
  return /^m\/44'\/145'\/\d+'$/.test(path);
}

export { HARDENED as KEYSTONE_HARDENED };
