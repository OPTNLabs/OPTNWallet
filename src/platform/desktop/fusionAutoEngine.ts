// Auto Fusion's policy and timing are Rust's: `optn_app::fusion` (cooldowns,
// the P2P rendezvous window, which failures are transient), applied by the
// shared driver (`optn_fusion_native::driver`) that the desktop, the CLI and
// the docker lab run. The renderer keeps only the names it shows.

export type FusionMode = 'p2p' | 'server';

/** After a paid success; the same as `optn_app::fusion::AUTO_FUSION_COOLDOWN_MS`. */
export const AUTO_FUSION_COOLDOWN_MS = 20_000;
/**
 * Before trying to start Auto again after it could not start; the same as
 * `optn_app::fusion::AUTO_FUSION_RETRY_MS`.
 */
export const AUTO_FUSION_RETRY_MS = 10_000;
