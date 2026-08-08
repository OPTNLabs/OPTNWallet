// What differs between air-gapped signers.
//
// "It's all PSBT" is not true enough to build on. Every device below speaks a
// PSBT, and no two agree on which one. The differences are not cosmetic —
// each one has already produced a signature this wallet rejected, or would:
//
//   * PSBT dialect. Version 145 is Paytaca's BCH extension (global 0xfb = 145,
//     explicit input/output counts, per-input 0x0e/0x0f/0x10). SeedCash skips
//     the globals it does not know and parses by the counts, so it tolerates
//     v145. A signer written against plain BIP174 may not.
//   * Sighash. Issue #8 asks for ALL|FORKID|ANYONECANPAY (0xc1). Upstream
//     SeedCash always signs 0x41 and only reads PSBT_IN_SIGHASH_TYPE on a
//     patched build. A signature over the wrong sighash is well-formed and
//     simply does not validate.
//   * Spent-output field. SeedCash's WITNESS_UTXO path keeps the compact-size
//     prefix and signs a script one byte longer than the one being verified,
//     so it must be given NON_WITNESS_UTXO — the whole parent transaction.
//   * Signature algorithm. SeedCash signs Schnorr by default; other devices
//     sign DER. Both are accepted on import, but the multisig unlock's dummy
//     element depends on which.
//   * Account export. A bare base58 xPub carries no fingerprint and no path,
//     so both must be supplied by hand. A BC-UR account export carries both.
//
// Keeping this as data rather than as branches means adding a device is a new
// entry plus whatever it genuinely needs, and the UI can render the choices
// from the list instead of hard-coding one card per device.

/** How the device hands over its account key. */
export type AccountImportFormat =
  /** Bare base58 xPub. Fingerprint and path must be supplied separately. */
  | 'xpub'
  /** BC-UR (crypto-hdkey / crypto-account); carries fingerprint and path. */
  | 'ur-account';

export interface SignerProfile {
  id: 'seedcash' | 'keystone';
  /** Shown on the picker card. */
  name: string;
  /** One line, in the user's language, about what this option is for. */
  summary: string;
  accountImport: AccountImportFormat;
  /**
   * Does the account import already carry the master fingerprint? When false
   * the wallet has to ask for it, and can only warn rather than guarantee the
   * device will recognise its own coins on review.
   */
  suppliesMasterFingerprint: boolean;
  /** Does the import state which account path the key came from? */
  suppliesAccountPath: boolean;
  /** PSBT global version to emit. */
  psbtVersion: 145 | 0;
  /** Sighash this wallet asks the device for. */
  sighashType: number;
  /**
   * Emit the whole parent transaction (PSBT_IN_NON_WITNESS_UTXO) rather than
   * the compact WITNESS_UTXO. Costs QR frames; required by SeedCash.
   */
  requiresParentTransaction: boolean;
  /**
   * Has a signature from this device actually been round-tripped and executed
   * on the BCH VM? Anything false may be offered for WATCHING, but sending
   * through it is untested and the UI should say so rather than imply parity.
   */
  signingVerified: boolean;
  /** Why signing is unverified, when it is — shown to the user, not hidden. */
  signingCaveat?: string;
}

export const SIGHASH_ALL_FORKID = 0x41;
export const SIGHASH_ALL_FORKID_ANYONECANPAY = 0xc1;

export const SIGNER_PROFILES: SignerProfile[] = [
  {
    id: 'seedcash',
    name: 'SeedCash',
    summary: 'Scan the account xPub, then sign by camera.',
    accountImport: 'xpub',
    suppliesMasterFingerprint: false,
    suppliesAccountPath: false,
    psbtVersion: 145,
    sighashType: SIGHASH_ALL_FORKID_ANYONECANPAY,
    requiresParentTransaction: true,
    // Round-tripped against SeedCash's own signing code: single-sig and 2-of-3
    // both finalize and execute on libauth's BCH VM.
    signingVerified: true,
  },
  {
    id: 'keystone',
    name: 'Keystone',
    summary: 'One scan sets up the wallet — nothing to type.',
    accountImport: 'ur-account',
    suppliesMasterFingerprint: true,
    suppliesAccountPath: true,
    // Left at the shared dialect until a device says otherwise. Guessing plain
    // BIP174 here would be a different untested assumption, not a safer one.
    psbtVersion: 145,
    sighashType: SIGHASH_ALL_FORKID_ANYONECANPAY,
    requiresParentTransaction: true,
    signingVerified: false,
    signingCaveat:
      'Watching and receiving are ready. Signing has not been tested against ' +
      'a physical Keystone yet — its Bitcoin Cash app may sign a different ' +
      'sighash than this wallet asks for, which would be rejected on import.',
  },
];

export function signerProfile(id: SignerProfile['id']): SignerProfile {
  const found = SIGNER_PROFILES.find((profile) => profile.id === id);
  if (!found) throw new Error(`Unknown signer profile "${id}".`);
  return found;
}

/** Signers whose send path has actually been proven end to end. */
export function verifiedSigners(): SignerProfile[] {
  return SIGNER_PROFILES.filter((profile) => profile.signingVerified);
}
