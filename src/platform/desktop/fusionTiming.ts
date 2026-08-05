// CashFusion timing — single source of truth shared by server (native) and P2P.
//
// Server numbers are Electron Cash `protocol.py` as implemented in
// `src-tauri/src/fusion/run.rs` (FusionTiming / T_* / JOIN_WAIT). P2P must not
// invent longer overall budgets: a slower path than server fusion is a product
// hit (user: "not exceed server based cashfusion overall timing per round").
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
// Overall server session ceiling (join + warmup + close):
//   120 + 33 + 45 ≈ 198s normal; blame path ≈ 233s.
// P2P budgets below stay inside that envelope.

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

/**
 * Hard ceiling for one full server-style session (join + warmup + close).
 * P2P click-to-done should stay at or under this.
 */
export const SERVER_SESSION_CEILING_MS =
  SERVER_JOIN_WAIT_MS + SERVER_WARMUP_MS + SERVER_ROUND_CLOSE_MS; // ~198s

// ─── P2P budgets (≤ server) ───────────────────────────────────────────

/** Pool discover — same as server JOIN_WAIT. */
export const P2P_GATHER_MAX_MS = SERVER_JOIN_WAIT_MS;
/** Min gather before locking a stable full set (under JOIN_WAIT). */
export const P2P_GATHER_MIN_MS = 30_000;
/** Hold 2–3 peer sets so a late Tor peer can still join (under JOIN_WAIT). */
export const P2P_SMALL_SET_HOLD_MS = 60_000;
/** Unchanged membership before lock. */
export const P2P_PEER_SET_STABLE_MS = 12_000;

/**
 * Rendezvous (propose/ACK/start). Capped by normal server close window so
 * agreement does not outlast a server round body.
 */
export const P2P_RENDEZVOUS_MS = SERVER_ROUND_CLOSE_MS;
export const P2P_PROPOSAL_TIMEOUT_MS = SERVER_COMPS_END_MS;

/**
 * Active round body after agreement (credentials → onion → sign → broadcast).
 * Uses the blame close ceiling — never longer than the server's worst honest
 * active round.
 */
export const P2P_ROUND_TIMEOUT_MS = SERVER_ROUND_BLAME_MS;

/** Wait for coordinator credential_params (≤ T_END_SIGS). */
export const P2P_CREDENTIAL_WAIT_MS = SERVER_SIGS_END_MS;

/**
 * After all peers mark ready, how long the coordinator waits for outputs.
 * Direct: comps window. Onion: full normal close window (multi-hop Tor must
 * still finish inside server T_START_CLOSE — not a longer custom budget).
 */
export const P2P_MISSING_OUTPUTS_DIRECT_MS = SERVER_COMPS_END_MS;
export const P2P_MISSING_OUTPUTS_ONION_MS = SERVER_ROUND_CLOSE_MS;

/**
 * Per-component send jitter. Server covert windows are 5s; keep P2P inject
 * inside that scale so N peers × M outputs still fit under T_END_COMPS / close.
 * (Previously 200–2000ms × many blobs blew past server budgets.)
 */
export const P2P_COMPONENT_JITTER_MS: [number, number] = [40, 400];

/** Re-send onion_declare cadence (well under comps window). */
export const P2P_ONION_DECLARE_RESEND_MS = 2_000;

/**
 * Durable lease backstop: gather + rendezvous + round, matching session ceiling
 * with a small reclaim margin (not a longer round).
 */
export const P2P_LEASE_TTL_MS = SERVER_SESSION_CEILING_MS + 30_000; // ~228s
