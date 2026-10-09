// How many times each coin has been fused — Electron Cash's `fuse_depth`.
//
// Every rule lives in Rust (optn-core fusion::depth, through the shared WASM
// core): how a coin's depth is found, the MIN-ancestry rule a round records,
// evidence-only eviction, cold-import merging, and Auto's eligibility and
// status lines. The CLI and the native driver use the same book.
//
// This file is the desktop's storage for it. Each wallet's book stays in
// memory as a WASM object, and is written to the same localStorage keys every
// earlier build used, so no recorded depth is lost on upgrade. Fusion txids
// are also kept durably in wallet SQL for history labels. Other windows get
// each change over a BroadcastChannel and merge it by depth.

import { getLocalStorage } from '../../utils/browserStorage';
import {
  ensureOptnCore,
  FusionDepthBook,
  fusionNormalizeOutpoint,
} from '../../wasm/optn-core';

const DEPTH_PREFIX = 'optn-fusion-coin-depth-';
const TXID_PREFIX = 'optn-fusion-txids-';
const TX_DEPTH_PREFIX = 'optn-fusion-tx-depth-';
const DEPTH_BC_NAME = 'optn-fusion-depth-sync';

/**
 * Same-window UI refresh. localStorage writes do not re-render React; after a
 * server (or P2P) fuse the Home / history / coin-control "Fused" badges stayed
 * blank until a full navigation. Dispatch so badges update live.
 */
export const FUSION_DEPTH_CHANGED_EVENT = 'optn-fusion-depth-changed';

function notifyFusionDepthChanged(walletId: number): void {
  try {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(
      new CustomEvent(FUSION_DEPTH_CHANGED_EVENT, {
        detail: { walletId },
      })
    );
  } catch {
    /* ignore */
  }
}

/** Canonical `txid:pos`, txid lower-cased. */
export function outpointFromParts(txHash: string, txPos: number): string {
  ensureOptnCore();
  return fusionNormalizeOutpoint(`${txHash}:${txPos}`);
}

function readStored(key: string): string | undefined {
  try {
    return getLocalStorage()?.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function writeStored(key: string, value: string): void {
  try {
    getLocalStorage()?.setItem(key, value);
  } catch {
    /* memory still holds it this session */
  }
}

const books = new Map<number, FusionDepthBook>();

function book(walletId: number): FusionDepthBook {
  const held = books.get(walletId);
  if (held) return held;
  ensureOptnCore();
  const loaded = FusionDepthBook.fromStored(
    readStored(`${DEPTH_PREFIX}${walletId}`),
    readStored(`${TX_DEPTH_PREFIX}${walletId}`),
    readStored(`${TXID_PREFIX}${walletId}`)
  );
  books.set(walletId, loaded);
  getDepthBc();
  return loaded;
}

let depthBc: BroadcastChannel | null = null;
function getDepthBc(): BroadcastChannel | null {
  if (depthBc) return depthBc;
  try {
    if (typeof BroadcastChannel === 'undefined') return null;
    depthBc = new BroadcastChannel(DEPTH_BC_NAME);
    depthBc.onmessage = (event: MessageEvent) => {
      const data = event.data as {
        walletId?: number;
        coins?: string;
        txDepth?: string;
      };
      if (!data || !Number.isInteger(data.walletId) || (data.walletId as number) <= 0) {
        return;
      }
      const walletId = data.walletId as number;
      book(walletId).mergeStored(data.coins, data.txDepth);
      notifyFusionDepthChanged(walletId);
    };
    return depthBc;
  } catch {
    return null;
  }
}

/** Write a wallet's book everywhere it is kept. */
function save(walletId: number, options: { txidsChanged: boolean }): void {
  const current = book(walletId);
  const coins = current.storedCoins();
  const txDepth = current.storedTxDepth();
  writeStored(`${DEPTH_PREFIX}${walletId}`, coins);
  writeStored(`${TX_DEPTH_PREFIX}${walletId}`, txDepth);
  if (options.txidsChanged) {
    writeStored(`${TXID_PREFIX}${walletId}`, current.storedTxids());
    void persistFusionTxidsToSql(walletId, current.fusionTxids()).catch(
      () => undefined
    );
  }
  try {
    getDepthBc()?.postMessage({ walletId, coins, txDepth });
  } catch {
    /* ignore */
  }
  notifyFusionDepthChanged(walletId);
}

/**
 * Rounds this coin has been through. Unknown coins are fresh (0).
 * Same rules for UI badges and Auto eligibility (server + P2P).
 */
export function coinDepth(walletId: number, outpoint: string): number {
  return book(walletId).depthOf(outpoint);
}

/** All recorded CashFusion CoinJoin txids for this wallet (P2P + server). */
export function listRecordedFusionTxids(walletId: number): string[] {
  return book(walletId).fusionTxids();
}

/**
 * Ensure history lists still show known fusion CoinJoins after Electrum refresh.
 * Shared by P2P and server — both stamp txids via completeFusionBroadcast.
 *
 * Only re-attach rows that are truly absent. Never invent a height-0 stub when
 * the same txid is already present (even with height 0) — that caused "Fused ·
 * Unconfirmed" forever for on-chain CoinJoins. Stubs stay height 0 only as a
 * last resort until Electrum backfill writes a real height.
 */
export function mergeRecordedFusionTxsIntoHistory<
  T extends { tx_hash: string; height: number; timestamp?: string },
>(walletId: number, transactions: readonly T[]): T[] {
  const known = listRecordedFusionTxids(walletId);
  if (known.length === 0) return [...transactions];
  const have = new Set(
    transactions.map((tx) => String(tx.tx_hash).trim().toLowerCase())
  );
  const missing = known
    .filter((txid) => !have.has(txid))
    .map(
      (tx_hash) =>
        ({
          tx_hash,
          // Sentinel only — callers must run height backfill for these.
          height: 0,
          timestamp: new Date().toISOString(),
        }) as T
    );
  if (missing.length === 0) return [...transactions];
  return [...missing, ...transactions];
}

/** Snapshot for COLD export (no secrets). */
export function exportFusionDepthState(walletId: number): {
  coinDepth: Record<string, { d: number; at: number }>;
  fusionTxids: string[];
} {
  const current = book(walletId);
  return {
    coinDepth: JSON.parse(current.storedCoins()) as Record<
      string,
      { d: number; at: number }
    >,
    fusionTxids: current.fusionTxids(),
  };
}

/**
 * Merge imported fusion state into this wallet (COLD import): per coin the
 * deeper record wins, txids are united.
 */
export function importFusionDepthState(
  walletId: number,
  state: {
    coinDepth?: Record<string, { d?: number; at?: number } | number>;
    fusionTxids?: string[];
  }
): { coins: number; txids: number } {
  const [coins, txids] = book(walletId).importState(
    JSON.stringify(state),
    Date.now()
  );
  save(walletId, { txidsChanged: true });
  return { coins, txids };
}

async function openWalletDatabase() {
  const { ensureDesktopLedgerTables } = await import('./desktopSchema');
  await ensureDesktopLedgerTables();
  const DatabaseService = (
    await import('../../apis/DatabaseManager/DatabaseService')
  ).default;
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  return { dbService, db: dbService.getDatabase() };
}

async function persistFusionTxidsToSql(
  walletId: number,
  txids: readonly string[]
): Promise<void> {
  if (!Number.isSafeInteger(walletId) || walletId <= 0) return;
  const { dbService, db } = await openWalletDatabase();
  if (!db) return;
  const now = new Date().toISOString();
  for (const txid of txids) {
    db.run(
      `INSERT INTO fusion_txids (wallet_id, txid, recorded_at)
       VALUES (?, ?, ?)
       ON CONFLICT(wallet_id, txid) DO NOTHING`,
      [walletId, txid, now]
    );
  }
  try {
    dbService.scheduleDatabaseSave(walletId);
  } catch {
    /* optional */
  }
}

/**
 * Load durable Fused labels from wallet SQL into the book, and write back any
 * the book had that SQL lacked. Call on wallet open / Auto start / before
 * showing history.
 */
export async function hydrateFusionLabels(walletId: number): Promise<number> {
  if (!Number.isSafeInteger(walletId) || walletId <= 0) return 0;
  try {
    const { db } = await openWalletDatabase();
    if (!db) return 0;
    const fromSql: string[] = [];
    const query = db.prepare(`SELECT txid FROM fusion_txids WHERE wallet_id = ?`);
    query.bind([walletId]);
    while (query.step()) {
      const row = query.getAsObject() as { txid?: string };
      if (typeof row.txid === 'string') fromSql.push(row.txid);
    }
    query.free();

    const current = book(walletId);
    const added = current.addTxids(fromSql);
    const all = current.fusionTxids();
    if (all.length > fromSql.length) {
      await persistFusionTxidsToSql(walletId, all);
    }
    writeStored(`${TXID_PREFIX}${walletId}`, current.storedTxids());
    if (added > 0 || all.length > 0) notifyFusionDepthChanged(walletId);
    return all.length;
  } catch {
    return 0;
  }
}

/**
 * One-shot restore from AppData `fusion-txid-recovery.json` (built from fuse
 * logs). Safe to call repeatedly.
 */
export async function restoreFusionLabelsFromRecoveryFile(): Promise<{
  wallets: number;
  txids: number;
}> {
  let wallets = 0;
  let txids = 0;
  try {
    const { readTextFile, exists, BaseDirectory } = await import(
      '@tauri-apps/plugin-fs'
    );
    const rel = 'fusion-txid-recovery.json';
    if (!(await exists(rel, { baseDir: BaseDirectory.AppData }))) {
      return { wallets: 0, txids: 0 };
    }
    const raw = await readTextFile(rel, { baseDir: BaseDirectory.AppData });
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const [walletKey, list] of Object.entries(parsed)) {
      const walletId = Number(walletKey);
      if (!Number.isSafeInteger(walletId) || walletId <= 0) continue;
      if (!Array.isArray(list)) continue;
      const current = book(walletId);
      const before = current.fusionTxids().length;
      // Each recovered txid also floors its outputs at depth 1.
      for (const item of list) {
        if (typeof item === 'string') current.recordFusionTxid(item);
      }
      const added = current.fusionTxids().length - before;
      if (current.fusionTxids().length > 0) {
        save(walletId, { txidsChanged: true });
        wallets += 1;
        txids += added;
        await hydrateFusionLabels(walletId);
      }
    }
  } catch {
    /* recovery file optional */
  }
  return { wallets, txids };
}

/** True if this wallet recorded `txid` as a completed CashFusion CoinJoin. */
export function isFusionTransaction(walletId: number, txid: string): boolean {
  return book(walletId).isFusionTransaction(txid);
}

/**
 * Remember a CoinJoin txid for history/home "Fused" badges, flooring its
 * outputs at depth 1 until they are recorded by outpoint.
 */
export function recordFusionTxid(walletId: number, txid: string): void {
  if (book(walletId).recordFusionTxid(txid)) {
    save(walletId, { txidsChanged: true });
  }
}

/**
 * Record one completed fusion: the coins it spent are gone, and the coins it
 * created are one round deeper than the shallowest coin it spent (Electron
 * Cash's MIN-ancestry rule; see optn-core fusion::depth).
 */
export function recordFusionRound(
  walletId: number,
  spentOutpoints: string[],
  createdOutpoints: string[]
): void {
  book(walletId).recordRound(spentOutpoints, createdOutpoints, Date.now());
  save(walletId, { txidsChanged: true });
}

export type FuseDepthEligibility = {
  total: number;
  /** Below the target: Auto may still fuse these. */
  eligible: number;
  atOrAboveDepth: number;
  /** The holder's rounds-per-coin target. */
  maxDepth: number;
  /** Min/max depth among the coins (for logs / UI). */
  minDepth: number;
  maxCoinDepth: number;
  /** Auto's status when nothing is below the target. */
  metMessage: string;
  /** One progress line while coins remain below the target. */
  gateLog: string;
};

/** The coins against the holder's target: "nothing eligible" is often "goal met". */
export function fuseDepthEligibility(
  walletId: number,
  utxos: ReadonlyArray<{ tx_hash: string; tx_pos: number }>,
  maxDepth: number
): FuseDepthEligibility {
  const view = JSON.parse(
    book(walletId).eligibility(
      utxos.map((utxo) => `${utxo.tx_hash}:${utxo.tx_pos}`),
      Math.max(0, Math.trunc(maxDepth))
    )
  ) as {
    total: number;
    eligible: number;
    atOrAbove: number;
    target: number;
    minDepth: number;
    maxDepth: number;
    metMessage: string;
    gateLog: string;
  };
  return {
    total: view.total,
    eligible: view.eligible,
    atOrAboveDepth: view.atOrAbove,
    maxDepth: view.target,
    minDepth: view.minDepth,
    maxCoinDepth: view.maxDepth,
    metMessage: view.metMessage,
    gateLog: view.gateLog,
  };
}

/** Test/support hook: forget every recorded depth for a wallet. */
export function clearFusionDepth(walletId: number): void {
  books.get(walletId)?.free();
  books.delete(walletId);
  try {
    getLocalStorage()?.removeItem(`${DEPTH_PREFIX}${walletId}`);
    getLocalStorage()?.removeItem(`${TXID_PREFIX}${walletId}`);
    getLocalStorage()?.removeItem(`${TX_DEPTH_PREFIX}${walletId}`);
  } catch {
    /* nothing to clear */
  }
  void (async () => {
    try {
      const { dbService, db } = await openWalletDatabase();
      if (!db) return;
      db.run(`DELETE FROM fusion_txids WHERE wallet_id = ?`, [walletId]);
      try {
        dbService.scheduleDatabaseSave(walletId);
      } catch {
        /* optional */
      }
    } catch {
      /* tests may lack SQL */
    }
  })();
}
