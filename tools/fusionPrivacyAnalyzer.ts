/**
 * Privacy Analyzer for CashFusion transactions.
 *
 * Analyzes a fusion tx (or simulated tx) for privacy leaks:
 *   1. Tier fingerprinting — can a chain analyst infer the tier from output values?
 *   2. Input→output linkage — can outputs be linked back to specific inputs?
 *   3. Fee pattern analysis — does the fee reveal tier or participant count?
 *   4. Output quantization quality — are outputs sufficiently mixed across tiers?
 *
 * Usage:
 *   import { analyzeFusionTx, type FusionTxAnalysis } from './fusionPrivacyAnalyzer';
 *   const report = analyzeFusionTx({ inputs, outputs, fee, tier, participantCount });
 */

// ── Types ──────────────────────────────────────────────────────────────────────

export interface FusionInput {
  value: number; // sats
  txid: string;
  index: number;
}

export interface FusionOutput {
  value: number; // sats
  script: string; // hex
}

export interface PrivacyReport {
  tierFingerprinting: TierFingerprintResult;
  inputOutputLinkage: LinkageResult;
  feePattern: FeePatternResult;
  quantizationQuality: QuantizationResult;
  overallScore: number; // 0-100, higher = more private
  warnings: string[];
}

export interface TierFingerprintResult {
  /** How many distinct output value clusters exist. Fewer = better privacy. */
  distinctClusters: number;
  /** Standard deviation of output values relative to the tier. Lower = better. */
  relativeStdDev: number;
  /** Could an analyst distinguish this tier from others? */
  distinguishable: boolean;
  score: number; // 0-100
}

export interface LinkageResult {
  /** Number of unique output scripts (fresh addresses = good). */
  uniqueScripts: number;
  /** Ratio of unique scripts to total outputs. */
  scriptRatio: number;
  /** Could input ownership be inferred from output patterns? */
  inferrable: boolean;
  score: number;
}

export interface FeePatternResult {
  /** Actual fee in sats. */
  feeSats: number;
  /** Fee as sat/vbyte. */
  feeRate: number;
  /** Is the fee within expected bounds for this tier? */
  withinBounds: boolean;
  /** Could the fee reveal the tier? */
  tierLeakage: boolean;
  score: number;
}

export interface QuantizationResult {
  /** Grid size used for quantization. */
  gridSize: number;
  /** How many outputs fall exactly on grid points. */
  onGridCount: number;
  /** Ratio of outputs on grid points. Higher = better quantization. */
  onGridRatio: number;
  /** Are output values too uniform (suspicious) or too varied (leaky)? */
  uniformityScore: number;
  score: number;
}

// ── Quantization Grid (matches fusionP2pAllocation.ts) ─────────────────────────

function quantizationGrid(tier: number): number {
  if (tier <= 0) return 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(tier)));
  return Math.max(100, Math.round(magnitude / 20));
}

// ── Analysis Functions ─────────────────────────────────────────────────────────

function analyzeTierFingerprinting(
  outputs: FusionOutput[],
  tier: number
): TierFingerprintResult {
  if (outputs.length === 0) {
    return { distinctClusters: 0, relativeStdDev: 0, distinguishable: false, score: 100 };
  }

  const values = outputs.map((o) => o.value);
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  const stdDev = Math.sqrt(variance);
  const relativeStdDev = tier > 0 ? stdDev / tier : 0;

  // Cluster analysis: group values within 10% of each other
  const sorted = [...values].sort((a, b) => a - b);
  const clusters: number[][] = [];
  let current = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] <= current[current.length - 1] * 1.1) {
      current.push(sorted[i]);
    } else {
      clusters.push(current);
      current = [sorted[i]];
    }
  }
  clusters.push(current);

  // Fewer clusters = harder to fingerprint
  const distinctClusters = clusters.length;
  const distinguishable = distinctClusters <= 2 && outputs.length >= 4;

  // Score: penalize low cluster count and low variance
  let score = 100;
  if (distinctClusters <= 2) score -= 30;
  if (relativeStdDev < 0.05) score -= 20; // too uniform
  if (relativeStdDev > 0.5) score -= 10; // too varied
  if (distinguishable) score -= 20;

  return {
    distinctClusters,
    relativeStdDev,
    distinguishable,
    score: Math.max(0, Math.min(100, score)),
  };
}

function analyzeLinkage(
  inputs: FusionInput[],
  outputs: FusionOutput[]
): LinkageResult {
  if (outputs.length === 0) {
    return { uniqueScripts: 0, scriptRatio: 0, inferrable: false, score: 100 };
  }

  const scripts = new Set(outputs.map((o) => o.script));
  const uniqueScripts = scripts.size;
  const scriptRatio = uniqueScripts / outputs.length;

  // Fresh addresses (all unique) = good. Reused scripts = bad.
  const inferrable = scriptRatio < 0.8 && inputs.length < outputs.length;

  let score = 100;
  if (scriptRatio < 1.0) score -= (1 - scriptRatio) * 50;
  if (inferrable) score -= 20;
  if (uniqueScripts < 2) score -= 30;

  return {
    uniqueScripts,
    scriptRatio,
    inferrable,
    score: Math.max(0, Math.min(100, score)),
  };
}

function analyzeFeePattern(
  inputs: FusionInput[],
  outputs: FusionOutput[],
  fee: number,
  tier: number,
  participantCount: number
): FeePatternResult {
  const P2PKH_OUTPUT_BYTES = 34;
  const TX_OVERHEAD = 10;
  const sizeOfInput = 114; // approximate

  const totalBytes =
    inputs.length * sizeOfInput +
    outputs.length * P2PKH_OUTPUT_BYTES +
    TX_OVERHEAD;
  const feeRate = totalBytes > 0 ? (fee / totalBytes) * 1000 : 0;

  // Expected fee range: 1-10 sat/vB for normal fusion
  const withinBounds = feeRate >= 0.5 && feeRate <= 50;

  // Tier leakage: if fee is exactly proportional to tier, it leaks info
  const expectedFee = tier * 0.001 * participantCount; // rough heuristic
  const tierLeakage = Math.abs(fee - expectedFee) / expectedFee < 0.05;

  let score = 100;
  if (!withinBounds) score -= 30;
  if (tierLeakage) score -= 25;
  if (feeRate < 0.1) score -= 15; // suspiciously low

  return {
    feeSats: fee,
    feeRate,
    withinBounds,
    tierLeakage,
    score: Math.max(0, Math.min(100, score)),
  };
}

function analyzeQuantization(
  outputs: FusionOutput[],
  tier: number
): QuantizationResult {
  const grid = quantizationGrid(tier);

  const onGridCount = outputs.filter((o) => o.value % grid === 0).length;
  const onGridRatio = outputs.length > 0 ? onGridCount / outputs.length : 0;

  // Uniformity: coefficient of variation of output values
  if (outputs.length < 2) {
    return {
      gridSize: grid,
      onGridCount,
      onGridRatio,
      uniformityScore: 1.0,
      score: 80,
    };
  }

  const values = outputs.map((o) => o.value);
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  const cv = mean > 0 ? Math.sqrt(variance) / mean : 0;

  // Good CV is 0.1-0.4 (some variation, not too uniform)
  const uniformityScore = cv < 0.1 ? 0.5 : cv > 0.4 ? 0.6 : 1.0;

  let score = 100;
  if (onGridRatio < 0.5) score -= 20; // poor quantization
  if (cv < 0.05) score -= 25; // too uniform
  if (cv > 0.6) score -= 15; // too varied

  return {
    gridSize: grid,
    onGridCount,
    onGridRatio,
    uniformityScore,
    score: Math.max(0, Math.min(100, score)),
  };
}

// ── Main Analyzer ──────────────────────────────────────────────────────────────

export interface AnalyzeFusionTxOptions {
  inputs: FusionInput[];
  outputs: FusionOutput[];
  fee: number;
  tier: number;
  participantCount: number;
}

export function analyzeFusionTx(options: AnalyzeFusionTxOptions): PrivacyReport {
  const { inputs, outputs, fee, tier, participantCount } = options;
  const warnings: string[] = [];

  const tierFingerprinting = analyzeTierFingerprinting(outputs, tier);
  const inputOutputLinkage = analyzeLinkage(inputs, outputs);
  const feePattern = analyzeFeePattern(inputs, outputs, fee, tier, participantCount);
  const quantizationQuality = analyzeQuantization(outputs, tier);

  if (tierFingerprinting.distinguishable) {
    warnings.push('Output value clusters are too distinct — tier may be fingerprinted');
  }
  if (inputOutputLinkage.inferrable) {
    warnings.push('Output scripts are not sufficiently unique — input ownership may leak');
  }
  if (inputOutputLinkage.uniqueScripts < 3 && outputs.length >= 3) {
    warnings.push('Too few unique output scripts — addresses may be reused');
  }
  if (feePattern.tierLeakage) {
    warnings.push('Fee is exactly proportional to tier — fee pattern may reveal tier');
  }
  if (quantizationQuality.onGridRatio < 0.5) {
    warnings.push('Fewer than half of outputs are on the quantization grid');
  }
  if (outputs.length < 3) {
    warnings.push('Fewer than 3 outputs — reduced mixing entropy');
  }
  if (inputs.length > outputs.length * 2) {
    warnings.push('Many inputs relative to outputs — input consolidation pattern visible');
  }

  const overallScore = Math.round(
    tierFingerprinting.score * 0.3 +
    inputOutputLinkage.score * 0.3 +
    feePattern.score * 0.2 +
    quantizationQuality.score * 0.2
  );

  return {
    tierFingerprinting,
    inputOutputLinkage,
    feePattern,
    quantizationQuality,
    overallScore,
    warnings,
  };
}

// ── Comparison: analyze two tiers to check fingerprinting resistance ────────────

export interface TierComparison {
  tierA: number;
  tierB: number;
  distinguishable: boolean;
  valueOverlap: number; // 0-1, how much the output value ranges overlap
  recommendation: string;
}

export function compareTiers(
  tierA: number,
  tierB: number,
  sampleOutputsA: FusionOutput[],
  sampleOutputsB: FusionOutput[]
): TierComparison {
  const valuesA = sampleOutputsA.map((o) => o.value);
  const valuesB = sampleOutputsB.map((o) => o.value);

  const minA = Math.min(...valuesA);
  const maxA = Math.max(...valuesA);
  const minB = Math.min(...valuesB);
  const maxB = Math.max(...valuesB);

  // Overlap: how much do the ranges intersect?
  const overlapStart = Math.max(minA, minB);
  const overlapEnd = Math.min(maxA, maxB);
  const overlap = Math.max(0, overlapEnd - overlapStart);
  const totalRange = Math.max(maxA, maxB) - Math.min(minA, minB);
  const valueOverlap = totalRange > 0 ? overlap / totalRange : 0;

  const distinguishable = valueOverlap < 0.3;

  let recommendation: string;
  if (distinguishable) {
    recommendation = `Tiers ${tierA} and ${tierB} are distinguishable. Adjust quantization grid to increase overlap.`;
  } else {
    recommendation = `Tiers ${tierA} and ${tierB} have sufficient overlap. Privacy is preserved.`;
  }

  return { tierA, tierB, distinguishable, valueOverlap, recommendation };
}
