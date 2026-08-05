// Two-file wallet pack:
//   1) <name>.optn       — keystore (encrypted seed), same as classic Export Wallet
//   2) <name>.optn-cold  — encrypted data (UTXOs snapshot, history, labels, fusion, …)
//
// Export writes both next to each other. Import accepts multi-select of both
// (or either alone). Data file never contains the seed.

import { invoke } from '@tauri-apps/api/core';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { writeTextFile, readTextFile } from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';
import { buildWalletFileContents } from './DesktopWalletManager';
import { defaultWalletFileName, parseWalletFile, type WalletFileV1 } from './walletFile';
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
    throw new Error('This wallet cannot export a keystore file.');
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
    title: 'Export wallet — save keystore (.optn); data file is written next to it',
    defaultPath,
    filters: [{ name: 'OPTN Wallet keystore', extensions: ['optn'] }],
  });
  if (typeof dest !== 'string' || !dest) {
    throw new Error('Export cancelled.');
  }

  await invoke('write_wallet_file', { path: dest, contents });

  let coldPath: string | null = null;
  let coldSkippedReason: string | undefined;
  try {
    const archive = await buildColdArchive(walletId);
    const enc = await encryptColdArchive(walletId, password, archive);
    coldPath = companionColdPath(dest);
    await writeTextFile(coldPath, serializeEncryptedColdArchive(enc));
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
  const { exists } = await import('@tauri-apps/plugin-fs');
  const picked = await openDialog({
    multiple: true,
    directory: false,
    title:
      'Open wallet pack — select .optn (data file is auto-loaded if beside it; Ctrl-click both if needed)',
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

  let { keystorePath, coldPath } = splitWalletPackPaths(paths);
  let keystore: WalletFileV1 | null = null;
  let coldText: string | null = null;

  // Sibling auto-detect: export writes Name.optn + Name.optn-cold together.
  if (keystorePath && !coldPath) {
    const sibling = companionColdPath(keystorePath);
    try {
      if (await exists(sibling)) {
        coldPath = sibling;
      }
    } catch {
      /* exists optional */
    }
  }

  if (keystorePath) {
    const text = await invoke<string>('read_wallet_file', {
      path: keystorePath,
    });
    keystore = parseWalletFile(text);
  }
  if (coldPath) {
    coldText = await readTextFile(coldPath);
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
