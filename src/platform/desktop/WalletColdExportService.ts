// Encrypted COLD archive — wallet memory protected by wallet password.
//
// On-disk file is AES-GCM under the same PBKDF2 password + kdf_salt as the
// wallet row (WalletCrypto). Plaintext JSON is never written to disk.
//
// Import restores labels + fusion depth only (never overwrites HOT balance).
// Seed stays in Export Wallet (.optn) / Recovery Phrase.
// See docs/wallet-hot-cold-design.md

import DatabaseService from '../../apis/DatabaseManager/DatabaseService';
import UTXOManager from '../../apis/UTXOManager/UTXOManager';
import KeyService from '../../services/KeyService';
import { Network } from '../../state/slices/networkSlice';
import { logError } from '../../utils/errorHandling';
import {
  listCoinLabels,
  setCoinLabel,
  type CoinLabelKind,
} from './CoinLabelService';
import {
  exportFusionDepthState,
  importFusionDepthState,
} from './fusionCoinDepth';
import {
  aesDecrypt,
  aesEncrypt,
  base64ToBytes,
  bytesToBase64,
  deriveKey,
} from './WalletCrypto';
import { SECRET_ENC_PREFIX } from './SecretCryptoService';

export const COLD_EXPORT_FORMAT = 'optn-cold-archive-v1' as const;
export const COLD_EXPORT_ENC_FORMAT = 'optn-cold-archive-enc-v1' as const;

export type ColdArchiveExport = {
  format: typeof COLD_EXPORT_FORMAT;
  exportedAt: string;
  walletId: number;
  network: string;
  containsSecrets: false;
  disclaimer: string;
  addresses: Array<{
    address: string;
    tokenAddress?: string | null;
    addressIndex?: number | null;
    changeIndex?: number | null;
  }>;
  utxos: Array<{
    address: string;
    tx_hash: string;
    tx_pos: number;
    value: number;
    height: number;
    token?: unknown;
  }>;
  transactions: Array<{
    tx_hash: string;
    height: number;
    amount?: number | null;
  }>;
  labels: Array<{
    kind: string;
    refKey: string;
    label: string;
    updatedAt: string;
  }>;
  fusion: {
    coinDepth: Record<string, { d: number; at: number }>;
    fusionTxids: string[];
  };
};

/** On-disk encrypted envelope (password-protected). */
export type ColdArchiveEncryptedFile = {
  format: typeof COLD_EXPORT_ENC_FORMAT;
  version: 1;
  sourceWalletId: number;
  kdfSalt: string;
  ciphertext: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isArchiveNetwork(value: unknown): value is Network {
  return value === Network.MAINNET || value === Network.CHIPNET;
}

function isSafePositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isValidFusionDepth(value: unknown): boolean {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0;
  }
  return (
    isRecord(value) &&
    isSafeNonNegativeInteger(value.d) &&
    Number.isFinite(value.at) &&
    (value.at as number) >= 0
  );
}

/** Reject malformed decrypted data before any label or fusion state is merged. */
function validateColdArchive(
  value: unknown
): asserts value is ColdArchiveExport {
  if (!isRecord(value) || value.format !== COLD_EXPORT_FORMAT) {
    throw new Error('Decrypted payload is not a cold archive.');
  }
  if (
    !isSafePositiveInteger(value.walletId) ||
    typeof value.exportedAt !== 'string' ||
    value.exportedAt.length === 0 ||
    typeof value.disclaimer !== 'string' ||
    !isArchiveNetwork(value.network) ||
    value.containsSecrets !== false ||
    !Array.isArray(value.addresses) ||
    !Array.isArray(value.utxos) ||
    !Array.isArray(value.transactions) ||
    !Array.isArray(value.labels) ||
    !isRecord(value.fusion) ||
    !isRecord(value.fusion.coinDepth) ||
    !Array.isArray(value.fusion.fusionTxids)
  ) {
    throw new Error('Decrypted cold archive has an invalid structure.');
  }
  if (
    value.addresses.length === 0 ||
    !value.addresses.every(
      (address) =>
        isRecord(address) &&
        typeof address.address === 'string' &&
        address.address.trim().length > 0
    )
  ) {
    throw new Error('Decrypted cold archive has no valid wallet addresses.');
  }
  if (
    !value.utxos.every(
      (utxo) =>
        isRecord(utxo) &&
        typeof utxo.address === 'string' &&
        utxo.address.trim().length > 0 &&
        typeof utxo.tx_hash === 'string' &&
        utxo.tx_hash.trim().length > 0 &&
        isSafeNonNegativeInteger(utxo.tx_pos) &&
        Number.isSafeInteger(utxo.value) &&
        (utxo.value as number) >= 0 &&
        Number.isInteger(utxo.height)
    ) ||
    !value.transactions.every(
      (transaction) =>
        isRecord(transaction) &&
        typeof transaction.tx_hash === 'string' &&
        transaction.tx_hash.trim().length > 0 &&
        Number.isInteger(transaction.height) &&
        (transaction.amount === null ||
          transaction.amount === undefined ||
          Number.isFinite(transaction.amount))
    ) ||
    !value.labels.every(
      (label) =>
        isRecord(label) &&
        typeof label.kind === 'string' &&
        typeof label.refKey === 'string' &&
        typeof label.label === 'string' &&
        typeof label.updatedAt === 'string'
    ) ||
    !value.fusion.fusionTxids.every(
      (txid) => typeof txid === 'string' && txid.trim().length > 0
    ) ||
    !Object.entries(value.fusion.coinDepth).every(
      ([outpoint, depth]) => outpoint.includes(':') && isValidFusionDepth(depth)
    )
  ) {
    throw new Error('Decrypted cold archive has invalid metadata.');
  }
}

async function readWalletNetwork(walletId: number): Promise<Network> {
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) throw new Error('Wallet database is unavailable.');

  const query = db.prepare('SELECT networkType FROM wallets WHERE id = ?');
  query.bind([walletId]);
  let networkType: unknown = null;
  if (query.step()) {
    networkType = (query.getAsObject() as Record<string, unknown>).networkType;
  }
  query.free();
  if (!isArchiveNetwork(networkType)) {
    throw new Error('Active wallet has an unknown network.');
  }
  return networkType;
}

async function readWalletKdfSalt(walletId: number): Promise<Uint8Array | null> {
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) return null;
  const query = db.prepare('SELECT kdf_salt FROM wallets WHERE id = ?');
  query.bind([walletId]);
  let saltB64: string | null = null;
  if (query.step()) {
    const row = query.getAsObject() as Record<string, unknown>;
    saltB64 =
      typeof row.kdf_salt === 'string' && row.kdf_salt ? row.kdf_salt : null;
  }
  query.free();
  return saltB64 ? base64ToBytes(saltB64) : null;
}

async function readEncryptedMnemonic(walletId: number): Promise<string | null> {
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

/** Verify password against this wallet's encrypted mnemonic (same as open). */
export async function verifyWalletPassword(
  walletId: number,
  password: string
): Promise<boolean> {
  // Empty string is a valid password for wallets created without one.
  if (walletId <= 0 || password === null || password === undefined) {
    return false;
  }
  const salt = await readWalletKdfSalt(walletId);
  const encMnemonic = await readEncryptedMnemonic(walletId);
  if (!salt || !encMnemonic?.startsWith(SECRET_ENC_PREFIX)) return false;
  try {
    const key = await deriveKey(password, salt);
    await aesDecrypt(key, encMnemonic.slice(SECRET_ENC_PREFIX.length));
    return true;
  } catch {
    return false;
  }
}

/**
 * Password for pack export/import without nagging unlocked / passwordless wallets.
 *
 * Order:
 *  1) In-memory unlock session password (including empty string) — no prompt
 *  2) Empty password if it decrypts this wallet — no prompt
 *  3) window.prompt only when a real password is required
 *
 * Returns null if the user cancels the prompt.
 */
export async function resolveWalletPassword(
  walletId: number,
  promptMessage: string
): Promise<string | null> {
  if (walletId <= 0) return null;

  try {
    const { getCachedPasswordSnapshot, hasCachedCredentialsForWallet } =
      await import('./WalletKeyCache');
    if (hasCachedCredentialsForWallet(walletId)) {
      const snap = getCachedPasswordSnapshot();
      // Trust the unlock session: password was verified when the wallet opened
      // (including empty-password wallets). Re-verify only if we have a snap.
      if (
        snap &&
        (snap.ownerWalletId === walletId || snap.ownerWalletId == null)
      ) {
        // Empty string is a valid cached password for no-password wallets.
        return snap.password;
      }
    }
  } catch {
    /* cache optional */
  }

  // Wallet may be exportable while locked if it has no password.
  if (await verifyWalletPassword(walletId, '')) {
    return '';
  }

  const typed = window.prompt(promptMessage);
  if (typed === null) return null;
  // Empty OK-click: treat as empty password attempt (passwordless wallets).
  if (!(await verifyWalletPassword(walletId, typed))) {
    throw new Error('Wrong wallet password.');
  }
  return typed;
}

async function loadTransactionRows(
  walletId: number
): Promise<ColdArchiveExport['transactions']> {
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) return [];
  const out: ColdArchiveExport['transactions'] = [];
  try {
    const q = db.prepare(
      `SELECT tx_hash, height, amount FROM transactions WHERE wallet_id = ?
       ORDER BY ABS(height) DESC`
    );
    q.bind([walletId]);
    while (q.step()) {
      const row = q.getAsObject() as {
        tx_hash?: string;
        height?: number;
        amount?: number | null;
      };
      if (typeof row.tx_hash === 'string' && row.tx_hash) {
        out.push({
          tx_hash: row.tx_hash,
          height: Number(row.height) || 0,
          amount: row.amount ?? null,
        });
      }
    }
    q.free();
  } catch (error) {
    logError('WalletColdExportService.loadTransactionRows', error, {
      walletId,
    });
  }
  return out;
}

/** Build plaintext archive in memory only (never write this to disk). */
export async function buildColdArchive(
  walletId: number
): Promise<ColdArchiveExport> {
  if (walletId <= 0) {
    throw new Error('No active wallet to export');
  }

  const keys = (await KeyService.retrieveKeys(walletId)) ?? [];
  const addresses = keys
    .filter((k) => k.address)
    .map((k) => ({
      address: k.address,
      tokenAddress: k.tokenAddress ?? null,
      addressIndex:
        typeof (k as { addressIndex?: number }).addressIndex === 'number'
          ? (k as { addressIndex?: number }).addressIndex
          : null,
      changeIndex:
        typeof (k as { changeIndex?: number }).changeIndex === 'number'
          ? (k as { changeIndex?: number }).changeIndex
          : null,
    }));

  const mgr = await UTXOManager();
  const addrStubs = addresses.map((a) => ({ address: a.address }));
  const { utxosMap, cashTokenUtxosMap } = await mgr.fetchUTXOsFromDatabase(
    addrStubs,
    walletId
  );
  const utxos: ColdArchiveExport['utxos'] = [];
  for (const list of [
    ...Object.values(utxosMap),
    ...Object.values(cashTokenUtxosMap),
  ]) {
    for (const u of list) {
      utxos.push({
        address: u.address,
        tx_hash: u.tx_hash,
        tx_pos: u.tx_pos,
        value: u.value ?? u.amount ?? 0,
        height: u.height ?? 0,
        token: u.token ?? undefined,
      });
    }
  }

  const labels = (await listCoinLabels(walletId)).map((r) => ({
    kind: r.kind,
    refKey: r.refKey,
    label: r.label,
    updatedAt: r.updatedAt,
  }));

  return {
    format: COLD_EXPORT_FORMAT,
    exportedAt: new Date().toISOString(),
    walletId,
    network: await readWalletNetwork(walletId),
    containsSecrets: false,
    disclaimer:
      'OPTN cold archive (inner payload): chain memory, labels, fusion depth. ' +
      'Does NOT include seed phrase. On disk this payload is password-encrypted.',
    addresses,
    utxos,
    transactions: await loadTransactionRows(walletId),
    labels,
    fusion: exportFusionDepthState(walletId),
  };
}

export function defaultColdArchiveFileName(
  walletId: number,
  exportedAt?: string
): string {
  const day = (exportedAt ?? new Date().toISOString()).slice(0, 10);
  return `optn-cold-archive-wallet${walletId}-${day}.optn-cold`;
}

/** Encrypt plaintext archive with wallet password + wallet kdf salt. */
export async function encryptColdArchive(
  walletId: number,
  password: string,
  archive?: ColdArchiveExport
): Promise<ColdArchiveEncryptedFile> {
  const salt = await readWalletKdfSalt(walletId);
  if (!salt) {
    throw new Error(
      'This wallet has no password encryption salt — cannot protect the archive.'
    );
  }
  const ok = await verifyWalletPassword(walletId, password);
  if (!ok) {
    throw new Error('Wrong wallet password.');
  }
  const key = await deriveKey(password, salt);
  const payload = archive ?? (await buildColdArchive(walletId));
  const ciphertext = await aesEncrypt(key, JSON.stringify(payload));
  return {
    format: COLD_EXPORT_ENC_FORMAT,
    version: 1,
    sourceWalletId: walletId,
    kdfSalt: bytesToBase64(salt),
    ciphertext,
  };
}

export function serializeEncryptedColdArchive(
  file: ColdArchiveEncryptedFile
): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

export function parseEncryptedColdArchive(
  text: string
): ColdArchiveEncryptedFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('File is not valid JSON.');
  }
  const o = parsed as Partial<ColdArchiveEncryptedFile>;
  const format = String((o as { format?: unknown }).format ?? '');
  if (format === 'optn-cold-archive-v1') {
    throw new Error(
      'This is an old unencrypted cold archive. Re-export with a password from a current build.'
    );
  }
  if (format !== COLD_EXPORT_ENC_FORMAT || o.version !== 1) {
    throw new Error('Not a valid OPTN encrypted cold archive.');
  }
  if (
    !isSafePositiveInteger(o.sourceWalletId) ||
    typeof o.kdfSalt !== 'string' ||
    typeof o.ciphertext !== 'string'
  ) {
    throw new Error('Encrypted cold archive is missing required fields.');
  }
  return {
    format: COLD_EXPORT_ENC_FORMAT,
    version: 1,
    sourceWalletId: o.sourceWalletId,
    kdfSalt: o.kdfSalt,
    ciphertext: o.ciphertext,
  };
}

export async function decryptColdArchive(
  file: ColdArchiveEncryptedFile,
  password: string
): Promise<ColdArchiveExport> {
  const salt = base64ToBytes(file.kdfSalt);
  const key = await deriveKey(password, salt);
  let plain: string;
  try {
    plain = await aesDecrypt(key, file.ciphertext);
  } catch {
    throw new Error('Wrong password or corrupted archive.');
  }
  let archive: unknown;
  try {
    archive = JSON.parse(plain);
  } catch {
    throw new Error('Wrong password or corrupted archive.');
  }
  validateColdArchive(archive);
  if (archive.walletId !== file.sourceWalletId) {
    throw new Error(
      'Encrypted cold archive identity does not match its payload.'
    );
  }
  return archive;
}

/**
 * Import COLD data into the active wallet. Does not change HOT balance/UTXOs.
 * Restores labels + fusion depth (merge).
 */
export async function importColdArchiveIntoWallet(
  walletId: number,
  archive: ColdArchiveExport
): Promise<{ labels: number; fusionCoins: number; fusionTxids: number }> {
  if (walletId <= 0) throw new Error('No active wallet');
  validateColdArchive(archive);

  const walletNetwork = await readWalletNetwork(walletId);
  if (archive.network !== walletNetwork) {
    throw new Error(
      'Archive network does not match this wallet. Open a wallet on the correct network first.'
    );
  }

  const keys = (await KeyService.retrieveKeys(walletId)) ?? [];
  const mine = new Set(keys.map((k) => k.address).filter(Boolean));
  if (mine.size === 0) {
    throw new Error(
      'Active wallet has no addresses to verify against this cold archive.'
    );
  }
  const overlap = archive.addresses.some((address) =>
    mine.has(address.address)
  );
  if (!overlap) {
    throw new Error(
      'Archive addresses do not match this wallet. Open the correct wallet first.'
    );
  }

  let labels = 0;
  for (const row of archive.labels) {
    const kind = row.kind as CoinLabelKind;
    if (kind !== 'outpoint' && kind !== 'txid' && kind !== 'address') continue;
    if (!row.refKey || !row.label) continue;
    await setCoinLabel(walletId, kind, row.refKey, row.label);
    labels += 1;
  }

  const fusion = importFusionDepthState(walletId, archive.fusion);

  return {
    labels,
    fusionCoins: fusion.coins,
    fusionTxids: fusion.txids,
  };
}

export async function saveEncryptedColdArchiveWithDialog(
  file: ColdArchiveEncryptedFile,
  suggestedName: string
): Promise<string | null> {
  const { save: saveDialog } = await import('@tauri-apps/plugin-dialog');
  const { invoke } = await import('@tauri-apps/api/core');
  const dest = await saveDialog({
    title: 'Save encrypted cold archive',
    defaultPath: suggestedName,
    filters: [{ name: 'OPTN cold archive', extensions: ['optn-cold'] }],
  });
  if (typeof dest !== 'string' || !dest) return null;
  // Normalize extension: dialog may omit it; Rust path guard requires .optn-cold.
  const path = /\.optn-cold$/i.test(dest) ? dest : `${dest}.optn-cold`;
  await invoke('write_optn_cold_file', {
    path,
    contents: serializeEncryptedColdArchive(file),
  });
  return path;
}

export async function pickAndReadColdArchiveFile(): Promise<string | null> {
  const { open: openDialog } = await import('@tauri-apps/plugin-dialog');
  const { invoke } = await import('@tauri-apps/api/core');
  const picked = await openDialog({
    multiple: false,
    directory: false,
    title: 'Open encrypted cold archive',
    filters: [{ name: 'OPTN cold archive', extensions: ['optn-cold'] }],
  });
  if (typeof picked !== 'string') return null;
  return invoke<string>('read_optn_cold_file', { path: picked });
}

export type ColdExportResult = {
  savedPath: string | null;
  archive: ColdArchiveExport;
};

/** Password-encrypt, Save As dialog. */
export async function exportEncryptedColdArchive(
  walletId: number,
  password: string
): Promise<ColdExportResult> {
  const archive = await buildColdArchive(walletId);
  const enc = await encryptColdArchive(walletId, password, archive);
  const savedPath = await saveEncryptedColdArchiveWithDialog(
    enc,
    defaultColdArchiveFileName(walletId, archive.exportedAt)
  );
  return { archive, savedPath };
}

/** Open file, password-decrypt, import labels + fusion into active wallet. */
export async function importEncryptedColdArchiveFromFile(
  walletId: number,
  password: string,
  fileText?: string
): Promise<{
  labels: number;
  fusionCoins: number;
  fusionTxids: number;
  sourceWalletId: number;
}> {
  const text = fileText ?? (await pickAndReadColdArchiveFile());
  if (text == null) {
    throw new Error('Import cancelled.');
  }
  const enc = parseEncryptedColdArchive(text);
  const archive = await decryptColdArchive(enc, password);
  const stats = await importColdArchiveIntoWallet(walletId, archive);
  return { ...stats, sourceWalletId: enc.sourceWalletId };
}
