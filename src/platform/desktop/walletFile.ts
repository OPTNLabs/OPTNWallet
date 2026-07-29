// Electron Cash-style wallet FILES.
//
// The SQLite DB (in IndexedDB) stays the app's working store, but every wallet
// is ALSO mirrored to a real, self-contained encrypted file so users have
// something they can back up, copy between machines, and re-open — the way
// Electron Cash keeps ~/.electron-cash/wallets/<name>.
//
// Default location: <AppData>/wallets/wallet-<id>.optn (auto-saved on create/
// import). Export/Open-from-anywhere use the OS file dialog (see useMenuBar).
//
// Security: the file carries the mnemonic ONLY in its already-encrypted form
// (AES-256-GCM under the wallet's own PBKDF2 password key) plus the KDF salt.
// Opening a file therefore still requires that wallet's password — the file is
// safe at rest.

import {
  writeTextFile,
  readTextFile,
  mkdir,
  readDir,
  exists,
  BaseDirectory,
} from '@tauri-apps/plugin-fs';

export const WALLETS_DIR = 'wallets';
export const WALLET_FILE_EXT = 'optn';

export interface WalletFileV1 {
  format: 'optn-wallet';
  version: 1;
  /** Original DB id at export time — informational; import allocates a new id. */
  sourceId: number;
  name: string;
  walletType: string;
  /** `enc:v1:...` ciphertext exactly as stored in the DB. */
  encryptedMnemonic: string;
  /** `enc:v1:...` ciphertext exactly as stored in the DB (may be empty). */
  encryptedPassphrase: string;
  /** base64 PBKDF2 salt used to derive this wallet's key. */
  kdfSalt: string;
  /** Effective BIP44 account path. Optional for files created before path persistence. */
  derivationPath?: string;
  derivationPathSource?: 'default' | 'custom';
}

export function serializeWalletFile(w: Omit<WalletFileV1, 'format' | 'version'>): string {
  const file: WalletFileV1 = { format: 'optn-wallet', version: 1, ...w };
  return JSON.stringify(file, null, 2);
}

export function parseWalletFile(text: string): WalletFileV1 {
  const parsed = JSON.parse(text) as Partial<WalletFileV1>;
  if (parsed.format !== 'optn-wallet' || parsed.version !== 1) {
    throw new Error('Not a valid OPTN wallet file.');
  }
  if (
    typeof parsed.encryptedMnemonic !== 'string' ||
    typeof parsed.kdfSalt !== 'string' ||
    typeof parsed.name !== 'string'
  ) {
    throw new Error('OPTN wallet file is missing required fields.');
  }
  return {
    format: 'optn-wallet',
    version: 1,
    sourceId: typeof parsed.sourceId === 'number' ? parsed.sourceId : 0,
    name: parsed.name,
    walletType: typeof parsed.walletType === 'string' ? parsed.walletType : 'standard',
    encryptedMnemonic: parsed.encryptedMnemonic,
    encryptedPassphrase:
      typeof parsed.encryptedPassphrase === 'string' ? parsed.encryptedPassphrase : '',
    kdfSalt: parsed.kdfSalt,
    derivationPath:
      typeof parsed.derivationPath === 'string' ? parsed.derivationPath : undefined,
    derivationPathSource:
      parsed.derivationPathSource === 'custom' ? 'custom' : 'default',
  };
}

/** Sanitize a wallet name into a filename-safe fragment. */
function safeName(name: string): string {
  return (name || 'wallet').replace(/[^a-zA-Z0-9-_]+/g, '_').slice(0, 40);
}

export function defaultWalletFileName(id: number, name: string): string {
  return `wallet-${id}-${safeName(name)}.${WALLET_FILE_EXT}`;
}

/**
 * Auto-save a wallet into the app's default wallets folder. Never throws to the
 * caller — a failed mirror must not fail wallet creation (the DB is the source
 * of truth). Returns the relative path on success, null on failure.
 */
export async function autoSaveWalletFile(
  w: Omit<WalletFileV1, 'format' | 'version'>
): Promise<string | null> {
  try {
    if (!(await exists(WALLETS_DIR, { baseDir: BaseDirectory.AppData }))) {
      await mkdir(WALLETS_DIR, { baseDir: BaseDirectory.AppData, recursive: true });
    }
    const rel = `${WALLETS_DIR}/${defaultWalletFileName(w.sourceId, w.name)}`;
    await writeTextFile(rel, serializeWalletFile(w), { baseDir: BaseDirectory.AppData });
    return rel;
  } catch (err) {
    console.warn('[walletFile] auto-save failed (DB copy is unaffected):', err);
    return null;
  }
}

/** List wallet files currently in the default wallets folder. */
export async function listWalletFiles(): Promise<string[]> {
  try {
    if (!(await exists(WALLETS_DIR, { baseDir: BaseDirectory.AppData }))) return [];
    const entries = await readDir(WALLETS_DIR, { baseDir: BaseDirectory.AppData });
    return entries
      .filter((e) => e.isFile && e.name.endsWith(`.${WALLET_FILE_EXT}`))
      .map((e) => `${WALLETS_DIR}/${e.name}`);
  } catch {
    return [];
  }
}

/** Read + parse a wallet file at an absolute path (from the OS open dialog). */
export async function readWalletFileAt(absolutePath: string): Promise<WalletFileV1> {
  const text = await readTextFile(absolutePath);
  return parseWalletFile(text);
}
