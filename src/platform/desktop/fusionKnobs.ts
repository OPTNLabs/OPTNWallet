/**
 * P2P Fusion protocol knobs — edit the numbers in this file.
 *
 * These are internal protocol constants, not wallet settings. Do not expose
 * them in the CashFusion UI. The contributor reference is
 * `docs/p2p-cashfusion-knobs.md`.
 *
 * This is the only place for values we expect to retune: player floor/cap,
 * sat tiers, gather / rendezvous / onion hop budgets.
 *
 * Do NOT put Electron Cash server wire timing here. That stays in
 * `fusionTiming.ts` (protocol.py T_*). Those are not knobs.
 *
 * Onion still needs ≥3 wallets (2 peelers). The product floor can be higher.
 * Protocol message cap is 20 players.
 */

export const FUSION_KNOB_LIMITS = {
  /** Onion mix-net needs ≥2 peelers. */
  minPlayersFloor: 3,
  /** fusionSession / allocation wire ceiling. */
  maxPlayersCeil: 20,
  maxTiers: 16,
  minTierSats: 10_000,
  maxTierSats: 21_000_000 * 100_000_000,
} as const;

export interface FusionKnobs {
  /** Need this many to lock gather / first proposal. */
  minPlayers: number;
  /**
   * After a proposal, the round may shrink to this many if some peers
   * never ACK or the coordinator vanishes. Onion floor is still 3.
   */
  minSafePlayers: number;
  maxPlayers: number;
  /** Satoshi size bands peers must share to sit in the same round. */
  tiersSats: number[];
  gatherMaxMs: number;
  gatherAloneMs: number;
  gatherAloneAutoMs: number;
  gatherMinMs: number;
  gatherFastWarmupMs: number;
  smallSetHoldMs: number;
  peerSetStableMs: number;
  peerSetStableFastMs: number;
  peakGraceMs: number;
  rendezvousMs: number;
  proposalTimeoutMs: number;
  rendezvousResendMs: number;
  missingOutputsOnionMs: number;
  credentialWaitMs: number;
}

/** Live defaults. Edit a number, save, Vite reloads. */
export const FUSION_KNOB_DEFAULTS: FusionKnobs = {
  minPlayers: 6,
  minSafePlayers: 4,
  maxPlayers: 10,
  tiersSats: [
    10_000, // 0.0001 BCH
    100_000, // 0.001 BCH
    1_000_000, // 0.01 BCH
    10_000_000, // 0.1 BCH
    100_000_000, // 1 BCH
  ],
  gatherMaxMs: 120_000,
  gatherAloneMs: 35_000,
  gatherAloneAutoMs: 120_000,
  gatherMinMs: 10_000,
  gatherFastWarmupMs: 5_000,
  smallSetHoldMs: 20_000,
  peerSetStableMs: 4_000,
  peerSetStableFastMs: 2_500,
  // Same as EC T_END_COMPS — how long we keep a faded peak before shrinking.
  peakGraceMs: 15_000,
  rendezvousMs: 60_000,
  proposalTimeoutMs: 20_000,
  rendezvousResendMs: 1_200,
  missingOutputsOnionMs: 36_000,
  credentialWaitMs: 35_000,
};

let live: FusionKnobs = { ...FUSION_KNOB_DEFAULTS, tiersSats: [...FUSION_KNOB_DEFAULTS.tiersSats] };

function asInt(value: unknown, fallback: number): number {
  const n = Math.trunc(Number(value));
  return Number.isSafeInteger(n) ? n : fallback;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = asInt(value, fallback);
  return Math.min(max, Math.max(min, n));
}

export function clampFusionKnobs(raw: Partial<FusionKnobs> | null | undefined): FusionKnobs {
  const src = raw && typeof raw === 'object' ? raw : {};
  const minSafePlayers = clampInt(
    src.minSafePlayers,
    FUSION_KNOB_LIMITS.minPlayersFloor,
    FUSION_KNOB_LIMITS.maxPlayersCeil,
    FUSION_KNOB_DEFAULTS.minSafePlayers
  );
  const minPlayers = clampInt(
    src.minPlayers,
    minSafePlayers,
    FUSION_KNOB_LIMITS.maxPlayersCeil,
    Math.max(minSafePlayers, FUSION_KNOB_DEFAULTS.minPlayers)
  );
  const maxPlayers = clampInt(
    src.maxPlayers,
    minPlayers,
    FUSION_KNOB_LIMITS.maxPlayersCeil,
    Math.max(minPlayers, FUSION_KNOB_DEFAULTS.maxPlayers)
  );
  const tiersSource = Array.isArray(src.tiersSats) ? src.tiersSats : FUSION_KNOB_DEFAULTS.tiersSats;
  const tiersSats = Array.from(
    new Set(
      tiersSource
        .map((tier) => Math.trunc(Number(tier)))
        .filter(
          (tier) =>
            Number.isSafeInteger(tier) &&
            tier >= FUSION_KNOB_LIMITS.minTierSats &&
            tier <= FUSION_KNOB_LIMITS.maxTierSats
        )
    )
  )
    .sort((a, b) => a - b)
    .slice(0, FUSION_KNOB_LIMITS.maxTiers);
  return {
    minPlayers,
    minSafePlayers,
    maxPlayers,
    tiersSats: tiersSats.length > 0 ? tiersSats : [...FUSION_KNOB_DEFAULTS.tiersSats],
    gatherMaxMs: clampInt(src.gatherMaxMs, 15_000, 600_000, FUSION_KNOB_DEFAULTS.gatherMaxMs),
    gatherAloneMs: clampInt(src.gatherAloneMs, 5_000, 180_000, FUSION_KNOB_DEFAULTS.gatherAloneMs),
    gatherAloneAutoMs: clampInt(
      src.gatherAloneAutoMs,
      15_000,
      600_000,
      FUSION_KNOB_DEFAULTS.gatherAloneAutoMs
    ),
    gatherMinMs: clampInt(src.gatherMinMs, 0, 60_000, FUSION_KNOB_DEFAULTS.gatherMinMs),
    gatherFastWarmupMs: clampInt(
      src.gatherFastWarmupMs,
      0,
      30_000,
      FUSION_KNOB_DEFAULTS.gatherFastWarmupMs
    ),
    smallSetHoldMs: clampInt(src.smallSetHoldMs, 0, 120_000, FUSION_KNOB_DEFAULTS.smallSetHoldMs),
    peerSetStableMs: clampInt(src.peerSetStableMs, 0, 30_000, FUSION_KNOB_DEFAULTS.peerSetStableMs),
    peerSetStableFastMs: clampInt(
      src.peerSetStableFastMs,
      0,
      15_000,
      FUSION_KNOB_DEFAULTS.peerSetStableFastMs
    ),
    peakGraceMs: clampInt(src.peakGraceMs, 1_000, 60_000, FUSION_KNOB_DEFAULTS.peakGraceMs),
    rendezvousMs: clampInt(src.rendezvousMs, 10_000, 180_000, FUSION_KNOB_DEFAULTS.rendezvousMs),
    proposalTimeoutMs: clampInt(
      src.proposalTimeoutMs,
      3_000,
      60_000,
      FUSION_KNOB_DEFAULTS.proposalTimeoutMs
    ),
    rendezvousResendMs: clampInt(
      src.rendezvousResendMs,
      250,
      10_000,
      FUSION_KNOB_DEFAULTS.rendezvousResendMs
    ),
    missingOutputsOnionMs: clampInt(
      src.missingOutputsOnionMs,
      8_000,
      120_000,
      FUSION_KNOB_DEFAULTS.missingOutputsOnionMs
    ),
    credentialWaitMs: clampInt(
      src.credentialWaitMs,
      8_000,
      120_000,
      FUSION_KNOB_DEFAULTS.credentialWaitMs
    ),
  };
}

export function getFusionKnobs(): FusionKnobs {
  return live;
}

export function applyFusionKnobs(patch: Partial<FusionKnobs>): FusionKnobs {
  live = clampFusionKnobs({ ...live, ...patch });
  return live;
}

export function resetFusionKnobs(): FusionKnobs {
  live = clampFusionKnobs(FUSION_KNOB_DEFAULTS);
  return live;
}

/** Parse `0.0001, 0.001, 0.01` (BCH) or raw sats ≥ 1000. */
export function parseTiersInput(text: string): number[] {
  return text
    .split(/[, \n]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const n = Number(part);
      if (!Number.isFinite(n) || n <= 0) return NaN;
      if (n < 21) return Math.round(n * 100_000_000);
      return Math.round(n);
    })
    .filter((n) => Number.isSafeInteger(n));
}

export function formatTiersInput(tiersSats: number[]): string {
  return tiersSats
    .map((sats) => {
      const bch = sats / 100_000_000;
      if (Number.isInteger(bch)) return String(bch);
      return String(bch);
    })
    .join(', ');
}
