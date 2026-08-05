// COLD archive export — public wallet memory for decades of tracking.
//
// Includes: addresses, current UTXOs, history, labels, fusion depth.
// NEVER includes: seed, mnemonic, private keys, xprv, passwords.
//
// This is NOT a full wallet backup for recovery. Recovery still needs the
// Recovery Phrase panel. This file restores *story*, not keys.
// See docs/wallet-hot-cold-design.md

import DatabaseService from '../../apis/DatabaseManager/DatabaseService';
import UTXOManager from '../../apis/UTXOManager/UTXOManager';
import KeyService from '../../services/KeyService';
import { Network } from '../../state/slices/networkSlice';
import { store } from '../../state/store';
import { logError } from '../../utils/errorHandling';
import { listCoinLabels } from './CoinLabelService';
import { exportFusionDepthState } from './fusionCoinDepth';

export const COLD_EXPORT_FORMAT = 'optn-cold-archive-v1' as const;

export type ColdArchiveExport = {
  format: typeof COLD_EXPORT_FORMAT;
  exportedAt: string;
  walletId: number;
  network: string;
  /** Explicit so no one mistakes this for a seed backup. */
  containsSecrets: false;
  disclaimer: string;
  addresses: Array<{
    address: string;
    tokenAddress?: string | null;
    addressIndex?: number | null;
    changeIndex?: number | null;
  }>;
  /** Current HOT spendable coins (chain-public data). */
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

function networkName(): string {
  try {
    const n = store.getState().network.currentNetwork;
    if (n === Network.CHIPNET) return 'chipnet';
    if (n === Network.TESTNET) return 'testnet';
    return 'mainnet';
  } catch {
    return 'unknown';
  }
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
    logError('WalletColdExportService.loadTransactionRows', error, { walletId });
  }
  return out;
}

/**
 * Build a full COLD archive JSON object (no secrets).
 */
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

  const fusion = exportFusionDepthState(walletId);
  const transactions = await loadTransactionRows(walletId);

  return {
    format: COLD_EXPORT_FORMAT,
    exportedAt: new Date().toISOString(),
    walletId,
    network: networkName(),
    containsSecrets: false,
    disclaimer:
      'OPTN cold archive: public chain memory, labels, and fusion depth only. ' +
      'Does NOT include seed phrase, private keys, or passwords. ' +
      'To recover spending ability, use Settings → Recovery Phrase separately.',
    addresses,
    utxos,
    transactions,
    labels,
    fusion,
  };
}

export function coldArchiveToJson(archive: ColdArchiveExport): string {
  return `${JSON.stringify(archive, null, 2)}\n`;
}

export function defaultColdArchiveFileName(archive: ColdArchiveExport): string {
  return `optn-cold-archive-wallet${archive.walletId}-${archive.exportedAt.slice(0, 10)}.json`;
}

/**
 * Browser fallback (non-Tauri): anchor download. In WebView2 this often does
 * nothing visible — prefer saveColdArchiveWithDialog on desktop.
 */
export function downloadColdArchiveJson(
  archive: ColdArchiveExport,
  filename?: string
): void {
  const json = coldArchiveToJson(archive);
  const name = filename ?? defaultColdArchiveFileName(archive);
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Desktop: native Save dialog + write to the path the user picks.
 * Returns the full path, or null if cancelled.
 */
export async function saveColdArchiveWithDialog(
  archive: ColdArchiveExport
): Promise<string | null> {
  const { save: saveDialog } = await import('@tauri-apps/plugin-dialog');
  const { writeTextFile } = await import('@tauri-apps/plugin-fs');
  const suggested = defaultColdArchiveFileName(archive);
  const dest = await saveDialog({
    title: 'Save cold archive',
    defaultPath: suggested,
    filters: [{ name: 'JSON archive', extensions: ['json'] }],
  });
  if (typeof dest !== 'string' || !dest) return null;
  await writeTextFile(dest, coldArchiveToJson(archive));
  return dest;
}

export type ColdExportResult = {
  archive: ColdArchiveExport;
  /** Full filesystem path when saved via dialog; null if cancelled / browser-only. */
  savedPath: string | null;
};

/**
 * Build archive and save it. On Tauri desktop: Save As dialog.
 * Fallback: browser download (may be invisible in some WebViews).
 */
export async function exportAndDownloadColdArchive(
  walletId: number
): Promise<ColdExportResult> {
  const archive = await buildColdArchive(walletId);
  try {
    const savedPath = await saveColdArchiveWithDialog(archive);
    return { archive, savedPath };
  } catch (error) {
    // Not running under Tauri, or dialog/fs unavailable.
    logError('WalletColdExportService.saveDialog', error, { walletId });
    downloadColdArchiveJson(archive);
    return { archive, savedPath: null };
  }
}
