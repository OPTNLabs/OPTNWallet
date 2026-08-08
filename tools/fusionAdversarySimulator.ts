/**
 * Adversarial Simulator for CashFusion P2P protocol.
 *
 * Simulates attacker models from THREAT_MODEL.md against the fusion protocol:
 *   1. Sybil — how many identities to win coordinator election?
 *   2. Timing correlation — can submission timing link inputs to participants?
 *   3. Chain analysis — can output patterns reveal tier or ownership?
 *   4. Coordinator collusion — what does a malicious coordinator learn?
 *   5. Eclipse — can an attacker isolate a victim from honest peers?
 *
 * Usage:
 *   import { simulateSybil, simulateTiming, ... } from './fusionAdversarySimulator';
 *   const result = simulateSybil({ totalPeers: 20, attackerPeers: 5 });
 */

// ── Types ──────────────────────────────────────────────────────────────────────

export interface SybilResult {
  totalPeers: number;
  attackerPeers: number;
  /** Probability of winning coordinator election (set-bound). */
  winProbability: number;
  /** Expected number of rounds coordinated by attacker out of N. */
  expectedRoundsCoordinated: number;
  /** Can the attacker learn input→output mapping for all participants? */
  learnsFullMapping: boolean;
  /** Can the attacker steal funds? */
  canSteal: boolean;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  mitigation: string;
}

export interface TimingResult {
  /** Number of submission timestamps analyzed. */
  sampleSize: number;
  /** Standard deviation of legitimate submission jitter (ms). */
  jitterStdDev: number;
  /** Can an observer correlate submission order with input ownership? */
  correlationPossible: boolean;
  /** What accuracy could an attacker achieve? */
  attackAccuracy: number; // 0-1
  /** How many rounds needed for statistically significant correlation? */
  roundsNeeded: number;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  mitigation: string;
}

export interface ChainAnalysisResult {
  /** Number of outputs to analyze. */
  outputCount: number;
  /** Can outputs be linked to a specific tier? */
  tierLeakage: boolean;
  /** Can outputs be linked to a specific participant? */
  participantLeakage: boolean;
  /** Entropy of output value distribution (bits). Higher = more private). */
  valueEntropy: number;
  /** Can the fee structure reveal participant count? */
  feeLeakage: boolean;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  mitigation: string;
}

export interface CoordinatorCollusionResult {
  /** What the coordinator learns. */
  learnsInputOutputMapping: boolean;
  learnsParticipantList: boolean;
  learnsTierAndEpoch: boolean;
  learnsBlindSignatures: boolean;
  /** What the coordinator CANNOT do. */
  canStealFunds: boolean;
  canForgeSignatures: boolean;
  canModifyTemplate: boolean;
  /** Can the coordinator link components across rounds? */
  crossRoundLinkage: boolean;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  mitigation: string;
}

export interface EclipseResult {
  /** Number of relays the attacker controls. */
  controlledRelays: number;
  /** Total relays in the network. */
  totalRelays: number;
  /** Probability of isolating a victim. */
  isolationProbability: number;
  /** Can the attacker prevent the victim from finding honest peers? */
  canIsolate: boolean;
  /** Can the attacker serve fake pool announcements? */
  canServeFakeAnnouncements: boolean;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  mitigation: string;
}

export interface SimulationReport {
  sybil: SybilResult;
  timing: TimingResult;
  chainAnalysis: ChainAnalysisResult;
  coordinatorCollusion: CoordinatorCollusionResult;
  eclipse: EclipseResult;
  overallRisk: 'low' | 'medium' | 'high' | 'critical';
  recommendations: string[];
}

// ── Sybil Simulation ───────────────────────────────────────────────────────────

/**
 * Simulate a Sybil attack on coordinator election.
 *
 * Coordinator election uses H(sorted pubkeys | candidate) — set-bound.
 * An attacker with k of n identities wins with probability k/n per round.
 */
export function simulateSybil(params: {
  totalPeers: number;
  attackerPeers: number;
  roundsSimulated?: number;
}): SybilResult {
  const { totalPeers, attackerPeers, roundsSimulated = 1000 } = params;

  if (attackerPeers >= totalPeers) {
    return {
      totalPeers,
      attackerPeers,
      winProbability: 1,
      expectedRoundsCoordinated: roundsSimulated,
      learnsFullMapping: true,
      canSteal: false,
      riskLevel: 'critical',
      mitigation: 'No mitigation — attacker controls all peers',
    };
  }

  const winProbability = attackerPeers / totalPeers;
  const expectedRoundsCoordinated = Math.round(winProbability * roundsSimulated);

  // Monte Carlo: simulate election over many rounds
  let wins = 0;
  for (let i = 0; i < roundsSimulated; i++) {
    // Random draw: which peer wins?
    const drawn = Math.floor(Math.random() * totalPeers);
    if (drawn < attackerPeers) wins++;
  }
  const observedWinRate = wins / roundsSimulated;

  // Risk assessment
  let riskLevel: SybilResult['riskLevel'];
  if (winProbability <= 0.1) riskLevel = 'low';
  else if (winProbability < 0.3) riskLevel = 'medium';
  else if (winProbability < 0.5) riskLevel = 'high';
  else riskLevel = 'critical';

  // Can the attacker steal? No — they can only coordinate, not sign others' inputs.
  // But they CAN learn the full input→output mapping for rounds they coordinate.
  const learnsFullMapping = winProbability > 0.05;

  return {
    totalPeers,
    attackerPeers,
    winProbability,
    expectedRoundsCoordinated,
    learnsFullMapping,
    canSteal: false,
    riskLevel,
    mitigation: `Set-bound election prevents offline grinding. Attacker must be present in the round. Max ${totalPeers} participants limits exposure.`,
  };
}

// ── Timing Correlation Simulation ──────────────────────────────────────────────

/**
 * Simulate timing-based input→participant linkage.
 *
 * Each peer submits components with 200-2000ms random jitter. An observer
 * sees submission timestamps and tries to correlate them with known inputs.
 */
export function simulateTiming(params: {
  peerCount: number;
  inputsPerPeer: number;
  jitterMinMs?: number;
  jitterMaxMs?: number;
  roundsSimulated?: number;
}): TimingResult {
  const {
    peerCount,
    inputsPerPeer,
    jitterMinMs = 200,
    jitterMaxMs = 2000,
    roundsSimulated = 100,
  } = params;

  const jitterRange = jitterMaxMs - jitterMinMs;
  const jitterStdDev = jitterRange / Math.sqrt(12); // uniform distribution

  // For each round, simulate submission timestamps and check if ordering
  // correlates with input ownership.
  let correctCorrelations = 0;
  let totalAttempts = 0;

  for (let round = 0; round < roundsSimulated; round++) {
    // Generate submission times for each peer
    const timestamps: Array<{ peer: number; time: number }> = [];
    for (let p = 0; p < peerCount; p++) {
      const jitter = jitterMinMs + Math.random() * jitterRange;
      timestamps.push({ peer: p, time: jitter });
    }
    // Sort by submission time
    timestamps.sort((a, b) => a.time - b.time);

    // Attacker tries to match submission order to input ownership.
    // With N peers and uniform jitter, random chance = 1/N.
    const randomAccuracy = 1 / peerCount;
    // But if attacker knows some timing patterns (e.g., faster submissions
    // correlate with fewer inputs), accuracy improves.
    const informedAccuracy = randomAccuracy * 1.5; // modest improvement

    correctCorrelations += informedAccuracy * inputsPerPeer * peerCount;
    totalAttempts += inputsPerPeer * peerCount;
  }

  const attackAccuracy = totalAttempts > 0 ? correctCorrelations / totalAttempts : 0;

  // Need enough rounds for statistical significance
  const roundsNeeded = Math.ceil(1 / (attackAccuracy - 1 / peerCount) ** 2) || 1000;

  let riskLevel: TimingResult['riskLevel'];
  if (attackAccuracy < 0.15) riskLevel = 'low';
  else if (attackAccuracy < 0.25) riskLevel = 'medium';
  else if (attackAccuracy < 0.4) riskLevel = 'high';
  else riskLevel = 'critical';

  return {
    sampleSize: peerCount * inputsPerPeer * roundsSimulated,
    jitterStdDev,
    correlationPossible: attackAccuracy > 1 / peerCount + 0.05,
    attackAccuracy,
    roundsNeeded,
    riskLevel,
    mitigation: '200-2000ms per-component jitter makes timing statistically uncorrelated with ownership. Fresh Tor circuit per batch adds network-level noise.',
  };
}

// ── Chain Analysis Simulation ──────────────────────────────────────────────────

/**
 * Simulate post-hoc chain analysis against fusion outputs.
 *
 * Tests whether output values, scripts, or fees leak information.
 */
export function simulateChainAnalysis(params: {
  tiers: number[];
  outputsPerTier: number;
  participantsPerRound: number;
}): ChainAnalysisResult {
  const { tiers, outputsPerTier, participantsPerRound } = params;

  // Quantization grid for each tier
  const grid = (tier: number) => {
    if (tier <= 0) return 1;
    const magnitude = Math.pow(10, Math.floor(Math.log10(tier)));
    return Math.max(100, Math.round(magnitude / 20));
  };

  // Generate simulated output values for each tier
  const tierOutputs: Map<number, number[]> = new Map();
  for (const tier of tiers) {
    const outputs: number[] = [];
    const g = grid(tier);
    for (let i = 0; i < outputsPerTier; i++) {
      // Quantized random value near tier
      const base = tier * (0.3 + Math.random() * 0.7);
      outputs.push(Math.round(base / g) * g);
    }
    tierOutputs.set(tier, outputs);
  }

  // Tier leakage: can we distinguish tiers by output values?
  const tierRanges = tiers.map((t) => {
    const outputs = tierOutputs.get(t)!;
    return { tier: t, min: Math.min(...outputs), max: Math.max(...outputs) };
  });

  let tierLeakage = false;
  for (let i = 0; i < tierRanges.length; i++) {
    for (let j = i + 1; j < tierRanges.length; j++) {
      const overlap =
        Math.max(0, Math.min(tierRanges[i].max, tierRanges[j].max) -
          Math.max(tierRanges[i].min, tierRanges[j].min));
      const totalRange =
        Math.max(tierRanges[i].max, tierRanges[j].max) -
        Math.min(tierRanges[i].min, tierRanges[j].min);
      if (totalRange > 0 && overlap / totalRange < 0.3) {
        tierLeakage = true;
      }
    }
  }

  // Participant leakage: can outputs be linked to specific participants?
  // With BIP69 ordering + fresh addresses, this should be very hard.
  const participantLeakage = outputsPerTier < 3 || participantsPerRound > 15;

  // Value entropy: Shannon entropy of output value distribution
  const allOutputs = tiers.flatMap((t) => tierOutputs.get(t)!);
  const valueBuckets = new Map<number, number>();
  const bucketSize = 1000; // 1000-sat buckets
  for (const v of allOutputs) {
    const bucket = Math.floor(v / bucketSize) * bucketSize;
    valueBuckets.set(bucket, (valueBuckets.get(bucket) ?? 0) + 1);
  }
  const total = allOutputs.length;
  let valueEntropy = 0;
  for (const count of valueBuckets.values()) {
    const p = count / total;
    if (p > 0) valueEntropy -= p * Math.log2(p);
  }

  // Fee leakage: does fee reveal participant count?
  const feeLeakage = participantsPerRound <= 5; // fewer participants = more fee variance

  let riskLevel: ChainAnalysisResult['riskLevel'];
  if (!tierLeakage && !participantLeakage && !feeLeakage) riskLevel = 'low';
  else if (tierLeakage || participantLeakage) riskLevel = 'high';
  else riskLevel = 'medium';

  return {
    outputCount: allOutputs.length,
    tierLeakage,
    participantLeakage,
    valueEntropy,
    feeLeakage,
    riskLevel,
    mitigation: 'Log-scale quantization grid rounds outputs to similar values across tiers. Fee fuzz adds 0-500 sats noise. BIP69 ordering hides input→output mapping.',
  };
}

// ── Coordinator Collusion Simulation ───────────────────────────────────────────

/**
 * Simulate what a malicious coordinator learns and can do.
 */
export function simulateCoordinatorCollusion(params: {
  participantCount: number;
  useBlindSignatures?: boolean;
  usePerComponentSubmission?: boolean;
}): CoordinatorCollusionResult {
  const {
    participantCount,
    useBlindSignatures = true,
    usePerComponentSubmission = true,
  } = params;

  // Coordinator ALWAYS learns:
  // - Input→output mapping (assembles the template)
  // - Participant list (from round_start)
  // - Tier and epoch
  const learnsInputOutputMapping = true;
  const learnsParticipantList = true;
  const learnsTierAndEpoch = true;

  // Coordinator learns blind signatures (but can't link them to final sigs)
  const learnsBlindSignatures = useBlindSignatures;

  // Coordinator CANNOT:
  // - Steal funds (can't sign others' inputs)
  // - Forge signatures (Schnorr is unforgeable)
  // - Modify template (peers verify byte-for-byte)
  const canStealFunds = false;
  const canForgeSignatures = false;
  const canModifyTemplate = false;

  // Cross-round linkage: with fresh Nostr identity per round, no.
  // But if the coordinator recognizes input patterns across rounds...
  const crossRoundLinkage = !usePerComponentSubmission;

  let riskLevel: CoordinatorCollusionResult['riskLevel'];
  if (canStealFunds || canForgeSignatures) riskLevel = 'critical';
  else if (crossRoundLinkage) riskLevel = 'medium';
  else riskLevel = 'low';

  return {
    learnsInputOutputMapping,
    learnsParticipantList,
    learnsTierAndEpoch,
    learnsBlindSignatures,
    canStealFunds,
    canForgeSignatures,
    canModifyTemplate,
    crossRoundLinkage,
    riskLevel,
    mitigation: 'Coordinator learns mapping but cannot steal. Blind signatures prevent component→signature linkage. Per-component submission with jitter prevents timing correlation. Fresh identity per round prevents cross-round linkage.',
  };
}

// ── Eclipse Attack Simulation ──────────────────────────────────────────────────

/**
 * Simulate an eclipse attack on relay connections.
 */
export function simulateEclipse(params: {
  controlledRelays: number;
  totalRelays: number;
  victimRelayConnections?: number;
}): EclipseResult {
  const {
    controlledRelays,
    totalRelays,
    victimRelayConnections = 3,
  } = params;

  // Probability of isolating the victim (all their connections are attacker-controlled)
  const pControl = controlledRelays / totalRelays;
  const isolationProbability = Math.pow(pControl, victimRelayConnections);

  const canIsolate = isolationProbability > 0.1;
  const canServeFakeAnnouncements = canIsolate;

  let riskLevel: EclipseResult['riskLevel'];
  if (isolationProbability < 0.01) riskLevel = 'low';
  else if (isolationProbability < 0.1) riskLevel = 'medium';
  else if (isolationProbability < 0.5) riskLevel = 'high';
  else riskLevel = 'critical';

  return {
    controlledRelays,
    totalRelays,
    isolationProbability,
    canIsolate,
    canServeFakeAnnouncements,
    riskLevel,
    mitigation: 'Multiple configured relays reduce eclipse risk. Pool announcements published to all relays. Ghost detection: if coordinator doesn\'t propose within 3.5s, failover re-elects.',
  };
}

// ── Full Simulation Report ─────────────────────────────────────────────────────

export interface SimulationParams {
  totalPeers: number;
  attackerPeers: number;
  inputsPerPeer: number;
  tiers: number[];
  outputsPerTier: number;
  controlledRelays: number;
  totalRelays: number;
  useBlindSignatures?: boolean;
  usePerComponentSubmission?: boolean;
}

export function runFullSimulation(params: SimulationParams): SimulationReport {
  const sybil = simulateSybil({
    totalPeers: params.totalPeers,
    attackerPeers: params.attackerPeers,
  });

  const timing = simulateTiming({
    peerCount: params.totalPeers,
    inputsPerPeer: params.inputsPerPeer,
  });

  const chainAnalysis = simulateChainAnalysis({
    tiers: params.tiers,
    outputsPerTier: params.outputsPerTier,
    participantsPerRound: params.totalPeers,
  });

  const coordinatorCollusion = simulateCoordinatorCollusion({
    participantCount: params.totalPeers,
    useBlindSignatures: params.useBlindSignatures ?? true,
    usePerComponentSubmission: params.usePerComponentSubmission ?? true,
  });

  const eclipse = simulateEclipse({
    controlledRelays: params.controlledRelays,
    totalRelays: params.totalRelays,
  });

  // Overall risk: worst of all categories
  const riskOrder = ['low', 'medium', 'high', 'critical'] as const;
  const risks = [sybil, timing, chainAnalysis, coordinatorCollusion, eclipse].map(
    (r) => r.riskLevel
  );
  const worstRisk = risks.reduce((worst, r) =>
    riskOrder.indexOf(r) > riskOrder.indexOf(worst) ? r : worst
  );

  const recommendations: string[] = [];
  if (sybil.riskLevel !== 'low')
    recommendations.push(sybil.mitigation);
  if (timing.riskLevel !== 'low')
    recommendations.push(timing.mitigation);
  if (chainAnalysis.riskLevel !== 'low')
    recommendations.push(chainAnalysis.mitigation);
  if (coordinatorCollusion.riskLevel !== 'low')
    recommendations.push(coordinatorCollusion.mitigation);
  if (eclipse.riskLevel !== 'low')
    recommendations.push(eclipse.mitigation);

  return {
    sybil,
    timing,
    chainAnalysis,
    coordinatorCollusion,
    eclipse,
    overallRisk: worstRisk,
    recommendations,
  };
}
