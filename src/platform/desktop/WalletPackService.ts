// Two-file wallet pack:
//   1) <name>.optn       — keystore (encrypted seed), same as classic Export Wallet
//   2) <name>.optn-cold  — encrypted data (UTXOs snapshot, history, labels, fusion, …)
//
// Export writes both next to each other. Import accepts multi-select of both
// (or either alone). Data file never contains the seed.

import { invoke } from '@tauri-apps/api/core';
import {
  open as openDialog,
  save as saveDialog,
} from '@tauri-apps/plugin-dialog';
import { join } from '@tauri-apps/api/path';
import { buildWalletFileContents } from './DesktopWalletManager';
import {
  defaultWalletFileName,
  parseWalletFile,
  type WalletFileV1,
} from './walletFile';
import {
  buildColdArchive,
  encryptColdArchive,
  serializeEncryptedColdArchive,
  parseEncryptedColdArchive,
  decryptColdArchive,
  importColdArchiveIntoWallet,
  defaultColdArchiveFileName,
  resolveWalletPassword,
} from './WalletColdExportService';
import { logError } from '../../utils/errorHandling';

/** Unrestricted Rust I/O for .optn-cold (same reason as write_wallet_file). */
async function writeOptnColdFile(
  path: string,
  contents: string
): Promise<void> {
  await invoke('write_optn_cold_file', { path, contents });
}

async function readOptnColdFile(path: string): Promise<string> {
  return invoke<string>('read_optn_cold_file', { path });
}

async function optnColdFileExists(path: string): Promise<boolean> {
  return invoke<boolean>('optn_cold_file_exists', { path });
}

export function isOptnColdPath(path: string): boolean {
  return /\.optn-cold$/i.test(path);
}

export function isOptnKeystorePath(path: string): boolean {
  return /\.optn$/i.test(path) && !isOptnColdPath(path);
}

/** Companion data path next to a keystore path. */
export function companionColdPath(optnPath: string): string {
  if (isOptnKeystorePath(optnPath)) {
    return `${optnPath.slice(0, -'.optn'.length)}.optn-cold`;
  }
  return `${optnPath}.optn-cold`;
}

/**
 * Display name from the path the user picked in the Save dialog.
 * Export used to keep the DB wallet_name inside the JSON even when the file
 * was renamed to e.g. "wallet7 for testing.optn" — re-import then showed the
 * old hard-coded name. Prefer the chosen stem when it is non-empty.
 */
export function walletNameFromOptnPath(optnPath: string): string | null {
  const base = optnPath.replace(/\\/g, '/').split('/').pop() ?? '';
  if (!isOptnKeystorePath(base)) return null;
  const stem = base.slice(0, -'.optn'.length).trim();
  return stem || null;
}

/** Stamp a display name into serialized .optn JSON (no re-encrypt). */
export function withWalletFileName(contents: string, name: string): string {
  try {
    const obj = JSON.parse(contents) as Record<string, unknown>;
    if (obj && typeof obj === 'object') {
      obj.name = name;
      return JSON.stringify(obj, null, 2);
    }
  } catch {
    /* leave contents unchanged */
  }
  return contents;
}

export function splitWalletPackPaths(paths: string[]): {
  keystorePath: string | null;
  coldPath: string | null;
} {
  const unique = Array.from(new Set(paths.filter(Boolean)));
  const coldPath = unique.find(isOptnColdPath) ?? null;
  const keystorePath = unique.find(isOptnKeystorePath) ?? null;
  return { keystorePath, coldPath };
}

export type ExportWalletPackResult = {
  keystorePath: string;
  coldPath: string | null;
  coldSkippedReason?: string;
};

/**
 * Export both files. Password is taken from the unlocked session when possible
 * (including empty password wallets). One Save dialog for .optn; .optn-cold
 * is written beside it automatically.
 */
export async function exportWalletPack(
  walletId: number,
  walletsDirPath: string | null,
  passwordOverride?: string
): Promise<ExportWalletPackResult> {
  if (walletId <= 0) throw new Error('No active wallet');

  const password =
    passwordOverride !== undefined
      ? passwordOverride
      : await resolveWalletPassword(
          walletId,
          'Wallet password to encrypt the data file (.optn-cold).\n' +
            '(Skipped automatically if this wallet is already unlocked or has no password.)'
        );
  if (password === null) {
    throw new Error('Export cancelled.');
  }

  const contents = await buildWalletFileContents(walletId);
  if (!contents) {
    throw new Error(
      'This wallet cannot export a v1 keystore file. Wallet packs currently support only seed-backed standard and Quantumroot wallets.'
    );
  }
  const name = (() => {
    try {
      return (JSON.parse(contents) as { name?: string }).name ?? 'wallet';
    } catch {
      return 'wallet';
    }
  })();
  const suggested = defaultWalletFileName(name);
  const defaultPath = walletsDirPath
    ? await join(walletsDirPath, suggested)
    : suggested;

  const dest = await saveDialog({
    title:
      'Export wallet — save keystore (.optn); data file is written next to it',
    defaultPath,
    filters: [{ name: 'OPTN Wallet keystore', extensions: ['optn'] }],
  });
  if (typeof dest !== 'string' || !dest) {
    throw new Error('Export cancelled.');
  }

  // Honor the Save-as name (e.g. "wallet7 for testing.optn") inside the file
  // so Open/import shows what the user typed, not only the DB wallet_name.
  const chosenName = walletNameFromOptnPath(dest);
  const contentsToWrite = chosenName
    ? withWalletFileName(contents, chosenName)
    : contents;

  await invoke('write_wallet_file', { path: dest, contents: contentsToWrite });

  let coldPath: string | null = null;
  let coldSkippedReason: string | undefined;
  try {
    const archive = await buildColdArchive(walletId);
    const enc = await encryptColdArchive(walletId, password, archive);
    coldPath = companionColdPath(dest);
    await writeOptnColdFile(coldPath, serializeEncryptedColdArchive(enc));
  } catch (err) {
    logError('WalletPackService.exportColdCompanion', err, { walletId });
    coldSkippedReason =
      err instanceof Error ? err.message : 'Could not write data file.';
  }

  return { keystorePath: dest, coldPath, coldSkippedReason };
}

export type PickedWalletPack = {
  keystore: WalletFileV1 | null;
  coldText: string | null;
  keystorePath: string | null;
  coldPath: string | null;
};

/**
 * Multi-select open dialog: pick .optn and/or .optn-cold together (Ctrl-click).
 * If only .optn is chosen, auto-loads sibling .optn-cold when it exists.
 */
export async function pickWalletPackFiles(
  defaultDir: string | null
): Promise<PickedWalletPack | null> {
  const picked = await openDialog({
    multiple: true,
    directory: false,
    title:
      'Open wallet pack — select .optn (data file auto-loads if it sits next to it)',
    defaultPath: defaultDir ?? undefined,
    filters: [
      {
        name: 'OPTN wallet pack',
        extensions: ['optn', 'optn-cold'],
      },
    ],
  });
  if (picked == null) return null;
  const paths = Array.isArray(picked)
    ? picked
    : typeof picked === 'string'
      ? [picked]
      : [];
  if (paths.length === 0) return null;

  const split = splitWalletPackPaths(paths);
  const keystorePath = split.keystorePath;
  let coldPath = split.coldPath;
  let keystore: WalletFileV1 | null = null;
  let coldText: string | null = null;

  // Sibling auto-detect: export writes Name.optn + Name.optn-cold together.
  // Uses Rust exists (not JS fs plugin) so Desktop/Downloads paths work.
  if (keystorePath && !coldPath) {
    const sibling = companionColdPath(keystorePath);
    try {
      if (await optnColdFileExists(sibling)) {
        coldPath = sibling;
      }
    } catch (err) {
      logError('WalletPackService.siblingColdExists', err, { sibling });
    }
  }

  if (keystorePath) {
    const text = await invoke<string>('read_wallet_file', {
      path: keystorePath,
    });
    keystore = parseWalletFile(text);
  }
  if (coldPath) {
    coldText = await readOptnColdFile(coldPath);
  }

  if (!keystore && !coldText) {
    throw new Error(
      'No .optn keystore or .optn-cold data file in the selection.'
    );
  }

  return { keystore, coldText, keystorePath, coldPath };
}

/**
 * Apply encrypted cold data into an already-open wallet (password-checked).
 */
export async function importColdDataIntoOpenWallet(
  walletId: number,
  coldText: string,
  password: string
): Promise<{ labels: number; fusionCoins: number; fusionTxids: number }> {
  const enc = parseEncryptedColdArchive(coldText);
  const archive = await decryptColdArchive(enc, password);
  return importColdArchiveIntoWallet(walletId, archive);
}

export { defaultColdArchiveFileName };
