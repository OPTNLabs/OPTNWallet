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

function read(walletId: number): DepthMap {
  try {
    const raw = getLocalStorage()?.getItem(storageKeyFor(walletId));
    if (!raw) return {};
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
        // If both casings existed, keep the higher depth claim.
        if (Math.trunc(d) >= prev) {
          out[norm] = { d: Math.trunc(d), at };
        }
      }
    }
    return out;
  } catch {
    // Unreadable storage must not stop fusion — it degrades to "everything is
    // depth 0", i.e. coins get fused again. Wasteful, never unsafe.
    return {};
  }
}

function write(walletId: number, entries: DepthMap): void {
  // Written verbatim. Dropping an entry here would silently reset a live coin's
  // depth to 0 and buy it another paid round.
  try {
    getLocalStorage()?.setItem(storageKeyFor(walletId), JSON.stringify(entries));
  } catch {
    /* storage unavailable — depth simply is not remembered */
  }
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

/** Rounds this coin has been through. Unknown coins are fresh (0). */
export function coinDepth(walletId: number, outpoint: string): number {
  return read(walletId)[normalizeOutpoint(outpoint)]?.d ?? 0;
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

function readFusionTxids(walletId: number): Set<string> {
  try {
    const raw = getLocalStorage()?.getItem(`${TXID_PREFIX}${walletId}`);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed.filter((t): t is string => typeof t === 'string' && t.length === 64)
    );
  } catch {
    return new Set();
  }
}

function writeFusionTxids(walletId: number, txids: Set<string>): void {
  try {
    getLocalStorage()?.setItem(
      `${TXID_PREFIX}${walletId}`,
      JSON.stringify([...txids])
    );
  } catch {
    /* ignore */
  }
}

/** True if this wallet recorded `txid` as a completed CashFusion CoinJoin. */
export function isFusionTransaction(walletId: number, txid: string): boolean {
  const normalized = txid.trim().toLowerCase();
  if (!normalized) return false;
  if (readFusionTxids(walletId).has(normalized)) return true;
  // Also true if any live depth entry was created by this tx (unspent outputs).
  const prefix = `${normalized}:`;
  return Object.keys(read(walletId)).some((outpoint) =>
    outpoint.startsWith(prefix)
  );
}

/** Remember a CoinJoin txid for history/home badges (wallet-local only). */
export function recordFusionTxid(walletId: number, txid: string): void {
  const normalized = txid.trim().toLowerCase();
  if (normalized.length !== 64) return;
  const set = readFusionTxids(walletId);
  set.add(normalized);
  writeFusionTxids(walletId, set);
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
  const spent = spentOutpoints.map(normalizeOutpoint);
  const created = createdOutpoints.map(normalizeOutpoint);
  // An unknown ancestor is depth 0 and correctly drags the minimum down. With no
  // recorded inputs at all there is no ancestry to inherit, so the floor is 0.
  const inheritedDepth =
    spent.length === 0
      ? 0
      : spent.reduce(
          (shallowest, outpoint) =>
            Math.min(shallowest, entries[outpoint]?.d ?? 0),
          Number.POSITIVE_INFINITY
        );
  spent.forEach((outpoint) => delete entries[outpoint]);
  const now = Date.now();
  created.forEach((outpoint) => {
    entries[outpoint] = { d: inheritedDepth + 1, at: now };
  });
  write(walletId, entries);
}

/** Coins the engine may still fuse, i.e. those below the configured depth. */
export function coinsBelowDepth<T extends { tx_hash: string; tx_pos: number }>(
  walletId: number,
  utxos: T[],
  maxDepth: number
): T[] {
  const entries = read(walletId);
  return utxos.filter(
    (utxo) =>
      (entries[outpointFromParts(utxo.tx_hash, utxo.tx_pos)]?.d ?? 0) < maxDepth
  );
}

/** Test/support hook: forget every recorded depth for a wallet. */
export function clearFusionDepth(walletId: number): void {
  try {
    getLocalStorage()?.removeItem(storageKeyFor(walletId));
    getLocalStorage()?.removeItem(`${TXID_PREFIX}${walletId}`);
  } catch {
    /* nothing to clear */
  }
}
