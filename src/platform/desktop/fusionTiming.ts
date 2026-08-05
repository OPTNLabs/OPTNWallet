// CashFusion timing — single source of truth shared by server (native) and P2P.
//
// Server numbers are Electron Cash `protocol.py` as implemented in
// `src-tauri/src/fusion/run.rs` (FusionTiming / T_* / JOIN_WAIT). P2P must not
// invent longer overall budgets than server fusion.
//
// Server phase model (relative to StartRound / covert_T0 unless noted):
//   T_START_COMPS  =  5s   begin component submit
//   T_END_COMPS    = 15s   component window closes
//   T_START_SIGS   = 20s   begin signature submit
//   T_END_SIGS     = 30s   signature window closes
//   T_EXPECTING_CONCLUSION = 35s
//   T_START_CLOSE  = 45s   normal round close
//   T_START_CLOSE_BLAME = 80s  blame-path close
//   JOIN_WAIT      = 120s  pool wait for tier (pre-round)
//   warmup         ≈ 30s + 3s slop between FusionBegin and StartRound
//
// Live multi-wallet evidence (2026-08-06, 4 wallets, optn-wallet.log):
//   • 4-way discovery: ~4–8s after first announce
//   • Min-gather 30s wasted ~15–20s after set was already stable at 4
//   • Agree + credentials + onion + assemble+sign: ~11s (02:09:04→:15)
//   • Die point: AFTER phase 6 — waiting on peer signatures / final (Tor)
//     with NO status text, then auto-restart from zero
//
// Efficient allocation (≤ server envelope): spend less on gather once full set
// is stable; keep round body ≤ T_START_CLOSE_BLAME; re-send critical gift-wraps
// often so the post-sign window is used for recovery, not silence.

/** protocol.py JOIN_WAIT — how long the server holds a client in the pool. */
export const SERVER_JOIN_WAIT_MS = 120_000;
/** protocol.py T_END_COMPS — components must be in by now. */
export const SERVER_COMPS_END_MS = 15_000;
/** protocol.py T_END_SIGS. */
export const SERVER_SIGS_END_MS = 30_000;
/** protocol.py T_EXPECTING_CONCLUSION. */
export const SERVER_CONCLUSION_MS = 35_000;
/** protocol.py T_START_CLOSE — normal active-round ceiling after StartRound. */
export const SERVER_ROUND_CLOSE_MS = 45_000;
/** protocol.py T_START_CLOSE_BLAME — absolute active-round ceiling. */
export const SERVER_ROUND_BLAME_MS = 80_000;
/** FusionBegin → StartRound warmup + slop (run.rs FusionTiming defaults). */
export const SERVER_WARMUP_MS = 33_000;
/** protocol.py covert submit window. */
export const SERVER_COVERT_SUBMIT_MS = 5_000;

/**
 * Hard ceiling for one full server-style session (join + warmup + close).
 * P2P click-to-done should stay at or under this.
 */
export const SERVER_SESSION_CEILING_MS =
  SERVER_JOIN_WAIT_MS + SERVER_WARMUP_MS + SERVER_ROUND_CLOSE_MS; // ~198s

// ─── P2P budgets (≤ server), phase-allocated from live data ───────────

/**
 * Pool discover max — same as server JOIN_WAIT.
 * Live: 4 wallets converged in &lt;10s; we still allow full JOIN_WAIT for Tor lag.
 */
export const P2P_GATHER_MAX_MS = SERVER_JOIN_WAIT_MS;

/**
 * Min gather before locking a full stable set.
 * Was 30s — live already had strict=4 by ~t+4s; 15s matches T_END_COMPS and
 * still absorbs Tor skew without burning half the session on countdown.
 */
export const P2P_GATHER_MIN_MS = SERVER_COMPS_END_MS;

/**
 * Extra hold for a stable 3-set so a 4th can join (under JOIN_WAIT).
 * Pairs only lock at maxWait or after peak-grace abandonment.
 */
export const P2P_SMALL_SET_HOLD_MS = 45_000;

/**
 * Unchanged membership before lock.
 * Was 12s; 6s is enough once min-gather passed (live set was stable for 20s+).
 */
export const P2P_PEER_SET_STABLE_MS = 6_000;

/**
 * After live set drops below peak, wait this long then accept reduced set.
 * Matches T_END_COMPS — not a full sig window.
 */
export const P2P_PEAK_GRACE_MS = SERVER_COMPS_END_MS;

/**
 * Rendezvous (propose/ACK/start) — full proposed set only (no 2-of-4 shrink).
 * Live: partial ACK started a 2-party fuse and stranded others. Use the full
 * T_START_CLOSE window so slow Tor ACKs can still join the FULL set; fail
 * cleanly if anyone is missing rather than fusing a subset.
 */
export const P2P_RENDEZVOUS_MS = SERVER_ROUND_CLOSE_MS;
export const P2P_PROPOSAL_TIMEOUT_MS = 12_000;

/**
 * Active round body after agreement (credentials → onion → sign → broadcast).
 * Hard cap = server blame close. Internal sub-windows below must sum sensibly
 * inside this (not each maxed independently).
 *
 *   credentials  ≤ 15s   (P2P_CREDENTIAL_WAIT_MS)
 *   onion/outputs ≤ 25s  (P2P_MISSING_OUTPUTS_ONION_MS) — live finished ~10s
 *   sig collect   ≤ 25s  (re-sends every P2P_SIG_RESEND_MS)
 *   finalize+bc   ≤ 15s
 *   ─────────────────
 *   sum            80s   = T_START_CLOSE_BLAME
 */
export const P2P_ROUND_TIMEOUT_MS = SERVER_ROUND_BLAME_MS;

/** Wait for coordinator credential_params (live: immediate). */
export const P2P_CREDENTIAL_WAIT_MS = SERVER_COMPS_END_MS;

/**
 * After all peers mark ready, how long coord waits for output pool.
 * Live onion path filled in ~10s; 25s leaves Tor headroom under 80s body.
 */
/** After all peers ready, wait for onion reveal batch. */
export const P2P_MISSING_OUTPUTS_ONION_MS = 25_000;

/**
 * Per-component inject jitter. Covert submit window is 5s — keep N×M blobs
 * inside that scale so onion inject does not steal the post-sign budget.
 */
export const P2P_COMPONENT_JITTER_MS: [number, number] = [30, 250];

/** Re-send onion_declare (under comps window). */
export const P2P_ONION_DECLARE_RESEND_MS = 1_500;

/**
 * Re-send assembled / signatures while waiting for the other side.
 * Live failure mode: one-shot gift-wrap drop after phase 6. Faster than
 * server covert submit cadence (5s) so several retries fit in a 25s sig window.
 */
export const P2P_ASSEMBLED_RESEND_MS = 1_500;
export const P2P_SIG_RESEND_MS = 1_500;
/** How often coord publishes "Waiting for signatures N/M" status. */
export const P2P_SIG_STATUS_MS = 3_000;

/**
 * Durable lease backstop: session ceiling + small margin.
 */
export const P2P_LEASE_TTL_MS = SERVER_SESSION_CEILING_MS + 30_000; // ~228s
