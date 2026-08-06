/**
 * Multi-Fulcrum reliability layer for OPTN's Electrum connection.
 *
 * Cascan-style goals without replacing the socket stack:
 *   - score hosts by latency + recent success/failure
 *   - prefer healthy hosts on connect / failover
 *   - keep blocked (cooldown) hosts at the back
 *
 * Still one active WebSocket at a time; ranking only chooses *which* Fulcrum
 * we connect to next. Quorum multi-read can build on this later.
 */

export type ServerHealth = {
  /** Higher is better. */
  score: number;
  /** Exponential moving average of successful request/connect latency (ms). */
  latencyEmaMs: number;
  successes: number;
  failures: number;
  lastOkAt: number;
  lastFailAt: number;
};

const LATENCY_EMA_ALPHA = 0.35;
const FAIL_PENALTY = 40;
const SUCCESS_BONUS = 8;
/** Recent success stickiness window (prefer the host we just used). */
const FRESH_OK_BONUS_MS = 5 * 60_000;
const FRESH_OK_BONUS = 40;
/** Cap latency samples so a multi-call batch wall-clock cannot poison ranking. */
const LATENCY_SAMPLE_CAP_MS = 2_000;
/**
 * Latency tax only trims the success bonus — a successful RPC must never
 * lower score. Without this, open-time listunspent batches (often 1–3s for
 * 50 addresses) recorded as "latency" and made the working Fulcrum look
 * worse than never-tried hosts → slower failover / reconnect thrash.
 */
const LATENCY_TAX_START_MS = 80;
const LATENCY_TAX_PER_MS = 1 / 40; // +1 tax per 40ms above start, max SUCCESS_BONUS-1
const SCORE_FLOOR = -200;
const SCORE_CEIL = 200;

const healthByHost = new Map<string, ServerHealth>();

function emptyHealth(): ServerHealth {
  return {
    score: 0,
    latencyEmaMs: 0,
    successes: 0,
    failures: 0,
    lastOkAt: 0,
    lastFailAt: 0,
  };
}

function clampScore(score: number): number {
  return Math.max(SCORE_FLOOR, Math.min(SCORE_CEIL, score));
}

function hostKey(server: string): string {
  return server.trim().toLowerCase();
}

export function getServerHealth(server: string): ServerHealth {
  return { ...(healthByHost.get(hostKey(server)) ?? emptyHealth()) };
}

export function getAllServerHealth(): Record<string, ServerHealth> {
  const out: Record<string, ServerHealth> = {};
  for (const [k, v] of healthByHost.entries()) {
    out[k] = { ...v };
  }
  return out;
}

/** Test/support: wipe scores. */
export function resetFulcrumReliability(): void {
  healthByHost.clear();
}

export function recordServerSuccess(
  server: string | null | undefined,
  latencyMs = 0,
  nowMs = Date.now()
): void {
  if (!server) return;
  const key = hostKey(server);
  const prev = healthByHost.get(key) ?? emptyHealth();
  // Callers should pass per-call average for batches; still cap samples so a
  // single slow open cannot erase a good host.
  const sample = Math.min(LATENCY_SAMPLE_CAP_MS, Math.max(0, latencyMs));
  const latencyEmaMs =
    prev.successes === 0
      ? sample
      : prev.latencyEmaMs * (1 - LATENCY_EMA_ALPHA) + sample * LATENCY_EMA_ALPHA;
  const over = Math.max(0, latencyEmaMs - LATENCY_TAX_START_MS);
  const latencyTax = Math.min(
    SUCCESS_BONUS - 1,
    Math.floor(over * LATENCY_TAX_PER_MS)
  );
  // Success always nets positive (at least +1).
  const delta = Math.max(1, SUCCESS_BONUS - latencyTax);
  const next: ServerHealth = {
    score: clampScore(prev.score + delta),
    latencyEmaMs,
    successes: prev.successes + 1,
    failures: prev.failures,
    lastOkAt: nowMs,
    lastFailAt: prev.lastFailAt,
  };
  healthByHost.set(key, next);
}

export function recordServerFailure(
  server: string | null | undefined,
  nowMs = Date.now()
): void {
  if (!server) return;
  const key = hostKey(server);
  const prev = healthByHost.get(key) ?? emptyHealth();
  healthByHost.set(key, {
    ...prev,
    score: clampScore(prev.score - FAIL_PENALTY),
    failures: prev.failures + 1,
    lastFailAt: nowMs,
  });
}

function effectiveScore(
  server: string,
  nowMs: number,
  isBlocked: (s: string) => boolean,
  preferred?: string | null
): number {
  if (isBlocked(server)) return SCORE_FLOOR - 1000;
  const h = healthByHost.get(hostKey(server)) ?? emptyHealth();
  let score = h.score;
  // Stick to a host that worked recently (open scan should not hop hosts).
  if (h.lastOkAt > 0 && nowMs - h.lastOkAt < FRESH_OK_BONUS_MS) {
    score += FRESH_OK_BONUS;
  }
  // Explicit last-healthy / sticky preference (storage or current socket).
  if (preferred && hostKey(preferred) === hostKey(server)) {
    score += 80;
  }
  // Prefer never-tried over known-bad when scores equal.
  if (h.successes === 0 && h.failures === 0) score += 5;
  // Mild preference for lower EMA among proven hosts.
  if (h.successes > 0 && h.latencyEmaMs > 0) {
    score -= Math.min(10, Math.floor(h.latencyEmaMs / 100));
  }
  return score;
}

/**
 * Order servers for connect/failover: healthy first, blocked last.
 * Stable among equal scores (preserves input relative order).
 */
export function rankServersForConnect(
  servers: readonly string[],
  options: {
    isBlocked?: (server: string) => boolean;
    nowMs?: number;
    /** Sticky host (last healthy / current) — strongly preferred if not blocked. */
    preferred?: string | null;
  } = {}
): string[] {
  if (servers.length <= 1) return [...servers];
  const isBlocked = options.isBlocked ?? (() => false);
  const nowMs = options.nowMs ?? Date.now();
  const preferred = options.preferred ?? null;
  return servers
    .map((server, index) => ({
      server,
      index,
      score: effectiveScore(server, nowMs, isBlocked, preferred),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((row) => row.server);
}
