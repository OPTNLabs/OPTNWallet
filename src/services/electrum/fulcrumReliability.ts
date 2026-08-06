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
const FRESH_OK_BONUS_MS = 60_000;
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
  const sample = Math.max(0, latencyMs);
  const latencyEmaMs =
    prev.successes === 0
      ? sample
      : prev.latencyEmaMs * (1 - LATENCY_EMA_ALPHA) + sample * LATENCY_EMA_ALPHA;
  // Prefer low latency: subtract a small fraction of EMA from score.
  const latencyTax = Math.min(30, Math.floor(latencyEmaMs / 50));
  const next: ServerHealth = {
    score: clampScore(prev.score + SUCCESS_BONUS - latencyTax),
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
  isBlocked: (s: string) => boolean
): number {
  if (isBlocked(server)) return SCORE_FLOOR - 1000;
  const h = healthByHost.get(hostKey(server)) ?? emptyHealth();
  let score = h.score;
  // Slight boost if we succeeded recently (session stickiness for healthy host).
  if (h.lastOkAt > 0 && nowMs - h.lastOkAt < FRESH_OK_BONUS_MS) {
    score += 15;
  }
  // Prefer never-tried over known-bad when scores equal.
  if (h.successes === 0 && h.failures === 0) score += 5;
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
  } = {}
): string[] {
  if (servers.length <= 1) return [...servers];
  const isBlocked = options.isBlocked ?? (() => false);
  const nowMs = options.nowMs ?? Date.now();
  return servers
    .map((server, index) => ({
      server,
      index,
      score: effectiveScore(server, nowMs, isBlocked),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((row) => row.server);
}
