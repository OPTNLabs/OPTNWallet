// COLD coin / tx labels — personal notes for decades of tracking.
// Never read by HOT balance or send/fusion coin selection.
// See docs/wallet-hot-cold-design.md

import DatabaseService from '../../apis/DatabaseManager/DatabaseService';
import { logError } from '../../utils/errorHandling';
import { ensureDesktopLedgerTables } from './desktopSchema';

export type CoinLabelKind = 'outpoint' | 'txid' | 'address';

export type CoinLabelRow = {
  kind: CoinLabelKind;
  refKey: string;
  label: string;
  updatedAt: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeLabel(raw: string): string {
  return raw.trim().slice(0, 200);
}

function isKind(value: string): value is CoinLabelKind {
  return value === 'outpoint' || value === 'txid' || value === 'address';
}

export function outpointKey(txHash: string, txPos: number): string {
  // Match fusion depth keys: lowercase txid so labels line up with Fused badges.
  return `${String(txHash).trim().toLowerCase()}:${txPos}`;
}

/** Set or replace a label. Empty string deletes the row. */
export async function setCoinLabel(
  walletId: number,
  kind: CoinLabelKind,
  refKey: string,
  label: string
): Promise<void> {
  if (walletId <= 0 || !refKey) return;
  await ensureDesktopLedgerTables();
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) return;

  const cleaned = normalizeLabel(label);
  try {
    if (!cleaned) {
      db.run(
        `DELETE FROM coin_labels
         WHERE wallet_id = ? AND kind = ? AND ref_key = ?`,
        [walletId, kind, refKey]
      );
      return;
    }
    db.run(
      `INSERT INTO coin_labels (wallet_id, kind, ref_key, label, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(wallet_id, kind, ref_key) DO UPDATE SET
         label = excluded.label,
         updated_at = excluded.updated_at`,
      [walletId, kind, refKey, cleaned, nowIso()]
    );
  } catch (error) {
    logError('CoinLabelService.setCoinLabel', error, { walletId, kind, refKey });
  }
}

export async function getCoinLabel(
  walletId: number,
  kind: CoinLabelKind,
  refKey: string
): Promise<string | null> {
  if (walletId <= 0 || !refKey) return null;
  await ensureDesktopLedgerTables();
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) return null;
  try {
    const q = db.prepare(
      `SELECT label FROM coin_labels
       WHERE wallet_id = ? AND kind = ? AND ref_key = ?`
    );
    q.bind([walletId, kind, refKey]);
    let label: string | null = null;
    if (q.step()) {
      const row = q.getAsObject() as { label?: string };
      label = typeof row.label === 'string' ? row.label : null;
    }
    q.free();
    return label;
  } catch {
    return null;
  }
}

/** All labels for a wallet (for export / list screens). */
export async function listCoinLabels(
  walletId: number
): Promise<CoinLabelRow[]> {
  if (walletId <= 0) return [];
  await ensureDesktopLedgerTables();
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) return [];
  const out: CoinLabelRow[] = [];
  try {
    const q = db.prepare(
      `SELECT kind, ref_key, label, updated_at FROM coin_labels
       WHERE wallet_id = ?
       ORDER BY updated_at DESC`
    );
    q.bind([walletId]);
    while (q.step()) {
      const row = q.getAsObject() as {
        kind?: string;
        ref_key?: string;
        label?: string;
        updated_at?: string;
      };
      if (
        typeof row.kind === 'string' &&
        isKind(row.kind) &&
        typeof row.ref_key === 'string' &&
        typeof row.label === 'string'
      ) {
        out.push({
          kind: row.kind,
          refKey: row.ref_key,
          label: row.label,
          updatedAt:
            typeof row.updated_at === 'string' ? row.updated_at : nowIso(),
        });
      }
    }
    q.free();
  } catch (error) {
    logError('CoinLabelService.listCoinLabels', error, { walletId });
  }
  return out;
}

/**
 * Export labels as plain text for backup (COLD archive seed).
 * Does not include private keys.
 */
export async function exportCoinLabelsCsv(walletId: number): Promise<string> {
  const rows = await listCoinLabels(walletId);
  const lines = ['kind,ref_key,label,updated_at'];
  for (const row of rows) {
    const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
    lines.push(
      [row.kind, row.refKey, row.label, row.updatedAt].map(esc).join(',')
    );
  }
  return lines.join('\n');
}
