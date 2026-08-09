// CashFusion timing & EC policy constants — single source of truth.
//
// **Strict Electron Cash protocol** values come from:
//   electroncash_plugins/fusion/protocol.py  (Protocol class)
//   electroncash_plugins/fusion/plugin.py    (DEFAULT_MAX_COINS, AUTOFUSE_INACTIVE_TIMEOUT)
//   electroncash_plugins/fusion/conf.py      (defaults)
//
// Native round engine: `src-tauri/src/fusion/run.rs` (FusionTiming / T_*).
// P2P must not invent longer overall budgets than a full server session body.
//
// Server phase model (relative to StartRound / covert_T0 unless noted):
//   T_START_COMPS  =  5s   begin component submit
//   T_END_COMPS    = 15s   component window closes  (TS_EXPECTING_COVERT_COMPONENTS)
//   T_START_SIGS   = 20s   begin signature submit
//   T_END_SIGS     = 30s   signature window closes  (TS_EXPECTING_COVERT_SIGNATURES)
//   T_EXPECTING_CONCLUSION = 35s
//   T_START_CLOSE  = 45s   normal round close
//   T_START_CLOSE_BLAME = 80s  blame-path close
//   WARMUP_TIME    = 30s ± WARMUP_SLOP 3s  (FusionBegin → StartRound)
//   Auto pool wait (client):
//     • enter JoinPools immediately; the server coordinates participant timing
//     • stop after 600s only while no tier advertises time_remaining
//     • while a best time exists, keep waiting for that server schedule
//
// UNCONFIRMED INPUTS (OPTN + EC-maintainer-endorsed direction):
//   • Accept height ≤ 0 UTXOs as fusion inputs (selection + peer blame lookup).
//   • Do NOT wait for a block confirmation before the next Auto round — only a
//     short post-fuse cooldown so Electrum can list the new CoinJoin outputs.
//   • Classic EC still marks unconfirmed ineligible in select_coins; we do not
//     copy that wait. Maintainers will endorse fusing 0-conf on BCH.
//
// MAINNET vs CHIPNET (server Auto/manual):
//   • These protocol numbers apply on BOTH networks — same EC wire timing.
//   • Mainnet default coordinator is fusion.servo.cash:8789 (not loopback).
//   • Chipnet local 127.0.0.1:8787 + weakened server Params is TEST harness only
//     (run_fusion_server.py). Never reuse those server-side relaxations for
//     mainnet production.

// ─── protocol.py — critical timeline ─────────────────────────────────────

/** protocol.py T_START_COMPS */
export const SERVER_COMPS_START_MS = 5_000;
/** protocol.py TS_EXPECTING_COVERT_COMPONENTS / client T_END comps window */
export const SERVER_COMPS_END_MS = 15_000;
/** protocol.py T_START_SIGS */
export const SERVER_SIGS_START_MS = 20_000;
/** protocol.py TS_EXPECTING_COVERT_SIGNATURES */
export const SERVER_SIGS_END_MS = 30_000;
/** protocol.py T_EXPECTING_CONCLUSION */
export const SERVER_CONCLUSION_MS = 35_000;
/** protocol.py T_START_CLOSE */
export const SERVER_ROUND_CLOSE_MS = 45_000;
/** protocol.py T_START_CLOSE_BLAME */
export const SERVER_ROUND_BLAME_MS = 80_000;
/** protocol.py WARMUP_TIME */
export const SERVER_WARMUP_TIME_MS = 30_000;
/** protocol.py WARMUP_SLOP */
export const SERVER_WARMUP_SLOP_MS = 3_000;
/** WARMUP_TIME + SLOP — FusionBegin → StartRound client envelope */
export const SERVER_WARMUP_MS = SERVER_WARMUP_TIME_MS + SERVER_WARMUP_SLOP_MS;
/** protocol.py COVERT_CONNECT_WINDOW */
export const SERVER_COVERT_CONNECT_WINDOW_MS = 15_000;
/** protocol.py COVERT_CONNECT_TIMEOUT */
export const SERVER_COVERT_CONNECT_TIMEOUT_MS = 15_000;
/** protocol.py COVERT_SUBMIT_WINDOW */
export const SERVER_COVERT_SUBMIT_MS = 5_000;
/** protocol.py COVERT_SUBMIT_TIMEOUT */
export const SERVER_COVERT_SUBMIT_TIMEOUT_MS = 3_000;
/** protocol.py COVERT_CONNECT_SPARES */
export const SERVER_COVERT_CONNECT_SPARES = 6;
/** protocol.py MAX_CLOCK_DISCREPANCY */
export const SERVER_MAX_CLOCK_DISCREPANCY_MS = 5_000;
/** protocol.py STANDARD_TIMEOUT */
export const SERVER_STANDARD_TIMEOUT_MS = 3_000;
/** protocol.py BLAME_VERIFY_TIME */
export const SERVER_BLAME_VERIFY_MS = 5_000;
/** protocol.py MIN_OUTPUT */
export const SERVER_MIN_OUTPUT_SATS = 10_000;

// ─── plugin.py — client pool / coin policy ───────────────────────────────

/**
 * plugin.py AUTOFUSE_INACTIVE_TIMEOUT. The deadline is checked only when a
 * TierStatusUpdate has no advertised `time_remaining` (`besttime is None`).
 * A scheduled tier is therefore not cut off merely because 600 seconds have
 * elapsed since registration.
 */
export const SERVER_AUTOFUSE_INACTIVE_MS = 600_000;

/**
 * plugin.py DEFAULT_MAX_COINS = 20 — max inputs one wallet puts in a batch.
 * assert DEFAULT_MAX_COINS > 10 in EC.
 */
export const EC_DEFAULT_MAX_COINS = 20;

/** plugin.py MAX_LIMIT_FUSE_DEPTH = 10 */
export const EC_MAX_FUSE_DEPTH = 10;

/**
 * Accept unconfirmed UTXOs as fusion inputs (height ≤ 0).
 *
 * Policy (mainnet + chipnet): fuse 0-conf immediately — no “wait for a block”
 * before the next Auto round. EC-maintainer direction endorses this for BCH;
 * classic EC client still excludes unconfirmed in select_coins / validation.py,
 * which we intentionally do not copy. Selection + peer blame lookup both honor
 * this flag so rounds can chain on fresh CoinJoin outputs without confirmation.
 */
export const ACCEPT_UNCONFIRMED_FUSION_INPUTS = true;

/**
 * There is no block-wait between Auto rounds. The only post-success delay is
 * {@link AUTO_FUSION_COOLDOWN_MS} in fusionAutoEngine (Electrum listunspent lag),
 * not a confirmation depth requirement.
 */
export const AUTO_WAIT_FOR_BLOCK_BEFORE_NEXT_ROUND = false;

// ─── P2P budgets (independent of Auto 600s pool wait) ────────────────────

/**
 * P2P pool discover max when peers already seen.
 * Kept at 120s (historical live multi-window budget) — not the Auto 600s
 * inactive timeout, which would make P2P gathers unreasonably long.
 */
export const P2P_GATHER_MAX_MS = 120_000;

/**
 * Manual Start alone budget. User is watching; fail fast so they can retry.
 * Live multi-wallet discovery is normally &lt;15s when relays overlap.
 */
export const P2P_GATHER_ALONE_MS = 35_000;

/**
 * Auto-fuse alone budget for P2P — full P2P gather max so staggered windows meet.
 */
export const P2P_GATHER_ALONE_AUTO_MS = P2P_GATHER_MAX_MS;

/**
 * Min gather before locking a *partial* set (MIN ≤ n < MAX).
 * Full MAX set uses {@link P2P_GATHER_FAST_WARMUP_MS} instead.
 */
export const P2P_GATHER_MIN_MS = 10_000;

/**
 * Brief warm-up before locking a *full* MAX set (Tor skew + one re-announce).
 */
export const P2P_GATHER_FAST_WARMUP_MS = 5_000;

/**
 * Extra hold when we have MIN..MAX-1 so more peers can join.
 */
export const P2P_SMALL_SET_HOLD_MS = 20_000;

/**
 * Unchanged membership before lock (normal path).
 */
export const P2P_PEER_SET_STABLE_MS = 4_000;

/** Stability required when already at MAX_PARTICIPANTS (fast lock). */
export const P2P_PEER_SET_STABLE_FAST_MS = 2_500;

/**
 * After live set drops below peak, wait this long then accept reduced set.
 * Matches T_END_COMPS.
 */
export const P2P_PEAK_GRACE_MS = SERVER_COMPS_END_MS;

/**
 * Rendezvous (propose/ACK/start) — full proposed set only.
 */
export const P2P_RENDEZVOUS_MS = 60_000;
/**
 * Wait for elected coordinator's first proposal before ghost failover.
 */
export const P2P_PROPOSAL_TIMEOUT_MS = 20_000;
/** Re-send proposal / ACK while waiting. */
export const P2P_RENDEZVOUS_RESEND_MS = 1_200;

/**
 * Active round body after agreement — hard cap = server blame close.
 */
export const P2P_ROUND_TIMEOUT_MS = SERVER_ROUND_BLAME_MS;

/**
 * Wait for coordinator credential_params over Tor gift-wrap.
 */
export const P2P_CREDENTIAL_WAIT_MS = 35_000;
export const P2P_CREDENTIAL_PARAMS_RESEND_MS = 1_500;
export const P2P_CREDENTIAL_PARAMS_RESEND_MAX = 12;

/** Slightly longer than declare+output resend budget so Tor can recover (E1). */
export const P2P_MISSING_OUTPUTS_ONION_MS = 36_000;

export const P2P_COMPONENT_JITTER_MS: [number, number] = [30, 250];

export const P2P_ONION_DECLARE_RESEND_MS = 1_500;
export const P2P_ONION_OUTPUT_RESEND_MAX = 8;
export const P2P_ONION_OUTPUT_RESEND_MS = 2_000;
export const P2P_ONION_DECLARE_RESEND_MAX = 12;

export const P2P_ASSEMBLED_RESEND_MS = 1_500;
export const P2P_SIG_RESEND_MS = 1_500;
export const P2P_SIG_STATUS_MS = 3_000;

/** Existing durable P2P lease backstop (unchanged by server scheduling). */
export const P2P_LEASE_TTL_MS = 708_000;
