// Desktop-only per-wallet key management (Electron Cash model): each wallet
// gets its own password and its own derived AES-256-GCM key, independent of
// any other wallet. This wraps the shared WalletManager()/KeyManager() —
// it never changes their call signatures, it only controls which key is
// active in WalletKeyCache before calling into them, so every existing
// SecretCryptoService.encryptText/decryptText/encryptBytes/decryptBytes call
// site (KeyManager.createKeys, fetchAddressPrivateKey, etc.) automatically
// operates under the correct wallet's key with zero changes to shared code.
//
// Legacy wallets created before this feature existed have no kdf_salt row —
// those fall back to whatever key is already active (the app-gate's key),
// preserving today's behavior for anything created earlier this session.

import WalletManager from '../../apis/WalletManager/WalletManager';
import DatabaseService from '../../apis/DatabaseManager/DatabaseService';
import { Network } from '../../state/slices/networkSlice';
import { WalletType } from '../../types/wallet';
import type { WalletRecord } from '../../types/wallet';
import { deriveKey, randomSalt, bytesToBase64, base64ToBytes, aesEncrypt, aesDecrypt } from './WalletCrypto';
import { setCachedWalletKey, getCachedWalletKey, clearCachedWalletKey } from './WalletKeyCache';
import { verify as verifyGatePassphrase } from './EcKeyManager';
import { SECRET_ENC_PREFIX } from './SecretCryptoService';
import { autoSaveWalletFile, type WalletFileV1 } from './walletFile';
import {
  checkStatus as bioCheckStatus,
  setData as bioSetData,
  getData as bioGetData,
  hasData as bioHasData,
  removeData as bioRemoveData,
} from '@choochmeque/tauri-plugin-biometry-api';

const BIO_DOMAIN = 'com.optilabs.wallet';
const bioName = (walletId: number) => `optn-wallet-bio-${walletId}`;

async function readKdfSalt(walletId: number): Promise<Uint8Array | null> {
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) return null;

  const query = db.prepare('SELECT kdf_salt FROM wallets WHERE id = ?');
  query.bind([walletId]);
  let saltB64: string | null = null;
  if (query.step()) {
    const row = query.getAsObject() as Record<string, unknown>;
    saltB64 = typeof row.kdf_salt === 'string' && row.kdf_salt ? row.kdf_salt : null;
  }
  query.free();
  return saltB64 ? base64ToBytes(saltB64) : null;
}

// Id of the most recently inserted wallet with this name. Used instead of
// WalletManager.setWalletId(), which finds the id by decrypting EVERY wallet
// row with the currently-cached key — that throws (and returns null) as soon
// as any other wallet was encrypted under a different per-wallet key, which
// silently skipped the kdf_salt write and made new wallets fall back to the
// old app-gate password. Matching by name + newest id needs no decryption.
async function findNewestWalletIdByName(name: string): Promise<number | null> {
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) return null;

  const query = db.prepare(
    'SELECT id FROM wallets WHERE wallet_name = ? ORDER BY id DESC LIMIT 1'
  );
  query.bind([name]);
  let id: number | null = null;
  if (query.step()) {
    const row = query.getAsObject() as Record<string, unknown>;
    id = typeof row.id === 'number' ? row.id : Number(row.id);
  }
  query.free();
  return Number.isFinite(id as number) ? id : null;
}

async function writeKdfSalt(walletId: number, salt: Uint8Array): Promise<void> {
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) throw new Error('Database unavailable');

  const query = db.prepare('UPDATE wallets SET kdf_salt = ? WHERE id = ?');
  query.run([bytesToBase64(salt), walletId]);
  query.free();
  await dbService.flushDatabaseToFile();
}

export interface CreateWalletWithPasswordArgs {
  name: string;
  mnemonic: string;
  passphrase: string;
  network: Network;
  walletType?: WalletType;
  password: string;
}

/**
 * Create a wallet whose mnemonic/passphrase are encrypted under a key derived
 * from `password` + a fresh per-wallet salt — not whatever key the app-gate
 * currently has cached. Returns the new wallet's id, or null on failure.
 */
export async function createWalletWithPassword(
  args: CreateWalletWithPasswordArgs
): Promise<number | null> {
  const { name, mnemonic, passphrase, network, password } = args;
  const walletType = args.walletType ?? WalletType.STANDARD;
  const manager = WalletManager();

  const salt = randomSalt(32);
  const key = await deriveKey(password, salt);

  // Activate this wallet's key BEFORE createWallet's internal
  // SecretCryptoService.encryptText() calls run, so the mnemonic/passphrase
  // are encrypted under it, not the previously-active key. Snapshot the
  // previous key first: every failure exit below must restore it, or a failed
  // creation leaves a foreign key active while another wallet is open.
  const previousKey = getCachedWalletKey();
  const restorePreviousKey = () => {
    if (previousKey) setCachedWalletKey(previousKey);
    else clearCachedWalletKey();
  };
  setCachedWalletKey(key);

  const created = await manager.createWallet(name, mnemonic, passphrase, network, walletType);
  if (!created) {
    restorePreviousKey();
    return null;
  }

  const walletId = await findNewestWalletIdByName(name);
  if (walletId == null) {
    restorePreviousKey();
    return null;
  }

  try {
    await writeKdfSalt(walletId, salt);
  } catch (err) {
    // Without its salt row this wallet can never be reopened (it would be
    // treated as legacy and checked against the gate key). Surface loudly.
    console.error(
      `[DesktopWalletManager] CRITICAL: wallet ${walletId} was created but its kdf_salt could not be written — it will not be openable. Delete and recreate it.`,
      err
    );
    restorePreviousKey();
    return null;
  }

  // Auto-mirror the wallet to a file in the default wallets folder (EC-style).
  // Encrypt under this wallet's own key so the file is safe at rest and can be
  // re-opened with the same password. Non-fatal: the DB row is the source of
  // truth, so a failed file write must not fail creation.
  try {
    const encryptedMnemonic = `${SECRET_ENC_PREFIX}${await aesEncrypt(key, mnemonic)}`;
    const encryptedPassphrase = passphrase
      ? `${SECRET_ENC_PREFIX}${await aesEncrypt(key, passphrase)}`
      : '';
    await autoSaveWalletFile({
      sourceId: walletId,
      name,
      walletType,
      encryptedMnemonic,
      encryptedPassphrase,
      kdfSalt: bytesToBase64(salt),
    });
  } catch (err) {
    console.warn('[DesktopWalletManager] wallet file mirror failed (DB copy is fine):', err);
  }

  return walletId;
}

/**
 * Open an existing wallet: derive its key from `password` + its stored salt,
 * activate it, and return the decrypted wallet record. Returns null if the
 * password is wrong (decrypt fails) or the wallet doesn't exist.
 *
 * Legacy wallets with no kdf_salt (created before per-wallet passwords
 * existed) skip re-derivation entirely and use whatever key is already
 * active — preserving today's behavior for those wallets.
 */
export async function openWalletWithPassword(
  walletId: number,
  password: string
): Promise<WalletRecord | null> {
  const manager = WalletManager();
  const salt = await readKdfSalt(walletId);

  if (salt) {
    // Verify-then-commit: prove the candidate key decrypts this wallet's own
    // mnemonic BEFORE touching the shared key cache. Activating an unverified
    // key would clobber the currently-open wallet's key on a mere typo —
    // any encrypt that ran afterwards would corrupt that wallet's data.
    const candidateKey = await deriveKey(password, salt);
    const mnemonicCiphertext = await readMnemonicCiphertext(walletId);
    if (!mnemonicCiphertext?.startsWith(SECRET_ENC_PREFIX)) {
      // Salted wallet whose mnemonic is not in encrypted form — inconsistent
      // row (dev artifact). Refuse rather than guess.
      console.warn(`[DesktopWalletManager] Wallet ${walletId} has kdf_salt but no encrypted mnemonic — refusing to open.`);
      return null;
    }
    try {
      await aesDecrypt(candidateKey, mnemonicCiphertext.slice(SECRET_ENC_PREFIX.length));
    } catch {
      return null; // wrong password — previous cached key left untouched
    }
    setCachedWalletKey(candidateKey);
  } else {
    // Legacy wallet (no kdf_salt): its data is encrypted under the app-gate
    // key, so the honest check is the gate passphrase — without this, any
    // typed password would "succeed" as long as some key was cached.
    const ok = await verifyGatePassphrase(password);
    if (!ok) return null;
    if (!getCachedWalletKey()) {
      console.warn('[DesktopWalletManager] Legacy wallet open refused: no key cached (gate locked?).');
      return null;
    }
  }

  const info = await manager.getWalletInfo(walletId);
  return info;
}

async function readMnemonicCiphertext(walletId: number): Promise<string | null> {
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) return null;

  const query = db.prepare('SELECT mnemonic FROM wallets WHERE id = ?');
  query.bind([walletId]);
  let mnemonic: string | null = null;
  if (query.step()) {
    const row = query.getAsObject() as Record<string, unknown>;
    mnemonic = typeof row.mnemonic === 'string' ? row.mnemonic : null;
  }
  query.free();
  return mnemonic;
}

/**
 * Build the serialized .optn contents for an existing wallet, straight from its
 * stored (already-encrypted) DB fields — no password needed, since nothing is
 * decrypted. Returns null if the wallet is missing or has no per-wallet salt
 * (legacy shared-key wallets aren't self-contained and can't be exported).
 */
export async function buildWalletFileContents(walletId: number): Promise<string | null> {
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) return null;

  const saltBytes = await readKdfSalt(walletId);
  if (!saltBytes) return null;

  const query = db.prepare('SELECT wallet_name, mnemonic, passphrase, walletType FROM wallets WHERE id = ?');
  query.bind([walletId]);
  let row: Record<string, unknown> | null = null;
  if (query.step()) row = query.getAsObject() as Record<string, unknown>;
  query.free();
  if (!row) return null;

  const { serializeWalletFile } = await import('./walletFile');
  return serializeWalletFile({
    sourceId: walletId,
    name: typeof row.wallet_name === 'string' ? row.wallet_name : `Wallet ${walletId}`,
    walletType: typeof row.walletType === 'string' ? row.walletType : 'standard',
    encryptedMnemonic: typeof row.mnemonic === 'string' ? row.mnemonic : '',
    encryptedPassphrase: typeof row.passphrase === 'string' ? row.passphrase : '',
    kdfSalt: bytesToBase64(saltBytes),
  });
}

export interface ImportWalletFileResult {
  walletId: number;
  network: Network;
  walletType: WalletType;
}

/**
 * Import a wallet from a parsed .optn file: decrypt its mnemonic with the given
 * password + the file's own salt (this also VERIFIES the password), then create
 * a fresh DB row via the normal per-wallet-password path (new salt, re-encrypted,
 * auto-mirrored to a file). Returns null if the password is wrong or the file is
 * malformed. Network isn't stored in the file (runtime setting) — caller passes
 * the network to import under.
 */
export async function importWalletFile(
  file: WalletFileV1,
  password: string,
  network: Network
): Promise<ImportWalletFileResult | null> {
  if (!file.encryptedMnemonic.startsWith(SECRET_ENC_PREFIX)) return null;
  let mnemonic: string;
  let passphrase = '';
  try {
    const salt = base64ToBytes(file.kdfSalt);
    const key = await deriveKey(password, salt);
    mnemonic = await aesDecrypt(key, file.encryptedMnemonic.slice(SECRET_ENC_PREFIX.length));
    if (file.encryptedPassphrase.startsWith(SECRET_ENC_PREFIX)) {
      passphrase = await aesDecrypt(key, file.encryptedPassphrase.slice(SECRET_ENC_PREFIX.length));
    }
  } catch {
    return null; // wrong password or corrupt file
  }

  const walletType =
    file.walletType === WalletType.QUANTUMROOT ? WalletType.QUANTUMROOT : WalletType.STANDARD;

  const walletId = await createWalletWithPassword({
    name: file.name,
    mnemonic,
    passphrase,
    network,
    walletType,
    password,
  });
  if (walletId == null) return null;
  return { walletId, network, walletType };
}

/** True if this wallet has its own independent password (not a legacy shared-key wallet). */
export async function walletHasOwnPassword(walletId: number): Promise<boolean> {
  const salt = await readKdfSalt(walletId);
  return salt !== null;
}

async function readWalletRow(
  walletId: number
): Promise<{ name: string; walletType: string; mnemonic: string; passphrase: string } | null> {
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) return null;
  const q = db.prepare('SELECT wallet_name, walletType, mnemonic, passphrase FROM wallets WHERE id = ?');
  q.bind([walletId]);
  let row: Record<string, unknown> | null = null;
  if (q.step()) row = q.getAsObject() as Record<string, unknown>;
  q.free();
  if (!row) return null;
  return {
    name: typeof row.wallet_name === 'string' ? row.wallet_name : `Wallet ${walletId}`,
    walletType: typeof row.walletType === 'string' ? row.walletType : 'standard',
    mnemonic: typeof row.mnemonic === 'string' ? row.mnemonic : '',
    passphrase: typeof row.passphrase === 'string' ? row.passphrase : '',
  };
}

/**
 * Change ONE wallet's password: verify the old password decrypts this wallet,
 * re-encrypt its mnemonic/passphrase under a new key (fresh salt), update the
 * DB row + kdf_salt, swap the cached key, and refresh its wallet file. Returns
 * false if the old password is wrong or the wallet has no per-wallet salt.
 */
export async function changeWalletPassword(
  walletId: number,
  oldPassword: string,
  newPassword: string
): Promise<boolean> {
  const salt = await readKdfSalt(walletId);
  if (!salt) return false;
  const row = await readWalletRow(walletId);
  if (!row || !row.mnemonic.startsWith(SECRET_ENC_PREFIX)) return false;

  // Verify old password by decrypting this wallet's own data.
  let mnemonic: string;
  let passphrase = '';
  try {
    const oldKey = await deriveKey(oldPassword, salt);
    mnemonic = await aesDecrypt(oldKey, row.mnemonic.slice(SECRET_ENC_PREFIX.length));
    if (row.passphrase.startsWith(SECRET_ENC_PREFIX)) {
      passphrase = await aesDecrypt(oldKey, row.passphrase.slice(SECRET_ENC_PREFIX.length));
    }
  } catch {
    return false; // wrong current password
  }

  // Re-encrypt under a fresh key + salt.
  const newSalt = randomSalt(32);
  const newKey = await deriveKey(newPassword, newSalt);
  const encMnemonic = `${SECRET_ENC_PREFIX}${await aesEncrypt(newKey, mnemonic)}`;
  const encPassphrase = passphrase ? `${SECRET_ENC_PREFIX}${await aesEncrypt(newKey, passphrase)}` : '';

  const dbService = DatabaseService();
  const db = dbService.getDatabase();
  if (!db) return false;
  const upd = db.prepare('UPDATE wallets SET mnemonic = ?, passphrase = ?, kdf_salt = ? WHERE id = ?');
  upd.run([encMnemonic, encPassphrase, bytesToBase64(newSalt), walletId]);
  upd.free();
  await dbService.flushDatabaseToFile();

  setCachedWalletKey(newKey);

  // Refresh the wallet file so its copy matches the new password.
  await autoSaveWalletFile({
    sourceId: walletId,
    name: row.name,
    walletType: row.walletType,
    encryptedMnemonic: encMnemonic,
    encryptedPassphrase: encPassphrase,
    kdfSalt: bytesToBase64(newSalt),
  });

  // A biometric enrollment stored the OLD password — refresh it if present.
  try {
    if (await bioHasData({ domain: BIO_DOMAIN, name: bioName(walletId) })) {
      await bioSetData({ domain: BIO_DOMAIN, name: bioName(walletId), data: newPassword });
    }
  } catch {
    /* biometric refresh is best-effort */
  }
  return true;
}

// ── Per-wallet biometric unlock (Windows Hello / Touch ID) ──────────────────
// Stores THIS wallet's password behind the OS biometric prompt, namespaced by
// wallet id, so each wallet's biometric is independent.

export async function isBiometricAvailable(): Promise<boolean> {
  try {
    return (await bioCheckStatus()).isAvailable;
  } catch {
    return false;
  }
}

/**
 * Generic biometric label. The plugin's reported biometryType proved
 * unreliable across platforms (e.g. it reported Touch ID on Windows), so we
 * avoid claiming a specific method the OS may not actually be using. The OS
 * prompt itself shows the real method (Windows Hello face/fingerprint/PIN,
 * Touch ID, etc.).
 */
export function getBiometricLabel(): string {
  return 'Biometric / PIN';
}

export async function hasWalletBiometric(walletId: number): Promise<boolean> {
  try {
    return await bioHasData({ domain: BIO_DOMAIN, name: bioName(walletId) });
  } catch {
    return false;
  }
}

/** Enroll biometric for a wallet after verifying its password. */
export async function enableWalletBiometric(walletId: number, password: string): Promise<boolean> {
  if (!(await verifyWalletPassword(walletId, password))) return false;
  await bioSetData({ domain: BIO_DOMAIN, name: bioName(walletId), data: password });
  return true;
}

export async function disableWalletBiometric(walletId: number): Promise<void> {
  try {
    await bioRemoveData({ domain: BIO_DOMAIN, name: bioName(walletId) });
  } catch {
    /* already gone */
  }
}

/** Prompt biometric, retrieve the wallet password, and open the wallet. */
export async function unlockWalletWithBiometric(walletId: number): Promise<WalletRecord | null> {
  try {
    const result = await bioGetData({
      domain: BIO_DOMAIN,
      name: bioName(walletId),
      reason: 'Unlock OPTN Wallet',
    });
    if (!result.data) return null;
    return await openWalletWithPassword(walletId, result.data);
  } catch (err) {
    console.warn('[DesktopWalletManager] biometric unlock failed/cancelled:', err);
    return null;
  }
}

/**
 * Verify a password against a wallet WITHOUT changing the cached key — used by
 * the seed-reveal confirmation. For a per-wallet-password wallet, the password
 * must decrypt that wallet's own mnemonic. Legacy (no-salt) wallets fall back
 * to the gate passphrase (that is what actually encrypted them).
 */
export async function verifyWalletPassword(
  walletId: number,
  password: string
): Promise<boolean> {
  const salt = await readKdfSalt(walletId);
  if (!salt) {
    return verifyGatePassphrase(password);
  }
  const ciphertext = await readMnemonicCiphertext(walletId);
  if (!ciphertext?.startsWith(SECRET_ENC_PREFIX)) return false;
  try {
    const candidateKey = await deriveKey(password, salt);
    await aesDecrypt(candidateKey, ciphertext.slice(SECRET_ENC_PREFIX.length));
    return true;
  } catch {
    return false;
  }
}
