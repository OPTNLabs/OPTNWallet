// How many times each coin has been fused — Electron Cash's `fuse_depth`.
//
// Auto-fusion needs a stopping condition. Without one it would re-fuse the same
// coins forever, paying a real fee every round, which is the difference between
// a privacy feature and a slow drain. EC bounds this per COIN, not per wallet:
// a coin that has been through `fuse_depth` rounds is left alone, while newly
// received coins still get fused.
//
// Depth lives in localStorage for the same reason the round keys and input locks
// do (fusionRoundState.ts): every window of the app shares it, and it survives a
// reload. A module variable would let a second window re-fuse a coin this window
// had already finished with.
//
// The map is self-pruning. A fusion SPENDS its inputs, so those outpoints can
// never appear again and their entries are dropped as the outputs are recorded.
// The map therefore tracks roughly the wallet's live coin count rather than
// growing forever. A timestamp is kept only as a backstop for entries orphaned
// by a round that died between spending and recording.

import { getLocalStorage } from '../../utils/browserStorage';

const DEPTH_PREFIX = 'optn-fusion-coin-depth-';
/** Wallet-local set of CoinJoin txids — for Home / history "Fused" labels after
 *  coins are spent (depth map prunes spent outpoints). */
const TXID_PREFIX = 'optn-fusion-txids-';
/**
 * Per-CoinJoin-txid depth. Outpoint keys sometimes miss (index / casing /
 * Electrum lag), which used to reset every round to depth 1 forever. Looking up
 * by parent txid keeps Auto able to stop at rounds-per-coin.
 */
const TX_DEPTH_PREFIX = 'optn-fusion-tx-depth-';

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

/** Canonical `txid:pos` — txid lowercased so Electrum/display case cannot hide depth. */
export function normalizeOutpoint(outpoint: string): string {
  const raw = outpoint.trim();
  const colon = raw.lastIndexOf(':');
  if (colon <= 0) return raw.toLowerCase();
  const tx = raw.slice(0, colon).toLowerCase();
  const pos = raw.slice(colon + 1);
  return `${tx}:${pos}`;
}

export function outpointFromParts(txHash: string, txPos: number): string {
  return normalizeOutpoint(`${txHash}:${txPos}`);
}

// Deliberately NO age or size based pruning.
//
// An earlier version expired entries after 180 days and capped the map at 5000
// entries. Both can forget a coin that is still unspent, and a forgotten coin
// reads as depth 0 — so auto-fusion picks it up again and pays another fee for
// mixing it already did. Age is a particularly bad proxy here: a coin can sit
// untouched for years and is no less fused for it.
//
// The only safe eviction is proof that a coin is gone. `recordFusionRound` drops
// the inputs a round consumed, and `pruneSpentDepth` drops anything absent from a
// fresh wallet snapshot. Both are evidence of spending; neither is a guess.

interface DepthEntry {
  /** Rounds this coin has already been through. */
  d: number;
  /** Epoch ms, for the orphan backstop only. */
  at: number;
}

type DepthMap = Record<string, DepthEntry>;

const storageKeyFor = (walletId: number) => `${DEPTH_PREFIX}${walletId}`;
const txDepthKeyFor = (walletId: number) => `${TX_DEPTH_PREFIX}${walletId}`;
const DEPTH_BC_NAME = 'optn-fusion-depth-sync';

function txidOfOutpoint(outpoint: string): string {
  const key = normalizeOutpoint(outpoint);
  const colon = key.lastIndexOf(':');
  return colon > 0 ? key.slice(0, colon) : key;
}

type TxDepthMap = Record<string, number>;

/**
 * Process-memory cache. Live log showed `depth: recorded N` then next Auto
 * `coin depths 0–0` — localStorage alone was not reliable across ticks in
 * multi-window Tauri. Memory keeps the chain for this session; localStorage +
 * BroadcastChannel still try to share across reloads / windows.
 */
const memEntries = new Map<number, DepthMap>();
const memTxDepth = new Map<number, TxDepthMap>();

let depthBc: BroadcastChannel | null = null;
function getDepthBc(): BroadcastChannel | null {
  if (depthBc) return depthBc;
  try {
    if (typeof BroadcastChannel === 'undefined') return null;
    depthBc = new BroadcastChannel(DEPTH_BC_NAME);
    depthBc.onmessage = (ev: MessageEvent) => {
      const data = ev.data as {
        walletId?: number;
        entries?: DepthMap;
        txDepth?: TxDepthMap;
      };
      if (
        !data ||
        !Number.isInteger(data.walletId) ||
        (data.walletId as number) <= 0
      ) {
        return;
      }
      const wid = data.walletId as number;
      // Merge by max depth — never replace a full map with {} from another window.
      if (data.entries && typeof data.entries === 'object') {
        const incoming = data.entries;
        const prev = memEntries.get(wid) ?? {};
        if (Object.keys(incoming).length === 0 && Object.keys(prev).length > 0) {
          /* ignore empty wipe */
        } else {
          const merged: DepthMap = { ...prev };
          for (const [k, v] of Object.entries(incoming)) {
            if (!v || typeof v.d !== 'number') continue;
            if (!merged[k] || v.d >= merged[k].d) merged[k] = v;
          }
          memEntries.set(wid, merged);
        }
      }
      if (data.txDepth && typeof data.txDepth === 'object') {
        const prev = memTxDepth.get(wid) ?? {};
        const merged: TxDepthMap = { ...prev };
        for (const [k, v] of Object.entries(data.txDepth)) {
          if (typeof v === 'number' && Number.isFinite(v)) {
            const key = k.toLowerCase();
            merged[key] = Math.max(merged[key] ?? 0, Math.trunc(v));
          }
        }
        memTxDepth.set(wid, merged);
      }
    };
    return depthBc;
  } catch {
    return null;
  }
}

function parseDepthMap(raw: string | null): DepthMap {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: DepthMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const { d, at } = value as { d?: unknown; at?: unknown };
      if (
        typeof d === 'number' &&
        Number.isFinite(d) &&
        d >= 0 &&
        typeof at === 'number' &&
        Number.isFinite(at)
      ) {
        const norm = normalizeOutpoint(key);
        const prev = out[norm]?.d ?? 0;
        if (Math.trunc(d) >= prev) {
          out[norm] = { d: Math.trunc(d), at };
        }
      }
    }
    return out;
  } catch {
    return {};
  }
}

function parseTxDepth(raw: string | null): TxDepthMap {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: TxDepthMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
        out[k.toLowerCase()] = Math.trunc(v);
      }
    }
    return out;
  } catch {
    return {};
  }
}

function readTxDepth(walletId: number): TxDepthMap {
  const cached = memTxDepth.get(walletId);
  if (cached) return cached;
  try {
    const fromLs = parseTxDepth(
      getLocalStorage()?.getItem(txDepthKeyFor(walletId)) ?? null
    );
    memTxDepth.set(walletId, fromLs);
    return fromLs;
  } catch {
    const empty: TxDepthMap = {};
    memTxDepth.set(walletId, empty);
    return empty;
  }
}

function writeTxDepth(walletId: number, map: TxDepthMap): void {
  memTxDepth.set(walletId, map);
  try {
    getLocalStorage()?.setItem(txDepthKeyFor(walletId), JSON.stringify(map));
  } catch {
    /* memory still holds it this session */
  }
  try {
    getDepthBc()?.postMessage({
      walletId,
      entries: memEntries.get(walletId) ?? {},
      txDepth: map,
    });
  } catch {
    /* ignore */
  }
  notifyFusionDepthChanged(walletId);
}

/**
 * Depth for an outpoint:
 *   1) exact outpoint entry
 *   2) per-parent-txid depth (survives Electrum index drift)
 *   3) parent is a recorded fusion CoinJoin → at least 1
 */
function depthOf(
  entries: DepthMap,
  txDepth: TxDepthMap,
  outpoint: string,
  fusionTxids?: ReadonlySet<string>
): number {
  const key = normalizeOutpoint(outpoint);
  if (entries[key]) return entries[key].d;
  const txid = txidOfOutpoint(key);
  if (typeof txDepth[txid] === 'number' && txDepth[txid] >= 1) {
    return txDepth[txid];
  }
  if (fusionTxids?.has(txid)) return 1;
  return 0;
}

function read(walletId: number): DepthMap {
  const cached = memEntries.get(walletId);
  if (cached) return cached;
  try {
    const fromLs = parseDepthMap(
      getLocalStorage()?.getItem(storageKeyFor(walletId)) ?? null
    );
    memEntries.set(walletId, fromLs);
    return fromLs;
  } catch {
    const empty: DepthMap = {};
    memEntries.set(walletId, empty);
    return empty;
  }
}

function write(walletId: number, entries: DepthMap): void {
  // Keep a live copy even when localStorage is flaky (multi-window Tauri).
  memEntries.set(walletId, entries);
  try {
    getLocalStorage()?.setItem(storageKeyFor(walletId), JSON.stringify(entries));
  } catch {
    /* memory still holds it this session */
  }
  try {
    // Receivers merge by max depth and ignore empty wipes.
    getDepthBc()?.postMessage({
      walletId,
      entries,
      txDepth: memTxDepth.get(walletId) ?? {},
    });
  } catch {
    /* ignore */
  }
  notifyFusionDepthChanged(walletId);
}

/**
 * Drop depth for coins a fresh wallet snapshot proves are gone.
 *
 * This is the ONLY bulk eviction, and it is evidence-based: `liveOutpoints` comes
 * from a reconciled snapshot, so anything missing has genuinely been spent and
 * can never come back. Call it after a refresh, never on a timer.
 *
 * A snapshot that is empty or unavailable must not be treated as "everything is
 * spent" — the caller passes what the chain reported, and an empty set is
 * rejected here rather than wiping the map.
 */
export function pruneSpentDepth(
  walletId: number,
  liveOutpoints: ReadonlySet<string>
): void {
  if (liveOutpoints.size === 0) return;
  const live = new Set(
    [...liveOutpoints].map((o) => normalizeOutpoint(o))
  );
  const entries = read(walletId);
  let changed = false;
  for (const outpoint of Object.keys(entries)) {
    if (!live.has(outpoint)) {
      delete entries[outpoint];
      changed = true;
    }
  }
  if (changed) write(walletId, entries);
}

/**
 * Rounds this coin has been through. Unknown coins are fresh (0).
 * Same rules for UI badges and Auto eligibility (server + P2P).
 */
export function coinDepth(walletId: number, outpoint: string): number {
  return depthOf(
    read(walletId),
    readTxDepth(walletId),
    outpoint,
    readFusionTxids(walletId)
  );
}

/** All recorded CashFusion CoinJoin txids for this wallet (P2P + server). */
export function listRecordedFusionTxids(walletId: number): string[] {
  return [...readFusionTxids(walletId)];
}

/**
 * Ensure history lists still show known fusion CoinJoins after Electrum refresh.
 * Shared by P2P and server — both stamp txids via completeFusionBroadcast.
 * Missing rows are re-attached at height 0 so they are not wiped by Sync.
 */
export function mergeRecordedFusionTxsIntoHistory<
  T extends { tx_hash: string; height: number; timestamp?: string },
>(walletId: number, transactions: readonly T[]): T[] {
  const known = readFusionTxids(walletId);
  if (known.size === 0) return [...transactions];
  const have = new Set(
    transactions.map((tx) => String(tx.tx_hash).trim().toLowerCase())
  );
  const missing = [...known]
    .filter((txid) => !have.has(txid))
    .map(
      (tx_hash) =>
        ({
          tx_hash,
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
  return {
    coinDepth: read(walletId),
    fusionTxids: [...readFusionTxids(walletId)],
  };
}

/**
 * Merge imported fusion state into this wallet (COLD import).
 * Depth: keep the max of local vs imported per outpoint (never lower privacy claim wrongly).
 * Txids: union.
 */
export function importFusionDepthState(
  walletId: number,
  state: {
    coinDepth?: Record<string, { d?: number; at?: number } | number>;
    fusionTxids?: string[];
  }
): { coins: number; txids: number } {
  const entries = read(walletId);
  let coins = 0;
  const incoming = state.coinDepth ?? {};
  for (const [outpoint, raw] of Object.entries(incoming)) {
    if (!outpoint.includes(':')) continue;
    const key = normalizeOutpoint(outpoint);
    let d = 0;
    let at = Date.now();
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      d = Math.max(0, Math.trunc(raw));
    } else if (raw && typeof raw === 'object') {
      d =
        typeof raw.d === 'number' && Number.isFinite(raw.d)
          ? Math.max(0, Math.trunc(raw.d))
          : 0;
      at =
        typeof raw.at === 'number' && Number.isFinite(raw.at)
          ? raw.at
          : Date.now();
    } else {
      continue;
    }
    const prev = entries[key]?.d ?? 0;
    if (d >= prev) {
      entries[key] = { d, at };
      coins += 1;
    }
  }
  write(walletId, entries);

  const txids = readFusionTxids(walletId);
  let addedTx = 0;
  for (const t of state.fusionTxids ?? []) {
    const n = t.trim().toLowerCase();
    if (n.length !== 64) continue;
    if (!txids.has(n)) {
      txids.add(n);
      addedTx += 1;
    }
  }
  writeFusionTxids(walletId, txids);
  return { coins, txids: addedTx };
}

/**
 * Fusion *labels* (Home / history "Fused") are durable SQL first.
 * localStorage + memory are a sync cache so isFusionTransaction stays sync.
 * Coin *depth* (×N) can still be memory/LS — that is Auto's stopping score.
 */
const memFusionTxids = new Map<number, Set<string>>();
const sqlHydratedWallets = new Set<number>();

function readFusionTxidsFromLocalStorage(walletId: number): Set<string> {
  try {
    const raw = getLocalStorage()?.getItem(`${TXID_PREFIX}${walletId}`);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed
        .filter((t): t is string => typeof t === 'string' && t.length === 64)
        .map((t) => t.toLowerCase())
    );
  } catch {
    return new Set();
  }
}

function readFusionTxidsFromSqlSync(walletId: number): Set<string> {
  try {
    // Dynamic require avoided — DatabaseService is ES module. Sync path only
    // works when the DB is already open; hydrateFusionLabels loads async.
    const g = globalThis as unknown as {
      __optnFusionTxidSql?: Map<number, Set<string>>;
    };
    return new Set(g.__optnFusionTxidSql?.get(walletId) ?? []);
  } catch {
    return new Set();
  }
}

function cacheSqlFusionTxids(walletId: number, txids: Set<string>): void {
  const g = globalThis as unknown as {
    __optnFusionTxidSql?: Map<number, Set<string>>;
  };
  if (!g.__optnFusionTxidSql) g.__optnFusionTxidSql = new Map();
  g.__optnFusionTxidSql.set(walletId, new Set(txids));
}

function readFusionTxids(walletId: number): Set<string> {
  const cached = memFusionTxids.get(walletId);
  if (cached) return cached;

  // Union: SQL hydrate cache + localStorage (legacy) so labels never regress.
  const fromSql = readFusionTxidsFromSqlSync(walletId);
  const fromLs = readFusionTxidsFromLocalStorage(walletId);
  const merged = new Set<string>([...fromSql, ...fromLs]);
  memFusionTxids.set(walletId, merged);
  return merged;
}

function writeFusionTxids(walletId: number, txids: Set<string>): void {
  const normalized = new Set(
    [...txids]
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length === 64)
  );
  memFusionTxids.set(walletId, normalized);
  cacheSqlFusionTxids(walletId, normalized);

  // Fast cache (multi-window) — best effort only.
  try {
    getLocalStorage()?.setItem(
      `${TXID_PREFIX}${walletId}`,
      JSON.stringify([...normalized])
    );
  } catch {
    /* ignore */
  }

  // Durable: wallet SQL. Labels must survive reload / LS wipe.
  void persistFusionTxidsToSql(walletId, normalized).catch(() => undefined);

  notifyFusionDepthChanged(walletId);
}

async function persistFusionTxidsToSql(
  walletId: number,
  txids: Set<string>
): Promise<void> {
  if (!Number.isSafeInteger(walletId) || walletId <= 0) return;
  const { ensureDesktopLedgerTables } = await import('./desktopSchema');
  await ensureDesktopLedgerTables();
  const DatabaseService = (await import('../../apis/DatabaseManager/DatabaseService'))
    .default;
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
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
 * Load durable Fused labels from wallet SQL into the sync cache.
 * Call on wallet open / Auto start / before showing history.
 */
export async function hydrateFusionLabels(walletId: number): Promise<number> {
  if (!Number.isSafeInteger(walletId) || walletId <= 0) return 0;
  try {
    const { ensureDesktopLedgerTables } = await import('./desktopSchema');
    await ensureDesktopLedgerTables();
    const DatabaseService = (
      await import('../../apis/DatabaseManager/DatabaseService')
    ).default;
    const dbService = DatabaseService();
    await dbService.ensureDatabaseStarted();
    const db = dbService.getDatabase();
    if (!db) return 0;

    const fromSql = new Set<string>();
    const q = db.prepare(
      `SELECT txid FROM fusion_txids WHERE wallet_id = ?`
    );
    q.bind([walletId]);
    while (q.step()) {
      const row = q.getAsObject() as { txid?: string };
      if (typeof row.txid === 'string' && row.txid.length === 64) {
        fromSql.add(row.txid.toLowerCase());
      }
    }
    q.free();

    const fromLs = readFusionTxidsFromLocalStorage(walletId);
    const merged = new Set<string>([...fromSql, ...fromLs]);
    // If LS had extras SQL was missing (legacy), write them through.
    if (fromLs.size > fromSql.size || [...fromLs].some((t) => !fromSql.has(t))) {
      await persistFusionTxidsToSql(walletId, merged);
    }

    memFusionTxids.set(walletId, merged);
    cacheSqlFusionTxids(walletId, merged);
    sqlHydratedWallets.add(walletId);

    // Keep LS cache in sync for multi-window.
    try {
      getLocalStorage()?.setItem(
        `${TXID_PREFIX}${walletId}`,
        JSON.stringify([...merged])
      );
    } catch {
      /* ignore */
    }

    if (merged.size > 0) notifyFusionDepthChanged(walletId);
    return merged.size;
  } catch {
    return 0;
  }
}

/**
 * One-shot restore from AppData `fusion-txid-recovery.json` (built from fuse
 * logs) plus any legacy localStorage keys. Safe to call repeatedly.
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
      const set = readFusionTxids(walletId);
      let added = 0;
      for (const item of list) {
        if (typeof item !== 'string') continue;
        const t = item.trim().toLowerCase();
        if (t.length !== 64) continue;
        if (!set.has(t)) {
          set.add(t);
          added += 1;
        }
      }
      if (added > 0 || set.size > 0) {
        writeFusionTxids(walletId, set);
        // Floor tx-depth so coin badges show Fused (≥1) for those parents.
        const td = readTxDepth(walletId);
        let tdChanged = false;
        for (const t of set) {
          if ((td[t] ?? 0) < 1) {
            td[t] = 1;
            tdChanged = true;
          }
        }
        if (tdChanged) writeTxDepth(walletId, td);
        wallets += 1;
        txids += added > 0 ? added : 0;
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
  const normalized = txid.trim().toLowerCase();
  if (!normalized || normalized.length !== 64) return false;
  if (readFusionTxids(walletId).has(normalized)) return true;
  // Also true if any live depth entry was created by this tx (unspent outputs).
  const prefix = `${normalized}:`;
  if (Object.keys(read(walletId)).some((outpoint) => outpoint.startsWith(prefix))) {
    return true;
  }
  // Per-txid depth map (server path often re-binds by Electrum outpoints only).
  const td = readTxDepth(walletId)[normalized];
  return typeof td === 'number' && td >= 1;
}

/**
 * Remember a CoinJoin txid for history/home "Fused" badges.
 * Durable in wallet SQL; LS/memory are only a sync cache.
 */
export function recordFusionTxid(walletId: number, txid: string): void {
  const normalized = txid.trim().toLowerCase();
  if (normalized.length !== 64) return;
  const set = readFusionTxids(walletId);
  set.add(normalized);
  writeFusionTxids(walletId, set);
  // Floor parent depth so Auto + badges see ≥1 even before outpoints re-bind.
  const td = readTxDepth(walletId);
  if ((td[normalized] ?? 0) < 1) {
    td[normalized] = 1;
    writeTxDepth(walletId, td);
  }
}

/**
 * Record the result of one completed fusion: the coins it spent are gone, and
 * the coins it created are one round deeper than the SHALLOWEST coin consumed.
 *
 * MIN, not max — this mirrors Electron Cash's recursive predicate, which calls a
 * coin fused to depth N only when EVERY wallet-owned ancestor reaches N-1
 * (`is_fuz_coin(..., require_depth)` walks the ancestry and fails if any input
 * falls short).
 *
 * The reason is that depth is a privacy claim, not a fee budget. A round mixing
 * a thrice-fused coin with a freshly received one produces outputs whose real
 * anonymity set is bounded by that fresh coin's history, so calling them
 * "depth 4" would overstate the mixing actually achieved — and a user reading
 * that number would believe they are better hidden than they are. Taking the
 * minimum keeps the claim conservative: it can understate privacy, never
 * overstate it.
 *
 * The cost is that a wallet which keeps receiving new coins keeps fusing, since
 * fresh ancestry legitimately drags depth back down. That is intended behaviour
 * (new money genuinely needs mixing); the spending it implies is bounded by the
 * engine's cooldown and by `fuseDepth` itself, not by this function.
 */
export function recordFusionRound(
  walletId: number,
  spentOutpoints: string[],
  createdOutpoints: string[]
): void {
  const entries = read(walletId);
  const txDepth = readTxDepth(walletId);
  const fusionTxids = readFusionTxids(walletId);
  const spent = spentOutpoints.map(normalizeOutpoint);
  const created = createdOutpoints.map(normalizeOutpoint);
  // Unknown ancestor is depth 0 (drags min down). Use full depthOf including
  // fusion-txid stamps — server path used to ignore those and always inherit 0
  // → every round looked like depth 1 and Auto never stopped at fuseDepth.
  const inheritedDepth =
    spent.length === 0
      ? 0
      : spent.reduce(
          (shallowest, outpoint) =>
            Math.min(
              shallowest,
              depthOf(entries, txDepth, outpoint, fusionTxids)
            ),
          Number.POSITIVE_INFINITY
        );
  const nextDepth =
    inheritedDepth === Number.POSITIVE_INFINITY ? 1 : inheritedDepth + 1;
  spent.forEach((outpoint) => delete entries[outpoint]);
  const now = Date.now();
  created.forEach((outpoint) => {
    entries[outpoint] = { d: nextDepth, at: now };
    const txid = txidOfOutpoint(outpoint);
    if (txid.length === 64) {
      txDepth[txid] = Math.max(txDepth[txid] ?? 0, nextDepth);
      fusionTxids.add(txid);
    }
  });
  write(walletId, entries);
  writeTxDepth(walletId, txDepth);
  writeFusionTxids(walletId, fusionTxids);
}

/** Coins the engine may still fuse, i.e. those below the configured depth. */
export function coinsBelowDepth<T extends { tx_hash: string; tx_pos: number }>(
  walletId: number,
  utxos: T[],
  maxDepth: number
): T[] {
  // Use full coinDepth (outpoint + parent txid + fusion-txid set) so server
  // Auto stops at rounds-per-coin the same way P2P does — not a weaker depthOf.
  return utxos.filter(
    (utxo) =>
      coinDepth(walletId, outpointFromParts(utxo.tx_hash, utxo.tx_pos)) <
      maxDepth
  );
}

/**
 * Clear Auto status when every coin already meets the box (rounds-per-coin).
 * Target is always `fuseDepth` from settings — never a hard-coded 3.
 * Shows live coin depth range so the user sees current depths (e.g. 2–4).
 * Same wording for P2P and server (shared startFusionRound).
 */
export function formatAutoDepthMetMessage(elig: {
  total: number;
  minDepth: number;
  maxCoinDepth: number;
  maxDepth: number;
}): string {
  if (elig.total === 0) {
    return 'Auto: no BCH coins to fuse (wallet empty of non-token UTXOs).';
  }
  const range =
    elig.minDepth === elig.maxCoinDepth
      ? `${elig.minDepth}`
      : `${elig.minDepth}–${elig.maxCoinDepth}`;
  return (
    `Auto: all ${elig.total} coin(s) already at rounds-per-coin depth ` +
    `(target = number in the box). Current coin depth ${range}. ` +
    `Idle until send/receive/tx or you raise rounds-per-coin to fuse further.`
  );
}

/** One-line progress / log while Auto still has coins below the box. */
export function formatAutoDepthGateLog(
  eligibleCount: number,
  target: number,
  minDepth: number,
  maxCoinDepth: number
): string {
  const range =
    minDepth === maxCoinDepth ? `${minDepth}` : `${minDepth}–${maxCoinDepth}`;
  return (
    `${eligibleCount} eligible below rounds-per-coin ` +
    `(target = box ${target}; current depth ${range})`
  );
}

/** Snapshot for Auto UI: empty eligible is often "goal met", not an error. */
export function fuseDepthEligibility(
  walletId: number,
  utxos: ReadonlyArray<{ tx_hash: string; tx_pos: number }>,
  maxDepth: number
): {
  total: number;
  eligible: number;
  atOrAboveDepth: number;
  maxDepth: number;
  /** Min/max depth among wallet coins (for logs / UI). */
  minDepth: number;
  maxCoinDepth: number;
} {
  let eligible = 0;
  let atOrAboveDepth = 0;
  let minDepth = Number.POSITIVE_INFINITY;
  let maxCoinDepth = 0;
  for (const utxo of utxos) {
    const d = coinDepth(
      walletId,
      outpointFromParts(utxo.tx_hash, utxo.tx_pos)
    );
    minDepth = Math.min(minDepth, d);
    maxCoinDepth = Math.max(maxCoinDepth, d);
    if (d < maxDepth) eligible += 1;
    else atOrAboveDepth += 1;
  }
  if (utxos.length === 0) {
    minDepth = 0;
  } else if (minDepth === Number.POSITIVE_INFINITY) {
    minDepth = 0;
  }
  return {
    total: utxos.length,
    eligible,
    atOrAboveDepth,
    maxDepth,
    minDepth,
    maxCoinDepth,
  };
}

/** Test/support hook: forget every recorded depth for a wallet. */
export function clearFusionDepth(walletId: number): void {
  memEntries.delete(walletId);
  memTxDepth.delete(walletId);
  memFusionTxids.delete(walletId);
  sqlHydratedWallets.delete(walletId);
  cacheSqlFusionTxids(walletId, new Set());
  try {
    getLocalStorage()?.removeItem(storageKeyFor(walletId));
    getLocalStorage()?.removeItem(`${TXID_PREFIX}${walletId}`);
    getLocalStorage()?.removeItem(txDepthKeyFor(walletId));
  } catch {
    /* nothing to clear */
  }
  void (async () => {
    try {
      const { ensureDesktopLedgerTables } = await import('./desktopSchema');
      await ensureDesktopLedgerTables();
      const DatabaseService = (
        await import('../../apis/DatabaseManager/DatabaseService')
      ).default;
      const dbService = DatabaseService();
      await dbService.ensureDatabaseStarted();
      const db = dbService.getDatabase();
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
