import DatabaseService from '../apis/DatabaseManager/DatabaseService';
import KeyManager from '../apis/WalletManager/KeyManager';
import {
  deriveHdPublicKeyAtPath,
  deriveMasterFingerprint,
} from './HdWalletService';
import { binToHex } from '@bitauth/libauth';
import type { Network } from '../state/slices/networkSlice';

const MASTER_FINGERPRINT_PATTERN = /^[0-9a-fA-F]{8}$/;

/**
 * Read public wallet metadata needed to annotate a PSBT.
 *
 * This deliberately lives outside the desktop onboarding layer: mobile and
 * desktop coordinators both need the fingerprint, while neither needs access
 * to desktop-only wallet import helpers.
 */
export async function getStoredMasterFingerprint(
  walletId: number
): Promise<string | null> {
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) return null;

  const query = db.prepare(
    'SELECT master_fingerprint FROM wallets WHERE id = ?'
  );
  try {
    query.bind([walletId]);
    if (!query.step()) return null;
    const row = query.getAsObject() as Record<string, unknown>;
    return typeof row.master_fingerprint === 'string' && row.master_fingerprint
      ? row.master_fingerprint
      : null;
  } finally {
    query.free();
  }
}

/** Convert an eight-hex-character fingerprint to PSBT's four-byte form. */
export function masterFingerprintBytes(
  fingerprint: string | null | undefined
): Uint8Array | null {
  if (!fingerprint) return null;
  const trimmed = fingerprint.trim();
  if (!MASTER_FINGERPRINT_PATTERN.test(trimmed)) return null;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(trimmed.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export type LocalWalletCosignerMetadata = {
  accountXpub: string;
  masterFingerprintHex: string;
  accountPath: string;
  network: Network;
};

/**
 * Derive only public cosigner metadata for the currently unlocked wallet.
 *
 * The seed is scoped inside KeyManager.withWalletSeedMaterial and never leaves
 * this function. An account xpub cannot provide the master fingerprint, so a
 * local OPTN wallet must derive both values from its seed when the user
 * explicitly chooses it as a multisig cosigner.
 */
export async function deriveLocalWalletCosignerMetadata(
  walletId: number
): Promise<LocalWalletCosignerMetadata> {
  return KeyManager().withWalletSeedMaterial(walletId, async (material) => {
    const accountXpub = await deriveHdPublicKeyAtPath(
      material.mnemonic,
      material.passphrase,
      material.networkType,
      material.derivationPath
    );
    const fingerprint = await deriveMasterFingerprint(
      material.mnemonic,
      material.passphrase
    );

    return {
      accountXpub,
      masterFingerprintHex: binToHex(fingerprint),
      accountPath: material.derivationPath,
      network: material.networkType,
    };
  });
}
